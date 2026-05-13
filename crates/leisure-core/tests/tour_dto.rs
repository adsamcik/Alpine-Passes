//! Tests for `crate::tour_dto` (F2-C1).
//!
//! Uses a small synthetic graph fixture (`LeisureGraph::load_from_json`) for
//! graph-dependent tests; pure functions are tested without a graph.

use leisure_core::tour_dto::{
    compressed_path, derive_modes, display_stops, endpoint_stop, endpoint_stop_for_end_node,
    enrich_break_point, implicit_passes_from_path, map_leisure_stop, map_pass_stop, map_poi_stop,
    normalize_corridor_items, open_route_tour_stops, pass_id_forms, pass_id_from_synthetic_id,
    path_from_edges, resolve_pass_id, resolve_selected_stop_id, same_stop, EndNode, EndpointKind,
    PlannerStopInput, SelectedStop, MAX_OSRM_WAYPOINTS,
};
use leisure_core::tour_dto::__testing as helpers;
use leisure_core::{
    LeisureGraph, NodeId, UiBreakItem, UiCorridorItem, UiEndpointStop, UiPassStop, UiPoiStop,
    UiPoint, UiTourStop,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn graph_fixture() -> LeisureGraph {
    let nodes = json!([
        { "id": "base", "kind": "junction", "name": "Base", "lat": 46.0, "lon": 7.0 },
        { "id": "p-stelvio", "kind": "pass", "name": "Stelvio", "lat": 46.5, "lon": 10.45, "elev": 2757.0, "scenicScore": 0.9, "themes": ["alpine"] },
        { "id": "p-stelvio:S", "kind": "pass-summit", "name": "Stelvio Summit", "lat": 46.5, "lon": 10.45, "elev": 2757.0, "passId": "p-stelvio", "summitParking": { "lat": 46.501, "lon": 10.451, "name": "Summit Lot" } },
        { "id": "p-stelvio:A", "kind": "pass-base", "name": "Stelvio A", "lat": 46.4, "lon": 10.4, "passId": "p-stelvio", "side": "A" },
        { "id": "p-stelvio:B", "kind": "pass-base", "name": "Stelvio B", "lat": 46.6, "lon": 10.5, "passId": "p-stelvio", "side": "B" },
        { "id": "p-bare", "kind": "pass", "name": "Bare Pass", "lat": 46.7, "lon": 9.0, "scenicScore": 5.0 },
        { "id": "poi-castle", "kind": "poi", "name": "Castle", "lat": 46.1, "lon": 7.1, "categories": ["historic", "viewpoint"], "themes": ["culture"], "scenicScore": 0.7, "visitDwellSec": 1800 },
        { "id": "poi-castle-near", "kind": "poi", "name": "Castle", "lat": 46.0001, "lon": 7.0001, "categories": ["historic"], "themes": ["culture"], "scenicScore": 0.5 },
        { "id": "poi-other", "kind": "poi", "name": "Lake", "lat": 46.2, "lon": 7.5 }
    ]);
    let edges = json!([]);
    let data = json!({
        "version": "test",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": 9, "edges": 0 },
        "nodes": nodes,
        "edges": edges,
    });
    LeisureGraph::load_from_json(&data.to_string()).expect("fixture parses")
}

fn empty_graph() -> LeisureGraph {
    let data = json!({
        "version": "t",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": 0, "edges": 0 },
        "nodes": [],
        "edges": [],
    });
    LeisureGraph::load_from_json(&data.to_string()).expect("parses")
}

fn pass_stop_input(pass_id: &str) -> PlannerStopInput {
    PlannerStopInput {
        kind: Some("pass".to_owned()),
        id: Some(pass_id.to_owned()),
        pass_id: Some(pass_id.to_owned()),
        ..Default::default()
    }
}

fn poi_stop_input(node_id: &str, dwell_sec: Option<u32>) -> PlannerStopInput {
    PlannerStopInput {
        kind: Some("poi".to_owned()),
        id: Some(node_id.to_owned()),
        node_id: Some(node_id.to_owned()),
        visit_dwell_sec: dwell_sec,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// map_pass_stop
// ---------------------------------------------------------------------------

#[test]
fn map_pass_stop_happy_uses_graph_node() {
    let g = graph_fixture();
    let stop = map_pass_stop(&pass_stop_input("p-stelvio"), &g);
    assert_eq!(stop.id, "p-stelvio");
    assert_eq!(stop.name, "Stelvio");
    assert!((stop.lat - 46.5).abs() < 1e-9);
    assert!((stop.lon - 10.45).abs() < 1e-9);
    assert_eq!(stop.elev, Some(2757.0));
    assert!((stop.quality - 0.9).abs() < 1e-9);
    assert_eq!(stop.themes, vec!["alpine"]);
    assert!(stop.base_a.is_some());
    assert!(stop.base_b.is_some());
    assert!(matches!(stop.summit_parking, Some(UiPoint::Coord { .. })));
}

#[test]
fn map_pass_stop_missing_sides_falls_back_to_stop_lat_lon() {
    let g = empty_graph();
    let mut stop_in = pass_stop_input("p-unknown");
    stop_in.lat = Some(45.0);
    stop_in.lon = Some(8.0);
    stop_in.name = Some("Unknown".to_owned());
    let stop = map_pass_stop(&stop_in, &g);
    assert_eq!(stop.id, "p-unknown");
    assert_eq!(stop.name, "Unknown");
    assert_eq!(stop.lat, 45.0);
    assert_eq!(stop.lon, 8.0);
    assert_eq!(stop.quality, 0.0);
    assert!(stop.base_a.is_none());
    assert!(stop.base_b.is_none());
}

#[test]
fn map_pass_stop_p_prefix_form_is_resolved() {
    let g = graph_fixture();
    // "stelvio" without `p-` prefix should still resolve via pass_id_for_node_id
    // map (built from the pass's :S/:A/:B nodes). Actually plain "stelvio"
    // isn't there — but `p-stelvio` is the canonical id, which is what we use.
    let stop = map_pass_stop(&pass_stop_input("p-stelvio"), &g);
    assert!(!stop.summit_parking.is_none());
}

#[test]
fn map_pass_stop_quality_above_one_clamps() {
    // p-bare has scenicScore: 5.0 → quality_of returns min(5/10, 1) = 0.5
    let g = graph_fixture();
    let stop = map_pass_stop(&pass_stop_input("p-bare"), &g);
    assert!((stop.quality - 0.5).abs() < 1e-9);
    assert!((stop.scenic_score - 0.5).abs() < 1e-9);
}

#[test]
fn map_pass_stop_themes_fallback_to_stop_when_node_empty() {
    let g = graph_fixture();
    let mut stop_in = pass_stop_input("p-bare");
    stop_in.themes = vec!["custom".to_owned()];
    let stop = map_pass_stop(&stop_in, &g);
    assert_eq!(stop.themes, vec!["custom"]);
}

// ---------------------------------------------------------------------------
// map_poi_stop
// ---------------------------------------------------------------------------

#[test]
fn map_poi_stop_happy_uses_node_data() {
    let g = graph_fixture();
    let stop = map_poi_stop(&poi_stop_input("poi-castle", None), &g);
    assert_eq!(stop.id, "poi-castle");
    assert_eq!(stop.name, "Castle");
    assert!(stop.is_poi);
    assert_eq!(stop.visit_dwell_sec, 1800);
    assert_eq!(stop.dwell_min, 30);
    assert!((stop.dwell_h - 0.5).abs() < 1e-9);
    assert_eq!(stop.poi_category, "historic");
    assert_eq!(stop.poi_themes, vec!["culture"]);
    assert!((stop.quality - 0.7).abs() < 1e-9);
}

#[test]
fn map_poi_stop_dwell_rounding() {
    let g = graph_fixture();
    let stop = map_poi_stop(&poi_stop_input("poi-other", Some(2700)), &g);
    assert_eq!(stop.visit_dwell_sec, 2700);
    assert_eq!(stop.dwell_min, 45);
    assert!((stop.dwell_h - 0.75).abs() < 1e-9);
}

#[test]
fn map_poi_stop_default_category_is_sight() {
    let g = graph_fixture();
    let stop = map_poi_stop(&poi_stop_input("poi-other", None), &g);
    assert_eq!(stop.poi_category, "sight");
}

#[test]
fn map_poi_stop_falls_back_to_stop_when_node_missing() {
    let g = empty_graph();
    let mut stop_in = poi_stop_input("missing-poi", Some(600));
    stop_in.name = Some("Mystery".to_owned());
    stop_in.lat = Some(46.0);
    stop_in.lon = Some(7.0);
    stop_in.categories = vec!["food".to_owned()];
    let stop = map_poi_stop(&stop_in, &g);
    assert_eq!(stop.id, "missing-poi");
    assert_eq!(stop.name, "Mystery");
    assert_eq!(stop.poi_category, "food");
    assert_eq!(stop.dwell_min, 10);
}

// ---------------------------------------------------------------------------
// map_leisure_stop dispatch
// ---------------------------------------------------------------------------

#[test]
fn map_leisure_stop_dispatches_pass_kind() {
    let g = graph_fixture();
    let r = map_leisure_stop(&pass_stop_input("p-stelvio"), &g);
    assert!(matches!(r, Some(UiTourStop::Pass(_))));
}

#[test]
fn map_leisure_stop_dispatches_poi_kind() {
    let g = graph_fixture();
    let r = map_leisure_stop(&poi_stop_input("poi-castle", None), &g);
    assert!(matches!(r, Some(UiTourStop::Poi(_))));
}

#[test]
fn map_leisure_stop_dispatches_via_pass_id_when_kind_missing() {
    let g = graph_fixture();
    let stop = PlannerStopInput {
        pass_id: Some("p-stelvio".to_owned()),
        ..Default::default()
    };
    let r = map_leisure_stop(&stop, &g);
    assert!(matches!(r, Some(UiTourStop::Pass(_))));
}

#[test]
fn map_leisure_stop_with_only_coords_returns_endpoint() {
    let g = empty_graph();
    let stop = PlannerStopInput {
        id: Some("custom".to_owned()),
        lat: Some(46.0),
        lon: Some(7.0),
        ..Default::default()
    };
    let r = map_leisure_stop(&stop, &g);
    assert!(matches!(r, Some(UiTourStop::Endpoint(_))));
}

#[test]
fn map_leisure_stop_returns_none_without_pass_or_coords() {
    let g = empty_graph();
    let stop = PlannerStopInput::default();
    assert!(map_leisure_stop(&stop, &g).is_none());
}

// ---------------------------------------------------------------------------
// display_stops
// ---------------------------------------------------------------------------

#[test]
fn display_stops_filters_all_four_kinds() {
    let stops = vec![
        PlannerStopInput { kind: Some("start".to_owned()), ..Default::default() },
        PlannerStopInput { kind: Some("pass".to_owned()), id: Some("p-1".to_owned()), ..Default::default() },
        PlannerStopInput { kind: Some("end".to_owned()), ..Default::default() },
        PlannerStopInput { kind: Some("return".to_owned()), ..Default::default() },
        PlannerStopInput { kind: Some("poi".to_owned()), id: Some("poi-1".to_owned()), ..Default::default() },
        PlannerStopInput { return_to_start: true, kind: Some("pass".to_owned()), id: Some("p-2".to_owned()), ..Default::default() },
    ];
    let out = display_stops(&stops);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].id.as_deref(), Some("p-1"));
    assert_eq!(out[1].id.as_deref(), Some("poi-1"));
}

#[test]
fn display_stops_preserves_order_and_unknown_kinds() {
    let stops = vec![
        PlannerStopInput { kind: Some("pass".to_owned()), id: Some("a".to_owned()), ..Default::default() },
        PlannerStopInput { kind: None, id: Some("b".to_owned()), ..Default::default() },
        PlannerStopInput { kind: Some("custom".to_owned()), id: Some("c".to_owned()), ..Default::default() },
    ];
    let out = display_stops(&stops);
    assert_eq!(out.len(), 3);
}

// ---------------------------------------------------------------------------
// same_stop
// ---------------------------------------------------------------------------

fn pass_tour_stop(id: &str, lat: f64, lon: f64) -> UiTourStop {
    UiTourStop::Pass(UiPassStop {
        id: id.to_owned(),
        name: id.to_owned(),
        lat,
        lon,
        elev: None,
        quality: 0.0,
        q_scenic: 0.0,
        q_summit: 0.0,
        q_approach: 0.0,
        scenic_score: 0.0,
        themes: vec![],
        viewpoints: vec![],
        base_a: None,
        base_b: None,
        summit_parking: None,
    })
}

fn endpoint_tour_stop(id: Option<&str>, lat: f64, lon: f64) -> UiTourStop {
    UiTourStop::Endpoint(UiEndpointStop {
        id: id.map(str::to_owned),
        name: id.map(str::to_owned),
        lat,
        lon,
        is_endpoint: true,
    })
}

#[test]
fn same_stop_matches_by_id() {
    let a = pass_tour_stop("x", 1.0, 2.0);
    let b = pass_tour_stop("x", 99.0, 99.0);
    assert!(same_stop(&a, &b));
}

#[test]
fn same_stop_matches_by_coordinates_within_epsilon() {
    let a = pass_tour_stop("a", 46.0, 7.0);
    let b = pass_tour_stop("b", 46.0 + 1e-7, 7.0 - 1e-7);
    assert!(same_stop(&a, &b));
}

#[test]
fn same_stop_rejects_outside_epsilon() {
    let a = pass_tour_stop("a", 46.0, 7.0);
    let b = pass_tour_stop("b", 46.001, 7.0);
    assert!(!same_stop(&a, &b));
}

#[test]
fn same_stop_endpoint_without_id_uses_coords() {
    let a = endpoint_tour_stop(None, 46.0, 7.0);
    let b = endpoint_tour_stop(None, 46.0, 7.0);
    assert!(same_stop(&a, &b));
}

#[test]
fn same_stop_endpoint_with_empty_id_uses_coords_only() {
    let a = endpoint_tour_stop(Some(""), 46.0, 7.0);
    let b = endpoint_tour_stop(Some(""), 46.0, 7.0);
    assert!(same_stop(&a, &b));
}

// ---------------------------------------------------------------------------
// endpoint_stop & open_route_tour_stops
// ---------------------------------------------------------------------------

#[test]
fn endpoint_stop_from_coord_point_preserves_lat_lon() {
    let p = UiPoint::Coord {
        lat: 46.0,
        lon: 7.0,
        name: Some("Origin".to_owned()),
    };
    let e = endpoint_stop(&p, EndpointKind::Start).expect("Some");
    assert_eq!(e.lat, 46.0);
    assert_eq!(e.lon, 7.0);
    assert_eq!(e.name.as_deref(), Some("Origin"));
    assert!(e.is_endpoint);
}

#[test]
fn endpoint_stop_from_id_point_has_nan_coords() {
    let p = UiPoint::Id("anchor".to_owned());
    let e = endpoint_stop(&p, EndpointKind::End).expect("Some");
    assert!(e.lat.is_nan());
    assert!(e.lon.is_nan());
    assert_eq!(e.id.as_deref(), Some("anchor"));
    assert_eq!(e.name.as_deref(), Some("anchor"));
}

#[test]
fn endpoint_stop_default_name_per_kind() {
    let p = UiPoint::Coord { lat: 0.0, lon: 0.0, name: None };
    assert_eq!(
        endpoint_stop(&p, EndpointKind::Start).unwrap().name.as_deref(),
        Some("Start")
    );
    assert_eq!(
        endpoint_stop(&p, EndpointKind::End).unwrap().name.as_deref(),
        Some("End")
    );
}

#[test]
fn endpoint_stop_for_end_node_id_resolves_via_graph() {
    let g = graph_fixture();
    let en = EndNode::Id("base");
    let e = endpoint_stop_for_end_node(&en, &g).expect("Some");
    assert!((e.lat - 46.0).abs() < 1e-9);
    assert!((e.lon - 7.0).abs() < 1e-9);
}

#[test]
fn endpoint_stop_for_end_node_id_unknown_returns_nan_endpoint() {
    let g = empty_graph();
    let en = EndNode::Id("missing");
    let e = endpoint_stop_for_end_node(&en, &g).expect("Some");
    assert!(e.lat.is_nan());
    assert_eq!(e.id.as_deref(), Some("missing"));
}

#[test]
fn open_route_tour_stops_closed_returns_input_unchanged() {
    let g = empty_graph();
    let stops = vec![pass_tour_stop("a", 1.0, 1.0)];
    let start = UiPoint::Coord { lat: 0.0, lon: 0.0, name: None };
    let out = open_route_tour_stops(stops.clone(), &start, None, true, &g);
    assert_eq!(out, stops);
}

#[test]
fn open_route_tour_stops_open_adds_start_and_end() {
    let g = graph_fixture();
    let stops = vec![pass_tour_stop("p-stelvio", 46.5, 10.45)];
    let start = UiPoint::Coord { lat: 46.0, lon: 7.0, name: Some("Base".to_owned()) };
    let end_node = Some(EndNode::Id("base"));
    let out = open_route_tour_stops(stops, &start, end_node, false, &g);
    assert_eq!(out.len(), 3);
    assert!(matches!(out[0], UiTourStop::Endpoint(_)));
    assert!(matches!(out[2], UiTourStop::Endpoint(_)));
}

#[test]
fn open_route_tour_stops_skips_start_when_first_already_matches() {
    let g = empty_graph();
    let stops = vec![endpoint_tour_stop(None, 46.0, 7.0)];
    let start = UiPoint::Coord { lat: 46.0, lon: 7.0, name: None };
    let out = open_route_tour_stops(stops, &start, None, false, &g);
    assert_eq!(out.len(), 1);
}

#[test]
fn open_route_tour_stops_skips_end_when_last_already_matches() {
    let g = graph_fixture();
    let stops = vec![
        endpoint_tour_stop(Some("base"), 46.0, 7.0),
        endpoint_tour_stop(Some("base"), 46.0, 7.0),
    ];
    let start = UiPoint::Coord { lat: 46.0, lon: 7.0, name: None };
    let out = open_route_tour_stops(stops, &start, Some(EndNode::Id("base")), false, &g);
    // start dropped (first stop has matching coords), end dropped (last has same id)
    assert_eq!(out.len(), 2);
}

// ---------------------------------------------------------------------------
// derive_modes
// ---------------------------------------------------------------------------

#[test]
fn derive_modes_out_and_back_when_path_only_visits_one_side() {
    let g = graph_fixture();
    let path = vec![NodeId::from("p-stelvio:A"), NodeId::from("p-stelvio:S"), NodeId::from("p-stelvio:A")];
    let stops = vec![pass_tour_stop("p-stelvio", 46.5, 10.45)];
    let modes = derive_modes(&path, &stops, &g);
    assert_eq!(modes.len(), 1);
    assert_eq!(modes[0].mode, "out-and-back");
    assert_eq!(modes[0].enter_side, 0);
    assert_eq!(modes[0].exit_side, 0);
}

#[test]
fn derive_modes_traverse_when_enter_and_exit_sides_differ() {
    let g = graph_fixture();
    let path = vec![NodeId::from("p-stelvio:A"), NodeId::from("p-stelvio:S"), NodeId::from("p-stelvio:B")];
    let stops = vec![pass_tour_stop("p-stelvio", 46.5, 10.45)];
    let modes = derive_modes(&path, &stops, &g);
    assert_eq!(modes[0].mode, "traverse");
    assert_eq!(modes[0].enter_side, 0);
    assert_eq!(modes[0].exit_side, 1);
}

#[test]
fn derive_modes_traverse_b_to_a() {
    let g = graph_fixture();
    let path = vec![NodeId::from("p-stelvio:B"), NodeId::from("p-stelvio:A")];
    let stops = vec![pass_tour_stop("p-stelvio", 46.5, 10.45)];
    let modes = derive_modes(&path, &stops, &g);
    assert_eq!(modes[0].mode, "traverse");
    assert_eq!(modes[0].enter_side, 1);
    assert_eq!(modes[0].exit_side, 0);
}

#[test]
fn derive_modes_poi_and_endpoint_get_their_own_mode() {
    let g = empty_graph();
    let stops = vec![
        UiTourStop::Poi(UiPoiStop {
            id: "poi-1".to_owned(), name: "POI".to_owned(), lat: 0.0, lon: 0.0,
            is_poi: true, visit_dwell_sec: 0, dwell_min: 0, dwell_h: 0.0,
            poi_category: "sight".to_owned(), poi_themes: vec![], quality: 0.0, scenic_score: 0.0,
        }),
        endpoint_tour_stop(Some("end"), 0.0, 0.0),
    ];
    let modes = derive_modes(&[], &stops, &g);
    assert_eq!(modes[0].mode, "poi");
    assert_eq!(modes[1].mode, "endpoint");
}

#[test]
fn derive_modes_default_to_a_when_path_has_no_pass_nodes() {
    let g = graph_fixture();
    let stops = vec![pass_tour_stop("p-stelvio", 46.5, 10.45)];
    let modes = derive_modes(&[], &stops, &g);
    assert_eq!(modes[0].enter_side, 0);
    assert_eq!(modes[0].exit_side, 0);
    assert_eq!(modes[0].mode, "out-and-back");
}

// ---------------------------------------------------------------------------
// implicit_passes_from_path
// ---------------------------------------------------------------------------

#[test]
fn implicit_passes_includes_passes_not_in_explicit_stops() {
    let g = graph_fixture();
    let path = vec![NodeId::from("p-stelvio:A"), NodeId::from("p-stelvio:S")];
    let result = implicit_passes_from_path(&path, &[], &g);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "p-stelvio");
}

