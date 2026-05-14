//! F6-C1 native tests for the new wasm_api extras
//! (`wasm_api::route_geom::build_route_requests` and
//! `wasm_api::tour_dto::resolve_selected_stop_ids`).
//!
//! These exercise the pure-Rust helpers behind the thin
//! `#[wasm_bindgen]` wrappers. The wasm wrappers themselves are JsValue
//! parsing facades; their underlying logic is identical to what is tested
//! here.

use leisure_core::optimizer::{PlanResult, PlanStatus, PublicTour};
use leisure_core::tour_dto::SelectedStop;
use leisure_core::ui_options::UiOptions;
use leisure_core::wasm_api::route_geom::build_route_requests;
use leisure_core::wasm_api::tour_dto::{resolve_selected_stop_ids, RawSelectedStop};
use leisure_core::{BudgetFit, LeisureGraph, NodeId, PublicStop, ThemeCoverage, UiPoint};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn graph_with(nodes: Vec<Value>) -> LeisureGraph {
    LeisureGraph::load_from_json(
        &json!({
            "version": "test",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "stats": { "nodes": nodes.len(), "edges": 0 },
            "nodes": nodes,
            "edges": [],
        })
        .to_string(),
    )
    .expect("graph parses")
}

fn pass_graph_fixture() -> LeisureGraph {
    graph_with(vec![
        json!({ "id": "base", "kind": "junction", "name": "Base", "lat": 46.0, "lon": 7.0 }),
        json!({ "id": "p-stelvio", "kind": "pass", "name": "Stelvio", "lat": 46.5, "lon": 10.45, "scenicScore": 0.9 }),
        json!({ "id": "p-stelvio:S", "kind": "pass-summit", "name": "Stelvio Summit", "lat": 46.5, "lon": 10.45, "passId": "p-stelvio" }),
        json!({ "id": "p-stelvio:A", "kind": "pass-base", "name": "Stelvio A", "lat": 46.4, "lon": 10.4, "passId": "p-stelvio", "side": "A" }),
        json!({ "id": "p-stelvio:B", "kind": "pass-base", "name": "Stelvio B", "lat": 46.6, "lon": 10.5, "passId": "p-stelvio", "side": "B" }),
        json!({ "id": "poi-castle", "kind": "poi", "name": "Castle", "lat": 46.1, "lon": 7.1 }),
    ])
}

fn public_stop(node_id: &str, lat: f64, lon: f64, order: usize) -> PublicStop {
    PublicStop {
        id: node_id.to_owned(),
        node_id: NodeId::from(node_id),
        pass_id: None,
        kind: "junction".to_owned(),
        name: node_id.to_owned(),
        lat,
        lon,
        themes: vec![],
        scenic_score: None,
        order,
        return_to_start: false,
    }
}

fn public_tour(end_node: &str, stops: Vec<PublicStop>, path: Vec<&str>) -> PublicTour {
    PublicTour {
        end_node: NodeId::from(end_node),
        stops,
        edges: vec![],
        total_leisure_cost: 0.0,
        total_distance_km: 0.0,
        total_duration_h: 0.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: vec![],
        theme_coverage: ThemeCoverage {
            requested: vec![],
            covered_themes: vec![],
            covered_requested: vec![],
            ratio: 0.0,
            score: 0.0,
        },
        budget_fit: BudgetFit {
            mode: "seconds".to_owned(),
            budget: 0.0,
            used: 0.0,
            remaining: 0.0,
            ratio: 0.0,
            within: true,
        },
        path: path.into_iter().map(NodeId::from).collect(),
        score: 0.0,
    }
}

fn plan_result(
    status: PlanStatus,
    primary: Option<PublicTour>,
    alternatives: Vec<PublicTour>,
) -> PlanResult {
    PlanResult {
        status,
        primary,
        alternatives,
        iterations: 0,
        elapsed_ms: 0.0,
        diagnostics: serde_json::Value::Null,
    }
}

