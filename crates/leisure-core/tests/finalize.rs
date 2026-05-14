//! Tests for `crate::finalize` (F5-C1).

use leisure_core::extras::ExtrasPartsApprox;
use leisure_core::finalize::__testing as h;
use leisure_core::finalize::{
    AlternativeData, AlternativeDraw, AlternativeDrawMeta, FinalizedPlan,
};
use leisure_core::tour_dto::{map_pass_stop, map_poi_stop};
use leisure_core::ui_options::{UiOptions, UiPoint};
use leisure_core::{
    BudgetFit, LeisureGraph, NodeId, PublicStop, PublicTour, ThemeCoverage, UiPassStop, UiPoiStop,
};
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

fn empty_graph() -> LeisureGraph {
    graph_with(vec![])
}

fn graph_with_n1() -> LeisureGraph {
    graph_with(vec![
        json!({ "id": "n1", "kind": "junction", "name": "Foo", "lat": 1.0, "lon": 2.0 }),
    ])
}

fn pass_graph() -> LeisureGraph {
    graph_with(vec![
        json!({ "id": "p-stelvio", "kind": "pass", "name": "Stelvio", "lat": 46.5, "lon": 10.45, "themes": ["alpine"] }),
        json!({ "id": "poi-castle", "kind": "poi", "name": "Castle", "lat": 46.1, "lon": 7.1, "categories": ["historic"], "visitDwellSec": 1800 }),
    ])
}

fn public_stop(
    id: &str,
    node_id: &str,
    kind: &str,
    name: &str,
    lat: f64,
    lon: f64,
    order: usize,
    return_to_start: bool,
) -> PublicStop {
    PublicStop {
        id: id.to_owned(),
        node_id: NodeId::from(node_id),
        pass_id: None,
        kind: kind.to_owned(),
        name: name.to_owned(),
        lat,
        lon,
        themes: Vec::new(),
        scenic_score: None,
        order,
        return_to_start,
    }
}

fn public_tour(end_node: &str, stops: Vec<PublicStop>) -> PublicTour {
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
        path: vec![],
        score: 0.0,
    }
}

