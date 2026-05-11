//! Corridor POI suggestions ported from `assets/js/leisure/corridor.js`.
//!
//! The module builds a time/distance reference for an optimizer tour, walks
//! deduplicated edge geometry, and ranks nearby POIs into auto-include,
//! suggestion, and drawer tiers.

use crate::graph::{haversine_m, LeisureGraph};
use crate::optimizer::PublicTour;
use crate::types::{Edge, EdgeKind, Node, NodeKind};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

const SIDE_ROAD_SPEED_KMH: f64 = 50.0;
const DEFAULT_TERRAIN_FACTOR: f64 = 1.4;
const PASS_CLIMB_TERRAIN_FACTOR: f64 = 1.7;
const DRAWER_MAX_DETOUR_MIN: f64 = 30.0;
const DRAWER_MIN_SCORE: f64 = 5.0;
const AVG_ROUTE_SPEED_KMH: f64 = 55.0;
const EPS: f64 = 1e-9;

#[derive(Clone, Debug, PartialEq)]
pub struct CorridorOptions {
    pub buffer_km: f64,
    pub auto_include_max_detour_min: f64,
    pub auto_include_min_score: f64,
    pub suggest_max_detour_min: f64,
    pub suggest_min_score: f64,
    pub themes: Vec<String>,
    pub personas: Vec<String>,
    pub max_auto_include_per_hour: usize,
    pub max_suggestions_total: usize,
    pub exclude_ids: BTreeSet<String>,
    pub detour_budget_min: Option<f64>,
    pub mode: CorridorMode,
}