// ---------------------------------------------------------------------------
// build_route_requests — the route_geom wasm-export helper
// ---------------------------------------------------------------------------

#[test]
fn build_route_requests_three_stop_tour_emits_lon_lat_pairs() {
    // 3-stop tour A→B→C: build_route_request walks the path and emits
    // [lon, lat] pairs in OSRM order. The returned RouteRequest list has
    // exactly one entry (primary only; no alternatives provided).
    let graph = graph_with(vec![
        json!({ "id": "A", "kind": "junction", "name": "A", "lat": 46.0, "lon": 7.0 }),
        json!({ "id": "B", "kind": "junction", "name": "B", "lat": 47.0, "lon": 8.0 }),
        json!({ "id": "C", "kind": "junction", "name": "C", "lat": 48.0, "lon": 9.0 }),
    ]);
    let primary = public_tour(
        "C",
        vec![
            public_stop("A", 46.0, 7.0, 0),
            public_stop("B", 47.0, 8.0, 1),
            public_stop("C", 48.0, 9.0, 2),
        ],
        vec!["A", "B", "C"],
    );
    let pr = plan_result(PlanStatus::Ok, Some(primary), vec![]);
    let ui = UiOptions {
        start: Some(UiPoint::Coord {
            lat: 46.0,
            lon: 7.0,
            name: None,
        }),
        ..UiOptions::default()
    };

    let requests = build_route_requests(&graph, &pr, &ui);

    assert_eq!(requests.len(), 1, "primary-only plan ⇒ one request");
    let coords = &requests[0].coords;
    assert!(
        coords.len() >= 3,
        "expected ≥3 coords for A→B→C, got {}",
        coords.len()
    );
    // Verify [lon, lat] order on the first coord (start = (46.0, 7.0)).
    assert_eq!(coords[0], [7.0, 46.0], "first coord must be [lon, lat]");
    // Walk down the path: each pair is [lon, lat].
    let last = coords.last().expect("tour has coords");
    assert_eq!(
        last,
        &[9.0, 48.0],
        "last coord must be [lon=9, lat=48] for C"
    );
}

#[test]
fn build_route_requests_emits_one_per_alternative_in_order() {
    // PlanResult with primary + 2 alternatives ⇒ 3 RouteRequests, in
    // order [primary, alt0, alt1].
    let graph = graph_with(vec![
        json!({ "id": "A", "kind": "junction", "name": "A", "lat": 46.0, "lon": 7.0 }),
        json!({ "id": "B", "kind": "junction", "name": "B", "lat": 47.0, "lon": 8.0 }),
        json!({ "id": "C", "kind": "junction", "name": "C", "lat": 48.0, "lon": 9.0 }),
    ]);
    let primary = public_tour(
        "B",
        vec![
            public_stop("A", 46.0, 7.0, 0),
            public_stop("B", 47.0, 8.0, 1),
        ],
        vec!["A", "B"],
    );
    let alt1 = public_tour(
        "C",
        vec![
            public_stop("A", 46.0, 7.0, 0),
            public_stop("C", 48.0, 9.0, 1),
        ],
        vec!["A", "C"],
    );
    let alt2 = public_tour(
        "B",
        vec![
            public_stop("C", 48.0, 9.0, 0),
            public_stop("B", 47.0, 8.0, 1),
        ],
        vec!["C", "B"],
    );
    let pr = plan_result(PlanStatus::Ok, Some(primary), vec![alt1, alt2]);
    let ui = UiOptions::default();

    let requests = build_route_requests(&graph, &pr, &ui);

    assert_eq!(requests.len(), 3, "primary + 2 alternatives ⇒ 3 requests");
    // Primary ends at B → its last coord is B = [8, 47].
    assert_eq!(requests[0].coords.last(), Some(&[8.0, 47.0]));
    // First alternative ends at C → last coord is C = [9, 48].
    assert_eq!(requests[1].coords.last(), Some(&[9.0, 48.0]));
    // Second alternative ends at B → last coord is B = [8, 47].
    assert_eq!(requests[2].coords.last(), Some(&[8.0, 47.0]));
}