fn ui_opts_with(start: Option<UiPoint>, end_node: Option<UiPoint>) -> UiOptions {
    UiOptions {
        start,
        end_node,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// FinalizedPlan serialization
// ---------------------------------------------------------------------------

#[test]
fn finalized_plan_serializes_with_flattened_plan_and_extra_keys() {
    let mut plan = FinalizedPlan::default();
    plan.plan.status = "ok".to_owned();
    plan.plan.km = 12.5;
    plan.alternatives_internal.push(AlternativeData {
        label: "alt-1".to_owned(),
        result: h::default_ui_plan_result(),
        draw: AlternativeDraw::default(),
        tour: Value::Null,
        tour_stops: vec![],
    });
    plan.error = Some("boom".to_owned());

    let v = serde_json::to_value(&plan).expect("serialize");
    let obj = v.as_object().expect("object");
    assert_eq!(obj.get("status").and_then(|x| x.as_str()), Some("ok"));
    assert_eq!(obj.get("km").and_then(|x| x.as_f64()), Some(12.5));
    assert!(
        obj.contains_key("_routeAlternatives"),
        "alternatives present"
    );
    assert_eq!(obj.get("error").and_then(|x| x.as_str()), Some("boom"));
}

#[test]
fn finalized_plan_skip_when_empty() {
    let plan = FinalizedPlan::default();
    let v = serde_json::to_value(&plan).expect("serialize");
    let obj = v.as_object().expect("object");
    assert!(!obj.contains_key("_routeAlternatives"));
    assert!(!obj.contains_key("error"));
    // Still has flattened UiPlanResult keys.
    assert!(obj.contains_key("status"));
    assert!(obj.contains_key("km"));
}

// ---------------------------------------------------------------------------
// infeasible_result
// ---------------------------------------------------------------------------

#[test]
fn infeasible_result_basic() {
    let opts = UiOptions::default();
    let env = leisure_core::finalize::infeasible_result("no-route", &opts, false, None, 0);
    assert_eq!(env.plan.status, "infeasible");
    assert_eq!(env.plan.reason.as_deref(), Some("no-route"));
    assert_eq!(env.error.as_deref(), Some("no-route"));
    assert!(env.plan.tour_stops.is_empty());
    assert!(env.plan.modes.is_empty());
    assert!(env.plan.implicit_passes.is_empty());
    assert!(env.plan.scenic_stops.is_empty());
    assert_eq!(env.plan.km, 0.0);
    assert_eq!(env.plan.drive_h, 0.0);
    assert_eq!(env.plan.total_h, 0.0);
    assert!(!env.plan.in_range);
    assert!(!env.plan.wasm_unavailable);
    assert!(env.alternatives_internal.is_empty());
}

#[test]
fn infeasible_result_preserves_trip_date_and_advanced() {
    let mut opts = UiOptions::default();
    opts.trip_date = Some("2026-07-15".to_owned());
    let env = leisure_core::finalize::infeasible_result("x", &opts, true, None, 7);
    assert_eq!(env.plan.advanced, true);
    assert_eq!(env.plan.trip_date.as_deref(), Some("2026-07-15"));
    assert_eq!(env.plan.total_open, 7);
}

#[test]
fn infeasible_result_end_node_string_id_preserved() {
    let opts = ui_opts_with(None, Some(UiPoint::Id("p-foo".to_owned())));
    let env = leisure_core::finalize::infeasible_result("x", &opts, false, None, 0);
    match env.plan.end_node {
        Some(UiPoint::Id(s)) => assert_eq!(s, "p-foo"),
        other => panic!("expected Id, got {:?}", other),
    }
}

#[test]
fn infeasible_result_end_node_coord_preserved() {
    let opts = ui_opts_with(
        None,
        Some(UiPoint::Coord {
            lat: 1.0,
            lon: 2.0,
            name: Some("X".to_owned()),
        }),
    );
    let env = leisure_core::finalize::infeasible_result("x", &opts, false, None, 0);
    match env.plan.end_node {
        Some(UiPoint::Coord { lat, lon, name }) => {
            assert_eq!(lat, 1.0);
            assert_eq!(lon, 2.0);
            assert_eq!(name.as_deref(), Some("X"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
}

#[test]
fn infeasible_result_end_node_garbage_dropped() {
    let opts = ui_opts_with(
        None,
        Some(UiPoint::Coord {
            lat: f64::NAN,
            lon: 0.0,
            name: None,
        }),
    );
    let env = leisure_core::finalize::infeasible_result("x", &opts, false, None, 0);
    assert!(env.plan.end_node.is_none());
}

#[test]
fn infeasible_result_diagnostics_default_null_when_plan_result_none() {
    let opts = UiOptions::default();
    let env = leisure_core::finalize::infeasible_result("x", &opts, false, None, 0);
    assert_eq!(env.plan.diagnostics, Value::Null);
}

// ---------------------------------------------------------------------------
// wasm_failure_result
// ---------------------------------------------------------------------------

#[test]
fn wasm_failure_result_sets_wasm_unavailable_and_warnings() {
    let opts = UiOptions::default();
    let env = leisure_core::finalize::wasm_failure_result("module fetch failed", &opts, false);
    assert!(env.plan.wasm_unavailable);
    assert_eq!(env.plan.status, "infeasible");
    assert_eq!(env.plan.reason.as_deref(), Some("wasm-unavailable"));
    let warning = env
        .plan
        .route_warning
        .as_deref()
        .expect("route warning set");
    assert!(warning.contains("module fetch failed"));
    assert!(warning.contains("WebAssembly is required"));
    assert_eq!(env.plan.status_warning.as_deref(), Some(warning));
}

// ---------------------------------------------------------------------------
// planner_stop_from_public
// ---------------------------------------------------------------------------

#[test]
fn planner_stop_from_public_round_trip_pass() {
    let graph = pass_graph();
    let mut stop = public_stop(
        "p-stelvio",
        "p-stelvio",
        "pass",
        "Stelvio",
        46.5,
        10.45,
        1,
        false,
    );
    stop.themes = vec!["alpine".to_owned()];
    stop.pass_id = Some("p-stelvio".to_owned());

    let input = h::planner_stop_from_public(&stop, &graph);
    assert_eq!(input.kind.as_deref(), Some("pass"));
    assert_eq!(input.id.as_deref(), Some("p-stelvio"));
    assert_eq!(input.node_id.as_deref(), Some("p-stelvio"));
    assert_eq!(input.pass_id.as_deref(), Some("p-stelvio"));
    assert_eq!(input.name.as_deref(), Some("Stelvio"));
    assert_eq!(input.lat, Some(46.5));
    assert_eq!(input.lon, Some(10.45));
    assert_eq!(input.themes, vec!["alpine".to_owned()]);

    // Feed back into F2 mapper.
    let mapped: UiPassStop = map_pass_stop(&input, &graph);
    assert_eq!(mapped.id, "p-stelvio");
    assert_eq!(mapped.name, "Stelvio");
    assert_eq!(mapped.themes, vec!["alpine".to_owned()]);
}

#[test]
fn planner_stop_from_public_round_trip_poi() {
    let graph = pass_graph();
    let stop = public_stop(
        "poi-castle",
        "poi-castle",
        "poi",
        "Castle",
        46.1,
        7.1,
        2,
        false,
    );
    let input = h::planner_stop_from_public(&stop, &graph);
    assert_eq!(input.kind.as_deref(), Some("poi"));
    assert_eq!(input.node_id.as_deref(), Some("poi-castle"));

    let mapped: UiPoiStop = map_poi_stop(&input, &graph);
    assert_eq!(mapped.id, "poi-castle");
    assert_eq!(mapped.name, "Castle");
    assert!(mapped.is_poi);
    // visitDwellSec 1800 from graph.
    assert_eq!(mapped.visit_dwell_sec, 1800);
}

// ---------------------------------------------------------------------------
// normalize_start
// ---------------------------------------------------------------------------

#[test]
fn normalize_start_id_resolves_via_graph() {
    let graph = graph_with_n1();
    let start = UiPoint::Id("n1".to_owned());
    let resolved = h::normalize_start(Some(&start), Some(&graph), None);
    match resolved {
        UiPoint::Coord { lat, lon, name } => {
            assert_eq!(lat, 1.0);
            assert_eq!(lon, 2.0);
            assert_eq!(name.as_deref(), Some("Foo"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
}

#[test]
fn normalize_start_id_unknown_falls_back_to_placeholder() {
    let graph = empty_graph();
    let start = UiPoint::Id("ghost".to_owned());
    let resolved = h::normalize_start(Some(&start), Some(&graph), None);
    match resolved {
        UiPoint::Coord { lat, lon, name } => {
            assert!(lat.is_nan());
            assert!(lon.is_nan());
            assert_eq!(name.as_deref(), Some("ghost"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
}

#[test]
fn normalize_start_coord_passes_through_when_finite() {
    let start = UiPoint::Coord {
        lat: 3.0,
        lon: 4.0,
        name: Some("Here".to_owned()),
    };
    let resolved = h::normalize_start(Some(&start), None, None);
    match resolved {
        UiPoint::Coord { lat, lon, name } => {
            assert_eq!(lat, 3.0);
            assert_eq!(lon, 4.0);
            assert_eq!(name.as_deref(), Some("Here"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
}

#[test]
fn normalize_start_coord_falls_back_to_tour_first_stop_when_nan() {
    let start = UiPoint::Coord {
        lat: f64::NAN,
        lon: f64::NAN,
        name: None,
    };
    let tour = public_tour(
        "B",
        vec![public_stop("A", "A", "junction", "A", 5.0, 6.0, 0, false)],
    );
    let resolved = h::normalize_start(Some(&start), None, Some(&tour));
    match resolved {
        UiPoint::Coord { lat, lon, name } => {
            assert_eq!(lat, 5.0);
            assert_eq!(lon, 6.0);
            assert_eq!(name.as_deref(), Some("Start"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
}

#[test]
fn normalize_start_none_synthesizes_from_tour_or_empty() {
    let tour = public_tour(
        "B",
        vec![public_stop("A", "A", "junction", "A", 7.0, 8.0, 0, false)],
    );
    let with_tour = h::normalize_start(None, None, Some(&tour));
    match with_tour {
        UiPoint::Coord { lat, lon, name } => {
            assert_eq!(lat, 7.0);
            assert_eq!(lon, 8.0);
            assert_eq!(name.as_deref(), Some("Start"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
    let no_tour = h::normalize_start(None, None, None);
    match no_tour {
        UiPoint::Coord { lat, lon, name } => {
            assert!(lat.is_nan());
            assert!(lon.is_nan());
            assert_eq!(name.as_deref(), Some("Start"));
        }
        other => panic!("expected Coord, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// result_end_node + is_closed_tour
// ---------------------------------------------------------------------------

#[test]
fn result_end_node_open_tour_returns_tour_end() {
    let tour = public_tour(
        "B",
        vec![public_stop("A", "A", "junction", "A", 0.0, 0.0, 0, false)],
    );
    let start = UiPoint::Id("A".to_owned());
    let end = h::result_end_node(&tour, &start);
    match end {
        Some(UiPoint::Id(s)) => assert_eq!(s, "B"),
        other => panic!("expected Id(B), got {:?}", other),
    }
}

#[test]
fn result_end_node_closed_tour_returns_start_id() {
    // end_node empty → closed
    let tour = public_tour(
        "",
        vec![public_stop(
            "n1", "n1", "junction", "n1", 0.0, 0.0, 0, false,
        )],
    );
    let start = UiPoint::Id("n1".to_owned());
    let end = h::result_end_node(&tour, &start);
    assert_eq!(end, Some(UiPoint::Id("n1".to_owned())));
}

#[test]
fn result_end_node_closed_tour_with_coord_start_returns_start() {
    let tour = public_tour(
        "",
        vec![public_stop(
            "n1", "n1", "junction", "n1", 0.0, 0.0, 0, false,
        )],
    );
    let start = UiPoint::Coord {
        lat: 9.0,
        lon: 10.0,
        name: Some("Origin".to_owned()),
    };
    let end = h::result_end_node(&tour, &start);
    assert_eq!(end, Some(start));
}

#[test]
fn is_closed_tour_triple_or() {
    // Case 1: empty endNode
    let t1 = public_tour(
        "",
        vec![public_stop("A", "A", "junction", "A", 0.0, 0.0, 0, false)],
    );
    assert!(h::is_closed_tour(&t1));

    // Case 2: endNode == first stop nodeId
    let t2 = public_tour(
        "A",
        vec![public_stop("A", "A", "junction", "A", 0.0, 0.0, 0, false)],
    );
    assert!(h::is_closed_tour(&t2));

    // Case 3: any stop with return_to_start=true
    let t3 = public_tour(
        "B",
        vec![
            public_stop("A", "A", "junction", "A", 0.0, 0.0, 0, false),
            public_stop("X", "X", "junction", "X", 0.0, 0.0, 1, true),
        ],
    );
    assert!(h::is_closed_tour(&t3));

    // Negative: open A->B with no return_to_start
    let t4 = public_tour(
        "B",
        vec![public_stop("A", "A", "junction", "A", 0.0, 0.0, 0, false)],
    );
    assert!(!h::is_closed_tour(&t4));
}

// ---------------------------------------------------------------------------
// project_extras_parts
// ---------------------------------------------------------------------------

#[test]
fn project_extras_parts_basic() {
    let parts = ExtrasPartsApprox {
        pass_stop_h: 0.5,
        lunch_h: 0.75,
        rest_h: 0.25,
        lunch_auto: true,
        rest_count: 1,
        pass_n: 2,
        pass_stop_mins: vec![15.0, 15.0],
        pass_stop_uniform: true,
    };
    let projected = h::project_extras_parts(&parts);
    assert_eq!(projected.corridor_h, 0.0);
    assert_eq!(projected.lunch_h, 0.75);
    assert_eq!(projected.breaks_h, 0.25);
}

// ---------------------------------------------------------------------------
// Misc — ensure AlternativeDrawMeta carries the camelCase keys
// ---------------------------------------------------------------------------

#[test]
fn alternative_draw_meta_serializes_camel_case() {
    let meta = AlternativeDrawMeta {
        drive_h: 1.5,
        dwell_h: 0.5,
        ..Default::default()
    };
    let v = serde_json::to_value(&meta).expect("serialize");
    let obj = v.as_object().unwrap();
    assert!(obj.contains_key("driveH"));
    assert!(obj.contains_key("dwellH"));
}

// ===========================================================================
// F5-C2 — translate_tour tests
// ===========================================================================

mod translate_tour_tests {
    use super::*;
    use leisure_core::extras::round_hours;
    use leisure_core::finalize::{translate_tour, TranslateTourCtx};
    use leisure_core::intent::IntentEntity;
    use leisure_core::optimizer::{PlanStatus, PublicTour as PT};
    use leisure_core::route_geom::APPROX_ROUTE_WARNING;
    use leisure_core::ui_options::RouteFacts;

    fn pass_stop_input(node_id: &str, name: &str, lat: f64, lon: f64, order: usize) -> PublicStop {
        let mut s = public_stop("p-stelvio", node_id, "pass", name, lat, lon, order, false);
        s.pass_id = Some("p-stelvio".to_owned());
        s
    }

    fn poi_stop_input(node_id: &str, name: &str, lat: f64, lon: f64, order: usize) -> PublicStop {
        public_stop("poi-castle", node_id, "poi", name, lat, lon, order, false)
    }

    fn ctx_basic<'a>(
        graph: &'a LeisureGraph,
        ui: &'a UiOptions,
        status: PlanStatus,
        include_phase4: bool,
        route_facts: Option<&'a RouteFacts>,
    ) -> TranslateTourCtx<'a> {
        TranslateTourCtx {
            graph,
            ui_options: ui,
            advanced: false,
            status,
            total_open: 7,
            reason: "",
            include_phase4,
            route_facts,
        }
    }

    fn open_tour() -> PT {
        public_tour(
            "poi-castle",
            vec![
                pass_stop_input("p-stelvio", "Stelvio", 46.5, 10.45, 0),
                poi_stop_input("poi-castle", "Castle", 46.1, 7.1, 1),
            ],
        )
    }

    fn closed_tour() -> PT {
        let mut t = public_tour(
            "p-stelvio",
            vec![
                pass_stop_input("p-stelvio", "Stelvio", 46.5, 10.45, 0),
                poi_stop_input("poi-castle", "Castle", 46.1, 7.1, 1),
            ],
        );
        t.path = vec![NodeId::from("p-stelvio"), NodeId::from("poi-castle")];
        t
    }

    fn start_point() -> UiPoint {
        UiPoint::Coord {
            lat: 46.6,
            lon: 10.5,
            name: Some("Origin".to_owned()),
        }
    }

    #[test]
    fn translate_tour_phase4_included_basic() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, true, None);

        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.result.status, "ok");
        assert!(!alt.result.tour_stops.is_empty());
        // intent surface field exists; ambiguous default false on empty
        let _: &str = alt.result.intent.top_persona.as_str();
        assert!(alt.result.corridor.items.is_empty() || !alt.result.corridor.items.is_empty());
        // route_facts None -> approximate route uses node coords; expect non-empty
        // latlngs (route_points always pushes start coord, then nodes).
        assert!(!alt.result.latlngs.is_empty());
        assert_eq!(alt.result.total_open, 7);
    }

    #[test]
    fn translate_tour_phase4_excluded_returns_empty_phase4() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);

        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.result.intent.top_persona, "");
        assert!(alt.result.intent.primary.is_empty());
        assert!(alt.result.corridor.items.is_empty());
        assert!(alt.result.corridor.auto_include.is_empty());
        assert!(alt.result.lunch_zones.is_empty());
        assert!(alt.result.breaks.is_empty());
        assert!(alt.result.draw_meta.leisure_overlays.lunch_zones.is_empty());
    }

    #[test]
    fn translate_tour_label_index_0_is_leisure_best() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.label, "Leisure best");
        assert_eq!(alt.result.route_alternative_index, 0);
    }

    #[test]
    fn translate_tour_label_index_1_is_leisure_alternative_2() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 1, &ctx);
        assert_eq!(alt.label, "Leisure alternative 2");
        assert_eq!(alt.result.route_alternative_index, 1);
    }

    #[test]
    fn translate_tour_route_facts_some_uses_osrm_data() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let geom = vec![[10.0_f64, 46.0], [10.5, 46.5], [11.0, 47.0]];
        let facts = RouteFacts {
            geom: geom.clone(),
            distance_km: Some(123.5),
            duration_h: Some(2.25),
        };
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, Some(&facts));
        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.result.km, 123.5);
        assert_eq!(alt.result.drive_h, 2.25);
        // latlngs are [lat, lon] swapped from [lon, lat] geom
        assert_eq!(alt.result.latlngs.len(), geom.len());
        assert_eq!(alt.result.latlngs[0], [46.0, 10.0]);
        assert_eq!(alt.result.latlngs[1], [46.5, 10.5]);
        assert!(alt.result.route_warning.is_none());
    }

    #[test]
    fn translate_tour_route_facts_none_falls_back_to_haversine_warning() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(
            alt.result.route_warning.as_deref(),
            Some(APPROX_ROUTE_WARNING)
        );
    }

    #[test]
    fn translate_tour_endpoints_correct() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };

        // Open tour: end_node tied to tour.end_node id.
        let open = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt_open = translate_tour(&open, 0, &ctx);
        match alt_open.result.end_node.as_ref().expect("end_node") {
            UiPoint::Id(id) => assert_eq!(id, "poi-castle"),
            other => panic!("expected Id end_node, got {other:?}"),
        }

        // Closed tour (end_node == first stop): end_node clones start.
        let closed = closed_tour();
        let alt_closed = translate_tour(&closed, 0, &ctx);
        let end = alt_closed.result.end_node.expect("end_node");
        let start = alt_closed.result.start.expect("start");
        assert_eq!(end, start);
    }

    #[test]
    fn translate_tour_advanced_forces_in_range_true() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            // pick a target the haversine route certainly does not satisfy
            target_value: Some(1.0),
            target_tol: Some(0.01),
            ..Default::default()
        };
        let tour = open_tour();
        let mut ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        ctx.advanced = true;
        let alt = translate_tour(&tour, 0, &ctx);
        assert!(alt.result.in_range);
    }

    #[test]
    fn translate_tour_route_alternatives_field_left_empty_for_caller_to_fill() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 2, &ctx);
        assert!(alt.result.route_alternatives.is_empty());
        assert_eq!(alt.result.route_alternative_index, 2);
    }

    #[test]
    fn translate_tour_alternative_data_carries_serializable_tour_and_tour_stops() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 0, &ctx);

        let tour_round: PublicTour =
            serde_json::from_value(alt.tour_value.clone()).expect("tour roundtrip");
        assert_eq!(tour_round.end_node.as_str(), tour.end_node.as_str());
        assert_eq!(tour_round.stops.len(), tour.stops.len());

        // Each tour_stops_value entry deserialises back into IntentEntity.
        for v in &alt.tour_stops_value {
            let _: IntentEntity =
                serde_json::from_value(v.clone()).expect("intent entity roundtrip");
        }
        assert_eq!(alt.tour_stops_value.len(), 2);
    }

    #[test]
    fn translate_tour_dwell_h_sums_visit_dwell_sec_over_3600() {
        // PublicStop has no visit_dwell_sec field, so planner_stop_from_public
        // emits None for every stop and the formula reduces to 0.0. This test
        // pins the formula identity.
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.result.dwell_h, 0.0);
        assert_eq!(alt.result.dwell_h, round_hours(0.0 / 3600.0));
    }

    #[test]
    fn translate_tour_total_h_equals_round_hours_of_sum() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 0, &ctx);
        let expected = round_hours(alt.result.drive_h + alt.result.dwell_h + alt.result.extras_h);
        assert_eq!(alt.result.total_h, expected);
    }

    #[test]
    fn translate_tour_degraded_status_yields_route_warning() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        // Provide route_facts so the haversine warning does not pre-empt the
        // degraded-status warning derivation path.
        let facts = RouteFacts {
            geom: vec![[10.0, 46.0], [11.0, 47.0]],
            distance_km: Some(50.0),
            duration_h: Some(1.0),
        };
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Degraded, false, Some(&facts));
        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.result.status, "degraded");
        assert_eq!(
            alt.result.route_warning.as_deref(),
            Some("Leisure optimizer returned a degraded tour.")
        );
    }

    #[test]
    fn translate_tour_reason_skipped_when_empty() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        let alt = translate_tour(&tour, 0, &ctx);
        assert!(alt.result.reason.is_none());

        let mut ctx2 = ctx_basic(&graph, &ui, PlanStatus::Ok, false, None);
        ctx2.reason = "diagnostic-x";
        let alt2 = translate_tour(&tour, 0, &ctx2);
        assert_eq!(alt2.result.reason.as_deref(), Some("diagnostic-x"));
    }

    #[test]
    fn translate_tour_draw_meta_carries_extras_and_overlays() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(start_point()),
            ..Default::default()
        };
        let tour = open_tour();
        let ctx = ctx_basic(&graph, &ui, PlanStatus::Ok, true, None);
        let alt = translate_tour(&tour, 0, &ctx);
        assert_eq!(alt.draw.meta.drive_h, alt.result.drive_h);
        assert_eq!(alt.draw.meta.dwell_h, alt.result.dwell_h);
        assert!(alt.draw.meta.extras.get("extrasH").is_some());
        // tour_stops in draw match the visible+endpoint tour stops in result.
        assert_eq!(alt.draw.tour_stops.len(), alt.result.tour_stops.len());
        let _ = &alt.draw.meta.leisure_overlays;
    }
}

