//! Lunch-zone finder ported from `assets/js/leisure/lunch.js`.
//!
//! The module samples an optimizer tour over time, evaluates a deterministic
//! lunch hunger curve, filters food POIs near the route, clusters them into
//! lunch zones, and returns browser-friendly serializable output.

use crate::graph::{dedupe_indices_by_haversine, haversine_m, LeisureGraph};
use crate::optimizer::PublicTour;
use crate::types::{Edge, EdgeKind, Node, NodeKind};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

const FOOD_RADIUS_M: f64 = 8_000.0;
const CLUSTER_EPS_M: f64 = 4_000.0;
const POLYGON_PAD_M: f64 = 500.0;
const SAMPLE_STEP_S: f64 = 5.0 * 60.0;
const SIDE_ROAD_M_PER_MIN: f64 = 500.0;
const BIG_PASS_GAIN_M: f64 = 800.0;
const POST_EFFORT_WINDOW_S: f64 = 45.0 * 60.0;
const QUALITY_SCORE_SCALE: f64 = 5.0;
const EPS: f64 = 1e-9;

#[derive(Clone, Debug, PartialEq)]
pub struct LunchOptions {
    pub start_time: String,
    /// Minutes east of UTC used to match browser `Date.setHours()` local-time semantics.
    ///
    /// NOTE: tz_offset_minutes is plumbed by the JS shim from `-new Date().getTimezoneOffset()`.
    /// wasm-shim.js must inject this into LunchOptions / BreakOptions JSON to match JS
    /// Date.setHours() local-time semantics.
    pub tz_offset_minutes: i32,
    pub persona: String,
    pub lunch_policy: LunchPolicy,
    pub narrative_mode: bool,
    pub weather: Option<String>,
}