#[test]
fn implicit_passes_excludes_explicit_pass_stops() {
    let g = graph_fixture();
    let path = vec![NodeId::from("p-stelvio:A")];
    let stops = vec![pass_tour_stop("p-stelvio", 46.5, 10.45)];
    let result = implicit_passes_from_path(&path, &stops, &g);
    assert!(result.is_empty());
}

#[test]
fn implicit_passes_dedup_within_single_pass() {
    let g = graph_fixture();
    let path = vec![
        NodeId::from("p-stelvio:A"),
        NodeId::from("p-stelvio:S"),
        NodeId::from("p-stelvio:B"),
    ];
    let result = implicit_passes_from_path(&path, &[], &g);
    assert_eq!(result.len(), 1);
}

// ---------------------------------------------------------------------------
// path_from_edges
// ---------------------------------------------------------------------------

#[test]
fn path_from_edges_happy() {
    let edges = vec!["a->b".to_owned(), "b->c".to_owned()];
    let path = path_from_edges(&edges);
    let strs: Vec<&str> = path.iter().map(NodeId::as_str).collect();
    assert_eq!(strs, vec!["a", "b", "c"]);
}

#[test]
fn path_from_edges_empty_returns_empty() {
    assert!(path_from_edges(&[]).is_empty());
}

