//! Tour DTO mapping helpers — Rust port of the pure-data layer of
//! `assets/js/leisure/lib/ui-translation.js` (stop mapping, mode/path
//! derivation, ID resolution, DTO normalization).
//!
//! See `crates/leisure-core/architecture.md` (F2) for the contract and the
//! ADRs (F2-001..F2-008) for the deliberate behavior choices.
//!
//! All functions return owned values; functions needing graph indexes accept
//! `&LeisureGraph`. The frozen `Ui*` types in `crate::types` are not modified.

use crate::graph::{haversine_m, LeisureGraph};
use crate::types::{
    Node, NodeId, NodeKind, Point, UiBreakItem, UiCorridorItem, UiEndpointStop, UiMode,
    UiPassStop, UiPoiStop, UiPoint, UiTourStop,
};

/// Maximum number of OSRM waypoints; mirrors `MAX_OSRM_WAYPOINTS` in
/// `assets/js/leisure/lib/ui-translation.js`.
pub const MAX_OSRM_WAYPOINTS: usize = 80;

// ===========================================================================
// PlannerStopInput — loose bag-of-optionals mirroring the JS optimizer-stop
// shape (see ADR-F2-004).
// ===========================================================================

/// Loose, JS-shaped optimizer stop input. Fields mirror the union of keys the
/// JS code reads off `stop.*`. Most callers populate only a small subset.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlannerStopInput {
    /// Optional discriminator: "pass" | "poi" | "start" | "end" | "return" |
    /// other. JS dispatches on `kind` or presence of `pass_id`.
    pub kind: Option<String>,
    pub id: Option<String>,
    /// POI node-id hint, used in preference to `id` for POI lookup.
    pub node_id: Option<String>,
    pub pass_id: Option<String>,
    pub name: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub themes: Vec<String>,
    pub categories: Vec<String>,
    pub visit_dwell_sec: Option<u32>,
    /// JS bookkeeping flag: stops with `return_to_start = true` are filtered
    /// out by `display_stops`.
    pub return_to_start: bool,
}

// ===========================================================================
// Endpoint / selection sum types.
// ===========================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointKind {
    Start,
    End,
}

impl EndpointKind {
    fn default_name(self) -> &'static str {
        match self {
            Self::Start => "Start",
            Self::End => "End",
        }
    }
}

