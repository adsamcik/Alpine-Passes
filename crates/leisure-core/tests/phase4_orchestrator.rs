//! F4-C1 unit + helper tests for the phase4 orchestrator skeleton.

use leisure_core::corridor::CorridorItem;
use leisure_core::phase4_orchestrator::{intent_candidate_from_corridor_item, phase_start_time};
use leisure_core::ui_options::UiOptions;

fn ui_with_start_time(s: &str) -> UiOptions {
    UiOptions {
        start_time: Some(s.to_owned()),
        ..UiOptions::default()
    }
}

fn ui_with_trip_date(s: &str) -> UiOptions {
    UiOptions {
        trip_date: Some(s.to_owned()),
        ..UiOptions::default()
    }
}

fn sample_corridor_item() -> CorridorItem {
    CorridorItem {
        poi_id: "poi-42".to_owned(),
        poi_name: "Lac Léman Viewpoint".to_owned(),
        lat: 46.21,
        lon: 6.15,
        score: 0.875,
        themes: vec!["scenic".to_owned(), "lake".to_owned()],
        categories: vec!["viewpoint".to_owned()],
        detour_min: 4.5,
        detour_km: 1.2,
        off_route_km: 0.4,
        insertion_index: 3,
        reason: "test".to_owned(),
        plannable: true,
        render_text: None,
    }
}

#[test]
fn phase_start_time_passes_through_iso_start_time() {
    let ui = ui_with_start_time("2026-05-13T09:30:00.000Z");
    assert_eq!(phase_start_time(&ui), "2026-05-13T09:30:00.000Z");
}

#[test]
fn phase_start_time_uses_trip_date_with_default_hour() {
    let ui = ui_with_trip_date("2026-05-13");
    assert_eq!(phase_start_time(&ui), "2026-05-13T08:00:00.000Z");
}

#[test]
fn phase_start_time_returns_empty_when_both_absent() {
    let ui = UiOptions::default();
    assert_eq!(phase_start_time(&ui), "");
}

#[test]
fn phase_start_time_ignores_malformed_trip_date() {
    let ui = ui_with_trip_date("2026/05/13");
    assert_eq!(phase_start_time(&ui), "");
}

#[test]
fn phase_start_time_falls_through_malformed_start_to_trip_date() {
    let ui = UiOptions {
        start_time: Some("2026/05/13T09:00".to_owned()),
        trip_date: Some("2026-05-13".to_owned()),
        ..UiOptions::default()
    };
    assert_eq!(phase_start_time(&ui), "2026-05-13T08:00:00.000Z");
}

#[test]
fn phase_start_time_rejects_multibyte_at_boundary_without_panic() {
    // Regression: byte-10 of "2025-01-0ä..." is the second byte of the
    // 'ä' codepoint, not a char boundary. The old str-slicing implementation
    // would panic; the byte-only validator must return "" cleanly.
    let ui = ui_with_start_time("2025-01-0\u{00e4}T08:00:00Z");
    assert_eq!(phase_start_time(&ui), "");
}

#[test]
fn phase_start_time_prefers_start_time_over_trip_date() {
    let ui = UiOptions {
        start_time: Some("2026-05-13T09:30:00.000Z".to_owned()),
        trip_date: Some("2030-01-01".to_owned()),
        ..UiOptions::default()
    };
    assert_eq!(phase_start_time(&ui), "2026-05-13T09:30:00.000Z");
}

#[test]
fn intent_candidate_from_corridor_item_maps_basic_fields() {
    let item = sample_corridor_item();
    let cand = intent_candidate_from_corridor_item(&item);
    assert_eq!(cand.poi_id, "poi-42");
    assert_eq!(cand.id, "poi-42");
    assert_eq!(cand.kind, "poi");
    assert_eq!(cand.name, "Lac Léman Viewpoint");
    assert!((cand.score - 0.875).abs() < 1e-12);
    assert_eq!(cand.themes, vec!["scenic".to_owned(), "lake".to_owned()]);
    assert_eq!(cand.categories, vec!["viewpoint".to_owned()]);
    assert!(cand.viewpoints.is_empty());
}

