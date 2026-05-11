//! Break-stop suggester ported from `assets/js/leisure/breaks.js`.
//!
//! The module splits a planned tour into inter-stop driving segments, merges
//! adjacent segments when the intervening stop dwell is under 15 minutes, and
//! samples deterministic driving-load chunks to suggest rest, viewpoint, fuel,
//! coffee, or stretch breaks.

use crate::graph::{haversine_m, LeisureGraph};
use crate::optimizer::PublicTour;
use crate::types::{Edge, EdgeKind, Node};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const DEFAULT_START: &str = "2026-06-15T08:00:00.000Z";
const SAMPLE_S: f64 = 10.0 * 60.0;
const MIN_TOUR_S: f64 = 45.0 * 60.0;
const MIN_REST_DWELL_S: f64 = 15.0 * 60.0;
const MIN_SINCE_STOP_S: f64 = 40.0 * 60.0;
const COOLDOWN_S: f64 = 40.0 * 60.0;
const CORRIDOR_RADIUS_M: f64 = 5_000.0;
const LONG_LEG_S: f64 = 90.0 * 60.0;
const EPS: f64 = 1e-9;

#[derive(Clone, Debug, PartialEq)]
pub struct BreakOptions {
    pub start_time: String,
    pub persona: String,
    pub weather: Option<String>,
    pub tour_packed: bool,
    pub corridor_pois: Vec<BreakPoiInput>,
    pub max_breaks_total: usize,
    // Mirrors JS tour.dwellSecPerStop lookup via dwell_sec_for_stop:
    // route node id, original stop id, then stop index.
    pub stop_dwell_sec: BTreeMap<String, f64>,
}