/// Open-tour end-node descriptor: either a graph node id or an inline point.
#[derive(Clone, Copy, Debug)]
pub enum EndNode<'a> {
    Id(&'a str),
    Point(&'a UiPoint),
}

/// Selection input for `resolve_selected_stop_id`: a raw id string, or a
/// POI-shaped object carrying name + coordinates for fallback lookup.
#[derive(Clone, Copy, Debug)]
pub enum SelectedStop<'a> {
    Id(&'a str),
    PoiNamed {
        id: Option<&'a str>,
        name: &'a str,
        lat: f64,
        lon: f64,
    },
}

// ===========================================================================
// Stop mapping
// ===========================================================================

/// Map a planner optimizer stop into a UI tour stop, dispatching on `kind` /
/// `pass_id` (mirrors JS `mapLeisureStop`).
///
/// Returns `None` for stops that would map to a bare endpoint without enough
/// data to build one (i.e. neither pass-id, kind=poi, nor a usable id).
pub fn map_leisure_stop(stop: &PlannerStopInput, graph: &LeisureGraph) -> Option<UiTourStop> {
    match stop.kind.as_deref() {
        Some("poi") => Some(UiTourStop::Poi(map_poi_stop(stop, graph))),
        Some("pass") => Some(UiTourStop::Pass(map_pass_stop(stop, graph))),
        _ => {
            if stop.pass_id.is_some() {
                Some(UiTourStop::Pass(map_pass_stop(stop, graph)))
            } else {
                // JS `uiPoint(stop)` returns a bare {id,name,kind,lat,lon}.
                // The closest frozen analog is an endpoint stop. Build one if
                // we have any usable coordinates.
                let lat = stop.lat?;
                let lon = stop.lon?;
                Some(UiTourStop::Endpoint(UiEndpointStop {
                    id: stop.id.clone(),
                    name: stop.name.clone(),
                    lat,
                    lon,
                    is_endpoint: true,
                }))
            }
        }
    }
}

/// Map a pass optimizer stop into a UI pass stop (JS `mapPassStop`).
///
/// When the requested pass is unknown, falls back to stop-supplied
/// `lat/lon/name` so the DTO is still well-formed (per pre-mortem item 3).
pub fn map_pass_stop(stop: &PlannerStopInput, graph: &LeisureGraph) -> UiPassStop {
    let pass_id = stop
        .pass_id
        .as_deref()
        .or(stop.id.as_deref())
        .unwrap_or("")
        .to_owned();

    let sides = if pass_id.is_empty() {
        None
    } else {
        graph.pass_sides_for(&pass_id)
    };

    let pass_node = sides
        .as_ref()
        .and_then(|s| s.pass.as_ref())
        .and_then(|id| graph.nodes.get(id))
        .or_else(|| graph.nodes.get(&NodeId::from(pass_id.as_str())));

    let summit_node = sides
        .as_ref()
        .and_then(|s| s.summit.as_ref())
        .and_then(|id| graph.nodes.get(id))
        .or_else(|| graph.nodes.get(&NodeId::from(format!("{pass_id}:S").as_str())));

    let base_a_node = sides
        .as_ref()
        .and_then(|s| s.a.as_ref())
        .and_then(|id| graph.nodes.get(id))
        .or_else(|| graph.nodes.get(&NodeId::from(format!("{pass_id}:A").as_str())));

    let base_b_node = sides
        .as_ref()
        .and_then(|s| s.b.as_ref())
        .and_then(|id| graph.nodes.get(id))
        .or_else(|| graph.nodes.get(&NodeId::from(format!("{pass_id}:B").as_str())));

    let name = pass_node
        .map(|n| n.name.clone())
        .or_else(|| stop.name.clone())
        .unwrap_or_else(|| pass_id.clone());

    let lat = first_finite([
        pass_node.map(|n| n.lat),
        summit_node.map(|n| n.lat),
        stop.lat,
    ])
    .unwrap_or(f64::NAN);
    let lon = first_finite([
        pass_node.map(|n| n.lon),
        summit_node.map(|n| n.lon),
        stop.lon,
    ])
    .unwrap_or(f64::NAN);

    let elev = pass_node.and_then(|n| n.elev).or_else(|| summit_node.and_then(|n| n.elev));

    let q = pass_node.map(quality_of_node).unwrap_or(0.0);

    let themes = pass_node
        .map(|n| n.themes.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| stop.themes.clone());

    let viewpoints = pass_node.map(|n| n.viewpoints.clone()).unwrap_or_default();

    let summit_parking = pass_node
        .and_then(|n| n.summit_parking.as_ref())
        .map(|p| ui_point_from_point(p, None, p.name.as_deref()))
        .or_else(|| summit_node.map(ui_point_from_node));

    UiPassStop {
        id: pass_id,
        name,
        lat,
        lon,
        elev,
        quality: q,
        q_scenic: q,
        q_summit: q,
        q_approach: q,
        scenic_score: q,
        themes,
        viewpoints,
        base_a: base_a_node.map(ui_point_from_node),
        base_b: base_b_node.map(ui_point_from_node),
        summit_parking,
    }
}

/// Map a POI optimizer stop into a UI POI stop (JS `mapPoiStop`).
pub fn map_poi_stop(stop: &PlannerStopInput, graph: &LeisureGraph) -> UiPoiStop {
    // JS: graph.nodes.get(stop.nodeId || stop.id) || matchPoiByName(stop, graph) || stop.
    let node = stop
        .node_id
        .as_deref()
        .or(stop.id.as_deref())
        .and_then(|id| graph.nodes.get(&NodeId::from(id)))
        .or_else(|| {
            let name = stop.name.as_deref()?;
            let lat = stop.lat.unwrap_or(f64::NAN);
            let lon = stop.lon.unwrap_or(f64::NAN);
            match_poi_by_name(name, lat, lon, graph)
        });

    let dwell = node
        .and_then(|n| n.visit_dwell_sec)
        .or(stop.visit_dwell_sec)
        .unwrap_or(0);
    let dwell_h = round_hours(f64::from(dwell) / 3600.0);

    let categories = node
        .map(|n| n.categories.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| stop.categories.clone());

    let id = node
        .map(|n| n.id.to_string())
        .or_else(|| stop.id.clone())
        .unwrap_or_default();

    let name = node
        .map(|n| n.name.clone())
        .or_else(|| stop.name.clone())
        .or_else(|| Some(id.clone()))
        .unwrap_or_default();

    let lat = node.map(|n| n.lat).or(stop.lat).unwrap_or(f64::NAN);
    let lon = node.map(|n| n.lon).or(stop.lon).unwrap_or(f64::NAN);

    let poi_category = categories
        .first()
        .cloned()
        .unwrap_or_else(|| "sight".to_owned());

    let poi_themes = node
        .map(|n| n.themes.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| stop.themes.clone());

    let q = node.map(quality_of_node).unwrap_or(0.0);

    UiPoiStop {
        id,
        name,
        lat,
        lon,
        is_poi: true,
        visit_dwell_sec: dwell,
        dwell_min: ((f64::from(dwell) / 60.0).round()) as u32,
        dwell_h,
        poi_category,
        poi_themes,
        quality: q,
        scenic_score: q,
    }
}

/// Build a UI endpoint sentinel stop from a UI point.
///
/// Mirrors JS `endpointStop`: returns `Some` whenever a point is provided
/// (lat/lon may be `NaN` if the source `UiPoint::Id` carries no coordinates).
pub fn endpoint_stop(point: &UiPoint, kind: EndpointKind) -> Option<UiEndpointStop> {
    let (id, name, lat, lon) = match point {
        UiPoint::Id(s) => (Some(s.clone()), Some(s.clone()), f64::NAN, f64::NAN),
        UiPoint::Coord { lat, lon, name } => (None, name.clone(), *lat, *lon),
    };
    let resolved_name = name.or_else(|| id.clone()).unwrap_or_else(|| kind.default_name().to_owned());
    Some(UiEndpointStop {
        id,
        name: Some(resolved_name),
        lat,
        lon,
        is_endpoint: true,
    })
}

/// Build a UI endpoint stop from an end-node id or inline point (JS
/// `endpointStopForEndNode`).
pub fn endpoint_stop_for_end_node(
    end_node: &EndNode<'_>,
    graph: &LeisureGraph,
) -> Option<UiEndpointStop> {
    match end_node {
        EndNode::Id(s) => match graph.nodes.get(&NodeId::from(*s)) {
            Some(node) => {
                let pt = ui_point_from_node(node);
                endpoint_stop(&pt, EndpointKind::End)
            }
            None => Some(UiEndpointStop {
                id: Some((*s).to_owned()),
                name: Some((*s).to_owned()),
                lat: f64::NAN,
                lon: f64::NAN,
                is_endpoint: true,
            }),
        },
        EndNode::Point(p) => endpoint_stop(p, EndpointKind::End),
    }
}

/// Compare two UI tour stops by id, then by ~1e-6° coordinate epsilon
/// (~0.11 m). See ADR-F2-007.
pub fn same_stop(a: &UiTourStop, b: &UiTourStop) -> bool {
    let (id_a, lat_a, lon_a) = stop_identity(a);
    let (id_b, lat_b, lon_b) = stop_identity(b);
    if let (Some(ia), Some(ib)) = (id_a, id_b) {
        if !ia.is_empty() && ia == ib {
            return true;
        }
    }
    (lat_a - lat_b).abs() < 1e-6 && (lon_a - lon_b).abs() < 1e-6
}

/// Filter optimizer bookkeeping stops out of the UI stop list (JS
/// `displayStops`). Returns borrowed references to the surviving inputs.
pub fn display_stops(stops: &[PlannerStopInput]) -> Vec<&PlannerStopInput> {
    stops
        .iter()
        .filter(|s| {
            if s.return_to_start {
                return false;
            }
            !matches!(s.kind.as_deref(), Some("start") | Some("end") | Some("return"))
        })
        .collect()
}

/// Add start/end sentinels for open A-to-B tours (JS `openRouteTourStops`).
///
/// `is_closed_tour` is supplied by the caller because closed-tour detection
/// requires optimizer fields (`tour.endNode`, `stops[*].returnToStart`) that
/// live outside the F2 surface.
pub fn open_route_tour_stops(
    planner_stops: Vec<UiTourStop>,
    start: &UiPoint,
    end_node: Option<EndNode<'_>>,
    is_closed_tour: bool,
    graph: &LeisureGraph,
) -> Vec<UiTourStop> {
    if is_closed_tour {
        return planner_stops;
    }
    let mut out: Vec<UiTourStop> = Vec::with_capacity(planner_stops.len() + 2);
    if let Some(start_stop) = endpoint_stop(start, EndpointKind::Start).map(UiTourStop::Endpoint) {
        let same_as_first = planner_stops.first().map(|s| same_stop(s, &start_stop)).unwrap_or(false);
        if !same_as_first {
            out.push(start_stop);
        }
    }
    out.extend(planner_stops);
    if let Some(end_stop) = end_node
        .as_ref()
        .and_then(|en| endpoint_stop_for_end_node(en, graph))
        .map(UiTourStop::Endpoint)
    {
        let same_as_last = out.last().map(|s| same_stop(s, &end_stop)).unwrap_or(false);
        if !same_as_last {
            out.push(end_stop);
        }
    }
    out
}

// ===========================================================================
// Mode / path derivation
// ===========================================================================

/// Derive UI traversal modes for tour stops from a route path (JS
/// `deriveModes`).
pub fn derive_modes(
    path: &[NodeId],
    tour_stops: &[UiTourStop],
    graph: &LeisureGraph,
) -> Vec<UiMode> {
    tour_stops
        .iter()
        .enumerate()
        .map(|(idx, stop)| {
            let pass_idx = idx as u32;
            match stop {
                UiTourStop::Poi(_) => UiMode {
                    pass_idx,
                    enter_side: 0,
                    exit_side: 0,
                    mode: "poi".to_owned(),
                },
                UiTourStop::Endpoint(_) => UiMode {
                    pass_idx,
                    enter_side: 0,
                    exit_side: 0,
                    mode: "endpoint".to_owned(),
                },
                UiTourStop::Pass(p) => {
                    let pass_id_target = p.id.as_str();
                    let mut sides: Vec<char> = Vec::new();
                    for node_id in path {
                        let mapped = graph
                            .pass_id_by_node_id
                            .get(node_id)
                            .map(NodeId::as_str)
                            .unwrap_or_else(|| node_id.as_str());
                        if mapped == pass_id_target {
                            if let Some(side) = side_suffix(node_id.as_str()) {
                                sides.push(side);
                            }
                        }
                    }
                    let enter = *sides.first().unwrap_or(&'A');
                    let exit = *sides.last().unwrap_or(&enter);
                    UiMode {
                        pass_idx,
                        enter_side: if enter == 'B' { 1 } else { 0 },
                        exit_side: if exit == 'B' { 1 } else { 0 },
                        mode: if enter != exit {
                            "traverse".to_owned()
                        } else {
                            "out-and-back".to_owned()
                        },
                    }
                }
            }
        })
        .collect()
}

/// Find path-traversed passes that are not explicit optimizer stops (JS
/// `implicitPassesFromPath`).
pub fn implicit_passes_from_path(
    path: &[NodeId],
    tour_stops: &[UiTourStop],
    graph: &LeisureGraph,
) -> Vec<UiPassStop> {
    use std::collections::HashSet;
    let explicit: HashSet<&str> = tour_stops
        .iter()
        .filter_map(|s| match s {
            UiTourStop::Pass(p) => Some(p.id.as_str()),
            _ => None,
        })
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for node_id in path {
        let Some(pass_id) = graph.pass_id_by_node_id.get(node_id) else {
            continue;
        };
        let pass_id_str = pass_id.as_str();
        if explicit.contains(pass_id_str) || !seen.insert(pass_id_str.to_owned()) {
            continue;
        }
        let stop = map_pass_stop(
            &PlannerStopInput {
                id: Some(pass_id_str.to_owned()),
                pass_id: Some(pass_id_str.to_owned()),
                kind: Some("pass".to_owned()),
                ..Default::default()
            },
            graph,
        );
        out.push(stop);
    }
    out
}

/// Derive a node path from optimizer edge ids (JS `pathFromEdges`).
///
/// Edge ids are `"<from>-><to>"`; malformed ids (no `->`, empty endpoints) are
/// skipped.
pub fn path_from_edges(edge_ids: &[String]) -> Vec<NodeId> {
    let mut path: Vec<NodeId> = Vec::new();
    for edge_id in edge_ids {
        let Some((from, to)) = edge_id.split_once("->") else {
            continue;
        };
        if from.is_empty() || to.is_empty() {
            continue;
        }
        if path.is_empty() {
            path.push(NodeId::from(from));
        }
        if path.last().map(NodeId::as_str) != Some(from) {
            path.push(NodeId::from(from));
        }
        path.push(NodeId::from(to));
    }
    path
}

/// Reduce long paths to the OSRM waypoint budget while preserving "important"
/// nodes (pass-base/pass-summit/poi). See ADR-F2-006 for divisor handling.
pub fn compressed_path(path: &[NodeId], graph: &LeisureGraph) -> Vec<NodeId> {
    if path.len() <= MAX_OSRM_WAYPOINTS {
        return path.to_vec();
    }
    let last = path.len() - 1;
    let important: Vec<NodeId> = path
        .iter()
        .enumerate()
        .filter(|(idx, node_id)| {
            if *idx == 0 || *idx == last {
                return true;
            }
            matches!(
                graph.nodes.get(*node_id).map(|n| &n.kind),
                Some(NodeKind::PassBase) | Some(NodeKind::PassSummit) | Some(NodeKind::Poi),
            )
        })
        .map(|(_, n)| n.clone())
        .collect();

    if important.len() <= MAX_OSRM_WAYPOINTS {
        return important;
    }

    let div = ((important.len() as f64) / (MAX_OSRM_WAYPOINTS as f64)).ceil() as usize;
    let div = div.max(1);
    let imp_last = important.len() - 1;
    important
        .iter()
        .enumerate()
        .filter(|(i, _)| *i == 0 || *i == imp_last || i % div == 0)
        .map(|(_, n)| n.clone())
        .collect()
}

// ===========================================================================
// ID resolution
// ===========================================================================

/// Resolve a selected UI stop to an optimizer node/pass id (JS
/// `resolveSelectedStopId`).
pub fn resolve_selected_stop_id(stop: &SelectedStop<'_>, graph: &LeisureGraph) -> Option<String> {
    match stop {
        SelectedStop::Id(s) => {
            if s.is_empty() {
                return None;
            }
            if graph_has_id(graph, s) {
                return Some((*s).to_owned());
            }
            Some((*s).to_owned())
        }
        SelectedStop::PoiNamed { id, name, lat, lon } => {
            if let Some(id_s) = id {
                if !id_s.is_empty() && graph_has_id(graph, id_s) {
                    return Some((*id_s).to_owned());
                }
            }
            // is_poi → match by name
            if let Some(node) = match_poi_by_name(name, *lat, *lon, graph) {
                return Some(node.id.to_string());
            }
            id.map(|s| s.to_owned()).filter(|s| !s.is_empty())
        }
    }
}

/// Generate the candidate id forms for a value, so callers can probe each
/// against `pass_id_by_node_id` / `pass_triplets` / `nodes` (JS
/// `passIdForms`).
pub fn pass_id_forms(value: &str) -> Vec<String> {
    let mut forms: Vec<String> = Vec::new();
    let add = |form: String, forms: &mut Vec<String>| {
        if !form.is_empty() && !forms.contains(&form) {
            forms.push(form);
        }
    };
    add(value.to_owned(), &mut forms);
    if let Some(stripped) = pass_id_from_synthetic_id(value) {
        add(stripped, &mut forms);
    }
    let snapshot = forms.clone();
    for form in snapshot {
        if let Some(stripped) = form.strip_prefix("p-") {
            add(stripped.to_owned(), &mut forms);
        } else {
            add(format!("p-{form}"), &mut forms);
        }
    }
    forms
}

/// Resolve any pass-shaped id to its canonical pass node id (JS
/// `resolvePassId`).
pub fn resolve_pass_id(graph: &LeisureGraph, id: &str) -> Option<NodeId> {
    if id.is_empty() {
        return None;
    }
    for form in pass_id_forms(id) {
        let key = NodeId::from(form.as_str());
        if let Some(mapped) = graph.pass_id_by_node_id.get(&key) {
            return Some(mapped.clone());
        }
        if graph.pass_triplets.contains_key(&key) {
            return Some(key);
        }
        if matches!(graph.nodes.get(&key).map(|n| &n.kind), Some(NodeKind::Pass)) {
            return Some(key);
        }
    }
    None
}

/// Strip a synthetic `:A` / `:B` / `:S` suffix from a node id, returning the
/// underlying pass id (JS `passIdFromSyntheticId`).
pub fn pass_id_from_synthetic_id(node_id: &str) -> Option<String> {
    let bytes = node_id.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    let last = bytes[bytes.len() - 1];
    if !matches!(last, b'A' | b'B' | b'S') {
        return None;
    }
    if bytes[bytes.len() - 2] != b':' {
        return None;
    }
    let prefix = &node_id[..node_id.len() - 2];
    if prefix.is_empty() {
        None
    } else {
        Some(prefix.to_owned())
    }
}

/// Find the nearest graph POI with the same normalized name as a UI stop
/// (JS `matchPoiByName`).
pub fn match_poi_by_name<'g>(
    stop_name: &str,
    stop_lat: f64,
    stop_lon: f64,
    graph: &'g LeisureGraph,
) -> Option<&'g Node> {
    let target = normalize_name(stop_name);
    if target.is_empty() {
        return None;
    }
    let mut best: Option<(&Node, f64)> = None;
    for poi_id in graph.nodes_of_kind(NodeKind::Poi) {
        let Some(poi) = graph.nodes.get(poi_id) else {
            continue;
        };
        if normalize_name(&poi.name) != target {
            continue;
        }
        let distance = haversine_route_km(&[
            (stop_lat, stop_lon),
            (poi.lat, poi.lon),
        ]);
        match best {
            Some((_, d)) if d <= distance => {}
            _ => best = Some((poi, distance)),
        }
    }
    best.map(|(node, _)| node)
}