impl Default for LunchOptions {
    fn default() -> Self {
        Self {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            tz_offset_minutes: 0,
            persona: "normal".to_owned(),
            lunch_policy: LunchPolicy::Auto,
            narrative_mode: true,
            weather: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum LunchPolicy {
    Auto,
    Skip,
    WindowMinutes(f64),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunchSuggestion {
    pub zones: Vec<LunchZone>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desert: Option<LunchDesert>,
    pub hunger_curve: Vec<HungerPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunchZone {
    pub id: String,
    pub polygon: Vec<[f64; 2]>,
    pub centroid: [f64; 2],
    pub t_arrive_min: String,
    pub t_arrive_max: String,
    pub candidates: Vec<LunchCandidate>,
    pub score: f64,
    pub vibe_tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub narrative_role: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunchCandidate {
    pub poi_id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub score: f64,
    pub categories: Vec<String>,
    pub themes: Vec<String>,
    pub detour_min: f64,
    pub distance_from_route_km: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunchDesert {
    pub stretch_start: String,
    pub stretch_end: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HungerPoint {
    pub t: String,
    pub value: f64,
}

#[derive(Clone, Debug)]
struct Profile {
    start_time: SimpleTime,
    vertices: Vec<RoutePoint>,
    segments: Vec<Segment>,
    total_duration_s: f64,
    scenic_threshold: f64,
}

#[derive(Clone, Debug)]
struct Segment {
    from: RoutePoint,
    to: RoutePoint,
    start_t: f64,
    end_t: f64,
    start_s: f64,
    end_s: f64,
    kind: Option<EdgeKind>,
    scenic_score: f64,
    gain_m: f64,
}

#[derive(Clone, Debug)]
struct RoutePoint {
    id: String,
    name: String,
    lat: f64,
    lon: f64,
    elev: Option<f64>,
    s_m: f64,
    t_sec: f64,
}

#[derive(Clone, Debug)]
struct FoodCandidate {
    poi_id: String,
    name: String,
    lat: f64,
    lon: f64,
    elev: Option<f64>,
    raw_score: f64,
    score: f64,
    categories: Vec<String>,
    themes: Vec<String>,
    detour_min: f64,
    distance_from_route_km: f64,
    s_m: f64,
    t_sec: f64,
    drift_min: f64,
}

#[derive(Clone, Copy, Debug)]
struct Window {
    min_sec: f64,
    max_sec: f64,
}

#[derive(Clone, Debug)]
struct CurveSample {
    t_sec: f64,
    value: f64,
}

#[derive(Clone, Debug)]
struct NarrativeContext {
    min_t: f64,
    max_t: f64,
    elev: f64,
}

#[derive(Clone, Debug)]
struct ZoneInternal {
    id: String,
    polygon: Vec<[f64; 2]>,
    centroid: [f64; 2],
    t_arrive_min: String,
    t_arrive_max: String,
    candidates: Vec<LunchCandidate>,
    score: f64,
    vibe_tag: String,
    narrative_role: Option<String>,
}

#[derive(Clone, Debug)]
struct NearestPoint<'a> {
    point: &'a RoutePoint,
    distance_m: f64,
}

#[derive(Clone, Debug)]
struct SimpleTime {
    date: String,
    seconds_of_day: i64,
    offset_minutes: i32,
}

/// Finds lunch areas near the tour route.
pub fn find_lunch_area(
    graph: &LeisureGraph,
    tour: &PublicTour,
    options: LunchOptions,
) -> LunchSuggestion {
    plan_lunch_zone(graph, tour, options)
}

/// JS-parity alias for `planLunchZone`.
pub(crate) fn plan_lunch_zone(
    graph: &LeisureGraph,
    tour: &PublicTour,
    options: LunchOptions,
) -> LunchSuggestion {
    let opts = normalize_options(options);
    let profile = build_profile(graph, tour, &opts.start_time, opts.tz_offset_minutes);
    if profile.total_duration_s <= 0.0 {
        return LunchSuggestion::default();
    }
    let curve = build_hunger_curve(&profile, &opts);
    if opts.lunch_policy == LunchPolicy::Skip {
        return LunchSuggestion {
            zones: Vec::new(),
            desert: None,
            hunger_curve: curve
                .iter()
                .map(|sample| HungerPoint {
                    t: profile.start_time.iso_at(sample.t_sec),
                    value: 0.0,
                })
                .collect(),
        };
    }
    let Some(peak) = curve
        .iter()
        .max_by(|a, b| {
            a.value
                .total_cmp(&b.value)
                .then_with(|| b.t_sec.total_cmp(&a.t_sec))
        })
        .cloned()
    else {
        return LunchSuggestion::default();
    };
    let window = lunch_window(&curve, &peak, &opts.lunch_policy);
    let hunger_curve = curve
        .iter()
        .map(|sample| HungerPoint {
            t: profile.start_time.iso_at(sample.t_sec),
            value: sample.value,
        })
        .collect::<Vec<_>>();

    let candidates = find_food_candidates(graph, &profile, window, peak.t_sec);
    if candidates.is_empty() {
        return LunchSuggestion {
            zones: Vec::new(),
            desert: Some(make_desert(&profile, window)),
            hunger_curve,
        };
    }

    let narrative = opts
        .narrative_mode
        .then(|| narrative_context(&profile))
        .flatten();
    let mut zones = cluster_candidates(&candidates)
        .iter()
        .map(|cluster| {
            build_zone(
                cluster,
                &profile,
                window,
                peak.t_sec,
                &opts,
                narrative.as_ref(),
            )
        })
        .collect::<Vec<_>>();
    zones.sort_by(compare_zones);
    LunchSuggestion {
        zones: zones
            .into_iter()
            .map(|zone| LunchZone {
                id: zone.id,
                polygon: zone.polygon,
                centroid: zone.centroid,
                t_arrive_min: zone.t_arrive_min,
                t_arrive_max: zone.t_arrive_max,
                candidates: zone.candidates,
                score: round(zone.score, 4),
                vibe_tag: zone.vibe_tag,
                narrative_role: zone.narrative_role,
            })
            .collect(),
        desert: None,
        hunger_curve,
    }
}

fn normalize_options(mut options: LunchOptions) -> LunchOptions {
    if !matches!(
        options.persona.as_str(),
        "early" | "normal" | "late" | "foodie" | "family"
    ) {
        options.persona = "normal".to_owned();
    }
    if !matches!(
        options.weather.as_deref(),
        Some("sunny" | "rainy" | "snow") | None
    ) {
        options.weather = None;
    }
    if matches!(options.lunch_policy, LunchPolicy::WindowMinutes(value) if !value.is_finite() || value <= 0.0)
    {
        options.lunch_policy = LunchPolicy::Auto;
    }
    options
}

fn build_profile(
    graph: &LeisureGraph,
    tour: &PublicTour,
    start_time: &str,
    tz_offset_minutes: i32,
) -> Profile {
    let start_time = SimpleTime::parse(start_time, tz_offset_minutes);
    let edges = route_edges(graph, tour);
    let mut vertices = Vec::new();
    let mut segments = Vec::new();
    let mut t_sec = 0.0;
    let mut s_m = 0.0;
    if !edges.is_empty() {
        if let Some(first) = edges
            .first()
            .and_then(|edge| point_from_node(graph, edge.from.as_str()))
        {
            vertices.push(RoutePoint {
                s_m: 0.0,
                t_sec: 0.0,
                ..first
            });
        }
        let mut last_id = vertices
            .first()
            .map(|point| point.id.clone())
            .unwrap_or_default();
        for edge in edges {
            let Some(from) = point_from_node(graph, edge.from.as_str()) else {
                continue;
            };
            let Some(to) = point_from_node(graph, edge.to.as_str()) else {
                continue;
            };
            if last_id != from.id {
                vertices.push(RoutePoint {
                    s_m,
                    t_sec,
                    ..from.clone()
                });
            }
            let duration_s =
                positive_number(edge.duration_s, fallback_duration_s(&from, &to, edge));
            let distance_m = positive_number(
                edge.distance_m,
                haversine_m(from.lat, from.lon, to.lat, to.lon),
            );
            let start_t = t_sec;
            let start_s = s_m;
            let line = expanded_line(edge, &from, &to);
            let line_distance = line_length_m(&line).max(distance_m);
            let mut traversed = 0.0;
            for i in 1..line.len() {
                traversed +=
                    haversine_m(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon);
                let ratio = if line_distance > EPS {
                    (traversed / line_distance).clamp(0.0, 1.0)
                } else {
                    i as f64 / line.len().saturating_sub(1).max(1) as f64
                };
                vertices.push(RoutePoint {
                    s_m: start_s + distance_m * ratio,
                    t_sec: start_t + duration_s * ratio,
                    ..line[i].clone()
                });
            }
            segments.push(make_segment(
                Some(edge.clone()),
                from.clone(),
                to.clone(),
                start_t,
                t_sec + duration_s,
                start_s,
                s_m + distance_m,
            ));
            t_sec += duration_s;
            s_m += distance_m;
            last_id = to.id;
        }
    } else {
        let points = tour
            .stops
            .iter()
            .filter_map(|stop| point_from_node(graph, stop.node_id.as_str()))
            .collect::<Vec<_>>();
        if let Some(first) = points.first() {
            vertices.push(RoutePoint {
                s_m: 0.0,
                t_sec: 0.0,
                ..first.clone()
            });
        }
        for pair in points.windows(2) {
            let from = &pair[0];
            let to = &pair[1];
            let edge = graph.edge_between(&from.id.as_str().into(), &to.id.as_str().into());
            let duration_s = edge
                .map(|edge| positive_number(edge.duration_s, fallback_duration_s(from, to, edge)))
                .unwrap_or_else(|| {
                    haversine_m(from.lat, from.lon, to.lat, to.lon) / 55_000.0 * 3600.0
                });
            let distance_m = edge
                .map(|edge| {
                    positive_number(
                        edge.distance_m,
                        haversine_m(from.lat, from.lon, to.lat, to.lon),
                    )
                })
                .unwrap_or_else(|| haversine_m(from.lat, from.lon, to.lat, to.lon));
            let start_t = t_sec;
            let start_s = s_m;
            t_sec += duration_s;
            s_m += distance_m;
            vertices.push(RoutePoint {
                s_m,
                t_sec,
                ..to.clone()
            });
            segments.push(make_segment(
                edge.cloned(),
                from.clone(),
                to.clone(),
                start_t,
                t_sec,
                start_s,
                s_m,
            ));
        }
    }
    let declared = if tour.total_duration_h.is_finite() && tour.total_duration_h > 0.0 {
        tour.total_duration_h * 3600.0
    } else {
        0.0
    };
    let mut scenic_scores = segments
        .iter()
        .map(|segment| segment.scenic_score)
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    scenic_scores.sort_by(f64::total_cmp);
    let scenic_threshold = if scenic_scores.is_empty() {
        f64::INFINITY
    } else {
        let index = ((scenic_scores.len() - 1) as f64 * 0.9).floor() as usize;
        scenic_scores[index]
    };
    Profile {
        start_time,
        vertices,
        segments,
        total_duration_s: t_sec.max(declared),
        scenic_threshold,
    }
}

fn route_edges<'a>(graph: &'a LeisureGraph, tour: &PublicTour) -> Vec<&'a Edge> {
    let mut out = Vec::new();
    for raw in &tour.edges {
        if let Some(edge) = graph
            .edge_by_id
            .get(raw)
            .or_else(|| graph.edge_by_key.get(raw))
            .and_then(|index| graph.edges.get(*index))
        {
            out.push(edge);
        }
    }
    if !out.is_empty() {
        return out;
    }
    for pair in tour.path.windows(2) {
        if let Some(edge) = graph.edge_between(&pair[0], &pair[1]) {
            out.push(edge);
        }
    }
    out
}

fn build_hunger_curve(profile: &Profile, opts: &LunchOptions) -> Vec<CurveSample> {
    let total = profile.total_duration_s.max(0.0);
    let mut samples = Vec::new();
    let mut t_sec = 0.0;
    while t_sec < total {
        samples.push(hunger_at(profile, opts, t_sec));
        t_sec += SAMPLE_STEP_S;
    }
    samples.push(hunger_at(profile, opts, total));
    samples
}

fn hunger_at(profile: &Profile, opts: &LunchOptions, t_sec: f64) -> CurveSample {
    let local_total_min = profile.start_time.minutes_at(t_sec);
    let (ideal_h, ideal_m) = persona_ideal(&opts.persona);
    let ideal_min = ideal_h as i64 * 60 + ideal_m as i64;
    let sigma_min = if opts.persona == "foodie" { 45.0 } else { 30.0 };
    let delta_min = (local_total_min - ideal_min) as f64;
    let ideal_score = (-0.5 * (delta_min / sigma_min).powi(2)).exp();
    let pressure = clamp01((t_sec / 3600.0 - 4.0) / 2.0) * 0.55;
    let post_effort = if recently_after_big_pass(profile, t_sec) {
        0.3
    } else {
        0.0
    };
    let scenic_anti = segment_at(profile, t_sec)
        .filter(|segment| segment.scenic_score >= profile.scenic_threshold)
        .map(|_| -0.2)
        .unwrap_or(0.0);
    CurveSample {
        t_sec,
        value: round(
            (ideal_score + pressure + post_effort + scenic_anti).max(0.0),
            4,
        ),
    }
}

fn persona_ideal(persona: &str) -> (i32, i32) {
    match persona {
        "early" => (11, 45),
        "late" => (13, 30),
        "foodie" => (12, 30),
        "family" => (12, 0),
        _ => (12, 30),
    }
}

fn recently_after_big_pass(profile: &Profile, t_sec: f64) -> bool {
    profile.segments.iter().any(|segment| {
        segment.gain_m >= BIG_PASS_GAIN_M
            && t_sec >= segment.end_t
            && t_sec <= segment.end_t + POST_EFFORT_WINDOW_S
    })
}

fn lunch_window(curve: &[CurveSample], peak: &CurveSample, policy: &LunchPolicy) -> Window {
    if let LunchPolicy::WindowMinutes(minutes) = policy {
        let half = minutes * 30.0;
        return Window {
            min_sec: (peak.t_sec - half).max(0.0),
            max_sec: peak.t_sec + half,
        };
    }
    let half_value = peak.value / 2.0;
    let peak_index = curve
        .iter()
        .position(|item| (item.t_sec - peak.t_sec).abs() <= EPS)
        .unwrap_or(0);
    let mut left = peak_index;
    let mut right = peak_index;
    while left > 0 && curve[left - 1].value >= half_value {
        left -= 1;
    }
    while right + 1 < curve.len() && curve[right + 1].value >= half_value {
        right += 1;
    }
    Window {
        min_sec: curve
            .get(left)
            .map(|item| item.t_sec)
            .unwrap_or((peak.t_sec - 45.0 * 60.0).max(0.0)),
        max_sec: curve
            .get(right)
            .map(|item| item.t_sec)
            .unwrap_or(peak.t_sec + 45.0 * 60.0),
    }
}

fn find_food_candidates(
    graph: &LeisureGraph,
    profile: &Profile,
    window: Window,
    peak_sec: f64,
) -> Vec<FoodCandidate> {
    let route_points = route_points_in_window(profile, window);
    let mut poi_ids = graph.nodes_of_kind(NodeKind::Poi).to_vec();
    poi_ids.sort();
    let mut out = Vec::new();
    for poi_id in poi_ids {
        let Some(poi) = graph.node(&poi_id) else {
            continue;
        };
        if !is_food_poi(poi) || !has_coord(poi.lat, poi.lon) {
            continue;
        }
        let Some(nearest) = nearest_point(&route_points, poi.lat, poi.lon) else {
            continue;
        };
        if nearest.distance_m > FOOD_RADIUS_M {
            continue;
        }
        let categories = normalize_tokens(&poi.categories);
        let themes = normalize_tokens(&poi.themes);
        let raw_score = finite_number(poi.score.or(poi.scenic_score).unwrap_or(0.0), 0.0);
        out.push(FoodCandidate {
            poi_id: poi.id.to_string(),
            name: poi.name.clone(),
            lat: poi.lat,
            lon: poi.lon,
            elev: poi.elev,
            raw_score,
            score: round(raw_score, 2),
            categories,
            themes,
            detour_min: round(nearest.distance_m / SIDE_ROAD_M_PER_MIN * 2.0, 2),
            distance_from_route_km: round(nearest.distance_m / 1000.0, 3),
            s_m: nearest.point.s_m,
            t_sec: nearest.point.t_sec,
            drift_min: ((nearest.point.t_sec - peak_sec).abs()) / 60.0,
        });
    }
    out.sort_by(compare_candidates);
    out
}

fn is_food_poi(poi: &Node) -> bool {
    let themes = normalize_tokens(&poi.themes);
    if themes.iter().any(|theme| theme == "food-drink") {
        return true;
    }
    let categories = normalize_tokens(&poi.categories);
    categories
        .iter()
        .any(|category| food_categories().contains(category.as_str()))
}

fn route_points_in_window(profile: &Profile, window: Window) -> Vec<RoutePoint> {
    let mut points = profile
        .vertices
        .iter()
        .filter(|point| point.t_sec >= window.min_sec - 1.0 && point.t_sec <= window.max_sec + 1.0)
        .cloned()
        .collect::<Vec<_>>();
    let mut t_sec = window.min_sec.max(0.0);
    while t_sec <= window.max_sec + 1.0 {
        if let Some(point) = point_at_time(profile, t_sec) {
            points.push(point);
        }
        t_sec += SAMPLE_STEP_S;
    }
    for t_sec in [window.min_sec, window.max_sec] {
        if let Some(point) = point_at_time(profile, t_sec) {
            points.push(point);
        }
    }
    if points.is_empty() {
        profile.vertices.clone()
    } else {
        points
    }
}

fn cluster_candidates(candidates: &[FoodCandidate]) -> Vec<Vec<FoodCandidate>> {
    let mut sorted = candidates.to_vec();
    sorted.sort_by(|a, b| {
        a.s_m
            .total_cmp(&b.s_m)
            .then_with(|| a.poi_id.cmp(&b.poi_id))
    });
    let mut seen = BTreeSet::new();
    let mut clusters = Vec::new();
    for candidate in &sorted {
        if seen.contains(&candidate.poi_id) {
            continue;
        }
        let mut cluster = Vec::new();
        let mut stack = vec![candidate.clone()];
        seen.insert(candidate.poi_id.clone());
        while let Some(current) = stack.pop() {
            cluster.push(current.clone());
            for other in &sorted {
                if seen.contains(&other.poi_id) {
                    continue;
                }
                if planar_distance_m(current.lat, current.lon, other.lat, other.lon)
                    <= CLUSTER_EPS_M
                {
                    seen.insert(other.poi_id.clone());
                    stack.push(other.clone());
                }
            }
        }
        cluster.sort_by(compare_candidates);
        clusters.push(cluster);
    }
    clusters.sort_by(|a, b| {
        a.first()
            .zip(b.first())
            .map(|(left, right)| {
                left.s_m
                    .total_cmp(&right.s_m)
                    .then_with(|| left.poi_id.cmp(&right.poi_id))
            })
            .unwrap_or(Ordering::Equal)
    });
    clusters
}

fn build_zone(
    cluster: &[FoodCandidate],
    profile: &Profile,
    window: Window,
    _peak_sec: f64,
    opts: &LunchOptions,
    narrative: Option<&NarrativeContext>,
) -> ZoneInternal {
    let centroid = cluster_centroid(cluster);
    let vibe_tag = vibe_for(cluster).to_owned();
    let polygon = clamp_polygon(expanded_hull(cluster, centroid), cluster, profile);
    let mean_quality = mean(cluster.iter().map(|c| normalized_quality(c.raw_score)));
    let entropy = category_entropy(cluster);
    let scenic = scenic_around(profile, mean(cluster.iter().map(|c| c.t_sec)));
    let avg_detour = mean(cluster.iter().map(|c| c.detour_min));
    let half_arrive_window_sec = (window.max_sec - window.min_sec).max(60.0) / 2.0;
    let arrival_sec = mean(cluster.iter().map(|c| c.t_sec)) + avg_detour * 30.0;
    let drift = mean(cluster.iter().map(|c| c.drift_min));
    let mut score =
        1.2 * (cluster.len() as f64).ln_1p() + 0.9 * mean_quality + 0.35 * entropy + 0.45 * scenic
            - 0.06 * avg_detour
            - 0.01 * drift;
    if opts.persona == "foodie" {
        score += 1.5 * mean_quality
            + if cluster.iter().any(|c| c.raw_score >= 5.0) {
                0.8
            } else {
                0.0
            };
    }
    if opts.persona == "family" {
        score += 0.55
            * mean(
                cluster.iter().map(|c| {
                    has_any(&c.categories, &["playground", "park", "toilet"]) as u8 as f64
                }),
            );
        if vibe_tag == "mountain-hut" {
            score -= 0.8 + 0.02 * avg_detour;
        }
    }
    if opts.weather.as_deref() == Some("rainy") && vibe_tag == "mountain-hut" {
        score -= 0.3;
    }
    let narrative_role = if qualifies_post_climax(narrative, cluster, centroid) {
        score += 0.7;
        Some("post-climax".to_owned())
    } else {
        None
    };
    let id_seed = cluster
        .iter()
        .map(|candidate| candidate.poi_id.as_str())
        .min()
        .unwrap_or("zone");
    ZoneInternal {
        id: format!("lunch-{id_seed}"),
        polygon,
        centroid: [round(centroid.0, 6), round(centroid.1, 6)],
        t_arrive_min: profile
            .start_time
            .iso_at((arrival_sec - half_arrive_window_sec).max(0.0)),
        t_arrive_max: profile
            .start_time
            .iso_at((arrival_sec + half_arrive_window_sec).max(0.0)),
        candidates: cluster.iter().map(public_candidate).collect(),
        score,
        vibe_tag,
        narrative_role,
    }
}

fn public_candidate(candidate: &FoodCandidate) -> LunchCandidate {
    LunchCandidate {
        poi_id: candidate.poi_id.clone(),
        name: candidate.name.clone(),
        lat: candidate.lat,
        lon: candidate.lon,
        score: candidate.score,
        categories: candidate.categories.clone(),
        themes: candidate.themes.clone(),
        detour_min: candidate.detour_min,
        distance_from_route_km: candidate.distance_from_route_km,
    }
}

fn vibe_for(cluster: &[FoodCandidate]) -> &'static str {
    if cluster
        .iter()
        .all(|candidate| has_any(&candidate.categories, &["alpine-hut", "mountain-hut"]))
    {
        "mountain-hut"
    } else if cluster
        .iter()
        .all(|candidate| has_any(&candidate.categories, &["restaurant", "cafe"]))
    {
        "valley"
    } else {
        "hidden"
    }
}

fn narrative_context(profile: &Profile) -> Option<NarrativeContext> {
    let climax = profile.segments.iter().max_by(|a, b| {
        let left = a.scenic_score
            + if a.kind == Some(EdgeKind::PassClimb) {
                0.25
            } else {
                0.0
            };
        let right = b.scenic_score
            + if b.kind == Some(EdgeKind::PassClimb) {
                0.25
            } else {
                0.0
            };
        left.total_cmp(&right)
            .then_with(|| b.end_t.total_cmp(&a.end_t))
    })?;
    let elev = [climax.from.elev, climax.to.elev]
        .iter()
        .filter_map(|value| *value)
        .fold(f64::NEG_INFINITY, f64::max);
    elev.is_finite().then_some(NarrativeContext {
        min_t: climax.end_t + 30.0 * 60.0,
        max_t: climax.end_t + 45.0 * 60.0,
        elev,
    })
}

fn qualifies_post_climax(
    narrative: Option<&NarrativeContext>,
    cluster: &[FoodCandidate],
    centroid: (f64, f64, Option<f64>),
) -> bool {
    let Some(narrative) = narrative else {
        return false;
    };
    let t = mean(cluster.iter().map(|c| c.t_sec));
    let elev = mean_option(cluster.iter().map(|c| c.elev)).or(centroid.2);
    t >= narrative.min_t
        && t <= narrative.max_t
        && elev.is_some_and(|value| narrative.elev - value >= 300.0)
}

fn make_desert(profile: &Profile, window: Window) -> LunchDesert {
    let start = profile.start_time.iso_at(window.min_sec);
    let end = profile.start_time.iso_at(window.max_sec);
    let a = named_point_at(profile, window.min_sec);
    let b = named_point_at(profile, window.max_sec);
    LunchDesert {
        stretch_start: start.clone(),
        stretch_end: end.clone(),
        message: format!(
            "No food {}-{} between {a} and {b} — pack a sandwich",
            hm_from_iso(&start),
            hm_from_iso(&end)
        ),
    }
}

fn expanded_hull(cluster: &[FoodCandidate], centroid: (f64, f64, Option<f64>)) -> Vec<[f64; 2]> {
    if cluster.len() == 1 {
        return diamond(centroid.0, centroid.1);
    }
    let mut points = cluster
        .iter()
        .map(|candidate| {
            to_xy(
                candidate.lat,
                candidate.lon,
                &candidate.poi_id,
                centroid.0,
                centroid.1,
            )
        })
        .collect::<Vec<_>>();
    points.sort_by(|a, b| {
        a.x.total_cmp(&b.x)
            .then_with(|| a.y.total_cmp(&b.y))
            .then_with(|| a.id.cmp(&b.id))
    });
    if points.len() == 2 || polygon_area_xy(&points).abs() < 1.0 {
        return rectangle(&cluster[0], cluster.last().unwrap_or(&cluster[0]), centroid);
    }
    let hull = monotone_hull(&points);
    if hull.len() < 3 || polygon_area_xy(&hull).abs() < 1.0 {
        return rectangle(&cluster[0], cluster.last().unwrap_or(&cluster[0]), centroid);
    }
    hull.iter()
        .map(|point| {
            let len = point.x.hypot(point.y).max(1.0);
            from_xy(
                point.x + point.x / len * POLYGON_PAD_M,
                point.y + point.y / len * POLYGON_PAD_M,
                centroid.0,
                centroid.1,
            )
        })
        .collect()
}

fn diamond(lat: f64, lon: f64) -> Vec<[f64; 2]> {
    let d_lat = meters_to_lat(POLYGON_PAD_M);
    let d_lon = meters_to_lon(POLYGON_PAD_M, lat);
    vec![
        [lat + d_lat, lon],
        [lat, lon + d_lon],
        [lat - d_lat, lon],
        [lat, lon - d_lon],
    ]
}

fn rectangle(
    a: &FoodCandidate,
    b: &FoodCandidate,
    centroid: (f64, f64, Option<f64>),
) -> Vec<[f64; 2]> {
    let pa = to_xy(a.lat, a.lon, &a.poi_id, centroid.0, centroid.1);
    let pb = to_xy(b.lat, b.lon, &b.poi_id, centroid.0, centroid.1);
    let dx = pb.x - pa.x;
    let dy = pb.y - pa.y;
    let len = dx.hypot(dy).max(1.0);
    let nx = -dy / len * POLYGON_PAD_M;
    let ny = dx / len * POLYGON_PAD_M;
    vec![
        from_xy(pa.x + nx, pa.y + ny, centroid.0, centroid.1),
        from_xy(pb.x + nx, pb.y + ny, centroid.0, centroid.1),
        from_xy(pb.x - nx, pb.y - ny, centroid.0, centroid.1),
        from_xy(pa.x - nx, pa.y - ny, centroid.0, centroid.1),
    ]
}

fn monotone_hull(points: &[XY]) -> Vec<XY> {
    let mut lower: Vec<XY> = Vec::new();
    for point in points {
        while lower.len() >= 2
            && cross(&lower[lower.len() - 2], &lower[lower.len() - 1], point) <= 0.0
        {
            lower.pop();
        }
        lower.push(point.clone());
    }
    let mut upper: Vec<XY> = Vec::new();
    for point in points.iter().rev() {
        while upper.len() >= 2
            && cross(&upper[upper.len() - 2], &upper[upper.len() - 1], point) <= 0.0
        {
            upper.pop();
        }
        upper.push(point.clone());
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

fn clamp_polygon(
    polygon: Vec<[f64; 2]>,
    cluster: &[FoodCandidate],
    profile: &Profile,
) -> Vec<[f64; 2]> {
    if !profile.vertices.iter().any(|v| v.elev.is_some())
        || !cluster.iter().any(|c| c.elev.is_some())
    {
        return polygon.into_iter().map(round_coord).collect();
    }
    let route_elev_points = profile
        .vertices
        .iter()
        .filter(|point| point.elev.is_some())
        .cloned()
        .collect::<Vec<_>>();
    let filtered = polygon
        .iter()
        .copied()
        .filter(|[lat, lon]| {
            let candidate = nearest_food_point(cluster, *lat, *lon);
            let route = nearest_point(&route_elev_points, *lat, *lon);
            match (candidate, route) {
                (Some(candidate), Some(route)) => {
                    let c_elev = candidate.point.elev.unwrap_or(0.0);
                    let r_elev = route.point.elev.unwrap_or(0.0);
                    (c_elev - r_elev).abs() <= 300.0
                }
                _ => true,
            }
        })
        .collect::<Vec<_>>();
    if filtered.len() >= 3 {
        filtered.into_iter().map(round_coord).collect()
    } else {
        polygon.into_iter().map(round_coord).collect()
    }
}

fn point_at_time(profile: &Profile, t_sec: f64) -> Option<RoutePoint> {
    if profile.segments.is_empty() {
        return profile.vertices.first().cloned();
    }
    let segment = segment_at(profile, t_sec).or_else(|| {
        if t_sec < profile.segments[0].start_t {
            profile.segments.first()
        } else {
            profile.segments.last()
        }
    })?;
    let ratio = clamp01((t_sec - segment.start_t) / (segment.end_t - segment.start_t).max(1.0));
    Some(RoutePoint {
        id: format!("{}:t{}", segment.from.id, t_sec.round() as i64),
        name: String::new(),
        lat: segment.from.lat + (segment.to.lat - segment.from.lat) * ratio,
        lon: segment.from.lon + (segment.to.lon - segment.from.lon) * ratio,
        elev: interpolate_option(segment.from.elev, segment.to.elev, ratio),
        s_m: segment.start_s + (segment.end_s - segment.start_s) * ratio,
        t_sec,
    })
}

fn segment_at(profile: &Profile, t_sec: f64) -> Option<&Segment> {
    profile
        .segments
        .iter()
        .find(|segment| t_sec >= segment.start_t && t_sec <= segment.end_t)
}

fn make_segment(
    edge: Option<Edge>,
    from: RoutePoint,
    to: RoutePoint,
    start_t: f64,
    end_t: f64,
    start_s: f64,
    end_s: f64,
) -> Segment {
    let kind = edge.as_ref().map(|edge| edge.kind.clone());
    let scenic_score = edge
        .as_ref()
        .and_then(|edge| edge.scenic_score)
        .unwrap_or(0.0);
    let gain_m = edge
        .as_ref()
        .and_then(|edge| {
            if edge.kind == EdgeKind::PassClimb {
                Some(
                    (to.elev.unwrap_or(0.0) - from.elev.unwrap_or(0.0))
                        .abs()
                        .max(300.0),
                )
            } else {
                None
            }
        })
        .unwrap_or_else(|| (to.elev.unwrap_or(0.0) - from.elev.unwrap_or(0.0)).abs());
    Segment {
        from,
        to,
        start_t,
        end_t,
        start_s,
        end_s,
        kind,
        scenic_score,
        gain_m,
    }
}

fn point_from_node(graph: &LeisureGraph, id: &str) -> Option<RoutePoint> {
    let node = graph.node(&id.into())?;
    has_coord(node.lat, node.lon).then(|| RoutePoint {
        id: node.id.to_string(),
        name: node.name.clone(),
        lat: node.lat,
        lon: node.lon,
        elev: node.elev,
        s_m: 0.0,
        t_sec: 0.0,
    })
}

fn expanded_line(edge: &Edge, from: &RoutePoint, to: &RoutePoint) -> Vec<RoutePoint> {
    let mut raw = Vec::with_capacity(edge.geometry.len() + 2);
    raw.push(from.clone());
    for (index, point) in edge.geometry.iter().enumerate() {
        raw.push(RoutePoint {
            id: format!("{}:g{index}", edge.canonical_id()),
            name: String::new(),
            lat: point[0],
            lon: point[1],
            elev: None,
            s_m: 0.0,
            t_sec: 0.0,
        });
    }
    raw.push(to.clone());
    let raw_vec: Vec<RoutePoint> = raw
        .into_iter()
        .filter(|point| has_coord(point.lat, point.lon))
        .collect();
    let coords = raw_vec
        .iter()
        .map(|point| (point.lat, point.lon))
        .collect::<Vec<_>>();
    dedupe_indices_by_haversine(&coords)
        .into_iter()
        .map(|index| raw_vec[index].clone())
        .collect()
}

fn compare_zones(a: &ZoneInternal, b: &ZoneInternal) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| a.id.cmp(&b.id))
        .then_with(|| a.centroid[0].total_cmp(&b.centroid[0]))
        .then_with(|| a.centroid[1].total_cmp(&b.centroid[1]))
}

fn compare_candidates(a: &FoodCandidate, b: &FoodCandidate) -> Ordering {
    a.detour_min
        .total_cmp(&b.detour_min)
        .then_with(|| b.raw_score.total_cmp(&a.raw_score))
        .then_with(|| a.poi_id.cmp(&b.poi_id))
}

fn cluster_centroid(cluster: &[FoodCandidate]) -> (f64, f64, Option<f64>) {
    (
        mean(cluster.iter().map(|c| c.lat)),
        mean(cluster.iter().map(|c| c.lon)),
        mean_option(cluster.iter().map(|c| c.elev)),
    )
}

fn category_entropy(cluster: &[FoodCandidate]) -> f64 {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for candidate in cluster {
        for category in &candidate.categories {
            *counts.entry(category.clone()).or_default() += 1;
        }
    }
    let total = counts.values().sum::<usize>();
    if total == 0 || counts.len() <= 1 {
        return 0.0;
    }
    let mut h = 0.0;
    for count in counts.values() {
        let p = *count as f64 / total as f64;
        h -= p * p.ln();
    }
    h / (counts.len() as f64).ln()
}

fn normalized_quality(score: f64) -> f64 {
    clamp01(score / QUALITY_SCORE_SCALE)
}

fn nearest_point(points: &[RoutePoint], lat: f64, lon: f64) -> Option<NearestPoint<'_>> {
    points
        .iter()
        .filter_map(|point| {
            let distance_m = planar_distance_m(point.lat, point.lon, lat, lon);
            distance_m
                .is_finite()
                .then_some(NearestPoint { point, distance_m })
        })
        .min_by(|a, b| {
            a.distance_m
                .total_cmp(&b.distance_m)
                .then_with(|| a.point.id.cmp(&b.point.id))
        })
}

#[derive(Clone, Debug)]
struct FoodNearest<'a> {
    point: &'a FoodCandidate,
    distance_m: f64,
}

fn nearest_food_point(points: &[FoodCandidate], lat: f64, lon: f64) -> Option<FoodNearest<'_>> {
    points
        .iter()
        .filter_map(|point| {
            let distance_m = planar_distance_m(point.lat, point.lon, lat, lon);
            distance_m
                .is_finite()
                .then_some(FoodNearest { point, distance_m })
        })
        .min_by(|a, b| {
            a.distance_m
                .total_cmp(&b.distance_m)
                .then_with(|| a.point.poi_id.cmp(&b.point.poi_id))
        })
}

fn planar_distance_m(a_lat: f64, a_lon: f64, b_lat: f64, b_lon: f64) -> f64 {
    if !has_coord(a_lat, a_lon) || !has_coord(b_lat, b_lon) {
        return f64::INFINITY;
    }
    let lat = (a_lat + b_lat).to_radians() / 2.0;
    ((a_lon - b_lon) * 111_320.0 * lat.cos()).hypot((a_lat - b_lat) * 111_320.0)
}

fn normalize_tokens(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|value| value.split(','))
        .map(normalize_token)
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize_token(value: &str) -> String {
    value.trim().to_lowercase().replace([' ', '_'], "-")
}

fn has_any(values: &[String], choices: &[&str]) -> bool {
    let set = values.iter().map(String::as_str).collect::<BTreeSet<_>>();
    choices.iter().any(|choice| set.contains(choice))
}

fn food_categories() -> BTreeSet<&'static str> {
    BTreeSet::from([
        "restaurant",
        "cafe",
        "cafe-bistro",
        "restaurant-cafe",
        "alpine-hut",
        "mountain-hut",
        "mountain-restaurant",
        "alpine-restaurant",
    ])
}

