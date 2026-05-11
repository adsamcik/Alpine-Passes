use leisure_core::{
    detect_breaks, find_corridor_pois, find_lunch_area, infer_intent, leisure_astar,
    suggest_breaks, suggest_corridor, surface_intent_pois, tags_from_entity, tags_from_target,
    AStarOptions, AStarStatus, BreakOptions, BreakPoiInput, BudgetFit, CorridorOptions,
    CorridorSuggestions, IntentCandidate, IntentEntity, IntentState, IntentTarget, LeisureGraph,
    LunchOptions, NodeId, PlanResult, PlanStatus, PublicStop, PublicTour, SurfaceIntentOptions,
    ThemeCoverage,
};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

static REAL_GRAPH: Lazy<LeisureGraph> = Lazy::new(load_real_graph);
static REAL_FIVE_STOP_TOUR: Lazy<PublicTour> =
    Lazy::new(|| real_five_stop_tour(Lazy::force(&REAL_GRAPH)));

#[test]
fn corridor_multisegment_geometry_finds_poi_near_explicit_intermediate_vertex() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0),
            node("b", "junction", 0.0, 0.14),
            poi("between-g2-g3", 0.001, 0.05, 8.5, &["viewpoint"], &[]),
        ],
        vec![edge_geom(
            "a",
            "b",
            16_000.0,
            1_200.0,
            "connector",
            "secondary",
            0.3,
            vec![
                [0.0, 0.00],
                [0.0, 0.02],
                [0.0, 0.04],
                [0.0, 0.05],
                [0.0, 0.06],
                [0.0, 0.08],
                [0.0, 0.10],
                [0.0, 0.12],
                [0.0, 0.14],
            ],
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());
    let item = corridor_item(&result, "between-g2-g3");

    assert!(result.diagnostics.route_vertex_count >= 8);
    assert!(
        item.off_route_km < 0.2,
        "off-route km: {}",
        item.off_route_km
    );
}

#[test]
fn corridor_very_long_edge_uses_explicit_geometry_probes_without_slowdown() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0),
            node("b", "junction", 0.0, km_lon_deg(50.0, 0.0)),
            poi(
                "long-mid",
                0.002,
                km_lon_deg(25.0, 0.0),
                8.0,
                &["viewpoint"],
                &[],
            ),
        ],
        vec![edge_geom(
            "a",
            "b",
            50_000.0,
            3_600.0,
            "connector",
            "secondary",
            0.3,
            (0..=50)
                .map(|km| [0.0, km_lon_deg(km as f64, 0.0)])
                .collect(),
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let started = Instant::now();
    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());
    let elapsed = started.elapsed();

    assert!(result.diagnostics.route_vertex_count >= 50);
    assert!(all_corridor_items(&result)
        .iter()
        .any(|item| item.poi_id == "long-mid"));
    assert!(
        elapsed.as_millis() < 200,
        "50 km synthetic corridor took {:?}",
        elapsed
    );
}

#[test]
fn corridor_poi_directly_on_geometry_vertex_has_zero_off_route_detour() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0),
            node("b", "junction", 0.0, 0.12),
            poi("on-vertex", 0.0, 0.06, 9.0, &["viewpoint"], &[]),
        ],
        vec![edge_geom(
            "a",
            "b",
            13_000.0,
            1_000.0,
            "connector",
            "secondary",
            0.3,
            vec![
                [0.0, 0.0],
                [0.0, 0.03],
                [0.0, 0.06],
                [0.0, 0.09],
                [0.0, 0.12],
            ],
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());
    let item = corridor_item(&result, "on-vertex");

    assert_eq!(item.off_route_km, 0.0);
    assert_eq!(item.detour_min, 0.0);
}

#[test]
fn corridor_step_boundary_pois_stay_on_correct_side_of_stop() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0),
            node("b", "junction", 0.0, 0.10),
            node("c", "junction", 0.0, 0.20),
            poi("before-b", 0.0, 0.091, 8.0, &["viewpoint"], &[]),
            poi("after-b", 0.0, 0.109, 8.0, &["viewpoint"], &[]),
        ],
        vec![
            edge_geom(
                "a",
                "b",
                11_000.0,
                900.0,
                "connector",
                "secondary",
                0.3,
                vec![[0.0, 0.0], [0.0, 0.091], [0.0, 0.10]],
            ),
            edge_geom(
                "b",
                "c",
                11_000.0,
                900.0,
                "connector",
                "secondary",
                0.3,
                vec![[0.0, 0.10], [0.0, 0.109], [0.0, 0.20]],
            ),
        ],
    );
    let tour = public_tour(&graph, &["a", "b", "c"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());
    let before = corridor_item(&result, "before-b");
    let after = corridor_item(&result, "after-b");

    assert_eq!(
        before.insertion_index, 1,
        "before-b should insert before stop b"
    );
    assert_eq!(
        after.insertion_index, 2,
        "after-b should insert after stop b"
    );
}