// ===========================================================================
// DTO normalization
// ===========================================================================

/// Copy coordinates from a tour-path source point onto a break item when
/// available (JS `enrichBreakPoint`).
///
/// JS reads `item.poiCandidate` first; the frozen Rust `UiBreakItem` has no
/// such field, so this port consults the graph node at
/// `path[at_tour_vertex_idx]` only.
pub fn enrich_break_point(
    item: UiBreakItem,
    tour_path: &[NodeId],
    graph: &LeisureGraph,
) -> UiBreakItem {
    let mut out = item;
    let idx = out.at_tour_vertex_idx as usize;
    let Some(node_id) = tour_path.get(idx) else {
        return out;
    };
    if let Some(node) = graph.nodes.get(node_id) {
        if node.lat.is_finite() && node.lon.is_finite() {
            out.lat = Some(node.lat);
            out.lon = Some(node.lon);
        }
    }
    out
}

/// Pass through corridor items, normalizing id/name fields (JS
/// `normalizeCorridorItems`).
///
/// The frozen `UiCorridorItem` already requires `id` and `name`; the JS
/// fallbacks (`poiId` / `poiName`) cannot occur here, so this is effectively
/// an identity. Kept as a stable entry point for parity with JS.
pub fn normalize_corridor_items(items: Vec<UiCorridorItem>) -> Vec<UiCorridorItem> {
    items
}