#[test]
fn build_route_requests_infeasible_returns_empty() {
    let graph = graph_with(vec![
        json!({ "id": "A", "kind": "junction", "name": "A", "lat": 0.0, "lon": 0.0 }),
    ]);
    let pr = plan_result(PlanStatus::Infeasible, None, vec![]);
    let ui = UiOptions::default();

    let requests = build_route_requests(&graph, &pr, &ui);

    assert!(requests.is_empty(), "Infeasible status ⇒ no requests");
}

#[test]
fn build_route_requests_no_primary_returns_empty() {
    // status=Ok but primary=None (defensive: shouldn't happen in practice
    // but the JS shim caller may pass it).
    let graph = graph_with(vec![
        json!({ "id": "A", "kind": "junction", "name": "A", "lat": 0.0, "lon": 0.0 }),
    ]);
    let pr = plan_result(PlanStatus::Ok, None, vec![]);
    let ui = UiOptions::default();

    let requests = build_route_requests(&graph, &pr, &ui);

    assert!(requests.is_empty(), "primary=None ⇒ no requests");
}

#[test]
fn build_route_requests_falls_back_to_first_stop_when_ui_start_absent() {
    // UiOptions.start = None ⇒ normalize_start derives the start from the
    // primary tour's first stop. The first emitted coord must therefore
    // be the first stop's coord ([lon, lat]).
    let graph = graph_with(vec![
        json!({ "id": "A", "kind": "junction", "name": "A", "lat": 46.0, "lon": 7.0 }),
        json!({ "id": "B", "kind": "junction", "name": "B", "lat": 47.0, "lon": 8.0 }),
    ]);
    let primary = public_tour(
        "B",
        vec![
            public_stop("A", 46.0, 7.0, 0),
            public_stop("B", 47.0, 8.0, 1),
        ],
        vec!["A", "B"],
    );
    let pr = plan_result(PlanStatus::Ok, Some(primary), vec![]);
    let ui = UiOptions {
        start: None,
        ..UiOptions::default()
    };

    let requests = build_route_requests(&graph, &pr, &ui);

    assert_eq!(requests.len(), 1);
    let first = requests[0].coords.first().expect("non-empty");
    assert_eq!(*first, [7.0, 46.0], "fallback start = first stop coord");
}

// ---------------------------------------------------------------------------
// resolve_selected_stop_ids — the tour_dto wasm-export helper
// ---------------------------------------------------------------------------

#[test]
fn resolve_selected_stop_ids_passes_ids_through_and_drops_empty_descriptors() {
    // Locks in the upstream resolver contract: any non-empty Id passes
    // through verbatim (graph membership is NOT required), while empty
    // / fully-empty descriptors are dropped.
    let graph = pass_graph_fixture();
    let raw = vec![RawSelectedStop {
        id: Some("totally-unknown".to_owned()),
        ..Default::default()
    }];
    let resolved = resolve_selected_stop_ids(&graph, &raw);
    assert_eq!(
        resolved,
        vec!["totally-unknown".to_owned()],
        "non-empty Id passes through even when graph doesn't have it"
    );
}

#[test]
fn resolve_selected_stop_ids_resolves_known_ids_and_drops_empty() {
    let graph = pass_graph_fixture();
    let raw = vec![
        RawSelectedStop {
            id: Some("base".to_owned()),
            ..Default::default()
        },
        RawSelectedStop {
            id: Some("p-stelvio:A".to_owned()),
            ..Default::default()
        },
        // Empty descriptor — must be dropped.
        RawSelectedStop::default(),
        // Empty-string id — must be dropped.
        RawSelectedStop {
            id: Some(String::new()),
            ..Default::default()
        },
    ];

    let resolved = resolve_selected_stop_ids(&graph, &raw);

    assert_eq!(resolved, vec!["base".to_owned(), "p-stelvio:A".to_owned()]);
}