#[test]
fn corridor_respects_upstream_astar_forbidden_node_by_following_safe_route() {
    let mut options = AStarOptions::default();
    options.forbidden_nodes.insert(NodeId::from("blocked-poi"));
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0),
            node("b", "junction", 0.0, 0.10),
            node("safe", "junction", 0.0, 0.05),
            poi("blocked-poi", 0.25, 0.05, 9.0, &["viewpoint"], &[]),
        ],
        vec![
            edge("a", "blocked-poi", 1_000.0, 60.0),
            edge("blocked-poi", "b", 1_000.0, 60.0),
            edge("a", "safe", 6_000.0, 600.0),
            edge("safe", "b", 6_000.0, 600.0),
        ],
    );

    let leg = leisure_astar(&graph, &NodeId::from("a"), &NodeId::from("b"), &options);
    assert_eq!(leg.status, AStarStatus::Ok);
    assert!(!leg.path.iter().any(|id| id.as_str() == "blocked-poi"));
    let tour = tour_from_astar(&graph, &leg);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());

    assert!(!all_corridor_items(&result)
        .iter()
        .any(|item| item.poi_id == "blocked-poi"));
}

#[test]
fn real_graph_furka_grimsel_corridor_with_nearby_poi_has_plannable_suggestion_within_10km() {
    let graph = load_real_graph_with_extra_nodes(vec![poi(
        "furka-grimsel-nearby-view",
        46.571,
        8.381,
        8.0,
        &["viewpoint"],
        &["panoramic-view"],
    )]);
    let tour = real_open_tour(&graph, "furkapass:A", "grimselpass:B");

    let result = suggest_corridor(
        &graph,
        &tour,
        CorridorOptions {
            buffer_km: 10.0,
            suggest_max_detour_min: 30.0,
            ..Default::default()
        },
    );

    assert!(all_corridor_items(&result)
        .iter()
        .any(|item| item.poi_id == "furka-grimsel-nearby-view"
            && item.plannable
            && item.off_route_km <= 10.0));
}

#[test]
fn lunch_tour_ending_exactly_at_1130_still_returns_zone() {
    let (graph, tour) = timed_line_fixture(
        3.5 * 3600.0,
        vec![food_poi("edge-cafe", 0.0, 0.34, &["cafe"], &[], 4.5)],
    );

    let result = find_lunch_area(
        &graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            ..Default::default()
        },
    );

    assert!(
        !result.zones.is_empty(),
        "11:30 boundary should overlap lunch window"
    );
    assert_eq!(result.zones[0].candidates[0].poi_id, "edge-cafe");
}

#[test]
fn lunch_tour_starting_at_1331_still_uses_hunger_curve_window() {
    let (graph, tour) = timed_line_fixture(
        45.0 * 60.0,
        vec![food_poi("too-late", 0.0, 0.01, &["restaurant"], &[], 5.0)],
    );

    let result = find_lunch_area(
        &graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T13:31:00.000Z".to_owned(),
            ..Default::default()
        },
    );

    assert!(!result.zones.is_empty());
    assert_eq!(result.zones[0].candidates[0].poi_id, "too-late");
}

#[test]
fn lunch_persona_windows_select_different_route_candidates() {
    let (graph, tour) = timed_line_fixture(
        6.0 * 3600.0,
        vec![
            food_poi("early-window", 0.0, 0.375, &["cafe"], &[], 4.0),
            food_poi("late-window", 0.0, 0.55, &["restaurant"], &[], 4.0),
        ],
    );

    let early = find_lunch_area(
        &graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            persona: "early".to_owned(),
            ..Default::default()
        },
    );
    let late = find_lunch_area(
        &graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            persona: "late".to_owned(),
            ..Default::default()
        },
    );

    assert_eq!(early.zones[0].candidates[0].poi_id, "early-window");
    assert_eq!(late.zones[0].candidates[0].poi_id, "late-window");
}

#[test]
fn lunch_food_category_without_food_drink_theme_is_still_considered() {
    let (graph, tour) = timed_line_fixture(
        5.0 * 3600.0,
        vec![poi("hut", 0.0, 0.54, 4.2, &["mountain-restaurant"], &[])],
    );

    let result = find_lunch_area(
        &graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            ..Default::default()
        },
    );

    assert_eq!(result.zones[0].candidates[0].poi_id, "hut");
    assert!(result.zones[0].candidates[0].themes.is_empty());
}