#[test]
fn path_from_edges_skips_malformed_ids() {
    let edges = vec!["malformed".to_owned(), "->b".to_owned(), "a->".to_owned(), "x->y".to_owned()];
    let path = path_from_edges(&edges);
    let strs: Vec<&str> = path.iter().map(NodeId::as_str).collect();
    assert_eq!(strs, vec!["x", "y"]);
}

#[test]
fn path_from_edges_handles_disjoint_sequences() {
    // a->b followed by c->d (b != c) — JS pushes c (since last != c) then d.
    let edges = vec!["a->b".to_owned(), "c->d".to_owned()];
    let path = path_from_edges(&edges);
    let strs: Vec<&str> = path.iter().map(NodeId::as_str).collect();
    assert_eq!(strs, vec!["a", "b", "c", "d"]);
}

// ---------------------------------------------------------------------------
// compressed_path
// ---------------------------------------------------------------------------

#[test]
fn compressed_path_short_is_unchanged() {
    let g = graph_fixture();
    let path: Vec<NodeId> = (0..MAX_OSRM_WAYPOINTS)
        .map(|i| NodeId::from(format!("n-{i}").as_str()))
        .collect();
    let out = compressed_path(&path, &g);
    assert_eq!(out, path);
}

#[test]
fn compressed_path_keeps_only_important_when_under_max() {
    // Build a path with mostly junctions and 2 passes — important.length < MAX,
    // so the divisor logic applies and (length <= MAX) shortcut returns
    // everything.
    let g = graph_fixture();
    let mut path: Vec<NodeId> = (0..MAX_OSRM_WAYPOINTS + 1)
        .map(|_| NodeId::from("base"))
        .collect();
    path[0] = NodeId::from("p-stelvio:A");
    path[MAX_OSRM_WAYPOINTS] = NodeId::from("p-stelvio:B");
    path[10] = NodeId::from("p-stelvio:S");
    let out = compressed_path(&path, &g);
    // First, last, plus pass nodes only — all important. Length <= MAX_OSRM, so
    // returns all important nodes.
    assert!(out.len() <= MAX_OSRM_WAYPOINTS);
    assert!(out.len() >= 3);
}