#[test]
fn resolve_selected_stop_ids_falls_back_through_id_pass_id_node_id() {
    // RawSelectedStop.to_selected_stop picks the first non-empty
    // id-shaped field, in order: id → passId → nodeId.
    let graph = pass_graph_fixture();
    let raw = vec![
        RawSelectedStop {
            id: Some(String::new()),
            pass_id: Some("p-stelvio".to_owned()),
            ..Default::default()
        },
        RawSelectedStop {
            pass_id: Some(String::new()),
            node_id: Some("base".to_owned()),
            ..Default::default()
        },
    ];

    let resolved = resolve_selected_stop_ids(&graph, &raw);

    assert_eq!(resolved.len(), 2);
    assert_eq!(resolved[0], "p-stelvio");
    assert_eq!(resolved[1], "base");
}

#[test]
fn resolve_selected_stop_ids_poi_named_resolves_via_match_by_name() {
    // No id/passId/nodeId, but name+lat+lon → SelectedStop::PoiNamed →
    // resolved by match_poi_by_name to the nearest same-name POI.
    let graph = pass_graph_fixture();
    let raw = vec![RawSelectedStop {
        name: Some("Castle".to_owned()),
        lat: Some(46.1),
        lon: Some(7.1),
        ..Default::default()
    }];

    let resolved = resolve_selected_stop_ids(&graph, &raw);

    assert_eq!(resolved, vec!["poi-castle".to_owned()]);
}

#[test]
fn raw_selected_stop_to_selected_stop_handles_all_empty_safely() {
    // Defensive: a RawSelectedStop with every field None / empty MUST
    // produce SelectedStop::Id("") (and not panic). The empty Id is then
    // rejected by resolve_selected_stop_id ⇒ caller filters it.
    let raw = RawSelectedStop::default();
    match raw.to_selected_stop() {
        SelectedStop::Id(s) => assert!(s.is_empty(), "empty descriptor → Id(\"\")"),
        SelectedStop::PoiNamed { .. } => panic!("empty descriptor must not become PoiNamed"),
    }

    // And the full pipeline drops it.
    let graph = pass_graph_fixture();
    assert!(resolve_selected_stop_ids(&graph, &[raw]).is_empty());
}

#[test]
fn resolve_selected_stop_ids_poi_named_without_coords_drops_entry() {
    // name present but lat/lon missing ⇒ PoiNamed branch can't be taken
    // (no coords to anchor match_poi_by_name) ⇒ falls through to Id("")
    // ⇒ resolver drops it.
    let graph = pass_graph_fixture();
    let raw = vec![RawSelectedStop {
        name: Some("Castle".to_owned()),
        lat: None,
        lon: None,
        ..Default::default()
    }];
    assert!(resolve_selected_stop_ids(&graph, &raw).is_empty());
}

#[test]
fn resolve_selected_stop_ids_poi_named_non_finite_coords_drops_entry() {
    // NaN/Infinity lat or lon ⇒ filtered before PoiNamed construction
    // ⇒ falls through to Id("") ⇒ resolver drops it. Prevents
    // non-deterministic match_poi_by_name results.
    let graph = pass_graph_fixture();
    let raw = vec![
        RawSelectedStop {
            name: Some("Castle".to_owned()),
            lat: Some(f64::NAN),
            lon: Some(7.1),
            ..Default::default()
        },
        RawSelectedStop {
            name: Some("Castle".to_owned()),
            lat: Some(46.1),
            lon: Some(f64::INFINITY),
            ..Default::default()
        },
    ];
    assert!(resolve_selected_stop_ids(&graph, &raw).is_empty());
}

#[test]
fn resolve_selected_stop_ids_empty_input_returns_empty() {
    let graph = pass_graph_fixture();
    assert!(resolve_selected_stop_ids(&graph, &[]).is_empty());
}