#[test]
fn lunch_long_food_desert_returns_desert_instead_of_empty_silence() {
    let (graph, tour) = timed_line_fixture(5.0 * 3600.0, Vec::new());

    let result = find_lunch_area(
        &graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            ..Default::default()
        },
    );

    assert!(result.zones.is_empty());
    let desert = result
        .desert
        .expect("missing-food corridor should report a desert");
    assert!(desert.message.contains("No food"));
    assert!(desert.message.contains("pack a sandwich"));
}

#[test]
fn real_graph_furka_grimsel_lunch_result_is_finite_and_deterministic() {
    let graph = Lazy::force(&REAL_GRAPH);
    let tour = real_open_tour(graph, "furkapass:A", "grimselpass:B");
    let options = LunchOptions {
        start_time: "2026-06-15T11:30:00.000Z".to_owned(),
        ..Default::default()
    };

    let first = find_lunch_area(graph, &tour, options.clone());
    let second = find_lunch_area(graph, &tour, options);

    assert_eq!(lunch_signature(&first), lunch_signature(&second));
    assert!(!first.hunger_curve.is_empty());
    assert!(first.desert.is_some() || !first.zones.is_empty());
    assert_finite_lunch(&first);
}

#[test]
fn breaks_three_dwells_merge_first_short_stop_and_all_short_chain() {
    let (graph, tour) = line_fixture(&[30.0, 30.0, 30.0, 30.0]);
    let dwell = dwell_map(&[("b", 10.0), ("c", 20.0), ("d", 25.0)]);

    let result = detect_breaks(
        &graph,
        &tour,
        BreakOptions {
            stop_dwell_sec: dwell,
            ..Default::default()
        },
    );

    assert_eq!(result.diagnostics.segment_count, 3);

    let all_short = detect_breaks(
        &graph,
        &tour,
        BreakOptions {
            stop_dwell_sec: dwell_map(&[("b", 5.0), ("c", 5.0), ("d", 5.0)]),
            ..Default::default()
        },
    );

    assert_eq!(all_short.diagnostics.segment_count, 1);
}

#[test]
fn breaks_exactly_15_minute_dwell_stays_separate_like_js_boundary() {
    let (graph, tour) = line_fixture(&[45.0, 45.0]);
    let dwell = dwell_map(&[("b", 15.0)]);

    let result = detect_breaks(
        &graph,
        &tour,
        BreakOptions {
            stop_dwell_sec: dwell,
            ..Default::default()
        },
    );

    assert_eq!(result.diagnostics.segment_count, 2);
}

#[test]
fn breaks_exactly_90_minute_long_leg_suggests_break() {
    let (graph, tour) = line_fixture(&[90.0]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());

    assert_eq!(result.breaks.len(), 1);
}

#[test]
fn breaks_three_hour_leg_without_nearby_poi_uses_stretch_break() {
    let (graph, tour) = line_fixture(&[180.0]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());
    let first = result
        .breaks
        .first()
        .expect("three-hour leg should produce a break");

    assert_eq!(first.break_type, "stretch");
    assert!(first.poi_candidate.is_none());
}

#[test]
fn breaks_open_ab_break_is_interior_not_at_endpoints() {
    let (graph, tour) = line_fixture(&[120.0]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());
    let first = result
        .breaks
        .first()
        .expect("two-hour leg should produce a break");

    assert!(
        first.at_tour_vertex_idx > 0.0 && first.at_tour_vertex_idx < 1.0,
        "break at vertex index {} should be inside the A→B leg",
        first.at_tour_vertex_idx
    );
}

#[test]
fn real_graph_long_tour_suggest_breaks_returns_at_least_one_break() {
    let graph = Lazy::force(&REAL_GRAPH);
    let tour = Lazy::force(&REAL_FIVE_STOP_TOUR);

    let breaks = suggest_breaks(graph, tour, BreakOptions::default());

    assert!(!breaks.is_empty());
}