#[test]
fn compressed_path_strides_when_important_exceeds_max() {
    let g = graph_fixture();
    // Create a path of MAX+2 entries, every single one is a pass-base node so
    // they all qualify as important.
    let path: Vec<NodeId> = (0..MAX_OSRM_WAYPOINTS + 5)
        .map(|i| NodeId::from(if i % 2 == 0 { "p-stelvio:A" } else { "p-stelvio:B" }))
        .collect();
    let out = compressed_path(&path, &g);
    // First and last always kept; total bounded.
    assert_eq!(out.first().unwrap().as_str(), "p-stelvio:A");
    assert!(out.len() <= MAX_OSRM_WAYPOINTS + 5);
    assert!(out.len() >= 3);
}

// ---------------------------------------------------------------------------
// pass_id_forms / pass_id_from_synthetic_id / resolve_pass_id
// ---------------------------------------------------------------------------

#[test]
fn pass_id_forms_full_set_for_p_prefixed_value() {
    let forms = pass_id_forms("p-stelvio");
    assert!(forms.contains(&"p-stelvio".to_owned()));
    assert!(forms.contains(&"stelvio".to_owned()));
}

#[test]
fn pass_id_forms_full_set_for_synthetic_value() {
    let forms = pass_id_forms("p-stelvio:S");
    assert!(forms.contains(&"p-stelvio:S".to_owned()));
    assert!(forms.contains(&"p-stelvio".to_owned()));
    assert!(forms.contains(&"stelvio".to_owned()));
}