#[test]
fn intent_candidate_from_corridor_item_clones_themes_and_categories() {
    let mut item = sample_corridor_item();
    let cand = intent_candidate_from_corridor_item(&item);
    // Mutating the source must not affect the candidate.
    item.themes.push("mutated".to_owned());
    item.categories.push("mutated".to_owned());
    assert_eq!(cand.themes.len(), 2);
    assert_eq!(cand.categories.len(), 1);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn safe_phase_returns_body_value_on_happy_path() {
    let out = leisure_core::phase4_orchestrator::__test_safe_phase_happy(42_i32);
    assert_eq!(out, 42);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn safe_phase_returns_fallback_on_panic() {
    // Suppress the default panic backtrace noise during this controlled panic.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let out = leisure_core::phase4_orchestrator::__test_safe_phase_with_panicking_body(
        "test-stage",
        99_i32,
    );
    std::panic::set_hook(prev);
    assert_eq!(out, 99);
}

use leisure_core::graph::LeisureGraph;
use leisure_core::intent::{
    IntentDistribution, SurfaceIntentDiagnostics, SurfaceIntentItem, SurfaceIntentResult,
};
use leisure_core::lunch::{LunchSuggestion, LunchZone};
use leisure_core::optimizer::{BudgetFit, PublicTour, ThemeCoverage};
use leisure_core::types::{GraphData, GraphStats, NodeId};

fn empty_graph() -> LeisureGraph {
    LeisureGraph::from_data(GraphData {
        version: "test".into(),
        generated_at: "1970-01-01T00:00:00Z".into(),
        stats: GraphStats::default(),
        nodes: Vec::new(),
        edges: Vec::new(),
    })
}

fn empty_tour() -> PublicTour {
    PublicTour {
        end_node: NodeId::from("n0"),
        stops: Vec::new(),
        edges: Vec::new(),
        total_leisure_cost: 0.0,
        total_distance_km: 0.0,
        total_duration_h: 0.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: Vec::new(),
        theme_coverage: ThemeCoverage {
            requested: Vec::new(),
            covered_themes: Vec::new(),
            covered_requested: Vec::new(),
            ratio: 0.0,
            score: 0.0,
        },
        budget_fit: BudgetFit {
            mode: String::new(),
            budget: 0.0,
            used: 0.0,
            remaining: 0.0,
            ratio: 0.0,
            within: true,
        },
        path: Vec::new(),
        score: 0.0,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn with_suppressed_panic_hook<T>(f: impl FnOnce() -> T) -> T {
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let out = f();
    std::panic::set_hook(prev_hook);
    out
}

#[test]
fn phase4_outputs_returns_complete_shape_on_minimal_inputs() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = leisure_core::phase4_orchestrator::phase4_outputs(&g, &t, &[], &ui);

    assert!(out.corridor.items.is_empty());
    assert!(out.corridor.auto_include.is_empty());
    assert!(out.lunch_zones.is_empty());
    assert!(out.breaks.is_empty());
    assert_eq!(out.intent.top_persona, "Photographer");
    assert!(out.intent.primary.is_empty());
    assert!(out.intent.serendipity.is_empty());
    assert!(out.overlays.corridor_suggestions.is_empty());
    assert!(out.overlays.corridor_auto_include.is_empty());
    assert!(out.overlays.lunch_zones.is_empty());
    assert!(out.overlays.breaks.is_empty());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_corridor_panic_returns_empty_corridor_other_stages_run() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = with_suppressed_panic_hook(|| {
        leisure_core::phase4_orchestrator::__test_phase4_with_panicking_stage(
            &g,
            &t,
            &[],
            &ui,
            "corridor",
        )
    });

    assert!(out.corridor.items.is_empty());
    assert!(out.corridor.auto_include.is_empty());
    assert!(out.overlays.corridor_suggestions.is_empty());
    assert_eq!(out.intent.top_persona, "Photographer");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_lunch_panic_returns_empty_lunch_other_stages_run() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = with_suppressed_panic_hook(|| {
        leisure_core::phase4_orchestrator::__test_phase4_with_panicking_stage(
            &g,
            &t,
            &[],
            &ui,
            "lunch",
        )
    });

    assert!(out.lunch_zones.is_empty());
    assert!(out.overlays.lunch_zones.is_empty());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_breaks_panic_returns_empty_breaks_other_stages_run() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = with_suppressed_panic_hook(|| {
        leisure_core::phase4_orchestrator::__test_phase4_with_panicking_stage(
            &g,
            &t,
            &[],
            &ui,
            "breaks",
        )
    });

    assert!(out.breaks.is_empty());
    assert!(out.overlays.breaks.is_empty());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_intent_panic_returns_default_intent_other_stages_run() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = with_suppressed_panic_hook(|| {
        leisure_core::phase4_orchestrator::__test_phase4_with_panicking_stage(
            &g,
            &t,
            &[],
            &ui,
            "intent",
        )
    });

    assert_eq!(out.intent.top_persona, "Balanced");
    assert!(out.intent.top_personas.is_empty());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_intent_surface_panic_returns_empty_primary_serendipity() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = with_suppressed_panic_hook(|| {
        leisure_core::phase4_orchestrator::__test_phase4_with_panicking_stage(
            &g,
            &t,
            &[],
            &ui,
            "intent-surface",
        )
    });

    assert!(out.intent.primary.is_empty());
    assert!(out.intent.serendipity.is_empty());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_lunch_zones_capped_at_two() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();
    let zones: Vec<LunchZone> = (0..5)
        .map(|i| LunchZone {
            id: format!("z{i}"),
            polygon: Vec::new(),
            centroid: [0.0, 0.0],
            t_arrive_min: format!("2026-05-13T{:02}:00:00.000Z", 11 + i),
            t_arrive_max: format!("2026-05-13T{:02}:30:00.000Z", 11 + i),
            candidates: Vec::new(),
            score: 1.0,
            vibe_tag: "casual".into(),
            narrative_role: None,
        })
        .collect();
    let lunch = LunchSuggestion {
        zones,
        ..LunchSuggestion::default()
    };

    let out =
        leisure_core::phase4_orchestrator::__test_phase4_with_lunch_zones(&g, &t, &[], &ui, lunch);

    assert_eq!(out.lunch_zones.len(), 2);
    assert_eq!(out.overlays.lunch_zones.len(), 2);
    assert_eq!(out.lunch_zones[0].start_h, 11.0);
    assert_eq!(out.lunch_zones[0].end_h, 11.5);
    assert_eq!(out.lunch_zones, out.overlays.lunch_zones);
    assert_eq!(out.breaks, out.overlays.breaks);
    assert_eq!(out.corridor.items, out.overlays.corridor_suggestions);
    assert_eq!(
        out.corridor.auto_include,
        out.overlays.corridor_auto_include
    );
}

#[test]
fn phase4_outputs_corridor_items_equal_overlays_corridor_suggestions() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = leisure_core::phase4_orchestrator::phase4_outputs(&g, &t, &[], &ui);

    assert_eq!(out.corridor.items, out.overlays.corridor_suggestions);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_intent_top_persona_fallback_chain() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let dist = IntentDistribution {
        top_persona: "Photographer".to_owned(),
        ..IntentDistribution::default()
    };
    let out = leisure_core::phase4_orchestrator::__test_phase4_with_hooks(
        &g,
        &t,
        &[],
        &ui,
        None,
        None,
        None,
        Some(dist),
        None,
    );
    assert_eq!(out.intent.top_persona, "Photographer");

    let surface = SurfaceIntentResult {
        diagnostics: SurfaceIntentDiagnostics {
            top_persona: "Family".to_owned(),
            ..SurfaceIntentDiagnostics::default()
        },
        ..SurfaceIntentResult::default()
    };
    let out = leisure_core::phase4_orchestrator::__test_phase4_with_hooks(
        &g,
        &t,
        &[],
        &ui,
        None,
        None,
        None,
        Some(IntentDistribution::default()),
        Some(surface),
    );
    assert_eq!(out.intent.top_persona, "Family");

    let out = leisure_core::phase4_orchestrator::__test_phase4_with_hooks(
        &g,
        &t,
        &[],
        &ui,
        None,
        None,
        None,
        Some(IntentDistribution::default()),
        Some(SurfaceIntentResult::default()),
    );
    assert_eq!(out.intent.top_persona, "Balanced");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_corridor_panic_lets_other_stages_actually_emit() {
    let injected_lunch = LunchSuggestion {
        zones: vec![LunchZone {
            id: "zone-x".into(),
            polygon: Vec::new(),
            centroid: [0.0, 0.0],
            t_arrive_min: "2026-05-13T12:00:00.000Z".into(),
            t_arrive_max: "2026-05-13T12:30:00.000Z".into(),
            candidates: Vec::new(),
            score: 1.0,
            vibe_tag: "casual".into(),
            narrative_role: None,
        }],
        ..LunchSuggestion::default()
    };

    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = with_suppressed_panic_hook(|| {
        leisure_core::phase4_orchestrator::__test_phase4_with_panicking_corridor_and_lunch_hook(
            &g,
            &t,
            &[],
            &ui,
            injected_lunch,
        )
    });

    assert!(out.corridor.items.is_empty());
    assert_eq!(out.lunch_zones.len(), 1);
    assert_eq!(out.lunch_zones[0].label.as_deref(), Some("casual"));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn intent_candidates_built_from_auto_include_chain_suggestions() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();
    let mut auto = sample_corridor_item();
    auto.poi_id = "auto-1".to_owned();
    auto.poi_name = "Auto Include".to_owned();
    auto.lat = 46.1;
    auto.lon = 7.1;
    auto.detour_km = 0.8;
    auto.detour_min = 3.0;
    auto.themes = vec!["lake".to_owned()];
    let mut suggestion = sample_corridor_item();
    suggestion.poi_id = "suggest-1".to_owned();
    suggestion.poi_name = "Suggestion".to_owned();
    suggestion.lat = 46.2;
    suggestion.lon = 7.2;
    suggestion.detour_km = 1.8;
    suggestion.detour_min = 8.0;
    suggestion.themes = vec!["scenic".to_owned()];
    let corridor = leisure_core::corridor::CorridorSuggestions {
        auto_include: vec![auto],
        suggestions: vec![suggestion],
        ..leisure_core::corridor::CorridorSuggestions::default()
    };
    let surface = SurfaceIntentResult {
        primary: vec![
            SurfaceIntentItem {
                poi_id: "auto-1".to_owned(),
                name: "Auto Include".to_owned(),
                final_score: 0.91,
                ..surface_item_defaults()
            },
            SurfaceIntentItem {
                poi_id: "suggest-1".to_owned(),
                name: "Suggestion".to_owned(),
                final_score: 0.82,
                ..surface_item_defaults()
            },
        ],
        ..SurfaceIntentResult::default()
    };

    let out = leisure_core::phase4_orchestrator::__test_phase4_with_hooks(
        &g,
        &t,
        &[],
        &ui,
        Some(corridor),
        None,
        None,
        None,
        Some(surface),
    );

    assert_eq!(out.intent.primary.len(), 2);
    assert_eq!(out.intent.primary[0].lat, 46.1);
    assert_eq!(out.intent.primary[0].lon, 7.1);
    assert_eq!(out.intent.primary[0].themes, vec!["lake".to_owned()]);
    assert_eq!(out.intent.primary[0].detour_km, Some(0.8));
    assert_eq!(out.intent.primary[0].detour_min, Some(3.0));
    assert_eq!(out.intent.primary[1].lat, 46.2);
    assert_eq!(out.intent.primary[1].lon, 7.2);
    assert_eq!(out.intent.primary[1].themes, vec!["scenic".to_owned()]);
    assert_eq!(out.intent.primary[1].detour_km, Some(1.8));
    assert_eq!(out.intent.primary[1].detour_min, Some(8.0));
}

#[cfg(not(target_arch = "wasm32"))]
fn surface_item_defaults() -> SurfaceIntentItem {
    SurfaceIntentItem {
        poi_id: String::new(),
        name: String::new(),
        score: 0.0,
        themes: Vec::new(),
        categories: Vec::new(),
        intent_match: 0.0,
        value: 0.0,
        final_score: 0.0,
        reason: String::new(),
        off_intent: false,
    }
}

// =====================================================================
// F4-C3: real-graph integration tests for the F4 Phase 4 orchestrator.
//
// SCOPE NOTE: these tests exercise `phase4_orchestrator::phase4_outputs`
// directly rather than `wasm_api::phase4::wasm_phase4_outputs`. The
// wasm-bindgen export cannot be called from a host (`cargo test`) target
// because there is no JS runtime to construct/decode `JsValue`. The
// export itself is a 6-line thin shim:
//   wasm_boundary(|| with_graph(handle, |g| {
//     let tour = parse_js(...)?;
//     let stops = parse_js_or_default(...)?;
//     let ui = parse_js_or_default(...)?;
//     Ok(phase4_outputs(g, &tour, &stops, &ui))
//   }))
// Each layer is independently covered:
//   - `wasm_api/mod.rs::parse_js` / `with_graph` — `wasm_handles.rs`
//   - `wasm_api/mod.rs` export roster — `wasm_api_parity.rs`
//   - The signature of `wasm_phase4_outputs` itself —
//     `wasm_phase4_outputs_signature_is_frozen` below (compile-time fn-ptr cast)
//   - The orchestrator body — `phase4_outputs_*` tests above (C1/C2)
// =====================================================================

#[cfg(not(target_arch = "wasm32"))]
use leisure_core::astar::{leisure_astar, AStarOptions, AStarStatus};
#[cfg(not(target_arch = "wasm32"))]
use leisure_core::intent::IntentEntity;
#[cfg(not(target_arch = "wasm32"))]
use leisure_core::optimizer::PublicStop;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::OnceLock;

// Compile-time signature check for the frozen `wasm_phase4_outputs`
// interface. Mirrors the pattern in `tests/wasm_api_parity.rs` for the
// other 12 exports. If the signature drifts, this fails to compile.
#[test]
fn wasm_phase4_outputs_signature_is_frozen() {
    use wasm_bindgen::JsValue;
    let _f: fn(u32, JsValue, JsValue, JsValue) -> Result<JsValue, JsValue> =
        leisure_core::wasm_api::phase4::wasm_phase4_outputs;
}

#[cfg(not(target_arch = "wasm32"))]
fn real_graph() -> &'static LeisureGraph {
    static GRAPH: OnceLock<LeisureGraph> = OnceLock::new();
    GRAPH.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let path = manifest
            .join("..")
            .join("..")
            .join("assets")
            .join("data")
            .join("leisure-graph.v1.json");
        let json = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        LeisureGraph::load_from_json(&json).expect("real graph fixture should parse")
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn real_planned_tour(graph: &LeisureGraph) -> PublicTour {
    // Build a real five-stop tour by routing between known fixture nodes
    // with `leisure_astar` (the same proven pattern used by
    // `tests/phase4_perf.rs::real_five_stop_tour`). We use real edges and
    // a real path so downstream stages (corridor/lunch/breaks) actually
    // have spatial context to operate on — a hand-crafted stub tour with
    // empty edges would let stages silently regress to empty output.
    let stop_ids = [
        "furkapass:A",
        "grimselpass:B",
        "sustenpass:A",
        "oberalppass:S",
        "nufenenpass-passo-della-novena:S",
    ];
    for id in stop_ids {
        assert!(
            graph.nodes.contains_key(&NodeId::from(id)),
            "fixture-required node `{id}` missing from leisure-graph.v1.json; \
             update this test if the fixture's pass ids changed"
        );
    }
    let mut path = Vec::<NodeId>::new();
    let mut edges = Vec::<String>::new();
    let mut total_duration_s = 0.0;
    let mut total_distance_m = 0.0;
    let mut total_leisure_cost = 0.0;
    for pair in stop_ids.windows(2) {
        let leg = leisure_astar(
            graph,
            &NodeId::from(pair[0]),
            &NodeId::from(pair[1]),
            &AStarOptions::default(),
        );
        assert_eq!(leg.status, AStarStatus::Ok, "{} -> {}", pair[0], pair[1]);
        if path.is_empty() {
            path.extend(leg.path.iter().cloned());
        } else {
            path.extend(leg.path.iter().skip(1).cloned());
        }
        edges.extend(
            leg.edges
                .iter()
                .filter_map(|index| graph.edges.get(*index).map(|edge| edge.canonical_id())),
        );
        total_duration_s += leg.total_duration_s;
        total_distance_m += leg.total_distance_m;
        total_leisure_cost += leg.total_leisure_cost;
    }
    let stops: Vec<PublicStop> = stop_ids
        .iter()
        .enumerate()
        .map(|(order, id)| {
            let node = graph.nodes.get(&NodeId::from(*id)).expect("checked above");
            PublicStop {
                id: (*id).to_owned(),
                node_id: node.id.clone(),
                pass_id: node.pass_id.as_ref().map(ToString::to_string),
                kind: node.kind.as_str().to_owned(),
                name: node.name.clone(),
                lat: node.lat,
                lon: node.lon,
                themes: node.themes.clone(),
                scenic_score: node.scenic_score,
                order,
                return_to_start: false,
            }
        })
        .collect();
    PublicTour {
        end_node: NodeId::from(*stop_ids.last().expect("last")),
        stops,
        edges,
        total_leisure_cost,
        total_distance_km: total_distance_m / 1000.0,
        total_duration_h: total_duration_s / 3600.0,
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
            budget: total_duration_s,
            used: total_duration_s,
            remaining: 0.0,
            ratio: 1.0,
            within: true,
        },
        path,
        score: 0.0,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn intent_entities_from_tour(tour: &PublicTour) -> Vec<IntentEntity> {
    tour.stops
        .iter()
        .map(|s| IntentEntity {
            id: Some(s.id.clone()),
            poi_id: Some(s.id.clone()),
            kind: Some(s.kind.clone()),
            name: Some(s.name.clone()),
            score: s.scenic_score,
            themes: s.themes.clone(),
            categories: Vec::new(),
            ..IntentEntity::default()
        })
        .collect()
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_real_graph_happy_path() {
    let graph = real_graph();
    let tour = real_planned_tour(graph);
    assert!(
        tour.stops.len() >= 2,
        "expected planner to produce a multi-stop tour, got {} stop(s)",
        tour.stops.len()
    );
    let tour_stops = intent_entities_from_tour(&tour);
    let ui = UiOptions {
        themes: vec!["scenic".into(), "lake".into()],
        personas: vec!["family".into()],
        trip_date: Some("2026-05-13".into()),
        tz_offset_minutes: Some(120),
        ..UiOptions::default()
    };

    let out = leisure_core::phase4_orchestrator::phase4_outputs(graph, &tour, &tour_stops, &ui);

    // Cap invariants from the spec.
    assert!(
        out.lunch_zones.len() <= 2,
        "lunch_zones must be capped at 2, got {}",
        out.lunch_zones.len()
    );
    assert!(
        out.breaks.len() <= 4,
        "breaks must be capped at 4, got {}",
        out.breaks.len()
    );
    // Overlay/outer mirror invariant (ADR-F4-003 + F4-C2 contract).
    assert_eq!(out.overlays.corridor_suggestions, out.corridor.items);
    assert_eq!(
        out.overlays.corridor_auto_include,
        out.corridor.auto_include
    );
    assert_eq!(out.overlays.lunch_zones, out.lunch_zones);
    assert_eq!(out.overlays.breaks, out.breaks);
    // Top-persona always populated (real value or "Balanced" fallback).
    assert!(
        !out.intent.top_persona.is_empty(),
        "top_persona must never be empty"
    );
    // Strength check (cross-family validator request): at least one stage
    // must emit non-empty data on a real graph + real tour, otherwise the
    // test silently passes if every stage regresses to its empty fallback.
    let some_stage_emitted = !out.corridor.items.is_empty()
        || !out.corridor.auto_include.is_empty()
        || !out.lunch_zones.is_empty()
        || !out.breaks.is_empty()
        || !out.intent.primary.is_empty()
        || !out.intent.serendipity.is_empty();
    assert!(
        some_stage_emitted,
        "no Phase 4 stage emitted any data on the real graph + planned tour; \
         this almost certainly indicates a regression in corridor/lunch/breaks/intent",
    );

    // Serializes cleanly and produces the expected camelCase top-level keys.
    let json = serde_json::to_value(&out).expect("UiPhase4Outputs must serialize");
    let object = json
        .as_object()
        .expect("UiPhase4Outputs must serialize as a JSON object");
    for key in ["corridor", "lunchZones", "breaks", "intent", "overlays"] {
        assert!(
            object.contains_key(key),
            "serialized output missing top-level `{key}` key; got keys: {:?}",
            object.keys().collect::<Vec<_>>()
        );
    }
    let overlays = object
        .get("overlays")
        .and_then(|v| v.as_object())
        .expect("overlays must be a JSON object");
    for key in [
        "lunchZones",
        "breaks",
        "corridorSuggestions",
        "corridorAutoInclude",
    ] {
        assert!(
            overlays.contains_key(key),
            "overlays missing `{key}`; got keys: {:?}",
            overlays.keys().collect::<Vec<_>>()
        );
    }
    let corridor_obj = object
        .get("corridor")
        .and_then(|v| v.as_object())
        .expect("corridor must be a JSON object");
    for key in ["items", "autoInclude"] {
        assert!(
            corridor_obj.contains_key(key),
            "corridor missing `{key}`; got keys: {:?}",
            corridor_obj.keys().collect::<Vec<_>>()
        );
    }
    let intent_obj = object
        .get("intent")
        .and_then(|v| v.as_object())
        .expect("intent must be a JSON object");
    for key in [
        "topPersona",
        "ambiguous",
        "primary",
        "serendipity",
        "topPersonas",
    ] {
        assert!(
            intent_obj.contains_key(key),
            "intent missing `{key}`; got keys: {:?}",
            intent_obj.keys().collect::<Vec<_>>()
        );
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn phase4_outputs_real_graph_with_no_personas_or_themes() {
    let graph = real_graph();
    let tour = real_planned_tour(graph);
    let tour_stops = intent_entities_from_tour(&tour);
    let ui = UiOptions::default();

    let out = leisure_core::phase4_orchestrator::phase4_outputs(graph, &tour, &tour_stops, &ui);

    // Caps still hold.
    assert!(out.lunch_zones.len() <= 2);
    assert!(out.breaks.len() <= 4);
    // The orchestrator must produce some persona via the fallback chain
    // (`intent_dist.top_persona` → `surfaced.diagnostics.top_persona` →
    // "Balanced"). It must never be empty even with empty UI inputs.
    assert!(
        !out.intent.top_persona.is_empty(),
        "top_persona must never be empty even with default UiOptions"
    );
    // Overlay mirror invariants still hold.
    assert_eq!(out.overlays.corridor_suggestions, out.corridor.items);
    assert_eq!(out.overlays.lunch_zones, out.lunch_zones);
    assert_eq!(out.overlays.breaks, out.breaks);
}

// Schema regression guard: the JS shim consumers (and downstream F6) read
// strictly camelCase keys at the top level. If a future edit accidentally
// drops `#[serde(rename_all = "camelCase")]` from `UiPhase4Outputs` or
// introduces a renamed field, this test catches it independently of any
// real-graph behavior.
#[test]
fn phase4_outputs_serializes_to_expected_camel_case_keys() {
    let g = empty_graph();
    let t = empty_tour();
    let ui = UiOptions::default();

    let out = leisure_core::phase4_orchestrator::phase4_outputs(&g, &t, &[], &ui);
    let json = serde_json::to_value(&out).expect("UiPhase4Outputs must serialize");
    let object = json
        .as_object()
        .expect("UiPhase4Outputs must serialize as a JSON object");

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort();
    let mut expected = vec!["breaks", "corridor", "intent", "lunchZones", "overlays"];
    expected.sort();
    assert_eq!(keys, expected);
}