impl Default for CorridorOptions {
    fn default() -> Self {
        Self {
            buffer_km: 5.0,
            auto_include_max_detour_min: 4.0,
            auto_include_min_score: 7.0,
            suggest_max_detour_min: 20.0,
            suggest_min_score: 6.0,
            themes: Vec::new(),
            personas: Vec::new(),
            max_auto_include_per_hour: 1,
            max_suggestions_total: 12,
            exclude_ids: BTreeSet::new(),
            detour_budget_min: None,
            mode: CorridorMode::Default,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CorridorMode {
    #[default]
    Default,
    HiddenGem,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorridorSuggestions {
    pub auto_include: Vec<CorridorItem>,
    pub suggestions: Vec<CorridorItem>,
    pub drawer: Vec<CorridorItem>,
    pub diagnostics: CorridorDiagnostics,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorridorDiagnostics {
    pub candidates_scanned: usize,
    pub corridor_poi_count: usize,
    pub soft_eligible_count: usize,
    pub route_vertex_count: usize,
    pub route_length_km: f64,
    pub auto_included_detour_sum: f64,
    pub fairness_overflow_count: usize,
    pub budget_overflow_count: usize,
    pub suggestion_overflow_count: usize,
    pub skipped_excluded: usize,
    pub buffer_km: f64,
    pub mode: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorridorItem {
    pub poi_id: String,
    pub poi_name: String,
    pub lat: f64,
    pub lon: f64,
    pub score: f64,
    pub themes: Vec<String>,
    pub categories: Vec<String>,
    pub detour_min: f64,
    pub detour_km: f64,
    pub off_route_km: f64,
    pub insertion_index: usize,
    pub reason: String,
    pub plannable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_text: Option<String>,
}

#[derive(Clone, Debug)]
struct Candidate {
    poi_id: String,
    poi_name: String,
    lat: f64,
    lon: f64,
    score: f64,
    themes: Vec<String>,
    categories: Vec<String>,
    detour_min: f64,
    detour_km: f64,
    off_route_km: f64,
    insertion_index: usize,
    bucket: i64,
    rank_score: f64,
}

#[derive(Clone, Debug)]
struct RouteReference {
    vertices: Vec<RouteVertex>,
    stop_refs: Vec<StopRef>,
    total_km: f64,
    total_duration_s: f64,
}

#[derive(Clone, Debug)]
struct RouteVertex {
    id: String,
    lat: f64,
    lon: f64,
    lat_rad: f64,
    lon_rad: f64,
    cos_lat: f64,
    index: usize,
    s: f64,
    t_sec: f64,
    on_pass_climb: bool,
}

#[derive(Clone, Debug)]
struct StopRef {
    order: usize,
    id: String,
    s: f64,
}

#[derive(Clone, Debug)]
struct RoutePoint {
    id: String,
    lat: f64,
    lon: f64,
}

#[derive(Clone, Debug)]
struct Nearest<'a> {
    vertex: &'a RouteVertex,
    distance_km: f64,
}

#[derive(Clone, Debug)]
struct FairnessResult {
    auto_include: Vec<Candidate>,
    overflow: Vec<Candidate>,
}

#[derive(Clone, Debug)]
struct BudgetResult {
    auto_include: Vec<Candidate>,
    overflow: Vec<Candidate>,
}

#[derive(Clone, Debug)]
struct RankedSuggestions {
    selected: Vec<Candidate>,
    overflow: Vec<Candidate>,
}

/// Suggests side-stop POIs near a planned route.
pub fn suggest_corridor(
    graph: &LeisureGraph,
    tour: &PublicTour,
    options: CorridorOptions,
) -> CorridorSuggestions {
    find_corridor_pois(graph, tour, options)
}

/// JS-parity alias for `findCorridorPois`.
pub fn find_corridor_pois(
    graph: &LeisureGraph,
    tour: &PublicTour,
    options: CorridorOptions,
) -> CorridorSuggestions {
    let opts = normalize_options(options);
    let reference = build_tour_reference(graph, tour);
    if reference.vertices.is_empty() {
        return empty_result(0, 0, opts.buffer_km, opts.mode);
    }

    let tour_ids = ids_in_tour(tour);
    let mut candidates = Vec::new();
    let mut candidates_scanned = 0usize;
    let mut corridor_poi_count = 0usize;
    let mut skipped_excluded = 0usize;

    let mut poi_ids = graph.nodes_of_kind(NodeKind::Poi).to_vec();
    poi_ids.sort();
    for poi_id_ref in poi_ids {
        let Some(poi) = graph.node(&poi_id_ref) else {
            continue;
        };
        candidates_scanned += 1;
        let poi_id = poi.id.to_string();
        if poi_id.is_empty() || opts.exclude_ids.contains(&poi_id) || tour_ids.contains(&poi_id) {
            skipped_excluded += 1;
            continue;
        }
        if !has_coord(poi.lat, poi.lon) {
            continue;
        }

        let Some(nearest) = nearest_tour_vertex(&reference.vertices, poi.lat, poi.lon) else {
            continue;
        };
        if nearest.distance_km > opts.buffer_km * 1.5 + EPS {
            continue;
        }
        corridor_poi_count += 1;

        let terrain_factor = if nearest.vertex.on_pass_climb {
            PASS_CLIMB_TERRAIN_FACTOR
        } else {
            DEFAULT_TERRAIN_FACTOR
        };
        let detour_km = nearest.distance_km * terrain_factor * 2.0;
        let detour_min = detour_km / SIDE_ROAD_SPEED_KMH * 60.0;
        let score = score_of(poi);
        if detour_min > DRAWER_MAX_DETOUR_MIN + EPS || score < DRAWER_MIN_SCORE {
            continue;
        }

        let categories = normalize_tokens(&poi.categories);
        let themes = normalize_tokens(&poi.themes);
        let insertion_index = insertion_index_for_s(&reference, nearest.vertex.s);
        let bucket = (nearest.vertex.t_sec / 3600.0).floor() as i64;
        let mut candidate = Candidate {
            poi_id,
            poi_name: poi.name.clone(),
            lat: poi.lat,
            lon: poi.lon,
            score,
            themes,
            categories,
            detour_min,
            detour_km,
            off_route_km: nearest.distance_km,
            insertion_index,
            bucket,
            rank_score: 0.0,
        };
        candidate.rank_score = rank_score(&candidate, &opts);
        candidates.push(candidate);
    }

    candidates.sort_by(compare_candidates);
    let mut auto_initial = Vec::new();
    let mut suggestion_initial = Vec::new();
    let mut drawer = Vec::new();

    for candidate in candidates.iter().cloned() {
        if is_auto(&candidate, &opts) {
            auto_initial.push(candidate);
        } else if is_suggestion(&candidate, &opts) {
            suggestion_initial.push(candidate);
        } else {
            drawer.push(candidate);
        }
    }

    let fairness = apply_auto_fairness(auto_initial, opts.max_auto_include_per_hour);
    let mut auto_include = fairness.auto_include;
    let mut suggestions = unique_by_poi_id(
        suggestion_initial
            .into_iter()
            .chain(fairness.overflow.iter().cloned())
            .collect(),
    );

    let budget = apply_detour_budget(auto_include, opts.detour_budget_min);
    auto_include = budget.auto_include;
    suggestions = unique_by_poi_id(
        suggestions
            .into_iter()
            .chain(budget.overflow.iter().cloned())
            .collect(),
    );

    let ranked = rank_suggestions_mmr(suggestions, opts.max_suggestions_total);
    let selected_ids = ranked
        .selected
        .iter()
        .map(|item| item.poi_id.clone())
        .collect::<BTreeSet<_>>();
    let auto_ids = auto_include
        .iter()
        .map(|item| item.poi_id.clone())
        .collect::<BTreeSet<_>>();
    let mut drawer_final = unique_by_poi_id(
        drawer
            .into_iter()
            .chain(ranked.overflow.iter().cloned())
            .filter(|item| !auto_ids.contains(&item.poi_id) && !selected_ids.contains(&item.poi_id))
            .collect(),
    );

    auto_include.sort_by(compare_route_order);
    drawer_final.sort_by(compare_candidates);
    let auto_included_detour_sum = auto_include.iter().map(|item| item.detour_min).sum::<f64>();
    let mode = opts.mode;

    CorridorSuggestions {
        auto_include: auto_include
            .iter()
            .map(|item| to_public_item(item, "auto", &opts))
            .collect(),
        suggestions: ranked
            .selected
            .iter()
            .map(|item| to_public_item(item, "suggestion", &opts))
            .collect(),
        drawer: drawer_final
            .iter()
            .map(|item| to_public_item(item, "drawer", &opts))
            .collect(),
        diagnostics: CorridorDiagnostics {
            candidates_scanned,
            corridor_poi_count,
            soft_eligible_count: candidates.len(),
            route_vertex_count: reference.vertices.len(),
            route_length_km: round(reference.total_km, 3),
            auto_included_detour_sum: round(auto_included_detour_sum, 2),
            fairness_overflow_count: fairness.overflow.len(),
            budget_overflow_count: budget.overflow.len(),
            suggestion_overflow_count: ranked.overflow.len(),
            skipped_excluded,
            buffer_km: opts.buffer_km,
            mode: mode_label(mode).to_owned(),
        },
    }
}

fn normalize_options(mut options: CorridorOptions) -> CorridorOptions {
    let defaults = CorridorOptions::default();
    if !options.buffer_km.is_finite() || options.buffer_km <= 0.0 {
        options.buffer_km = defaults.buffer_km;
    }
    if !options.auto_include_max_detour_min.is_finite() || options.auto_include_max_detour_min < 0.0
    {
        options.auto_include_max_detour_min = defaults.auto_include_max_detour_min;
    }
    if !options.auto_include_min_score.is_finite() {
        options.auto_include_min_score = defaults.auto_include_min_score;
    }
    if !options.suggest_max_detour_min.is_finite() || options.suggest_max_detour_min < 0.0 {
        options.suggest_max_detour_min = defaults.suggest_max_detour_min;
    }
    if !options.suggest_min_score.is_finite() {
        options.suggest_min_score = defaults.suggest_min_score;
    }
    options.themes = normalize_tokens(&options.themes);
    options.personas = normalize_tokens(&options.personas);
    options.detour_budget_min = options
        .detour_budget_min
        .filter(|value| value.is_finite())
        .map(|value| value.max(0.0));
    options
}

fn build_tour_reference(graph: &LeisureGraph, tour: &PublicTour) -> RouteReference {
    let mut reference = route_reference(graph, tour);
    if reference.vertices.is_empty() {
        return reference;
    }
    let declared_duration_s = duration_seconds_of(tour);
    if declared_duration_s > 0.0 && reference.total_duration_s > 0.0 {
        let scale = declared_duration_s / reference.total_duration_s;
        for vertex in &mut reference.vertices {
            vertex.t_sec *= scale;
        }
        reference.total_duration_s = declared_duration_s;
    }
    reference.stop_refs = stop_refs_for_tour(tour, &reference.vertices);
    reference
}

fn route_reference(graph: &LeisureGraph, tour: &PublicTour) -> RouteReference {
    let edges = route_edges(graph, tour);
    if !edges.is_empty() {
        return reference_from_edges(graph, &edges);
    }
    let points = tour
        .stops
        .iter()
        .filter_map(|stop| point_from_id(graph, stop.node_id.as_str()))
        .collect::<Vec<_>>();
    reference_from_points(graph, &points)
}

fn route_edges<'a>(graph: &'a LeisureGraph, tour: &PublicTour) -> Vec<&'a Edge> {
    let mut out = Vec::new();
    for raw in &tour.edges {
        if let Some(edge) = resolve_edge(graph, raw) {
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

fn resolve_edge<'a>(graph: &'a LeisureGraph, raw: &str) -> Option<&'a Edge> {
    graph
        .edge_by_id
        .get(raw)
        .or_else(|| graph.edge_by_key.get(raw))
        .and_then(|index| graph.edges.get(*index))
}

fn reference_from_edges(graph: &LeisureGraph, edges: &[&Edge]) -> RouteReference {
    let mut vertices: Vec<RouteVertex> = Vec::new();
    let mut total_km = 0.0;
    let mut total_duration_s = 0.0;
    for edge in edges {
        let Some(from) = point_from_id(graph, edge.from.as_str()) else {
            continue;
        };
        let Some(to) = point_from_id(graph, edge.to.as_str()) else {
            continue;
        };
        let distance_km = edge_distance_km(edge, &from, &to);
        let duration_s = edge_duration_s(edge, distance_km);
        let line = expanded_line(edge, &from, &to);
        let line_km = line_length_km(&line);
        let on_pass = edge.kind == EdgeKind::PassClimb;
        if on_pass && !vertices.is_empty() {
            if let Some(last) = vertices.last_mut() {
                last.on_pass_climb = true;
            }
        }
        if vertices.is_empty() {
            vertices.push(make_vertex(
                &line[0],
                0,
                total_km,
                total_duration_s,
                on_pass,
            ));
        } else if vertices
            .last()
            .is_some_and(|last: &RouteVertex| last.id != from.id)
        {
            vertices.push(make_vertex(
                &from,
                vertices.len(),
                total_km,
                total_duration_s,
                on_pass,
            ));
        }
        let mut traversed_km = 0.0;
        for i in 1..line.len() {
            traversed_km +=
                haversine_m(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon) / 1000.0;
            let ratio = if line_km > EPS {
                (traversed_km / line_km).clamp(0.0, 1.0)
            } else {
                i as f64 / (line.len().saturating_sub(1).max(1)) as f64
            };
            vertices.push(make_vertex(
                &line[i],
                vertices.len(),
                total_km + distance_km * ratio,
                total_duration_s + duration_s * ratio,
                on_pass,
            ));
        }
        total_km += distance_km;
        total_duration_s += duration_s;
        if let Some(last) = vertices.last_mut() {
            last.s = total_km;
            last.t_sec = total_duration_s;
        }
    }
    RouteReference {
        vertices,
        stop_refs: Vec::new(),
        total_km,
        total_duration_s,
    }
}

fn reference_from_points(graph: &LeisureGraph, points: &[RoutePoint]) -> RouteReference {
    if points.is_empty() {
        return RouteReference {
            vertices: Vec::new(),
            stop_refs: Vec::new(),
            total_km: 0.0,
            total_duration_s: 0.0,
        };
    }
    let mut total_km = 0.0;
    let mut total_duration_s = 0.0;
    let mut vertices = vec![make_vertex(&points[0], 0, 0.0, 0.0, false)];
    for i in 1..points.len() {
        let previous = &points[i - 1];
        let current = &points[i];
        let edge = graph.edge_between(&previous.id.as_str().into(), &current.id.as_str().into());
        let distance_km = edge
            .map(|edge| edge_distance_km(edge, previous, current))
            .unwrap_or_else(|| {
                haversine_m(previous.lat, previous.lon, current.lat, current.lon) / 1000.0
            });
        let duration_s = edge
            .map(|edge| edge_duration_s(edge, distance_km))
            .unwrap_or_else(|| distance_km / AVG_ROUTE_SPEED_KMH * 3600.0);
        let on_pass = edge.is_some_and(|edge| edge.kind == EdgeKind::PassClimb);
        if on_pass {
            if let Some(last) = vertices.last_mut() {
                last.on_pass_climb = true;
            }
        }
        let line = if let Some(edge) = edge {
            expanded_line(edge, previous, current)
        } else {
            vec![previous.clone(), current.clone()]
        };
        let line_km = line_length_km(&line);
        let mut traversed_km = 0.0;
        for j in 1..line.len() {
            traversed_km +=
                haversine_m(line[j - 1].lat, line[j - 1].lon, line[j].lat, line[j].lon) / 1000.0;
            let ratio = if line_km > EPS {
                (traversed_km / line_km).clamp(0.0, 1.0)
            } else {
                j as f64 / (line.len().saturating_sub(1).max(1)) as f64
            };
            vertices.push(make_vertex(
                &line[j],
                vertices.len(),
                total_km + distance_km * ratio,
                total_duration_s + duration_s * ratio,
                on_pass,
            ));
        }
        total_km += distance_km;
        total_duration_s += duration_s;
        if let Some(last) = vertices.last_mut() {
            last.s = total_km;
            last.t_sec = total_duration_s;
        }
    }
    RouteReference {
        vertices,
        stop_refs: Vec::new(),
        total_km,
        total_duration_s,
    }
}

fn point_from_id(graph: &LeisureGraph, id: &str) -> Option<RoutePoint> {
    let node = graph.node(&id.into())?;
    has_coord(node.lat, node.lon).then(|| RoutePoint {
        id: node.id.to_string(),
        lat: node.lat,
        lon: node.lon,
    })
}

fn expanded_line(edge: &Edge, from: &RoutePoint, to: &RoutePoint) -> Vec<RoutePoint> {
    let mut raw = Vec::with_capacity(edge.geometry.len() + 2);
    raw.push(from.clone());
    for (index, point) in edge.geometry.iter().enumerate() {
        let id = format!("{}:g{index}", edge.canonical_id());
        raw.push(RoutePoint {
            id,
            lat: point[0],
            lon: point[1],
        });
    }
    raw.push(to.clone());
    let mut filtered: Vec<RoutePoint> = Vec::new();
    for point in raw {
        if !has_coord(point.lat, point.lon) {
            continue;
        }
        let keep = filtered.last().map_or(true, |last| {
            haversine_m(last.lat, last.lon, point.lat, point.lon) > 1.0
        });
        if keep {
            filtered.push(point);
        }
    }
    if filtered.len() < 2 {
        return vec![from.clone(), to.clone()];
    }
    filtered
}

fn edge_distance_km(edge: &Edge, from: &RoutePoint, to: &RoutePoint) -> f64 {
    if edge.distance_m.is_finite() && edge.distance_m > 0.0 {
        edge.distance_m / 1000.0
    } else {
        haversine_m(from.lat, from.lon, to.lat, to.lon) / 1000.0
    }
}

fn edge_duration_s(edge: &Edge, distance_km: f64) -> f64 {
    if edge.duration_s.is_finite() && edge.duration_s > 0.0 {
        edge.duration_s
    } else {
        distance_km / AVG_ROUTE_SPEED_KMH * 3600.0
    }
}

fn line_length_km(line: &[RoutePoint]) -> f64 {
    line.windows(2)
        .map(|pair| haversine_m(pair[0].lat, pair[0].lon, pair[1].lat, pair[1].lon) / 1000.0)
        .filter(|value| value.is_finite())
        .sum()
}

fn make_vertex(
    point: &RoutePoint,
    index: usize,
    s: f64,
    t_sec: f64,
    on_pass_climb: bool,
) -> RouteVertex {
    let lat_rad = point.lat.to_radians();
    let lon_rad = point.lon.to_radians();
    RouteVertex {
        id: point.id.clone(),
        lat: point.lat,
        lon: point.lon,
        lat_rad,
        lon_rad,
        cos_lat: lat_rad.cos(),
        index,
        s,
        t_sec,
        on_pass_climb,
    }
}

fn stop_refs_for_tour(tour: &PublicTour, vertices: &[RouteVertex]) -> Vec<StopRef> {
    let mut refs = Vec::new();
    let mut start_index = 0usize;
    for (order, stop) in tour.stops.iter().enumerate() {
        let id = stop.node_id.to_string();
        if let Some((found, vertex)) = vertices
            .iter()
            .enumerate()
            .skip(start_index)
            .find(|(_, vertex)| vertex.id == id)
        {
            refs.push(StopRef {
                order,
                id,
                s: vertex.s,
            });
            start_index = found + 1;
        }
    }
    refs
}

fn insertion_index_for_s(reference: &RouteReference, s: f64) -> usize {
    let stop_refs = &reference.stop_refs;
    if stop_refs.is_empty() {
        return 0;
    }
    let mut insertion_index = 1usize;
    for stop_ref in stop_refs {
        if stop_ref.s <= s + EPS {
            insertion_index = stop_ref.order + 1;
        } else {
            break;
        }
    }
    let closed = stop_refs.len() > 1
        && stop_refs
            .first()
            .zip(stop_refs.last())
            .is_some_and(|(first, last)| !first.id.is_empty() && first.id == last.id);
    insertion_index.min(
        (if closed {
            stop_refs.len().saturating_sub(1)
        } else {
            stop_refs.len()
        })
        .max(1),
    )
}

fn ids_in_tour(tour: &PublicTour) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for stop in &tour.stops {
        ids.insert(stop.id.clone());
        ids.insert(stop.node_id.to_string());
        if let Some(pass_id) = &stop.pass_id {
            ids.insert(pass_id.clone());
        }
    }
    ids
}

fn nearest_tour_vertex(vertices: &[RouteVertex], lat: f64, lon: f64) -> Option<Nearest<'_>> {
    if !has_coord(lat, lon) {
        return None;
    }
    let lat_rad = lat.to_radians();
    let lon_rad = lon.to_radians();
    let cos_lat = lat_rad.cos();
    let mut best_approx = f64::INFINITY;
    let mut best_vertex: Option<&RouteVertex> = None;
    for candidate in vertices {
        let candidate_approx =
            ((candidate.lon - lon) * cos_lat).powi(2) + (candidate.lat - lat).powi(2);
        let replace = candidate_approx < best_approx - EPS
            || ((candidate_approx - best_approx).abs() <= EPS
                && best_vertex.map_or(true, |best| candidate.index < best.index));
        if replace {
            best_approx = candidate_approx;
            best_vertex = Some(candidate);
        }
    }
    let vertex = best_vertex?;
    let h = ((vertex.lat_rad - lat_rad) / 2.0).sin().powi(2)
        + cos_lat * vertex.cos_lat * ((vertex.lon_rad - lon_rad) / 2.0).sin().powi(2);
    Some(Nearest {
        vertex,
        distance_km: 2.0 * 6_371.0 * h.sqrt().min(1.0).asin(),
    })
}

fn apply_auto_fairness(candidates: Vec<Candidate>, cap_per_hour: usize) -> FairnessResult {
    if cap_per_hour == 0 {
        let mut overflow = candidates;
        overflow.sort_by(compare_candidates);
        return FairnessResult {
            auto_include: Vec::new(),
            overflow,
        };
    }
    let mut sorted = candidates;
    sorted.sort_by(compare_candidates);
    let mut counts: BTreeMap<i64, usize> = BTreeMap::new();
    let mut auto_include = Vec::new();
    let mut overflow = Vec::new();
    for candidate in sorted {
        let count = counts.get(&candidate.bucket).copied().unwrap_or(0);
        if count < cap_per_hour {
            counts.insert(candidate.bucket, count + 1);
            auto_include.push(candidate);
        } else {
            overflow.push(candidate);
        }
    }
    FairnessResult {
        auto_include,
        overflow,
    }
}

fn apply_detour_budget(candidates: Vec<Candidate>, budget_min: Option<f64>) -> BudgetResult {
    let Some(budget_min) = budget_min else {
        return BudgetResult {
            auto_include: candidates,
            overflow: Vec::new(),
        };
    };
    let mut sorted = candidates;
    sorted.sort_by(compare_candidates);
    let mut auto_include = Vec::new();
    let mut overflow = Vec::new();
    let mut used = 0.0;
    for candidate in sorted {
        if used + candidate.detour_min <= budget_min + EPS {
            used += candidate.detour_min;
            auto_include.push(candidate);
        } else {
            overflow.push(candidate);
        }
    }
    BudgetResult {
        auto_include,
        overflow,
    }
}

fn rank_suggestions_mmr(candidates: Vec<Candidate>, max_suggestions: usize) -> RankedSuggestions {
    let mut pool = unique_by_poi_id(candidates);
    pool.sort_by(compare_candidates);
    let mut selected = Vec::new();
    while !pool.is_empty() && selected.len() < max_suggestions {
        let mut best_index = 0usize;
        let mut best_score = f64::NEG_INFINITY;
        for (index, candidate) in pool.iter().enumerate() {
            let score = candidate.rank_score - category_similarity(candidate, &selected) * 2.5;
            let replace = score > best_score + EPS
                || ((score - best_score).abs() <= EPS
                    && compare_candidates(candidate, &pool[best_index]) == Ordering::Less);
            if replace {
                best_score = score;
                best_index = index;
            }
        }
        selected.push(pool.remove(best_index));
    }
    pool.sort_by(compare_candidates);
    RankedSuggestions {
        selected,
        overflow: pool,
    }
}

fn category_similarity(candidate: &Candidate, selected: &[Candidate]) -> f64 {
    if selected.is_empty() || candidate.categories.is_empty() {
        return 0.0;
    }
    let mut max_similarity: f64 = 0.0;
    for item in selected {
        let union = candidate
            .categories
            .iter()
            .chain(item.categories.iter())
            .cloned()
            .collect::<BTreeSet<_>>();
        if union.is_empty() {
            continue;
        }
        let overlap = candidate
            .categories
            .iter()
            .filter(|category| item.categories.contains(category))
            .count();
        max_similarity = max_similarity.max(overlap as f64 / union.len() as f64);
    }
    max_similarity
}

fn rank_score(candidate: &Candidate, opts: &CorridorOptions) -> f64 {
    let mut value = candidate.score;
    if opts.mode == CorridorMode::HiddenGem {
        let popularity = candidate.categories.len().max(1) as f64;
        value /= (popularity + 1.0).ln();
        if candidate.themes.iter().any(|theme| theme == "hidden-gem") {
            value *= 1.2;
        }
    }
    let theme_tokens = normalize_tokens(&opts.themes);
    let persona_tokens = normalize_tokens(&opts.personas);
    let persona_theme_tokens = normalize_tokens(
        &persona_tokens
            .iter()
            .flat_map(|persona| {
                persona_themes(persona)
                    .iter()
                    .map(|theme| (*theme).to_owned())
            })
            .collect::<Vec<_>>(),
    );
    let theme_hits = count_overlap(&candidate.themes, &theme_tokens)
        + count_overlap(&candidate.categories, &theme_tokens);
    let persona_hits = count_overlap(&candidate.themes, &persona_theme_tokens)
        + count_overlap(&candidate.categories, &persona_theme_tokens)
        + count_overlap(&candidate.categories, &persona_tokens);
    value + theme_hits as f64 * 2.0 + persona_hits as f64 * 1.2 - candidate.detour_min * 0.03
}

fn is_auto(candidate: &Candidate, opts: &CorridorOptions) -> bool {
    candidate.detour_min <= opts.auto_include_max_detour_min + EPS
        && candidate.score >= opts.auto_include_min_score
}

fn is_suggestion(candidate: &Candidate, opts: &CorridorOptions) -> bool {
    candidate.detour_min <= opts.suggest_max_detour_min + EPS
        && candidate.score >= opts.suggest_min_score
}

fn to_public_item(candidate: &Candidate, tier: &str, opts: &CorridorOptions) -> CorridorItem {
    let reason = reason_for(candidate, tier, opts);
    let plannable = tier != "drawer";
    CorridorItem {
        poi_id: candidate.poi_id.clone(),
        poi_name: candidate.poi_name.clone(),
        lat: candidate.lat,
        lon: candidate.lon,
        score: round(candidate.score, 2),
        themes: candidate.themes.clone(),
        categories: candidate.categories.clone(),
        detour_min: round(candidate.detour_min, 1),
        detour_km: round(candidate.detour_km, 2),
        off_route_km: round(candidate.off_route_km, 3),
        insertion_index: candidate.insertion_index,
        reason: reason.clone(),
        plannable,
        render_text: (!plannable).then_some(reason),
    }
}

fn reason_for(candidate: &Candidate, tier: &str, opts: &CorridorOptions) -> String {
    let label = human_label(
        candidate
            .categories
            .first()
            .or_else(|| candidate.themes.first())
            .map(String::as_str)
            .unwrap_or("stop"),
    );
    if opts.mode == CorridorMode::HiddenGem
        && (candidate.categories.len() <= 1
            || candidate.themes.iter().any(|theme| theme == "hidden-gem"))
    {
        return format!(
            "Hidden gem: {} km off-route",
            format_number(candidate.off_route_km, 1)
        );
    }
    match tier {
        "auto" => format!(
            "Auto: {} min round-trip detour, score {} {label}",
            candidate.detour_min.round() as i64,
            format_number(candidate.score, 1)
        ),
        "suggestion" => format!(
            "Suggest: {} min round-trip detour {label}",
            candidate.detour_min.round() as i64
        ),
        _ => format!(
            "Explore: {} min round-trip detour {label}",
            candidate.detour_min.round() as i64
        ),
    }
}

fn compare_candidates(a: &Candidate, b: &Candidate) -> Ordering {
    b.rank_score
        .total_cmp(&a.rank_score)
        .then_with(|| b.score.total_cmp(&a.score))
        .then_with(|| a.detour_min.total_cmp(&b.detour_min))
        .then_with(|| a.insertion_index.cmp(&b.insertion_index))
        .then_with(|| a.poi_id.cmp(&b.poi_id))
}

fn compare_route_order(a: &Candidate, b: &Candidate) -> Ordering {
    a.insertion_index
        .cmp(&b.insertion_index)
        .then_with(|| a.detour_min.total_cmp(&b.detour_min))
        .then_with(|| b.rank_score.total_cmp(&a.rank_score))
        .then_with(|| a.poi_id.cmp(&b.poi_id))
}

fn unique_by_poi_id(items: Vec<Candidate>) -> Vec<Candidate> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert(item.poi_id.clone()) {
            out.push(item);
        }
    }
    out
}