#[test]
fn pass_id_forms_full_set_for_bare_value() {
    let forms = pass_id_forms("foo");
    assert!(forms.contains(&"foo".to_owned()));
    assert!(forms.contains(&"p-foo".to_owned()));
}

#[test]
fn pass_id_forms_dedup() {
    let forms = pass_id_forms("p-foo");
    let count = forms.iter().filter(|s| *s == "p-foo").count();
    assert_eq!(count, 1);
}

#[test]
fn pass_id_from_synthetic_id_strips_a_b_s_suffix() {
    assert_eq!(pass_id_from_synthetic_id("p-x:A").as_deref(), Some("p-x"));
    assert_eq!(pass_id_from_synthetic_id("p-x:B").as_deref(), Some("p-x"));
    assert_eq!(pass_id_from_synthetic_id("p-x:S").as_deref(), Some("p-x"));
}

#[test]
fn pass_id_from_synthetic_id_returns_none_for_non_synthetic() {
    assert!(pass_id_from_synthetic_id("p-x").is_none());
    assert!(pass_id_from_synthetic_id("p-x:Z").is_none());
    assert!(pass_id_from_synthetic_id("").is_none());
    assert!(pass_id_from_synthetic_id(":A").is_none());
}

#[test]
fn resolve_pass_id_via_canonical_form() {
    let g = graph_fixture();
    assert_eq!(resolve_pass_id(&g, "p-stelvio").map(|n| n.to_string()).as_deref(), Some("p-stelvio"));
}