// ===========================================================================
// Private helpers
// ===========================================================================

fn ui_point_from_node(node: &Node) -> UiPoint {
    UiPoint::Coord {
        lat: node.lat,
        lon: node.lon,
        name: Some(node.name.clone()),
    }
}

fn ui_point_from_point(point: &Point, _id: Option<&str>, name: Option<&str>) -> UiPoint {
    UiPoint::Coord {
        lat: point.lat,
        lon: point.lon,
        name: name.map(str::to_owned).or_else(|| point.name.clone()),
    }
}

#[allow(dead_code)] // kept for spec-parity; useful when extras.rs (C2) or F5 reads node coords.
fn point_lat_lon(node: &Node) -> (f64, f64) {
    (node.lat, node.lon)
}

fn push_point(points: &mut Vec<(f64, f64)>, lat: f64, lon: f64) {
    if !lat.is_finite() || !lon.is_finite() {
        return;
    }
    if let Some((prev_lat, prev_lon)) = points.last() {
        if (prev_lat - lat).abs() < 1e-6 && (prev_lon - lon).abs() < 1e-6 {
            return;
        }
    }
    points.push((lat, lon));
}

/// Two-arg form of `quality_of` (private to C1). The public three-arg
/// version that includes a `raw_quality` source lives in `extras.rs` (C2);
/// see ADR-F2-005.
fn quality_of(scenic_score: Option<f64>, score: Option<f64>) -> f64 {
    let raw = scenic_score
        .filter(|v| v.is_finite())
        .or_else(|| score.filter(|v| v.is_finite()))
        .unwrap_or(0.0);
    if !raw.is_finite() {
        return 0.0;
    }
    if raw > 1.0 {
        (raw / 10.0).min(1.0)
    } else {
        raw.max(0.0)
    }
}