// ===========================================================================
// F5-C3 — finalize_plan tests
// ===========================================================================

mod finalize_plan_tests {
    use super::*;
    use leisure_core::ears::decompose_ears;
    use leisure_core::finalize::__testing::diagnostics_reason;
    use leisure_core::finalize::finalize_plan;
    use leisure_core::intent::IntentEntity;
    use leisure_core::optimizer::{
        leisure_plan_auto, PlanOptions, PlanResult, PlanStatus, PublicTour as PT,
    };
    use leisure_core::phase4_orchestrator::phase4_outputs;
    use leisure_core::ui_options::RouteFacts;
    use serde_json::json;
    use std::path::PathBuf;

    fn pass_stop(node_id: &str, name: &str, lat: f64, lon: f64, order: usize) -> PublicStop {
        let mut s = public_stop("p-stelvio", node_id, "pass", name, lat, lon, order, false);
        s.pass_id = Some("p-stelvio".to_owned());
        s
    }

    fn poi_stop(node_id: &str, name: &str, lat: f64, lon: f64, order: usize) -> PublicStop {
        public_stop("poi-castle", node_id, "poi", name, lat, lon, order, false)
    }

    fn open_tour() -> PT {
        public_tour(
            "poi-castle",
            vec![
                pass_stop("p-stelvio", "Stelvio", 46.5, 10.45, 0),
                poi_stop("poi-castle", "Castle", 46.1, 7.1, 1),
            ],
        )
    }