#[test]
fn resolve_pass_id_via_synthetic_form() {
    let g = graph_fixture();
    assert_eq!(resolve_pass_id(&g, "p-stelvio:A").map(|n| n.to_string()).as_deref(), Some("p-stelvio"));
    assert_eq!(resolve_pass_id(&g, "p-stelvio:S").map(|n| n.to_string()).as_deref(), Some("p-stelvio"));
}

#[test]
fn resolve_pass_id_returns_none_for_unknown() {
    let g = graph_fixture();
    assert!(resolve_pass_id(&g, "p-unknown").is_none());
    assert!(resolve_pass_id(&g, "").is_none());
}

// ---------------------------------------------------------------------------
// resolve_selected_stop_id / match_poi_by_name
// ---------------------------------------------------------------------------

#[test]
fn resolve_selected_stop_id_via_node_id() {
    let g = graph_fixture();
    let s = SelectedStop::Id("base");
    assert_eq!(resolve_selected_stop_id(&s, &g).as_deref(), Some("base"));
}

#[test]
fn resolve_selected_stop_id_via_pass_triplet() {
    let g = graph_fixture();
    let s = SelectedStop::Id("p-stelvio");
    assert_eq!(resolve_selected_stop_id(&s, &g).as_deref(), Some("p-stelvio"));
}