fn quality_of_node(node: &Node) -> f64 {
    quality_of(node.scenic_score, node.score)
}

fn normalize_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_space = false;
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

fn haversine_route_km(points: &[(f64, f64)]) -> f64 {
    let mut total = 0.0;
    for window in points.windows(2) {
        total += haversine_km(window[0], window[1]);
    }
    total
}

fn haversine_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    if !a.0.is_finite() || !a.1.is_finite() || !b.0.is_finite() || !b.1.is_finite() {
        return 0.0;
    }
    haversine_m(a.0, a.1, b.0, b.1) / 1000.0
}

fn round_hours(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 100.0).round() / 100.0
}

fn first_finite<const N: usize>(candidates: [Option<f64>; N]) -> Option<f64> {
    for c in candidates {
        if let Some(v) = c {
            if v.is_finite() {
                return Some(v);
            }
        }
    }
    // Mirror JS `??`: also accept a finite-or-NaN first present value if no
    // finite candidate exists. This preserves NaN propagation.
    for c in candidates {
        if c.is_some() {
            return c;
        }
    }
    None
}

fn side_suffix(node_id: &str) -> Option<char> {
    let bytes = node_id.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let last = bytes[bytes.len() - 1];
    if bytes[bytes.len() - 2] != b':' {
        return None;
    }
    match last {
        b'A' => Some('A'),
        b'B' => Some('B'),
        _ => None,
    }
}