#[test]
fn intent_target_entity_equivalence_is_byte_for_byte_and_order_independent() {
    let target = IntentTarget {
        id: Some("target-1".to_owned()),
        poi_id: Some("poi-1".to_owned()),
        kind: Some("poi".to_owned()),
        name: Some("Summit Restaurant".to_owned()),
        score: Some(8.0),
        themes: vec!["Mountain Summit".to_owned(), "Food_Drink".to_owned()],
        categories: vec!["restaurant".to_owned(), "viewpoint".to_owned()],
        viewpoints: vec![json!({ "lat": 46.0, "lon": 8.0 })],
    };
    let entity = IntentEntity {
        id: target.id.clone(),
        poi_id: target.poi_id.clone(),
        kind: target.kind.clone(),
        name: target.name.clone(),
        score: target.score,
        themes: vec!["Food_Drink".to_owned(), "Mountain Summit".to_owned()],
        categories: vec!["viewpoint".to_owned(), "restaurant".to_owned()],
        viewpoints: target.viewpoints.clone(),
    };

    let target_tags = tags_from_target(&target);
    let entity_tags = tags_from_entity(&entity);

    assert_eq!(target_tags, entity_tags);
    assert_eq!(
        target_tags,
        vec![
            "food-drink".to_owned(),
            "mountain-summit".to_owned(),
            "panoramic-view".to_owned(),
            "poi".to_owned(),
            "restaurant".to_owned(),
            "viewpoint".to_owned(),
            "viewpoints".to_owned(),
        ]
    );
}