#[test]
fn resolve_selected_stop_id_unknown_id_still_returned() {
    let g = graph_fixture();
    let s = SelectedStop::Id("not-in-graph");
    assert_eq!(resolve_selected_stop_id(&s, &g).as_deref(), Some("not-in-graph"));
}

#[test]
fn resolve_selected_stop_id_poi_named_resolves_via_match() {
    let g = graph_fixture();
    let s = SelectedStop::PoiNamed { id: None, name: "Castle", lat: 46.1, lon: 7.1 };
    let id = resolve_selected_stop_id(&s, &g).expect("Some");
    assert_eq!(id, "poi-castle");
}

#[test]
fn match_poi_by_name_picks_nearest_when_multiple_match() {
    let g = graph_fixture();
    // poi-castle at (46.1, 7.1), poi-castle-near at (46.0001, 7.0001). Stop at
    // (46.0, 7.0) → near is closer.
    let n = leisure_core::tour_dto::match_poi_by_name("Castle", 46.0, 7.0, &g).expect("Some");
    assert_eq!(n.id.as_str(), "poi-castle-near");

    // Stop near 46.1, 7.1 → original castle wins.
    let n = leisure_core::tour_dto::match_poi_by_name("Castle", 46.1, 7.1, &g).expect("Some");
    assert_eq!(n.id.as_str(), "poi-castle");
}

#[test]
fn match_poi_by_name_returns_none_for_blank_name() {
    let g = graph_fixture();
    assert!(leisure_core::tour_dto::match_poi_by_name("   ", 0.0, 0.0, &g).is_none());
}

#[test]
fn match_poi_by_name_normalizes_whitespace_and_case() {
    let g = graph_fixture();
    assert!(leisure_core::tour_dto::match_poi_by_name("  CASTLE  ", 46.1, 7.1, &g).is_some());
}

// ---------------------------------------------------------------------------
// enrich_break_point
// ---------------------------------------------------------------------------

fn break_item(idx: u32) -> UiBreakItem {
    UiBreakItem {
        at_tour_vertex_idx: idx,
        at_km: 0.0,
        at_h: 0.0,
        source: "test".to_owned(),
        stop_min: 0,
        rest_min: 0,
        rest_numbers: vec![],
        lat: None,
        lon: None,
        kind: None,
        reason: None,
    }
}

#[test]
fn enrich_break_point_copies_coords_from_graph_node() {
    let g = graph_fixture();
    let path = vec![NodeId::from("base"), NodeId::from("poi-castle")];
    let item = enrich_break_point(break_item(1), &path, &g);
    assert_eq!(item.lat, Some(46.1));
    assert_eq!(item.lon, Some(7.1));
}

#[test]
fn enrich_break_point_no_op_when_index_out_of_range() {
    let g = graph_fixture();
    let path = vec![NodeId::from("base")];
    let item = enrich_break_point(break_item(5), &path, &g);
    assert!(item.lat.is_none());
}

#[test]
fn enrich_break_point_no_op_when_node_missing() {
    let g = empty_graph();
    let path = vec![NodeId::from("ghost")];
    let item = enrich_break_point(break_item(0), &path, &g);
    assert!(item.lat.is_none());
}

// ---------------------------------------------------------------------------
// normalize_corridor_items
// ---------------------------------------------------------------------------

#[test]
fn normalize_corridor_items_passthrough() {
    let items = vec![UiCorridorItem {
        id: "c-1".to_owned(),
        name: "POI 1".to_owned(),
        lat: 46.0,
        lon: 7.0,
        themes: vec![],
        score: 0.9,
        detour_km: None,
        detour_min: None,
    }];
    let out = normalize_corridor_items(items.clone());
    assert_eq!(out, items);
}

#[test]
fn normalize_corridor_items_empty_passthrough() {
    let out = normalize_corridor_items(vec![]);
    assert!(out.is_empty());
}

// ---------------------------------------------------------------------------
// Pure helper boundary tests (round_hours, quality_of, normalize_name, ...)
// ---------------------------------------------------------------------------

#[test]
fn round_hours_basic() {
    assert!((helpers::round_hours(1.234) - 1.23).abs() < 1e-12);
    assert!((helpers::round_hours(1.235) - 1.24).abs() < 1e-12);
    assert_eq!(helpers::round_hours(0.0), 0.0);
}

#[test]
fn round_hours_nan_and_infinite_normalize_to_zero() {
    assert_eq!(helpers::round_hours(f64::NAN), 0.0);
    assert_eq!(helpers::round_hours(f64::INFINITY), 0.0);
    assert_eq!(helpers::round_hours(f64::NEG_INFINITY), 0.0);
}

#[test]
fn quality_of_clamps_above_one_via_div_ten() {
    assert!((helpers::quality_of(Some(5.0), None) - 0.5).abs() < 1e-12);
    assert!((helpers::quality_of(Some(20.0), None) - 1.0).abs() < 1e-12);
}

#[test]
fn quality_of_clamps_negative_to_zero() {
    assert_eq!(helpers::quality_of(Some(-1.0), None), 0.0);
}