fn stop_identity(stop: &UiTourStop) -> (Option<&str>, f64, f64) {
    match stop {
        UiTourStop::Pass(p) => (Some(p.id.as_str()), p.lat, p.lon),
        UiTourStop::Poi(p) => (Some(p.id.as_str()), p.lat, p.lon),
        UiTourStop::Endpoint(e) => (e.id.as_deref(), e.lat, e.lon),
    }
}

fn graph_has_id(graph: &LeisureGraph, id: &str) -> bool {
    let key = NodeId::from(id);
    graph.nodes.contains_key(&key)
        || graph.pass_triplets.contains_key(&key)
        || graph.pass_id_by_node_id.contains_key(&key)
}

// Re-export private helpers under `pub(crate)` so tests in the integration
// tests file (`tests/tour_dto.rs`) can exercise them directly when needed via
// targeted public wrappers below.

#[doc(hidden)]
pub mod __testing {
    //! Test-only re-exports of private helpers. Not part of the stable API.
    use super::*;

    pub fn normalize_name(name: &str) -> String {
        super::normalize_name(name)
    }
    pub fn quality_of(scenic_score: Option<f64>, score: Option<f64>) -> f64 {
        super::quality_of(scenic_score, score)
    }
    pub fn round_hours(value: f64) -> f64 {
        super::round_hours(value)
    }
    pub fn haversine_km(a: (f64, f64), b: (f64, f64)) -> f64 {
        super::haversine_km(a, b)
    }
    pub fn haversine_route_km(points: &[(f64, f64)]) -> f64 {
        super::haversine_route_km(points)
    }
    pub fn push_point(points: &mut Vec<(f64, f64)>, lat: f64, lon: f64) {
        super::push_point(points, lat, lon)
    }
    pub fn side_suffix(id: &str) -> Option<char> {
        super::side_suffix(id)
    }
    pub fn ui_point_from_node(node: &Node) -> UiPoint {
        super::ui_point_from_node(node)
    }
}