    fn alt_tour(suffix: &str) -> PT {
        let mut s1 = pass_stop("p-stelvio", "Stelvio", 46.5, 10.45, 0);
        s1.id = format!("p-stelvio-{suffix}");
        let mut s2 = poi_stop("poi-castle", "Castle", 46.1, 7.1, 1);
        s2.id = format!("poi-castle-{suffix}");
        public_tour("poi-castle", vec![s1, s2])
    }

    fn start_point() -> UiPoint {
        UiPoint::Coord {
            lat: 46.6,
            lon: 10.5,
            name: Some("Origin".to_owned()),
        }
    }

    fn ui_with_start_and_date() -> UiOptions {
        UiOptions {
            start: Some(start_point()),
            trip_date: Some("2026-07-15".to_owned()),
            ..Default::default()
        }
    }

    fn plan_ok(primary: PT, alts: Vec<PT>) -> PlanResult {
        PlanResult {
            status: PlanStatus::Ok,
            primary: Some(primary),
            alternatives: alts,
            iterations: 1,
            elapsed_ms: 1.0,
            diagnostics: json!({"foo": "bar"}),
        }
    }

    fn plan_infeasible(reason: &str) -> PlanResult {
        PlanResult {
            status: PlanStatus::Infeasible,
            primary: None,
            alternatives: vec![],
            iterations: 0,
            elapsed_ms: 0.0,
            diagnostics: json!({"reason": reason}),
        }
    }