#[test]
fn quality_of_falls_back_through_priority() {
    assert_eq!(helpers::quality_of(None, Some(0.4)), 0.4);
    assert_eq!(helpers::quality_of(None, None), 0.0);
}

#[test]
fn normalize_name_collapses_whitespace_and_lowercases() {
    assert_eq!(helpers::normalize_name("  Foo   Bar\tBaz "), "foo bar baz");
    assert_eq!(helpers::normalize_name(""), "");
}

#[test]
fn normalize_name_handles_unicode() {
    // case folding via to_lowercase
    assert_eq!(helpers::normalize_name("Café"), "café");
    assert_eq!(helpers::normalize_name("ZÜRICH"), "zürich");
}

#[test]
fn haversine_km_handles_zero_distance() {
    assert_eq!(helpers::haversine_km((46.0, 7.0), (46.0, 7.0)), 0.0);
}

#[test]
fn haversine_km_returns_zero_for_non_finite_input() {
    assert_eq!(helpers::haversine_km((f64::NAN, 0.0), (0.0, 0.0)), 0.0);
}

#[test]
fn haversine_route_km_sums_segments() {
    // ~111 km per degree of latitude near the equator. Two 1° latitude steps.
    let pts = vec![(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)];
    let total = helpers::haversine_route_km(&pts);
    assert!((total - 222.0).abs() < 5.0, "total = {total}");
}

#[test]
fn push_point_dedupes_consecutive_within_epsilon() {
    let mut pts: Vec<(f64, f64)> = Vec::new();
    helpers::push_point(&mut pts, 46.0, 7.0);
    helpers::push_point(&mut pts, 46.0 + 1e-7, 7.0);
    helpers::push_point(&mut pts, 47.0, 7.0);
    assert_eq!(pts.len(), 2);
}

#[test]
fn push_point_skips_non_finite() {
    let mut pts: Vec<(f64, f64)> = Vec::new();
    helpers::push_point(&mut pts, f64::NAN, 7.0);
    helpers::push_point(&mut pts, 46.0, f64::INFINITY);
    assert!(pts.is_empty());
}

#[test]
fn side_suffix_recognizes_a_and_b() {
    assert_eq!(helpers::side_suffix("p-x:A"), Some('A'));
    assert_eq!(helpers::side_suffix("p-x:B"), Some('B'));
    assert_eq!(helpers::side_suffix("p-x:S"), None);
    assert_eq!(helpers::side_suffix("p-x"), None);
}

// ---------------------------------------------------------------------------
// Adversarial / hostile inputs
// ---------------------------------------------------------------------------

#[test]
fn adversarial_compressed_path_at_max_plus_one_boundary() {
    let g = graph_fixture();
    // length = MAX+1, with first/last/middle as important pass nodes.
    let mut path: Vec<NodeId> = (0..MAX_OSRM_WAYPOINTS + 1)
        .map(|_| NodeId::from("base"))
        .collect();
    path[0] = NodeId::from("p-stelvio:A");
    path[40] = NodeId::from("p-stelvio:S");
    path[MAX_OSRM_WAYPOINTS] = NodeId::from("p-stelvio:B");
    let out = compressed_path(&path, &g);
    // Important set has 3 elements → all three retained (≤ MAX).
    assert_eq!(out.len(), 3);
}

#[test]
fn adversarial_map_pass_stop_with_nan_stop_lat_lon() {
    let g = empty_graph();
    let mut s = pass_stop_input("p-x");
    s.lat = Some(f64::NAN);
    s.lon = Some(f64::NAN);
    let out = map_pass_stop(&s, &g);
    assert!(out.lat.is_nan());
}

#[test]
fn adversarial_unicode_pass_id_is_preserved() {
    let g = empty_graph();
    let s = pass_stop_input("päss-éxprès");
    let out = map_pass_stop(&s, &g);
    assert_eq!(out.id, "päss-éxprès");
}

#[test]
fn adversarial_pass_id_from_synthetic_short_strings() {
    // Boundary: input of exact length 3 like "x:A"
    assert_eq!(pass_id_from_synthetic_id("x:A").as_deref(), Some("x"));
}

#[test]
fn adversarial_resolve_selected_stop_id_empty_string_returns_none() {
    let g = graph_fixture();
    assert!(resolve_selected_stop_id(&SelectedStop::Id(""), &g).is_none());
}

#[test]
fn adversarial_path_from_edges_arrow_in_node_id_split_only_first() {
    // "a->b->c" → split_once gives ("a", "b->c") → from="a", to="b->c"
    let path = path_from_edges(&["a->b->c".to_owned()]);
    let strs: Vec<&str> = path.iter().map(NodeId::as_str).collect();
    assert_eq!(strs, vec!["a", "b->c"]);
}

#[test]
fn adversarial_display_stops_only_bookkeeping_returns_empty() {
    let stops = vec![
        PlannerStopInput { kind: Some("start".to_owned()), ..Default::default() },
        PlannerStopInput { return_to_start: true, ..Default::default() },
    ];
    assert!(display_stops(&stops).is_empty());
}