impl Default for BreakOptions {
    fn default() -> Self {
        Self {
            start_time: DEFAULT_START.to_owned(),
            persona: "default".to_owned(),
            weather: None,
            tour_packed: false,
            corridor_pois: Vec::new(),
            max_breaks_total: 4,
            stop_dwell_sec: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakPoiInput {
    pub poi_id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub score: f64,
    pub detour_min: f64,
    pub categories: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenic_score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub popularity: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakSuggestions {
    pub breaks: Vec<BreakStop>,
    pub load_curve: Vec<LoadCurvePoint>,
    pub diagnostics: BreakDiagnostics,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakStop {
    pub id: String,
    #[serde(rename = "type")]
    pub break_type: String,
    pub t_start: String,
    pub t_end: String,
    pub at_segment_idx: usize,
    pub at_tour_vertex_idx: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poi_candidate: Option<BreakPoiCandidate>,
    pub reason: String,
    pub load: BreakLoad,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pacing_role: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakPoiCandidate {
    pub poi_id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub score: f64,
    pub detour_min: f64,
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakLoad {
    pub boredom: f64,
    pub effort: f64,
    pub total: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadCurvePoint {
    pub tour_vertex_idx: f64,
    pub t: String,
    pub boredom: f64,
    pub effort: f64,
    pub total: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakDiagnostics {
    pub total_drive_h: f64,
    pub segment_count: usize,
    pub packed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppressed_reason: Option<String>,
}

#[derive(Clone, Debug)]
struct Segment {
    edges: Vec<Edge>,
    start_vertex_idx: f64,
    end_vertex_idx: f64,
    end_stop: Option<StopRef>,
    merged_segment_count: usize,
}

#[derive(Clone, Debug)]
struct StopRef {
    id: String,
    dwell_sec: f64,
}

#[derive(Clone, Debug)]
struct SegmentMetrics {
    duration_s: f64,
    scenic: f64,
    straight_fraction: f64,
    curvature_density: f64,
    elev_gain_per_km: f64,
    poi_density: f64,
    motorway_fraction: f64,
}

#[derive(Clone, Debug)]
struct Chunk {
    duration_s: f64,
    edge: Edge,
    point: Option<Point>,
    tour_vertex_idx: f64,
}

#[derive(Clone, Debug)]
struct Point {
    lat: f64,
    lon: f64,
}

#[derive(Clone, Debug)]
struct Load {
    boredom: f64,
    effort: f64,
    total: f64,
}

#[derive(Clone, Debug)]
struct ScoredCandidate {
    poi_id: String,
    name: String,
    lat: f64,
    lon: f64,
    detour_min: f64,
    score: f64,
    categories: Vec<String>,
}

#[derive(Clone, Debug)]
struct SimpleTime {
    date: String,
    seconds_of_day: i64,
}

/// Suggests break stops and returns only the break list.
pub fn suggest_breaks(
    graph: &LeisureGraph,
    tour: &PublicTour,
    options: BreakOptions,
) -> Vec<BreakStop> {
    detect_breaks(graph, tour, options).breaks
}

/// JS-parity alias for `detectBreaks`.
pub fn detect_breaks(
    graph: &LeisureGraph,
    tour: &PublicTour,
    options: BreakOptions,
) -> BreakSuggestions {
    let options = normalize_options(options);
    let edges = tour_edges(graph, tour);
    let segments = split_segments(graph, tour, &edges, &options);
    let total_duration_s = total_drive_seconds(tour, &edges);
    let diagnostics = BreakDiagnostics {
        total_drive_h: round(total_duration_s / 3600.0, 3),
        segment_count: segments.len(),
        packed: options.tour_packed,
        suppressed_reason: options.tour_packed.then(|| "tour-packed".to_owned()),
    };
    let start_time = SimpleTime::parse(&options.start_time);
    let threshold = persona_threshold(&options.persona);
    let mut load_curve = Vec::new();
    let mut breaks = Vec::new();
    let allow_suggestions =
        !options.tour_packed && total_duration_s >= MIN_TOUR_S && options.max_breaks_total > 0;
    let mut drive_clock_s = 0.0;
    let mut schedule_extra_s = 0.0;
    let mut last_break_drive_s = f64::NEG_INFINITY;

    for (segment_idx, segment) in segments.iter().enumerate() {
        let metrics = segment_metrics(graph, segment, &options.corridor_pois);
        let mut since_stop_s = 0.0;
        let mut load_total = 0.0;
        let mut load_boredom = 0.0;
        let mut load_effort = 0.0;
        let mut segment_elapsed_s = 0.0;
        let mut pending_decompression = false;
        for chunk in segment_chunks(graph, segment) {
            let duration_s = chunk.duration_s;
            let next_drive_clock_s = drive_clock_s + duration_s;
            segment_elapsed_s += duration_s;
            since_stop_s += duration_s;
            if is_high_pass_climax(graph, &chunk.edge) {
                pending_decompression = true;
            }
            let t = start_time.iso_at(next_drive_clock_s + schedule_extra_s);
            let chunk_load = mental_load(&metrics, duration_s, &t, options.weather.as_deref());
            load_total += chunk_load.total;
            load_boredom += chunk_load.boredom;
            load_effort += chunk_load.effort;
            load_curve.push(LoadCurvePoint {
                tour_vertex_idx: chunk.tour_vertex_idx,
                t: t.clone(),
                boredom: round(chunk_load.boredom, 3),
                effort: round(chunk_load.effort, 3),
                total: round(chunk_load.total, 3),
            });
            let can_suggest = allow_suggestions
                && since_stop_s > MIN_SINCE_STOP_S
                && next_drive_clock_s - last_break_drive_s >= COOLDOWN_S
                && load_total > threshold;
            if can_suggest {
                let role = pacing_role(&metrics, segment_elapsed_s, pending_decompression);
                let candidate = select_candidate(
                    &options.corridor_pois,
                    chunk.point.as_ref(),
                    &options.persona,
                    role.as_deref(),
                );
                let break_type = candidate
                    .as_ref()
                    .map(|candidate| break_type(candidate, &options.persona, role.as_deref()))
                    .unwrap_or_else(|| "stretch".to_owned());
                let dwell_s = break_duration_s(&break_type);
                let t_start = t;
                let t_end = start_time.iso_at(next_drive_clock_s + schedule_extra_s + dwell_s);
                breaks.push(BreakStop {
                    id: format!("break-{}", breaks.len() + 1),
                    break_type: break_type.clone(),
                    t_start,
                    t_end,
                    at_segment_idx: segment_idx,
                    at_tour_vertex_idx: chunk.tour_vertex_idx,
                    poi_candidate: candidate.map(|candidate| BreakPoiCandidate {
                        poi_id: candidate.poi_id,
                        name: candidate.name,
                        lat: candidate.lat,
                        lon: candidate.lon,
                        score: candidate.score,
                        detour_min: candidate.detour_min,
                        categories: candidate.categories,
                    }),
                    reason: reason_for(
                        &break_type,
                        role.as_deref(),
                        (since_stop_s / 60.0).round() as i64,
                    ),
                    load: BreakLoad {
                        boredom: round(load_boredom, 3),
                        effort: round(load_effort, 3),
                        total: round(load_total, 3),
                    },
                    pacing_role: role,
                });
                last_break_drive_s = next_drive_clock_s;
                schedule_extra_s += dwell_s;
                since_stop_s = 0.0;
                load_total = 0.0;
                load_boredom = 0.0;
                load_effort = 0.0;
                pending_decompression = false;
            }
            drive_clock_s = next_drive_clock_s;
        }
    }

    BreakSuggestions {
        breaks: cap_breaks(breaks, options.max_breaks_total),
        load_curve,
        diagnostics,
    }
}

fn normalize_options(mut options: BreakOptions) -> BreakOptions {
    if !persona_thresholds().contains_key(options.persona.as_str()) {
        options.persona = "default".to_owned();
    }
    if !matches!(
        options.weather.as_deref(),
        Some("sunny" | "rainy" | "snow") | None
    ) {
        options.weather = None;
    }
    options
}

fn tour_edges(graph: &LeisureGraph, tour: &PublicTour) -> Vec<Edge> {
    let mut out = Vec::new();
    for item in &tour.edges {
        if let Some(edge) = graph
            .edge_by_id
            .get(item)
            .or_else(|| graph.edge_by_key.get(item))
            .and_then(|index| graph.edges.get(*index))
        {
            out.push(edge.clone());
        }
    }
    if !out.is_empty() {
        return out;
    }
    for pair in tour.path.windows(2) {
        if let Some(edge) = graph.edge_between(&pair[0], &pair[1]) {
            out.push(edge.clone());
        }
    }
    out
}

fn split_segments(
    graph: &LeisureGraph,
    tour: &PublicTour,
    edges: &[Edge],
    options: &BreakOptions,
) -> Vec<Segment> {
    let stop_refs = resolve_stop_refs(graph, tour, edges, options);
    let stop_ids = stop_refs
        .iter()
        .map(|stop| stop.id.clone())
        .collect::<Vec<_>>();
    let route = tour
        .path
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let stop_vertex_idxs = stop_ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            route
                .iter()
                .position(|route_id| route_id == id)
                .unwrap_or(index) as f64
        })
        .collect::<Vec<_>>();
    if edges.is_empty() {
        return Vec::new();
    }
    if stop_ids.len() < 2 {
        return vec![Segment {
            edges: edges.to_vec(),
            start_vertex_idx: 0.0,
            end_vertex_idx: route.len().saturating_sub(1).max(1) as f64,
            end_stop: None,
            merged_segment_count: 1,
        }];
    }
    let mut segments = Vec::new();
    let mut current = Vec::new();
    let mut segment_idx = 0usize;
    let mut next_stop_id = stop_ids.get(1).cloned().unwrap_or_default();
    for edge in edges {
        current.push(edge.clone());
        if edge.to.to_string() == next_stop_id && segment_idx < stop_ids.len().saturating_sub(2) {
            segments.push(Segment {
                edges: current,
                start_vertex_idx: stop_vertex_idxs
                    .get(segment_idx)
                    .copied()
                    .unwrap_or(segment_idx as f64),
                end_vertex_idx: stop_vertex_idxs
                    .get(segment_idx + 1)
                    .copied()
                    .unwrap_or(segment_idx as f64 + 1.0),
                end_stop: stop_refs.get(segment_idx + 1).cloned(),
                merged_segment_count: 1,
            });
            current = Vec::new();
            segment_idx += 1;
            next_stop_id = stop_ids.get(segment_idx + 1).cloned().unwrap_or_default();
        }
    }
    if !current.is_empty() {
        let end_index = (segment_idx + 1).min(stop_ids.len() - 1);
        segments.push(Segment {
            edges: current,
            start_vertex_idx: stop_vertex_idxs
                .get(segment_idx)
                .copied()
                .unwrap_or(segment_idx as f64),
            end_vertex_idx: stop_vertex_idxs
                .get(end_index)
                .copied()
                .unwrap_or((route.len().saturating_sub(1)).max(segment_idx + 1) as f64),
            end_stop: stop_refs.get(end_index).cloned(),
            merged_segment_count: 1,
        });
    }
    let raw = if segments.is_empty() {
        vec![Segment {
            edges: edges.to_vec(),
            start_vertex_idx: 0.0,
            end_vertex_idx: stop_ids
                .len()
                .saturating_sub(1)
                .max(route.len().saturating_sub(1)) as f64,
            end_stop: stop_refs.last().cloned(),
            merged_segment_count: 1,
        }]
    } else {
        segments
    };
    merge_short_dwell_segments(raw)
}

fn merge_short_dwell_segments(segments: Vec<Segment>) -> Vec<Segment> {
    if segments.len() <= 1 {
        return segments;
    }
    let mut merged = Vec::new();
    let mut iter = segments.into_iter();
    let Some(mut current) = iter.next() else {
        return merged;
    };
    current.merged_segment_count = 1;
    for next in iter {
        let dwell_sec = current
            .end_stop
            .as_ref()
            .map(|stop| stop.dwell_sec)
            .unwrap_or(0.0);
        if dwell_sec < MIN_REST_DWELL_S {
            current.edges.extend(next.edges);
            current.end_vertex_idx = next.end_vertex_idx;
            current.end_stop = next.end_stop;
            current.merged_segment_count += next.merged_segment_count.max(1);
        } else {
            merged.push(current);
            current = Segment {
                merged_segment_count: next.merged_segment_count.max(1),
                ..next
            };
        }
    }
    merged.push(current);
    merged
}

fn segment_metrics(
    graph: &LeisureGraph,
    segment: &Segment,
    corridor_pois: &[BreakPoiInput],
) -> SegmentMetrics {
    let mut duration_s = 0.0;
    let mut distance_m = 0.0;
    let mut scenic_weighted = 0.0;
    let mut straight_weighted = 0.0;
    let mut curvature_weighted = 0.0;
    let mut elev_gain_m = 0.0;
    let mut road_mix: BTreeMap<String, f64> = BTreeMap::new();
    for edge in &segment.edges {
        let d_s = edge_duration_s(edge);
        let d_m = edge_distance_m(edge, graph);
        let scenic = scenic_score(graph, edge);
        let curvature = edge_curvature_density(graph, edge, d_m);
        let straight = edge_straight_fraction(graph, edge);
        let road_class = normalized_road_class(edge);
        duration_s += d_s;
        distance_m += d_m;
        scenic_weighted += scenic * d_s;
        straight_weighted += straight * d_s;
        curvature_weighted += curvature * d_s;
        elev_gain_m += edge_elevation_gain_m(graph, edge);
        *road_mix.entry(road_class).or_default() += d_m;
    }
    let distance_km = (distance_m / 1000.0).max(0.001);
    let poi_density = corridor_poi_density(corridor_pois, segment, graph, distance_km);
    let motorway_fraction = road_fraction(&road_mix, distance_m, &["motorway", "trunk"]);
    SegmentMetrics {
        duration_s,
        scenic: clamp01(if duration_s > 0.0 {
            scenic_weighted / duration_s
        } else {
            0.2
        }),
        straight_fraction: clamp01(if duration_s > 0.0 {
            straight_weighted / duration_s
        } else {
            0.5
        }),
        curvature_density: (if duration_s > 0.0 {
            curvature_weighted / duration_s
        } else {
            0.0
        })
        .max(0.0),
        elev_gain_per_km: elev_gain_m / distance_km,
        poi_density,
        motorway_fraction,
    }
}

fn segment_chunks(graph: &LeisureGraph, segment: &Segment) -> Vec<Chunk> {
    let segment_duration_s = segment
        .edges
        .iter()
        .map(edge_duration_s)
        .sum::<f64>()
        .max(1.0);
    let vertex_span = (segment.end_vertex_idx - segment.start_vertex_idx).max(0.0);
    let mut chunks = Vec::new();
    let mut remaining_in_chunk = SAMPLE_S;
    let mut current_chunk_s = 0.0;
    let mut point = None;
    let mut elapsed_s = 0.0;
    for edge in &segment.edges {
        let edge_duration = edge_duration_s(edge).max(0.0);
        let mut remaining_edge_s = edge_duration;
        while remaining_edge_s > EPS {
            let take_s = remaining_edge_s.min(remaining_in_chunk);
            current_chunk_s += take_s;
            elapsed_s += take_s;
            remaining_edge_s -= take_s;
            remaining_in_chunk -= take_s;
            point = point_along_edge(graph, edge, 1.0 - remaining_edge_s / edge_duration.max(1.0));
            let vertex_idx = round(
                segment.start_vertex_idx + vertex_span * (elapsed_s / segment_duration_s),
                3,
            );
            if remaining_in_chunk <= EPS {
                chunks.push(Chunk {
                    duration_s: current_chunk_s,
                    edge: edge.clone(),
                    point: point.clone(),
                    tour_vertex_idx: vertex_idx,
                });
                remaining_in_chunk = SAMPLE_S;
                current_chunk_s = 0.0;
            }
        }
    }
    if current_chunk_s > EPS {
        if let Some(edge) = segment.edges.last() {
            chunks.push(Chunk {
                duration_s: current_chunk_s,
                edge: edge.clone(),
                point,
                tour_vertex_idx: round(segment.end_vertex_idx, 3),
            });
        }
    }
    chunks
}

fn mental_load(
    metrics: &SegmentMetrics,
    duration_s: f64,
    t_iso: &str,
    weather: Option<&str>,
) -> Load {
    let duration_min = duration_s / 60.0;
    let boredom = duration_min
        * metrics.straight_fraction
        * (1.0 - metrics.scenic)
        * (1.0 - metrics.poi_density.mul_add(0.05, 0.0).min(0.25));
    let effort =
        duration_min * metrics.curvature_density * (metrics.elev_gain_per_km - 30.0).max(0.0)
            / 100.0;
    let total = boredom + effort + circadian_penalty(t_iso) + glare_penalty(t_iso, weather);
    Load {
        boredom,
        effort,
        total,
    }
}

fn circadian_penalty(t_iso: &str) -> f64 {
    let minutes = minutes_from_iso(t_iso);
    triangular(minutes as f64, 14.0 * 60.0 + 30.0, 75.0, 0.4)
        + triangular(minutes as f64, 17.0 * 60.0, 60.0, 0.2)
}

fn glare_penalty(t_iso: &str, weather: Option<&str>) -> f64 {
    if weather != Some("sunny") {
        return 0.0;
    }
    let minutes = minutes_from_iso(t_iso);
    let hour = minutes as f64 / 60.0;
    if !(9.0..17.0).contains(&hour) {
        0.3
    } else {
        0.0
    }
}

fn pacing_role(
    metrics: &SegmentMetrics,
    segment_elapsed_s: f64,
    pending_decompression: bool,
) -> Option<String> {
    if pending_decompression {
        return Some("decompression".to_owned());
    }
    let progress = segment_elapsed_s / metrics.duration_s.max(1.0);
    if metrics.motorway_fraction >= 0.7
        && metrics.duration_s >= LONG_LEG_S
        && (0.35..=0.75).contains(&progress)
    {
        return Some("micro-surprise".to_owned());
    }
    None
}

fn select_candidate(
    pois: &[BreakPoiInput],
    point: Option<&Point>,
    persona: &str,
    role: Option<&str>,
) -> Option<ScoredCandidate> {
    let point = point?;
    let mut candidates = Vec::new();
    for poi in pois {
        if !has_coord(poi.lat, poi.lon) {
            continue;
        }
        let distance_m = haversine_m(point.lat, point.lon, poi.lat, poi.lon);
        if distance_m > CORRIDOR_RADIUS_M {
            continue;
        }
        let detour_min = finite_number(poi.detour_min, 0.0);
        let cats = poi_tokens(poi);
        let scenic = normalized_score(poi.scenic_score.unwrap_or(poi.score));
        let score = -detour_min * 3.0
            + facility_match(&cats)
            + scenic * 3.0
            + dwell_fit(detour_min)
            + persona_bonus(&cats, persona)
            + role_bonus(&cats, scenic, poi, role);
        candidates.push(ScoredCandidate {
            poi_id: if poi.poi_id.is_empty() {
                poi.name.clone()
            } else {
                poi.poi_id.clone()
            },
            name: if poi.name.is_empty() {
                poi.poi_id.clone()
            } else {
                poi.name.clone()
            },
            lat: poi.lat,
            lon: poi.lon,
            detour_min: round(detour_min, 1),
            score: round(score, 3),
            categories: cats,
        });
    }
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.detour_min.total_cmp(&b.detour_min))
            .then_with(|| a.poi_id.cmp(&b.poi_id))
    });
    candidates
        .into_iter()
        .find(|candidate| candidate.score >= 1.0)
}

fn facility_match(cats: &[String]) -> f64 {
    let mut score = 0.0;
    if has_any(
        cats,
        &[
            "cafe",
            "coffee",
            "restaurant",
            "food",
            "food-drink",
            "cafe-bistro",
            "restaurant-cafe",
        ],
    ) {
        score += 2.0;
    }
    if has_any(
        cats,
        &[
            "viewpoint",
            "viewpoints",
            "viewpoint-panorama",
            "panoramic-view",
            "scenic",
            "hidden-gem",
            "mountain-summit",
        ],
    ) {
        score += 2.0;
    }
    if has_any(cats, &["playground", "park", "picnic"]) {
        score += 2.0;
    }
    if has_any(cats, &["fuel", "gas", "petrol", "charging"]) {
        score += 2.0;
    }
    if has_any(cats, &["settlement", "village", "valley"]) {
        score += 1.0;
    }
    score
}

fn persona_bonus(cats: &[String], persona: &str) -> f64 {
    match persona {
        "family" if has_any(cats, &["playground", "restaurant", "picnic", "park"]) => 3.0,
        "motorcyclist"
            if has_any(
                cats,
                &[
                    "viewpoint",
                    "viewpoints",
                    "viewpoint-panorama",
                    "panoramic-view",
                    "drivers-road",
                ],
            ) =>
        {
            3.0
        }
        "gourmet"
            if has_any(
                cats,
                &[
                    "cafe",
                    "coffee",
                    "food",
                    "food-drink",
                    "restaurant",
                    "cafe-bistro",
                    "restaurant-cafe",
                ],
            ) =>
        {
            3.0
        }
        "photographer"
            if has_any(
                cats,
                &[
                    "viewpoint",
                    "viewpoints",
                    "viewpoint-panorama",
                    "panoramic-view",
                    "scenic",
                    "hidden-gem",
                    "mountain-summit",
                ],
            ) =>
        {
            3.0
        }
        "speedrunner" if has_any(cats, &["fuel", "gas", "petrol", "charging"]) => 3.0,
        _ => 0.0,
    }
}

fn role_bonus(cats: &[String], scenic: f64, poi: &BreakPoiInput, role: Option<&str>) -> f64 {
    match role {
        Some("decompression") => {
            (if has_any(
                cats,
                &["settlement", "village", "valley", "restaurant", "cafe"],
            ) {
                2.0
            } else {
                0.0
            }) + if scenic <= 0.45 { 1.5 } else { -0.5 }
        }
        Some("micro-surprise") => {
            let popularity = normalized_score(poi.popularity.unwrap_or(0.2));
            if scenic >= 0.65 && popularity <= 0.4 {
                2.5
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

fn dwell_fit(detour_min: f64) -> f64 {
    if detour_min <= 5.0 {
        1.0
    } else if detour_min <= 10.0 {
        0.5
    } else {
        0.0
    }
}

fn break_type(candidate: &ScoredCandidate, persona: &str, role: Option<&str>) -> String {
    let cats = &candidate.categories;
    if has_any(cats, &["fuel", "gas", "petrol", "charging"]) {
        "fuel"
    } else if has_any(
        cats,
        &[
            "viewpoint",
            "viewpoints",
            "viewpoint-panorama",
            "panoramic-view",
            "scenic",
            "hidden-gem",
            "mountain-summit",
        ],
    ) {
        "viewpoint"
    } else if has_any(cats, &["cafe", "coffee"]) {
        "coffee"
    } else if has_any(
        cats,
        &[
            "restaurant",
            "food",
            "food-drink",
            "cafe-bistro",
            "restaurant-cafe",
        ],
    ) {
        if persona == "gourmet" {
            "coffee"
        } else {
            "rest"
        }
    } else if has_any(
        cats,
        &[
            "playground",
            "park",
            "picnic",
            "settlement",
            "village",
            "valley",
        ],
    ) || role == Some("decompression")
    {
        "rest"
    } else if role == Some("micro-surprise") {
        "viewpoint"
    } else {
        "stretch"
    }
    .to_owned()
}

fn reason_for(break_type: &str, role: Option<&str>, minutes: i64) -> String {
    match role {
        Some("decompression") => "Decompression stop after a high pass descent".to_owned(),
        Some("micro-surprise") => "Micro-surprise stop to break a long motorway run".to_owned(),
        _ => format!("{break_type} break after {minutes} minutes of accumulated driving load"),
    }
}

fn break_duration_s(break_type: &str) -> f64 {
    match break_type {
        "stretch" | "fuel" => 10.0 * 60.0,
        "coffee" | "viewpoint" => 15.0 * 60.0,
        _ => 20.0 * 60.0,
    }
}

fn cap_breaks(mut breaks: Vec<BreakStop>, max_breaks_total: usize) -> Vec<BreakStop> {
    if breaks.len() > max_breaks_total {
        let keep = breaks
            .iter()
            .enumerate()
            .map(|(index, item)| (index, item.load.total, item.t_start.clone()))
            .collect::<Vec<_>>();
        let mut keep_sorted = keep;
        keep_sorted.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.2.cmp(&b.2)));
        let keep_set = keep_sorted
            .into_iter()
            .take(max_breaks_total)
            .map(|item| item.0)
            .collect::<BTreeSet<_>>();
        breaks = breaks
            .into_iter()
            .enumerate()
            .filter_map(|(index, item)| keep_set.contains(&index).then_some(item))
            .collect();
        breaks.sort_by(|a, b| a.t_start.cmp(&b.t_start));
    }
    for (index, item) in breaks.iter_mut().enumerate() {
        item.id = format!("break-{}", index + 1);
    }
    breaks
}

fn corridor_poi_density(
    pois: &[BreakPoiInput],
    segment: &Segment,
    graph: &LeisureGraph,
    distance_km: f64,
) -> f64 {
    if pois.is_empty() {
        return 0.0;
    }
    let points = segment
        .edges
        .iter()
        .flat_map(|edge| {
            [
                node_by_id(graph, edge.from.as_str()),
                node_by_id(graph, edge.to.as_str()),
            ]
        })
        .flatten()
        .collect::<Vec<_>>();
    let mut count = 0usize;
    for poi in pois {
        if has_coord(poi.lat, poi.lon)
            && points.iter().any(|route_point| {
                haversine_m(poi.lat, poi.lon, route_point.lat, route_point.lon) <= CORRIDOR_RADIUS_M
            })
        {
            count += 1;
        }
    }
    count as f64 / distance_km.max(1.0)
}

fn edge_curvature_density(graph: &LeisureGraph, edge: &Edge, distance_m: f64) -> f64 {
    let points = edge_points(graph, edge);
    if points.len() < 3 {
        return edge_kind_curvature(edge);
    }
    let headings = points
        .windows(2)
        .map(|pair| bearing_rad(&pair[0], &pair[1]))
        .collect::<Vec<_>>();
    let turn = headings
        .windows(2)
        .map(|pair| angle_delta(pair[0], pair[1]).abs())
        .sum::<f64>();
    edge_kind_curvature(edge).max(turn / (distance_m / 1000.0).max(0.2))
}

fn edge_straight_fraction(graph: &LeisureGraph, edge: &Edge) -> f64 {
    let points = edge_points(graph, edge);
    if points.len() < 3 {
        return if normalized_road_class(edge) == "motorway" {
            0.95
        } else {
            0.85
        };
    }
    let headings = points
        .windows(2)
        .map(|pair| bearing_rad(&pair[0], &pair[1]))
        .collect::<Vec<_>>();
    let turn = headings
        .windows(2)
        .map(|pair| angle_delta(pair[0], pair[1]).abs())
        .sum::<f64>();
    clamp01(1.0 - (turn / std::f64::consts::PI).min(1.0))
}

fn edge_kind_curvature(edge: &Edge) -> f64 {
    if edge.kind == EdgeKind::PassClimb || normalized_road_class(edge) == "mountain" {
        0.7
    } else if normalized_road_class(edge) == "motorway" {
        0.05
    } else {
        0.1
    }
}

fn edge_elevation_gain_m(graph: &LeisureGraph, edge: &Edge) -> f64 {
    let from = node_by_id(graph, edge.from.as_str());
    let to = node_by_id(graph, edge.to.as_str());
    let direct =
        to.and_then(|to| to.elev).unwrap_or(0.0) - from.and_then(|from| from.elev).unwrap_or(0.0);
    if direct.is_finite() && direct > 0.0 {
        return direct;
    }
    if edge.kind == EdgeKind::PassClimb && edge.to.as_str().ends_with(":S") {
        let summit = summit_elevation(graph, edge);
        if summit.is_finite() {
            return (summit - 1000.0).max(300.0);
        }
    }
    0.0
}

fn is_high_pass_climax(graph: &LeisureGraph, edge: &Edge) -> bool {
    let to = node_by_id(graph, edge.to.as_str());
    let elev = to
        .and_then(|node| node.elev)
        .unwrap_or_else(|| summit_elevation(graph, edge));
    elev.is_finite()
        && elev > 1500.0
        && (edge.kind == EdgeKind::PassClimb || edge.to.as_str().ends_with(":S"))
}

fn summit_elevation(graph: &LeisureGraph, edge: &Edge) -> f64 {
    let pass_id = edge
        .pass_id
        .as_ref()
        .map(ToString::to_string)
        .or_else(|| edge.from.as_str().split(':').next().map(str::to_owned))
        .unwrap_or_default();
    node_by_id(graph, &pass_id)
        .and_then(|node| node.elev)
        .unwrap_or(f64::NAN)
}

fn scenic_score(graph: &LeisureGraph, edge: &Edge) -> f64 {
    let direct = normalized_score(edge.scenic_score.unwrap_or(0.0));
    if direct > 0.0 {
        return direct;
    }
    let values = [
        node_by_id(graph, edge.from.as_str()),
        node_by_id(graph, edge.to.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(|node| normalized_score(node.scenic_score.or(node.score).unwrap_or(0.0)))
    .filter(|value| *value > 0.0)
    .collect::<Vec<_>>();
    if values.is_empty() {
        0.2
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn normalized_road_class(edge: &Edge) -> String {
    let raw = edge
        .road_class
        .as_deref()
        .unwrap_or_else(|| edge.kind.as_str())
        .to_lowercase();
    if raw.contains("motorway") || raw.contains("trunk") || raw.contains("highway") {
        if raw.contains("trunk") {
            "trunk"
        } else {
            "motorway"
        }
        .to_owned()
    } else if raw.contains("pass") || raw.contains("mountain") || raw.contains("alpine") {
        "mountain".to_owned()
    } else if raw.contains("primary") {
        "primary".to_owned()
    } else if raw.contains("secondary") {
        "secondary".to_owned()
    } else {
        raw
    }
}

fn road_fraction(road_mix: &BTreeMap<String, f64>, distance_m: f64, classes: &[&str]) -> f64 {
    if distance_m <= 0.0 {
        return 0.0;
    }
    classes
        .iter()
        .map(|class| road_mix.get(*class).copied().unwrap_or(0.0))
        .sum::<f64>()
        / distance_m
}

fn edge_points(graph: &LeisureGraph, edge: &Edge) -> Vec<Point> {
    if edge.geometry.len() >= 2 {
        return edge
            .geometry
            .iter()
            .filter_map(|pair| {
                has_coord(pair[0], pair[1]).then_some(Point {
                    lat: pair[0],
                    lon: pair[1],
                })
            })
            .collect();
    }
    [
        node_by_id(graph, edge.from.as_str()),
        node_by_id(graph, edge.to.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter_map(|node| {
        has_coord(node.lat, node.lon).then_some(Point {
            lat: node.lat,
            lon: node.lon,
        })
    })
    .collect()
}

fn point_along_edge(graph: &LeisureGraph, edge: &Edge, fraction: f64) -> Option<Point> {
    let points = edge_points(graph, edge);
    if points.is_empty() {
        return None;
    }
    if points.len() == 1 {
        return points.first().cloned();
    }
    let scaled = clamp01(fraction) * (points.len() - 1) as f64;
    let index = scaled
        .floor()
        .clamp(0.0, points.len().saturating_sub(2) as f64) as usize;
    let local = scaled - index as f64;
    let a = &points[index];
    let b = &points[index + 1];
    Some(Point {
        lat: a.lat + (b.lat - a.lat) * local,
        lon: a.lon + (b.lon - a.lon) * local,
    })
}

fn edge_duration_s(edge: &Edge) -> f64 {
    edge.duration_s.max(0.0)
}

fn edge_distance_m(edge: &Edge, graph: &LeisureGraph) -> f64 {
    if edge.distance_m.is_finite() && edge.distance_m > 0.0 {
        return edge.distance_m;
    }
    let from = node_by_id(graph, edge.from.as_str());
    let to = node_by_id(graph, edge.to.as_str());
    match (from, to) {
        (Some(from), Some(to)) => haversine_m(from.lat, from.lon, to.lat, to.lon),
        _ => 0.0,
    }
}

fn total_drive_seconds(tour: &PublicTour, edges: &[Edge]) -> f64 {
    let edge_total = edges.iter().map(edge_duration_s).sum::<f64>();
    if edge_total > 0.0 {
        edge_total
    } else if tour.total_duration_h.is_finite() {
        tour.total_duration_h * 3600.0
    } else {
        0.0
    }
}

fn resolve_stop_refs(
    graph: &LeisureGraph,
    tour: &PublicTour,
    edges: &[Edge],
    options: &BreakOptions,
) -> Vec<StopRef> {
    let route_ids = edges
        .iter()
        .flat_map(|edge| [edge.from.to_string(), edge.to.to_string()])
        .collect::<BTreeSet<_>>();
    tour.stops
        .iter()
        .enumerate()
        .filter_map(|(index, stop)| {
            let direct = stop.node_id.to_string();
            let id = if route_ids.contains(&direct) {
                direct
            } else {
                nearest_route_node_id(graph, stop.lat, stop.lon, &route_ids).unwrap_or(direct)
            };
            (!id.is_empty()).then(|| StopRef {
                dwell_sec: dwell_sec_for_stop(options, stop.id.as_str(), &id, index),
                id,
            })
        })
        .collect()
}

fn nearest_route_node_id(
    graph: &LeisureGraph,
    lat: f64,
    lon: f64,
    route_ids: &BTreeSet<String>,
) -> Option<String> {
    if !has_coord(lat, lon) {
        return None;
    }
    route_ids
        .iter()
        .filter_map(|id| {
            let node = node_by_id(graph, id)?;
            has_coord(node.lat, node.lon)
                .then(|| (id.clone(), haversine_m(lat, lon, node.lat, node.lon)))
        })
        .filter(|(_, distance)| *distance <= CORRIDOR_RADIUS_M)
        .min_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
        .map(|item| item.0)
}

fn dwell_sec_for_stop(options: &BreakOptions, stop_id: &str, id: &str, index: usize) -> f64 {
    options
        .stop_dwell_sec
        .get(id)
        .or_else(|| options.stop_dwell_sec.get(stop_id))
        .or_else(|| options.stop_dwell_sec.get(&index.to_string()))
        .copied()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
}

fn poi_tokens(poi: &BreakPoiInput) -> Vec<String> {
    poi.categories
        .iter()
        .chain(poi.themes.iter())
        .flat_map(|value| value.split(','))
        .map(normalize_token)
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn has_any(tokens: &[String], choices: &[&str]) -> bool {
    let token_set = tokens.iter().map(String::as_str).collect::<BTreeSet<_>>();
    choices
        .iter()
        .any(|choice| token_set.contains(normalize_token(choice).as_str()))
}

fn normalize_token(value: &str) -> String {
    value.trim().to_lowercase().replace([' ', '_'], "-")
}

fn normalized_score(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else if value > 1.0 {
        clamp01(value / 100.0)
    } else {
        clamp01(value)
    }
}

fn node_by_id<'a>(graph: &'a LeisureGraph, id: &str) -> Option<&'a Node> {
    graph.node(&id.into())
}

fn persona_threshold(persona: &str) -> f64 {
    persona_thresholds().get(persona).copied().unwrap_or(3.5)
}

fn persona_thresholds() -> BTreeMap<&'static str, f64> {
    BTreeMap::from([
        ("default", 3.5),
        ("motorcyclist", 3.0),
        ("family", 2.5),
        ("gourmet", 4.0),
        ("photographer", 3.5),
        ("speedrunner", 6.0),
    ])
}

fn finite_number(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn triangular(value: f64, center: f64, width: f64, amplitude: f64) -> f64 {
    let distance = (value - center).abs();
    if distance >= width {
        0.0
    } else {
        amplitude * (1.0 - distance / width)
    }
}

fn bearing_rad(a: &Point, b: &Point) -> f64 {
    let lat1 = a.lat.to_radians();
    let lat2 = b.lat.to_radians();
    let d_lon = (b.lon - a.lon).to_radians();
    (d_lon.sin() * lat2.cos())
        .atan2(lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * d_lon.cos())
}

fn angle_delta(a: f64, b: f64) -> f64 {
    (b - a).sin().atan2((b - a).cos())
}

fn has_coord(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite()
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn round(value: f64, decimals: i32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let scale = 10_f64.powi(decimals);
    (value * scale).round() / scale
}

fn minutes_from_iso(value: &str) -> i32 {
    let time = value.split('T').nth(1).unwrap_or("00:00:00");
    let mut parts = time.split(':');
    let hour = parts
        .next()
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);
    let minute = parts
        .next()
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);
    hour * 60 + minute
}

impl SimpleTime {
    fn parse(value: &str) -> Self {
        let source = if value.trim().is_empty() {
            DEFAULT_START
        } else {
            value
        };
        let date = source.get(0..10).unwrap_or("2026-06-15").to_owned();
        let time = source.split('T').nth(1).unwrap_or("08:00:00");
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