fn score_of(poi: &Node) -> f64 {
    poi.score.or(poi.scenic_score).unwrap_or(0.0)
}

fn normalize_tokens(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn count_overlap(a: &[String], b: &[String]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let set = b.iter().collect::<BTreeSet<_>>();
    a.iter().filter(|item| set.contains(item)).count()
}

fn duration_seconds_of(tour: &PublicTour) -> f64 {
    if tour.total_duration_h.is_finite() && tour.total_duration_h > 0.0 {
        tour.total_duration_h * 3600.0
    } else {
        0.0
    }
}

fn has_coord(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite()
}

fn human_label(value: &str) -> String {
    value.replace('-', " ")
}

fn format_number(value: f64, digits: i32) -> String {
    format!("{:.*}", digits.max(0) as usize, round(value, digits))
}

fn round(value: f64, digits: i32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let factor = 10_f64.powi(digits);
    ((value + f64::EPSILON) * factor).round() / factor
}

fn persona_themes(persona: &str) -> &'static [&'static str] {
    match persona {
        "scenic" => &[
            "viewpoint-panorama",
            "mountain-summit",
            "alpine-lake",
            "glacier",
            "waterfall-gorge",
            "national-park",
            "panoramic-view",
            "viewpoints",
            "high-alpine",
        ],
        "photographer" => &[
            "viewpoint-panorama",
            "mountain-summit",
            "alpine-lake",
            "glacier",
            "panoramic-view",
            "photogenic",
            "viewpoints",
        ],
        "driver" => &[
            "drivers-road",
            "alpine-pass",
            "mountain-summit",
            "viewpoint-panorama",
            "bridge-engineering",
            "special-experience",
            "high-alpine",
        ],
        "touring" => &[
            "drivers-road",
            "viewpoint-panorama",
            "old-town",
            "castle-fortress",
            "monastery-church",
            "museum-cultural",
            "scenic-railway",
            "village",
            "historic",
        ],
        "family" => &[
            "alpine-lake",
            "village",
            "old-town",
            "castle-fortress",
            "museum-cultural",
            "special-experience",
            "scenic-railway",
            "family-friendly",
        ],
        "hiker" => &[
            "glacier",
            "alpine-lake",
            "national-park",
            "mountain-summit",
            "waterfall-gorge",
            "viewpoint-panorama",
            "hike-required",
        ],
        "food" => &["food-drink", "cafe-bistro", "restaurant-cafe"],
        _ => &[],
    }
}

fn mode_label(mode: CorridorMode) -> &'static str {
    match mode {
        CorridorMode::Default => "default",
        CorridorMode::HiddenGem => "hidden-gem",
    }
}

fn empty_result(
    route_vertex_count: usize,
    candidates_scanned: usize,
    buffer_km: f64,
    mode: CorridorMode,
) -> CorridorSuggestions {
    CorridorSuggestions {
        auto_include: Vec::new(),
        suggestions: Vec::new(),
        drawer: Vec::new(),
        diagnostics: CorridorDiagnostics {
            candidates_scanned,
            corridor_poi_count: 0,
            soft_eligible_count: 0,
            route_vertex_count,
            route_length_km: 0.0,
            auto_included_detour_sum: 0.0,
            fairness_overflow_count: 0,
            budget_overflow_count: 0,
            suggestion_overflow_count: 0,
            skipped_excluded: 0,
            buffer_km,
            mode: mode_label(mode).to_owned(),
        },
    }
}