fn has_coord(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite()
}

fn positive_number(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

fn finite_number(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn fallback_duration_s(from: &RoutePoint, to: &RoutePoint, edge: &Edge) -> f64 {
    let distance_m = positive_number(
        edge.distance_m,
        haversine_m(from.lat, from.lon, to.lat, to.lon),
    );
    distance_m / 55_000.0 * 3600.0
}

fn line_length_m(points: &[RoutePoint]) -> f64 {
    points
        .windows(2)
        .map(|pair| haversine_m(pair[0].lat, pair[0].lon, pair[1].lat, pair[1].lon))
        .filter(|value| value.is_finite())
        .sum()
}

fn mean(values: impl IntoIterator<Item = f64>) -> f64 {
    let clean = values
        .into_iter()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if clean.is_empty() {
        0.0
    } else {
        clean.iter().sum::<f64>() / clean.len() as f64
    }
}

fn mean_option(values: impl IntoIterator<Item = Option<f64>>) -> Option<f64> {
    let clean = values
        .into_iter()
        .flatten()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    (!clean.is_empty()).then(|| clean.iter().sum::<f64>() / clean.len() as f64)
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn round(value: f64, digits: i32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let factor = 10_f64.powi(digits);
    ((value + f64::EPSILON) * factor).round() / factor
}

fn round_coord(coord: [f64; 2]) -> [f64; 2] {
    [round(coord[0], 6), round(coord[1], 6)]
}

fn scenic_around(profile: &Profile, t_sec: f64) -> f64 {
    let scenic = segment_at(profile, t_sec)
        .map(|segment| segment.scenic_score)
        .unwrap_or(0.0);
    if scenic > 1.0 {
        scenic / 10.0
    } else {
        scenic
    }
}

#[derive(Clone, Debug)]
struct XY {
    id: String,
    x: f64,
    y: f64,
}

fn to_xy(lat: f64, lon: f64, id: &str, origin_lat: f64, origin_lon: f64) -> XY {
    let lat_m = 111_320.0;
    let lon_m = 111_320.0 * origin_lat.to_radians().cos();
    XY {
        id: id.to_owned(),
        x: (lon - origin_lon) * lon_m,
        y: (lat - origin_lat) * lat_m,
    }
}

fn from_xy(x: f64, y: f64, origin_lat: f64, origin_lon: f64) -> [f64; 2] {
    [
        origin_lat + y / 111_320.0,
        origin_lon + x / (111_320.0 * origin_lat.to_radians().cos()),
    ]
}

fn meters_to_lat(meters: f64) -> f64 {
    meters / 111_320.0
}

fn meters_to_lon(meters: f64, lat: f64) -> f64 {
    meters / (111_320.0 * lat.to_radians().cos())
}

fn cross(o: &XY, a: &XY, b: &XY) -> f64 {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

fn polygon_area_xy(points: &[XY]) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..points.len() {
        let a = &points[i];
        let b = &points[(i + 1) % points.len()];
        area += a.x * b.y - b.x * a.y;
    }
    area / 2.0
}

fn interpolate_option(a: Option<f64>, b: Option<f64>, ratio: f64) -> Option<f64> {
    match (a, b) {
        (Some(left), Some(right)) if left.is_finite() && right.is_finite() => {
            Some(left + (right - left) * ratio)
        }
        _ => None,
    }
}

fn named_point_at(profile: &Profile, t_sec: f64) -> String {
    let Some(target) = point_at_time(profile, t_sec) else {
        return "route point".to_owned();
    };
    nearest_point(&profile.vertices, target.lat, target.lon)
        .map(|nearest| {
            if !nearest.point.name.is_empty() {
                nearest.point.name.clone()
            } else {
                nearest.point.id.clone()
            }
        })
        .unwrap_or_else(|| "route point".to_owned())
}

fn hm_from_iso(value: &str) -> String {
    value
        .split('T')
        .nth(1)
        .and_then(|time| time.get(0..5))
        .unwrap_or("00:00")
        .to_owned()
}

impl SimpleTime {
    fn parse(value: &str, offset_minutes: i32) -> Self {
        let date = value.get(0..10).unwrap_or("2026-06-15").to_owned();
        let time = value.split('T').nth(1).unwrap_or("08:00:00");
        let mut parts = time.split(':');
        let hour = parts
            .next()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(8);
        let minute = parts
            .next()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        let second = parts
            .next()
            .and_then(|v| v.get(0..2))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        Self {
            date,
            seconds_of_day: (hour * 3600 + minute * 60 + second).rem_euclid(86_400),
            offset_minutes,
        }
    }

    fn iso_at(&self, offset_s: f64) -> String {
        let total = (self.seconds_of_day as f64 + offset_s).round() as i64;
        let day_offset = total.div_euclid(86_400);
        let seconds = total.rem_euclid(86_400);
        let hour = seconds / 3600;
        let minute = (seconds % 3600) / 60;
        let second = seconds % 60;
        let date = if day_offset == 0 {
            self.date.clone()
        } else {
            advance_iso_date(&self.date, day_offset)
        };
        format!("{date}T{hour:02}:{minute:02}:{second:02}.000Z")
    }

    fn minutes_at(&self, offset_s: f64) -> i64 {
        let total = (self.seconds_of_day as f64 + offset_s).round() as i64;
        total / 60 + self.offset_minutes as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunger_curve_uses_local_timezone_offset_for_ideal_time() {
        let start_time = SimpleTime::parse("2026-06-15T08:00:00.000Z", 120);
        let (ideal_h, ideal_m) = persona_ideal("normal");
        let delta_min = start_time.minutes_at(0.0) - (ideal_h as i64 * 60 + ideal_m as i64);

        assert_eq!(start_time.minutes_at(0.0), 10 * 60);
        assert_eq!(delta_min, -150);
    }

    #[test]
    fn hunger_curve_handles_tour_crossing_local_midnight() {
        let start_time = SimpleTime::parse("2026-06-15T22:00:00.000Z", 120);

        assert_eq!(
            start_time.minutes_at(0.0),
            1440,
            "local time at t=0 should be 1440 (next-day midnight)"
        );
        assert_eq!(
            start_time.minutes_at(43_200.0),
            1440 + 720,
            "12h later should be 36:00 absolute"
        );
    }

    #[test]
    fn expanded_line_uses_raw_prev_dedup_matching_js() {
        let from = route_point("from", 0.0, 0.0);
        let to = route_point("to", 0.0, 0.0000099);
        let edge = Edge {
            id: Some("from->to".to_owned()),
            from: "from".into(),
            to: "to".into(),
            kind: EdgeKind::Connector,
            distance_m: 1.1,
            duration_s: 1.0,
            leisure_cost: 1.0,
            pass_id: None,
            side: None,
            scenic_score: None,
            season: None,
            road_class: None,
            is_highway: None,
            geometry: vec![[0.0, 0.0000054]],
            source: None,
        };

        let result = expanded_line(&edge, &from, &to);

        assert_eq!(result.len(), 1, "Should match JS: keep only 'from'");
        assert_eq!(result[0].id, "from");
    }

    fn route_point(id: &str, lat: f64, lon: f64) -> RoutePoint {
        RoutePoint {
            id: id.to_owned(),
            name: id.to_owned(),
            lat,
            lon,
            elev: None,
            s_m: 0.0,
            t_sec: 0.0,
        }
    }
}

fn advance_iso_date(date: &str, days: i64) -> String {
    let parts = date.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return date.to_owned();
    }
    let Some(year) = parts[0].parse::<i32>().ok() else {
        return date.to_owned();
    };
    let Some(month) = parts[1].parse::<u32>().ok() else {
        return date.to_owned();
    };
    let Some(day) = parts[2].parse::<u32>().ok() else {
        return date.to_owned();
    };
    let (year, month, day) = civil_from_days(days_from_civil(year, month, day) + days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year as i64 - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i64;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}