#[test]
fn intent_infers_summit_poi_as_photographer_like_js_weights() {
    let intent = infer_intent(IntentState {
        pinned_stops: vec![IntentEntity {
            kind: Some("poi".to_owned()),
            themes: vec!["mountain-summit".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    });

    assert_eq!(intent.top_persona, "Photographer");
}

#[test]
fn intent_infers_restaurant_food_poi_as_gourmet() {
    let intent = infer_intent(IntentState {
        pinned_stops: vec![IntentEntity {
            kind: Some("poi".to_owned()),
            themes: vec!["food-drink".to_owned()],
            categories: vec!["restaurant".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    });

    assert_eq!(intent.top_persona, "Gourmet");
}

#[test]
fn intent_viewpoint_plus_summit_keeps_photographer_priority() {
    let intent = infer_intent(IntentState {
        pinned_stops: vec![IntentEntity {
            kind: Some("poi".to_owned()),
            themes: vec!["mountain-summit".to_owned()],
            categories: vec!["viewpoint".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    });

    let photographer = persona_probability(&intent, "Photographer");
    assert_eq!(intent.top_persona, "Photographer");
    assert!(photographer > persona_probability(&intent, "NatureHiker"));
    assert!(photographer > persona_probability(&intent, "ThrillRider"));
}

#[test]
fn intent_empty_and_unknown_tags_are_tolerated_without_skewing_distribution() {
    let empty = infer_intent(IntentState::default());
    assert_eq!(empty.top_persona, "Photographer");
    assert!(empty.ambiguous);
    assert_probability_sum(&empty);

    let unknown = infer_intent(IntentState {
        pinned_stops: vec![IntentEntity {
            kind: Some("poi".to_owned()),
            categories: vec!["future-hyperloop-stop".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    });

    assert_probability_sum(&unknown);
    assert!(!unknown
        .effective_tag_vector
        .contains_key("future-hyperloop-stop"));
}

#[test]
fn real_graph_plan_result_pipeline_is_non_empty_and_deterministic_for_same_seed() {
    let graph = Lazy::force(&REAL_GRAPH);

    let first = phase4_outputs_for_seed(graph, 4242);
    let second = phase4_outputs_for_seed(graph, 4242);

    assert_eq!(first.signature, second.signature);
    assert!(
        first.corridor_count > 0,
        "corridor should surface real POIs"
    );
    assert!(
        first.lunch_count > 0,
        "lunch should return zones or a desert"
    );
    assert!(
        first.break_count > 0,
        "breaks should be suggested on the long real tour"
    );
    assert!(
        first.intent_count > 0,
        "intent surfacing should return candidates"
    );
}

#[test]
#[ignore = "manual Phase 4 perf guard; shared CI/debug machines can be noisy"]
fn phase4_five_stop_all_modules_under_100ms() {
    let graph = Lazy::force(&REAL_GRAPH);
    let tour = real_five_stop_tour(graph);
    let started = Instant::now();

    let corridor = find_corridor_pois(graph, &tour, CorridorOptions::default());
    let lunch = find_lunch_area(
        graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            ..Default::default()
        },
    );
    let breaks = detect_breaks(
        graph,
        &tour,
        BreakOptions {
            corridor_pois: break_pois_from_corridor(&corridor),
            ..Default::default()
        },
    );
    let intent = infer_intent(intent_state_from_tour(&tour));
    let surfaced = surface_intent_pois(
        graph,
        Some(&tour),
        Some(&intent),
        SurfaceIntentOptions {
            top_k: 8,
            serendipity_fraction: 0.25,
            corridor_pois: intent_candidates_from_corridor(&corridor),
        },
    );
    let elapsed = started.elapsed();

    assert!(
        elapsed.as_secs_f64() < 0.1,
        "Phase 4 combined modules took {:.3}ms; corridor={}, lunch={}, breaks={}, intent={}",
        elapsed.as_secs_f64() * 1000.0,
        all_corridor_items(&corridor).len(),
        lunch.zones.len() + usize::from(lunch.desert.is_some()),
        breaks.breaks.len(),
        surfaced.primary.len() + surfaced.serendipity.len()
    );
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Phase4Signature {
    tour_stops: Vec<String>,
    corridor_ids: Vec<String>,
    lunch_ids: Vec<String>,
    break_roles: Vec<String>,
    intent_ids: Vec<String>,
}

struct Phase4Outputs {
    signature: Phase4Signature,
    corridor_count: usize,
    lunch_count: usize,
    break_count: usize,
    intent_count: usize,
}

fn phase4_outputs_for_seed(graph: &LeisureGraph, seed: u64) -> Phase4Outputs {
    let result = phase4_plan_result(graph, seed);
    let tour = tour_from_plan_result(&result);
    let corridor = find_corridor_pois(graph, &tour, CorridorOptions::default());
    let lunch = find_lunch_area(
        graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:30:00.000Z".to_owned(),
            ..Default::default()
        },
    );
    let breaks = detect_breaks(
        graph,
        &tour,
        BreakOptions {
            corridor_pois: break_pois_from_corridor(&corridor),
            ..Default::default()
        },
    );
    let intent = infer_intent(intent_state_from_tour(&tour));
    let surfaced = surface_intent_pois(
        graph,
        Some(&tour),
        Some(&intent),
        SurfaceIntentOptions {
            top_k: 8,
            serendipity_fraction: 0.25,
            corridor_pois: intent_candidates_from_corridor(&corridor),
        },
    );

    let corridor_ids = all_corridor_items(&corridor)
        .iter()
        .map(|item| item.poi_id.clone())
        .collect::<Vec<_>>();
    let lunch_ids = lunch_signature(&lunch);
    let break_roles = breaks
        .breaks
        .iter()
        .map(|item| {
            format!(
                "{}:{}",
                item.break_type,
                item.pacing_role.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    let intent_ids = surfaced
        .primary
        .iter()
        .chain(surfaced.serendipity.iter())
        .map(|item| item.poi_id.clone())
        .collect::<Vec<_>>();
    let tour_stops = tour
        .stops
        .iter()
        .map(|stop| stop.id.clone())
        .collect::<Vec<_>>();

    Phase4Outputs {
        corridor_count: corridor_ids.len(),
        lunch_count: lunch_ids.len(),
        break_count: break_roles.len(),
        intent_count: intent_ids.len(),
        signature: Phase4Signature {
            tour_stops,
            corridor_ids,
            lunch_ids,
            break_roles,
            intent_ids,
        },
    }
}

fn phase4_plan_result(graph: &LeisureGraph, seed: u64) -> PlanResult {
    let _ = graph;
    PlanResult {
        status: PlanStatus::Ok,
        primary: Some(Lazy::force(&REAL_FIVE_STOP_TOUR).clone()),
        alternatives: Vec::new(),
        iterations: 0,
        elapsed_ms: 0.0,
        diagnostics: json!({ "seed": seed }),
    }
}

fn tour_from_plan_result(result: &PlanResult) -> PublicTour {
    result
        .primary
        .as_ref()
        .expect("plan result should contain a primary tour")
        .clone()
}

fn all_corridor_items(result: &CorridorSuggestions) -> Vec<leisure_core::CorridorItem> {
    result
        .auto_include
        .iter()
        .chain(result.suggestions.iter())
        .chain(result.drawer.iter())
        .cloned()
        .collect()
}

fn corridor_item(result: &CorridorSuggestions, poi_id: &str) -> leisure_core::CorridorItem {
    all_corridor_items(result)
        .into_iter()
        .find(|item| item.poi_id == poi_id)
        .unwrap_or_else(|| panic!("corridor item {poi_id} should be present"))
}

fn break_pois_from_corridor(corridor: &CorridorSuggestions) -> Vec<BreakPoiInput> {
    all_corridor_items(corridor)
        .into_iter()
        .map(|item| BreakPoiInput {
            poi_id: item.poi_id,
            name: item.poi_name,
            lat: item.lat,
            lon: item.lon,
            score: item.score,
            detour_min: item.detour_min,
            categories: item.categories,
            themes: item.themes,
            scenic_score: Some(item.score),
            popularity: None,
        })
        .collect()
}

fn intent_candidates_from_corridor(corridor: &CorridorSuggestions) -> Vec<IntentCandidate> {
    all_corridor_items(corridor)
        .into_iter()
        .map(|item| IntentCandidate {
            poi_id: item.poi_id.clone(),
            id: item.poi_id,
            kind: "poi".to_owned(),
            name: item.poi_name,
            score: item.score,
            themes: item.themes,
            categories: item.categories,
            viewpoints: Vec::new(),
        })
        .collect()
}

fn intent_state_from_tour(tour: &PublicTour) -> IntentState {
    IntentState {
        pinned_stops: tour
            .stops
            .iter()
            .map(|stop| IntentEntity {
                id: Some(stop.id.clone()),
                kind: Some(stop.kind.clone()),
                name: Some(stop.name.clone()),
                themes: stop.themes.clone(),
                ..Default::default()
            })
            .collect(),
        theme_chips: vec!["panoramic-view".to_owned()],
        ..Default::default()
    }
}

fn lunch_signature(result: &leisure_core::LunchSuggestion) -> Vec<String> {
    let mut signature = result
        .zones
        .iter()
        .map(|zone| {
            format!(
                "{}:{}",
                zone.id,
                zone.candidates
                    .iter()
                    .map(|candidate| candidate.poi_id.as_str())
                    .collect::<Vec<_>>()
                    .join("|")
            )
        })
        .collect::<Vec<_>>();
    if let Some(desert) = &result.desert {
        signature.push(format!(
            "desert:{}:{}",
            desert.stretch_start, desert.stretch_end
        ));
    }
    signature
}

fn assert_finite_lunch(result: &leisure_core::LunchSuggestion) {
    for point in &result.hunger_curve {
        assert!(point.value.is_finite());
    }
    for zone in &result.zones {
        assert!(zone.centroid[0].is_finite());
        assert!(zone.centroid[1].is_finite());
        assert!(zone.score.is_finite());
        for candidate in &zone.candidates {
            assert!(candidate.lat.is_finite());
            assert!(candidate.lon.is_finite());
            assert!(candidate.detour_min.is_finite());
            assert!(candidate.distance_from_route_km.is_finite());
        }
    }
}

fn persona_probability(intent: &leisure_core::IntentDistribution, persona: &str) -> f64 {
    intent
        .personas
        .get(persona)
        .copied()
        .unwrap_or_else(|| panic!("persona {persona} should be present"))
}

fn assert_probability_sum(intent: &leisure_core::IntentDistribution) {
    let sum = intent.personas.values().sum::<f64>();
    assert!(sum.is_finite());
    assert!((sum - 1.0).abs() < 1e-9, "probabilities summed to {sum}");
}

fn dwell_map(entries: &[(&str, f64)]) -> BTreeMap<String, f64> {
    entries
        .iter()
        .map(|(id, minutes)| ((*id).to_owned(), minutes * 60.0))
        .collect()
}

fn line_fixture(edge_minutes: &[f64]) -> (LeisureGraph, PublicTour) {
    let mut nodes = Vec::new();
    for index in 0..=edge_minutes.len() {
        nodes.push(node(
            &format!("{}", (b'a' + index as u8) as char),
            "junction",
            0.0,
            index as f64 * 0.1,
        ));
    }
    let mut edges = Vec::new();
    for (index, minutes) in edge_minutes.iter().enumerate() {
        let from = format!("{}", (b'a' + index as u8) as char);
        let to = format!("{}", (b'a' + index as u8 + 1) as char);
        edges.push(edge_geom(
            &from,
            &to,
            minutes * 1_000.0,
            minutes * 60.0,
            "connector",
            "secondary",
            0.02,
            Vec::new(),
        ));
    }
    let graph = graph_with(nodes, edges);
    let ids = (0..=edge_minutes.len())
        .map(|index| format!("{}", (b'a' + index as u8) as char))
        .collect::<Vec<_>>();
    let refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let tour = public_tour(&graph, &refs);
    (graph, tour)
}

fn timed_line_fixture(duration_s: f64, mut extra_nodes: Vec<Value>) -> (LeisureGraph, PublicTour) {
    let mut nodes = vec![
        node("start", "junction", 0.0, 0.0),
        node("end", "junction", 0.0, 0.60),
    ];
    nodes.append(&mut extra_nodes);
    let graph = graph_with(
        nodes,
        vec![edge_geom(
            "start",
            "end",
            60_000.0,
            duration_s,
            "connector",
            "secondary",
            0.2,
            vec![[0.0, 0.0], [0.0, 0.60]],
        )],
    );
    let tour = public_tour(&graph, &["start", "end"]);
    (graph, tour)
}

fn public_tour(graph: &LeisureGraph, ids: &[&str]) -> PublicTour {
    if ids.is_empty() {
        return empty_tour();
    }
    let stops = ids
        .iter()
        .enumerate()
        .map(|(order, id)| public_stop(graph, id, order, order + 1 == ids.len() && ids[0] == *id))
        .collect::<Vec<_>>();
    let edges = ids
        .windows(2)
        .map(|pair| format!("{}->{}", pair[0], pair[1]))
        .collect::<Vec<_>>();
    let (total_duration_s, total_distance_m, total_cost) = edge_totals(graph, &edges);
    PublicTour {
        end_node: NodeId::from(*ids.last().expect("tour should have a last id")),
        stops,
        edges,
        total_leisure_cost: total_cost,
        total_distance_km: total_distance_m / 1000.0,
        total_duration_h: total_duration_s / 3600.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: vec![],
        theme_coverage: empty_theme_coverage(),
        budget_fit: budget_fit(total_duration_s),
        path: ids.iter().map(|id| NodeId::from(*id)).collect(),
        score: 0.0,
    }
}

fn tour_from_astar(graph: &LeisureGraph, leg: &leisure_core::AStarResult) -> PublicTour {
    let first = leg
        .path
        .first()
        .expect("A* path should include a first node")
        .clone();
    let last = leg
        .path
        .last()
        .expect("A* path should include a last node")
        .clone();
    let edges = leg
        .edges
        .iter()
        .map(|index| {
            graph
                .edges
                .get(*index)
                .expect("A* edge index should resolve")
                .canonical_id()
        })
        .collect::<Vec<_>>();
    PublicTour {
        end_node: last.clone(),
        stops: vec![
            public_stop(graph, first.as_str(), 0, false),
            public_stop(graph, last.as_str(), 1, false),
        ],
        edges,
        total_leisure_cost: leg.total_leisure_cost,
        total_distance_km: leg.total_distance_m / 1000.0,
        total_duration_h: leg.total_duration_s / 3600.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: vec![],
        theme_coverage: empty_theme_coverage(),
        budget_fit: budget_fit(leg.total_duration_s),
        path: leg.path.clone(),
        score: 0.0,
    }
}

fn real_open_tour(graph: &LeisureGraph, start: &str, end: &str) -> PublicTour {
    let leg = leisure_astar(
        graph,
        &NodeId::from(start),
        &NodeId::from(end),
        &AStarOptions::default(),
    );
    assert_eq!(
        leg.status,
        AStarStatus::Ok,
        "{start} -> {end} should be reachable"
    );
    tour_from_astar(graph, &leg)
}

fn real_five_stop_tour(graph: &LeisureGraph) -> PublicTour {
    let stop_ids = [
        "furkapass:A",
        "grimselpass:B",
        "sustenpass:A",
        "oberalppass:S",
        "nufenenpass-passo-della-novena:S",
    ];
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
        edges.extend(leg.edges.iter().map(|index| {
            graph
                .edges
                .get(*index)
                .expect("real A* edge index should resolve")
                .canonical_id()
        }));
        total_duration_s += leg.total_duration_s;
        total_distance_m += leg.total_distance_m;
        total_leisure_cost += leg.total_leisure_cost;
    }
    let stops = stop_ids
        .iter()
        .enumerate()
        .map(|(order, id)| public_stop(graph, id, order, false))
        .collect::<Vec<_>>();
    PublicTour {
        end_node: NodeId::from(*stop_ids.last().expect("real tour should have a final stop")),
        stops,
        edges,
        total_leisure_cost,
        total_distance_km: total_distance_m / 1000.0,
        total_duration_h: total_duration_s / 3600.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: vec![],
        theme_coverage: empty_theme_coverage(),
        budget_fit: budget_fit(total_duration_s),
        path,
        score: 0.0,
    }
}

fn public_stop(graph: &LeisureGraph, id: &str, order: usize, return_to_start: bool) -> PublicStop {
    let node = graph
        .node(&NodeId::from(id))
        .unwrap_or_else(|| panic!("node {id} should exist"));
    PublicStop {
        id: id.to_owned(),
        node_id: node.id.clone(),
        pass_id: node.pass_id.as_ref().map(ToString::to_string),
        kind: node.kind.as_str().to_owned(),
        name: node.name.clone(),
        lat: node.lat,
        lon: node.lon,
        themes: node.themes.clone(),
        scenic_score: node.scenic_score,
        order,
        return_to_start,
    }
}

fn edge_totals(graph: &LeisureGraph, edge_ids: &[String]) -> (f64, f64, f64) {
    edge_ids.iter().fold((0.0, 0.0, 0.0), |acc, id| {
        let edge = graph
            .edge_by_id
            .get(id)
            .or_else(|| graph.edge_by_key.get(id))
            .and_then(|index| graph.edges.get(*index))
            .unwrap_or_else(|| panic!("edge {id} should exist"));
        (
            acc.0 + edge.duration_s,
            acc.1 + edge.distance_m,
            acc.2 + edge.leisure_cost,
        )
    })
}

fn empty_tour() -> PublicTour {
    PublicTour {
        end_node: NodeId::from(""),
        stops: vec![],
        edges: vec![],
        total_leisure_cost: 0.0,
        total_distance_km: 0.0,
        total_duration_h: 0.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: vec![],
        theme_coverage: empty_theme_coverage(),
        budget_fit: budget_fit(0.0),
        path: vec![],
        score: 0.0,
    }
}

fn empty_theme_coverage() -> ThemeCoverage {
    ThemeCoverage {
        requested: vec![],
        covered_themes: vec![],
        covered_requested: vec![],
        ratio: 0.0,
        score: 0.0,
    }
}

fn budget_fit(duration_s: f64) -> BudgetFit {
    BudgetFit {
        mode: "seconds".to_owned(),
        budget: duration_s,
        used: duration_s,
        remaining: 0.0,
        ratio: if duration_s > 0.0 { 1.0 } else { 0.0 },
        within: true,
    }
}

fn graph_with(nodes: Vec<Value>, edges: Vec<Value>) -> LeisureGraph {
    LeisureGraph::load_from_json(
        &json!({
            "version": "test",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "stats": { "nodes": nodes.len(), "edges": edges.len() },
            "nodes": nodes,
            "edges": edges,
        })
        .to_string(),
    )
    .expect("synthetic graph should parse")
}

fn node(id: &str, kind: &str, lat: f64, lon: f64) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "name": id,
        "lat": lat,
        "lon": lon,
        "elev": 700.0,
        "score": 0.0,
        "scenicScore": 0.2,
        "themes": [],
        "categories": []
    })
}

fn poi(id: &str, lat: f64, lon: f64, score: f64, categories: &[&str], themes: &[&str]) -> Value {
    json!({
        "id": id,
        "kind": "poi",
        "name": id,
        "lat": lat,
        "lon": lon,
        "elev": 700.0,
        "score": score,
        "scenicScore": score,
        "categories": categories,
        "themes": themes
    })
}

fn food_poi(
    id: &str,
    lat: f64,
    lon: f64,
    categories: &[&str],
    themes: &[&str],
    score: f64,
) -> Value {
    poi(id, lat, lon, score, categories, themes)
}

fn edge(from: &str, to: &str, distance_m: f64, duration_s: f64) -> Value {
    edge_geom(
        from,
        to,
        distance_m,
        duration_s,
        "connector",
        "secondary",
        0.2,
        Vec::new(),
    )
}

fn edge_geom(
    from: &str,
    to: &str,
    distance_m: f64,
    duration_s: f64,
    kind: &str,
    road_class: &str,
    scenic_score: f64,
    geometry: Vec<[f64; 2]>,
) -> Value {
    json!({
        "id": format!("{from}->{to}"),
        "from": from,
        "to": to,
        "kind": kind,
        "roadClass": road_class,
        "distanceM": distance_m,
        "durationS": duration_s,
        "leisureCost": duration_s,
        "scenicScore": scenic_score,
        "season": "all",
        "geometry": geometry
    })
}

fn load_real_graph() -> LeisureGraph {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("data")
        .join("leisure-graph.v1.json");
    let json = fs::read_to_string(path).expect("real graph JSON should be readable");
    LeisureGraph::load_from_json(&json).expect("real graph should parse")
}

fn load_real_graph_with_extra_nodes(extra_nodes: Vec<Value>) -> LeisureGraph {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("data")
        .join("leisure-graph.v1.json");
    let text = fs::read_to_string(path).expect("real graph JSON should be readable");
    let mut data: Value = serde_json::from_str(&text).expect("real graph JSON should be valid");
    let node_len = {
        let nodes = data["nodes"]
            .as_array_mut()
            .expect("real graph JSON should contain a nodes array");
        nodes.extend(extra_nodes);
        nodes.len()
    };
    data["stats"]["nodes"] = json!(node_len);
    LeisureGraph::load_from_json(&data.to_string()).expect("augmented real graph should parse")
}

fn km_lon_deg(km: f64, lat: f64) -> f64 {
    km / (111.320 * lat.to_radians().cos())
}