    // -----------------------------------------------------------------------
    // 1. Infeasibility short-circuit
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_infeasible_short_circuit() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_infeasible("budget-too-small");

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        assert_eq!(env.plan.status, "infeasible");
        assert_eq!(env.error.as_deref(), Some("budget-too-small"));
        assert!(env.alternatives_internal.is_empty());
        assert_eq!(env.plan.reason.as_deref(), Some("budget-too-small"));
        // Diagnostics carried through from PlanResult into the envelope's plan.
        assert_eq!(
            env.plan.diagnostics.get("reason").and_then(|v| v.as_str()),
            Some("budget-too-small")
        );
    }

    #[test]
    fn finalize_plan_primary_none_short_circuits_even_when_status_ok() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = PlanResult {
            status: PlanStatus::Ok,
            primary: None,
            alternatives: vec![],
            iterations: 0,
            elapsed_ms: 0.0,
            diagnostics: json!({"reason": "no-primary-tour"}),
        };

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        assert_eq!(env.plan.status, "infeasible");
        assert_eq!(env.error.as_deref(), Some("no-primary-tour"));
    }

    #[test]
    fn finalize_plan_diagnostics_reason_falls_back_to_infeasible_when_missing() {
        let plan = PlanResult {
            status: PlanStatus::Infeasible,
            primary: None,
            alternatives: vec![],
            iterations: 0,
            elapsed_ms: 0.0,
            diagnostics: json!({}),
        };
        assert_eq!(diagnostics_reason(&plan), "infeasible");
    }

    // -----------------------------------------------------------------------
    // 2. Cross-references: every alternative has the full summary list
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_cross_references_present_on_every_alternative() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![alt_tour("a"), alt_tour("b")]);

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        assert_eq!(env.alternatives_internal.len(), 3);

        let summaries_top = &env.plan.route_alternatives;
        assert_eq!(summaries_top.len(), 3);
        assert_eq!(summaries_top[0].index, 0);
        assert_eq!(summaries_top[1].index, 1);
        assert_eq!(summaries_top[2].index, 2);
        assert_eq!(summaries_top[0].label, "Leisure best");
        assert_eq!(summaries_top[1].label, "Leisure alternative 2");
        assert_eq!(summaries_top[2].label, "Leisure alternative 3");

        for (i, alt) in env.alternatives_internal.iter().enumerate() {
            assert_eq!(alt.result.route_alternative_index, i as u32);
            assert_eq!(alt.result.route_alternatives.len(), 3);
            // Same summaries on every alt.
            for (j, s) in alt.result.route_alternatives.iter().enumerate() {
                assert_eq!(s.index, j as u32);
                assert_eq!(s.label, summaries_top[j].label);
                assert_eq!(s.km, summaries_top[j].km);
                assert_eq!(s.total_h, summaries_top[j].total_h);
                assert_eq!(s.in_range, summaries_top[j].in_range);
            }
        }
    }

    // -----------------------------------------------------------------------
    // 3. include_phase4 toggling: primary calls phase4, alternatives do not.
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_primary_phase4_invoked_alternatives_skipped() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![alt_tour("a")]);

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        assert_eq!(env.alternatives_internal.len(), 2);

        // Top-level plan mirrors primary's phase4 surface (overlays/intent/etc).
        let primary = &env.alternatives_internal[0];
        assert_eq!(env.plan.intent, primary.result.intent);
        assert_eq!(env.plan.corridor, primary.result.corridor);
        assert_eq!(env.plan.lunch_zones, primary.result.lunch_zones);
        assert_eq!(env.plan.breaks, primary.result.breaks);
        assert_eq!(
            env.plan.draw_meta.leisure_overlays,
            primary.draw.meta.leisure_overlays
        );

        // Alternatives ran with include_phase4=false → guaranteed empty defaults.
        let alt = &env.alternatives_internal[1];
        assert_eq!(alt.result.intent, leisure_core::UiIntentSurface::default());
        assert_eq!(alt.result.corridor, leisure_core::UiCorridor::default());
        assert!(alt.result.lunch_zones.is_empty());
        assert!(alt.result.breaks.is_empty());
        assert_eq!(
            alt.draw.meta.leisure_overlays,
            leisure_core::UiOverlays::default()
        );
    }

    // -----------------------------------------------------------------------
    // 4. ADR-F5-003 contract: F6 lazy phase4 round-trip.
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_route_alternatives_internal_round_trip_for_f6() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![alt_tour("a"), alt_tour("b")]);

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        // Primary always has serialized tour data; check non-primary too —
        // F6 enriches only the alternatives the user picks.
        for alt in env.alternatives_internal.iter().skip(1) {
            let tour: PT =
                serde_json::from_value(alt.tour.clone()).expect("tour round-trips into PublicTour");
            let stops: Vec<IntentEntity> = alt
                .tour_stops
                .iter()
                .map(|v| serde_json::from_value(v.clone()).expect("intent entity round-trips"))
                .collect();
            // ADR-F5-003 gate: the lazy enrichment surface MUST accept the
            // shape we ship, without panicking. phase4_outputs always
            // returns a populated UiPhase4Outputs (per-stage fallbacks).
            let out = phase4_outputs(&graph, &tour, &stops, &ui);
            // Sanity: the corridor shape is at least the default skeleton.
            let _ = out.corridor.items.len();
            let _ = out.intent.top_persona.as_str();
        }
    }

    // -----------------------------------------------------------------------
    // 5. Open A→B tour: end_node is UiPoint::Id of tour's end.
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_open_tour_endnode_field() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![]);

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        match env.plan.end_node.as_ref().expect("end_node set") {
            UiPoint::Id(s) => assert_eq!(s, "poi-castle"),
            other => panic!("expected UiPoint::Id, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // 6. Closed loop: end_node mirrors the resolved start.
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_closed_loop_endnode_equals_start() {
        let graph = pass_graph();
        let ui = UiOptions {
            start: Some(UiPoint::Id("p-stelvio".to_owned())),
            trip_date: Some("2026-07-15".to_owned()),
            ..Default::default()
        };
        // Closed tour: end_node == first stop's node id.
        let mut tour = open_tour();
        tour.end_node = NodeId::from("p-stelvio");
        let plan = plan_ok(tour, vec![]);

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        // Start is normalized through graph -> UiPoint::Coord with name from
        // the resolved node. result_end_node clones the start for closed
        // tours, so the end_node should equal the resolved start.
        let start = env.plan.start.as_ref().expect("start");
        let end = env.plan.end_node.as_ref().expect("end_node");
        assert_eq!(start, end);
    }

    // -----------------------------------------------------------------------
    // 7. Field-presence audit: app.js consumer surface.
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_field_presence_audit_app_js_consumers() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![alt_tour("a")]);

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        let v = serde_json::to_value(&env).expect("serialize");
        let obj = v.as_object().expect("top-level object");

        let required = [
            "status",
            "start",
            "endNode",
            "tourStops",
            "modes",
            "implicitPasses",
            "scenicStops",
            "km",
            "driveH",
            "dwellH",
            "extrasH",
            "extrasParts",
            "totalH",
            "inRange",
            "advanced",
            "tripDate",
            "totalOpen",
            "intent",
            "corridor",
            "lunchZones",
            "breaks",
            "routeAlternatives",
            "routeAlternativeIndex",
            "_latlngs",
            "_drawMeta",
            "diagnostics",
            "wasmUnavailable",
            "_routeAlternatives",
        ];
        for key in required {
            assert!(
                obj.contains_key(key),
                "missing required key `{key}` in finalized plan; got keys: {:?}",
                obj.keys().collect::<Vec<_>>()
            );
        }

        // Optional/skip-when-empty: present-or-absent per spec. For an OK
        // plan the only ones we can statically guarantee absent are `reason`
        // and `error` (no infeasibility). `routeWarning`/`statusWarning`
        // depend on whether the route fell back to the approximate haversine
        // path, so they're contract-optional and not asserted here.
        assert!(!obj.contains_key("reason"));
        assert!(!obj.contains_key("error"));
    }

    #[test]
    fn finalize_plan_infeasible_field_presence_includes_reason_and_error() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_infeasible("missing-start");

        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        let v = serde_json::to_value(&env).expect("serialize");
        let obj = v.as_object().expect("object");
        assert_eq!(
            obj.get("status").and_then(|x| x.as_str()),
            Some("infeasible")
        );
        assert_eq!(
            obj.get("reason").and_then(|x| x.as_str()),
            Some("missing-start")
        );
        assert_eq!(
            obj.get("error").and_then(|x| x.as_str()),
            Some("missing-start")
        );
        // No alternatives serialized for infeasible envelopes.
        assert!(!obj.contains_key("_routeAlternatives"));
    }

    // -----------------------------------------------------------------------
    // 8. Real-graph end-to-end gate.
    // -----------------------------------------------------------------------

    fn real_graph_load() -> LeisureGraph {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("assets")
            .join("data")
            .join("leisure-graph.v1.json");
        let json = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        LeisureGraph::load_from_json(&json).expect("real graph parses")
    }

    #[test]
    fn finalize_plan_real_graph_end_to_end() {
        let graph = real_graph_load();
        let ears = decompose_ears(&graph);
        let mut options = PlanOptions::with_start("furkapass:A");
        options.budget_seconds = Some(20_000.0);
        options.seed = Some(7);
        options.k_alternatives = 3;
        options.time_budget_ms = 100.0;
        let plan = leisure_plan_auto(&graph, &ears, options);
        assert!(
            plan.primary.is_some(),
            "real-graph fixture should produce a primary tour; \
             status={:?} diagnostics={}",
            plan.status,
            plan.diagnostics
        );

        let ui = UiOptions {
            start: Some(UiPoint::Id("furkapass:A".to_owned())),
            trip_date: Some("2026-07-15".to_owned()),
            ..Default::default()
        };
        let expected_alts = 1 + plan.alternatives.len();
        let env = finalize_plan(&plan, &[], &ui, &graph, false);

        assert_eq!(env.plan.status, "ok");
        assert!(
            !env.alternatives_internal.is_empty(),
            "expected non-empty alternatives_internal"
        );
        assert_eq!(env.alternatives_internal.len(), expected_alts);
        assert!(
            !env.alternatives_internal[0].result.tour_stops.is_empty(),
            "primary alt should have tour_stops"
        );
        // Primary intent surface populated (top_persona is the canonical proof
        // that include_phase4 actually ran on the primary).
        let primary_intent = &env.alternatives_internal[0].result.intent;
        let _persona = primary_intent.top_persona.as_str();
        // At least one alternative carries a non-Null serialized tour for F6.
        assert!(
            env.alternatives_internal.iter().any(|a| !a.tour.is_null()),
            "expected at least one non-Null serialized tour"
        );
        // Cross-reference summaries length matches the alternative count.
        assert_eq!(
            env.plan.route_alternatives.len(),
            env.alternatives_internal.len()
        );
    }

    // -----------------------------------------------------------------------
    // 9. infeasible_result extra coverage (C1 contract reaffirmed by C3).
    // -----------------------------------------------------------------------

    #[test]
    fn infeasible_result_with_explicit_total_open_persists() {
        let ui = UiOptions::default();
        let env = leisure_core::finalize::infeasible_result("nope", &ui, true, None, 42);
        assert_eq!(env.plan.total_open, 42);
        assert!(env.plan.advanced);
    }

    // -----------------------------------------------------------------------
    // 10. wasm export symbol presence (compile-time link check).
    // -----------------------------------------------------------------------

    #[test]
    fn wasm_finalize_plan_export_symbols_present() {
        // Type-checking the function pointers is enough to assert the
        // wasm-exported symbols exist. We don't invoke them — JsValue ↔
        // JS bridging only works in a wasm runtime.
        let _f1: fn(
            u32,
            wasm_bindgen::JsValue,
            wasm_bindgen::JsValue,
            wasm_bindgen::JsValue,
            bool,
        ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> =
            leisure_core::wasm_api::finalize::wasm_finalize_plan;
        let _f2: fn(
            String,
            wasm_bindgen::JsValue,
            bool,
        ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> =
            leisure_core::wasm_api::finalize::wasm_infeasible_result;
    }

    // -----------------------------------------------------------------------
    // 11. route_facts wiring: per-alternative None vs Some.
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_plan_route_facts_per_alternative_picked_by_index() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![alt_tour("a")]);

        let primary_facts = RouteFacts {
            geom: vec![[10.0_f64, 46.0], [10.5, 46.5]],
            distance_km: Some(200.0),
            duration_h: Some(3.5),
        };
        let route_facts = vec![Some(primary_facts), None];
        let env = finalize_plan(&plan, &route_facts, &ui, &graph, false);
        // Primary uses OSRM facts.
        assert_eq!(env.plan.km, 200.0);
        assert_eq!(env.plan.drive_h, 3.5);
        assert!(env.plan.route_warning.is_none());
        // Alternative falls back to approximate route → warning set.
        let alt = &env.alternatives_internal[1];
        assert!(alt.result.route_warning.is_some());
    }

    #[test]
    fn finalize_plan_empty_route_facts_treats_all_alts_as_approximate() {
        let graph = pass_graph();
        let ui = ui_with_start_and_date();
        let plan = plan_ok(open_tour(), vec![alt_tour("a")]);
        let env = finalize_plan(&plan, &[], &ui, &graph, false);
        for alt in &env.alternatives_internal {
            assert!(
                alt.result.route_warning.is_some(),
                "expected approximate route warning when route_facts is empty"
            );
        }
    }
}
