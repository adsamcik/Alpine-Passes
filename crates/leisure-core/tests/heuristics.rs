use leisure_core::{
    break_persona_for, is_in_range, is_seasonally_closed_pass, lunch_persona_for,
    lunch_policy_for, optimizer_options, projected_open_pass_count, top_intent_personas,
    LeisureGraph, LunchPersona, LunchPolicy, NodeId, TargetMode, UiOptions,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

// =====================================================================
// optimizer_options
// =====================================================================

#[test]
fn optimizer_options_time_mode_default_six_hours() {
    let ui = UiOptions {
        target_mode: TargetMode::Time,
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.budget_seconds, Some(6.0 * 3600.0));
    assert_eq!(opts.budget_km, None);
    assert_eq!(opts.k_alternatives, 3);
    assert_eq!(opts.time_budget_ms, 1_000);
}

#[test]
fn optimizer_options_distance_mode_default_two_hundred_km() {
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.budget_km, Some(200.0));
    assert_eq!(opts.budget_seconds, None);
}

#[test]
fn optimizer_options_explicit_budget_seconds_wins() {
    let ui = UiOptions {
        target_mode: TargetMode::Time,
        target_value: Some(10.0),
        budget_seconds: Some(7_200.0),
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.budget_seconds, Some(7_200.0));
    assert_eq!(opts.budget_km, None);
}

#[test]
fn optimizer_options_explicit_budget_km_wins() {
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        target_value: Some(99.0),
        budget_km: Some(120.0),
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.budget_km, Some(120.0));
    assert_eq!(opts.budget_seconds, None);
}

#[test]
fn optimizer_options_both_explicit_honored() {
    let ui = UiOptions {
        budget_seconds: Some(3_600.0),
        budget_km: Some(50.0),
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.budget_seconds, Some(3_600.0));
    assert_eq!(opts.budget_km, Some(50.0));
}

#[test]
fn optimizer_options_open_only_propagates_seasonal_cutoff() {
    let ui = UiOptions {
        open_only: true,
        trip_date: Some("2026-12-04".into()),
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.seasonal_cutoff, Some("2026-12-04".into()));
}

#[test]
fn optimizer_options_open_only_false_clears_seasonal_cutoff() {
    let ui = UiOptions {
        open_only: false,
        trip_date: Some("2026-12-04".into()),
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.seasonal_cutoff, None);
}

#[test]
fn optimizer_options_negative_target_falls_back_to_default() {
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        target_value: Some(-12.0),
        ..Default::default()
    };
    let opts = optimizer_options(&ui);
    assert_eq!(opts.budget_km, Some(200.0));
}

// =====================================================================
// is_seasonally_closed_pass
// =====================================================================

#[test]
fn seasonally_closed_high_pass_in_winter() {
    let graph = pass_graph(&[("alpine", 2_000.0)]);
    assert!(is_seasonally_closed_pass(
        &graph,
        &NodeId::from("alpine"),
        Some("2026-12-04"),
    ));
}

#[test]
fn not_closed_when_low_elevation_in_winter() {
    let graph = pass_graph(&[("low", 1_500.0)]);
    assert!(!is_seasonally_closed_pass(
        &graph,
        &NodeId::from("low"),
        Some("2026-12-04"),
    ));
}

#[test]
fn not_closed_when_summer_even_if_high() {
    let graph = pass_graph(&[("alpine", 2_500.0)]);
    assert!(!is_seasonally_closed_pass(
        &graph,
        &NodeId::from("alpine"),
        Some("2026-06-15"),
    ));
}

#[test]
fn not_closed_when_no_trip_date() {
    let graph = pass_graph(&[("alpine", 2_500.0)]);
    assert!(!is_seasonally_closed_pass(
        &graph,
        &NodeId::from("alpine"),
        None,
    ));
}

#[test]
fn not_closed_when_garbage_trip_date() {
    let graph = pass_graph(&[("alpine", 2_500.0)]);
    assert!(!is_seasonally_closed_pass(
        &graph,
        &NodeId::from("alpine"),
        Some("not-a-date"),
    ));
}

#[test]
fn seasonally_closed_uses_summit_elev_when_pass_elev_missing() {
    let nodes = vec![
        json!({ "id": "p1", "kind": "pass", "name": "p1", "lat": 0.0, "lon": 0.0 }),
        json!({
            "id": "p1:S", "kind": "pass-summit", "name": "p1 summit",
            "lat": 0.0, "lon": 0.0, "elev": 2_100.0, "passId": "p1", "side": "A"
        }),
        json!({
            "id": "p1:A", "kind": "pass-base", "name": "p1 a",
            "lat": 0.0, "lon": 0.0, "passId": "p1", "side": "A"
        }),
        json!({
            "id": "p1:B", "kind": "pass-base", "name": "p1 b",
            "lat": 0.0, "lon": 0.0, "passId": "p1", "side": "B"
        }),
    ];
    let graph = graph_with(nodes, vec![]);
    assert!(is_seasonally_closed_pass(
        &graph,
        &NodeId::from("p1"),
        Some("2026-01-15"),
    ));
}

#[test]
fn seasonally_closed_accepts_rfc3339_trip_date() {
    let graph = pass_graph(&[("alpine", 2_000.0)]);
    assert!(is_seasonally_closed_pass(
        &graph,
        &NodeId::from("alpine"),
        Some("2026-12-04T10:00:00.000Z"),
    ));
}

// =====================================================================
// projected_open_pass_count
// =====================================================================

#[test]
fn projected_open_pass_count_filters_forbidden() {
    let graph = pass_graph(&[("a", 800.0), ("b", 800.0), ("c", 800.0)]);
    let ui = UiOptions {
        forbidden_pass_ids: vec!["b".into()],
        ..Default::default()
    };
    assert_eq!(projected_open_pass_count(&graph, &ui), 2);
}

#[test]
fn projected_open_pass_count_open_only_excludes_seasonally_closed() {
    let graph = pass_graph(&[("a", 2_000.0), ("b", 2_100.0), ("c", 2_500.0)]);
    let ui = UiOptions {
        open_only: true,
        trip_date: Some("2026-12-04".into()),
        ..Default::default()
    };
    assert_eq!(projected_open_pass_count(&graph, &ui), 0);
}

#[test]
fn projected_open_pass_count_defaults_count_all() {
    let graph = pass_graph(&[("a", 800.0), ("b", 800.0), ("c", 800.0)]);
    let ui = UiOptions::default();
    assert_eq!(projected_open_pass_count(&graph, &ui), 3);
}

// =====================================================================
// is_in_range
// =====================================================================

#[test]
fn is_in_range_no_target_falls_back_to_fit_within_true() {
    let ui = UiOptions::default();
    assert!(is_in_range(123.0, 4.0, Some(true), false, &ui));
}

#[test]
fn is_in_range_no_target_falls_back_to_fit_within_false_default() {
    let ui = UiOptions::default();
    assert!(!is_in_range(123.0, 4.0, None, false, &ui));
}

#[test]
fn is_in_range_distance_in_tolerance() {
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        target_value: Some(100.0),
        target_tol: Some(0.2),
        ..Default::default()
    };
    assert!(is_in_range(115.0, 4.0, None, false, &ui));
}

#[test]
fn is_in_range_distance_out_of_tolerance() {
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        target_value: Some(100.0),
        target_tol: Some(0.2),
        ..Default::default()
    };
    assert!(!is_in_range(135.0, 4.0, None, false, &ui));
}

#[test]
fn is_in_range_time_in_tolerance() {
    let ui = UiOptions {
        target_mode: TargetMode::Time,
        target_value: Some(6.0),
        target_tol: Some(0.1),
        ..Default::default()
    };
    assert!(is_in_range(200.0, 6.4, None, true, &ui));
}

#[test]
fn is_in_range_minimum_tolerance_floor_enforced() {
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        target_value: Some(100.0),
        target_tol: Some(0.01),
        ..Default::default()
    };
    assert!(is_in_range(104.9, 4.0, None, false, &ui));
    assert!(!is_in_range(106.0, 4.0, None, false, &ui));
}

#[test]
fn is_in_range_zero_tolerance_falls_back_to_default_per_js() {
    // JS: `Number(targetTol) || 0.2` — 0 is falsy and falls through to the
    // 0.2 default, not the 0.05 floor.
    let ui = UiOptions {
        target_mode: TargetMode::Distance,
        target_value: Some(100.0),
        target_tol: Some(0.0),
        ..Default::default()
    };
    assert!(is_in_range(115.0, 4.0, None, false, &ui));
    assert!(!is_in_range(125.0, 4.0, None, false, &ui));
}

// =====================================================================
// lunch_persona_for
// =====================================================================

#[test]
fn lunch_persona_family_takes_priority_case_insensitive() {
    let personas = vec!["Family".to_owned(), "wine".to_owned()];
    assert_eq!(lunch_persona_for(&personas), LunchPersona::Family);
}

#[test]
fn lunch_persona_wine_maps_to_foodie() {
    let personas = vec!["wine".to_owned()];
    assert_eq!(lunch_persona_for(&personas), LunchPersona::Foodie);
}

#[test]
fn lunch_persona_empty_is_normal() {
    assert_eq!(lunch_persona_for(&[]), LunchPersona::Normal);
}

#[test]
fn lunch_persona_as_str_round_trip() {
    assert_eq!(LunchPersona::Family.as_str(), "family");
    assert_eq!(LunchPersona::Foodie.as_str(), "foodie");
    assert_eq!(LunchPersona::Normal.as_str(), "normal");
}

// =====================================================================
// break_persona_for — every priority arm
// =====================================================================

#[test]
fn break_persona_family_first() {
    let personas = vec!["family".to_owned(), "photo".to_owned()];
    assert_eq!(break_persona_for(&personas), "family");
}

#[test]
fn break_persona_photographer_before_gourmet() {
    let personas = vec!["photographer".to_owned(), "wine".to_owned()];
    assert_eq!(break_persona_for(&personas), "photographer");
}

#[test]
fn break_persona_gourmet_when_only_food_aliases() {
    let personas = vec!["gourmet".to_owned()];
    assert_eq!(break_persona_for(&personas), "gourmet");
}

#[test]
fn break_persona_falls_through_to_first_lowercase() {
    let personas = vec!["Hiker".to_owned(), "Other".to_owned()];
    assert_eq!(break_persona_for(&personas), "hiker");
}

#[test]
fn break_persona_default_for_empty_list() {
    assert_eq!(break_persona_for(&[]), "default");
}

// =====================================================================
// lunch_policy_for
// =====================================================================

#[test]
fn lunch_policy_none_is_auto() {
    assert_eq!(lunch_policy_for(None), LunchPolicy::Auto);
}

#[test]
fn lunch_policy_auto_string_is_auto() {
    assert_eq!(lunch_policy_for(Some("auto")), LunchPolicy::Auto);
}

#[test]
fn lunch_policy_zero_is_skip() {
    assert_eq!(lunch_policy_for(Some("0")), LunchPolicy::Skip);
}

#[test]
fn lunch_policy_none_string_is_skip() {
    assert_eq!(lunch_policy_for(Some("none")), LunchPolicy::Skip);
}

#[test]
fn lunch_policy_skip_string_is_skip() {
    assert_eq!(lunch_policy_for(Some("skip")), LunchPolicy::Skip);
}

#[test]
fn lunch_policy_numeric_string_is_window_minutes() {
    assert_eq!(
        lunch_policy_for(Some("45")),
        LunchPolicy::WindowMinutes(45.0)
    );
}

#[test]
fn lunch_policy_garbage_falls_back_to_auto() {
    assert_eq!(lunch_policy_for(Some("garbage")), LunchPolicy::Auto);
}

#[test]
fn lunch_policy_empty_string_is_auto() {
    assert_eq!(lunch_policy_for(Some("")), LunchPolicy::Auto);
}

// =====================================================================
// top_intent_personas
// =====================================================================

#[test]
fn top_intent_personas_returns_top_three_by_score() {
    let mut intent: BTreeMap<String, f64> = BTreeMap::new();
    intent.insert("scenic".into(), 0.4);
    intent.insert("foodie".into(), 0.9);
    intent.insert("hiker".into(), 0.6);
    intent.insert("photographer".into(), 0.2);
    let top = top_intent_personas(&intent);
    assert_eq!(top, vec!["foodie", "hiker", "scenic"]);
}

#[test]
fn top_intent_personas_excludes_entropy_key() {
    let mut intent: BTreeMap<String, f64> = BTreeMap::new();
    intent.insert("entropy".into(), 1.0);
    intent.insert("scenic".into(), 0.5);
    intent.insert("foodie".into(), 0.3);
    let top = top_intent_personas(&intent);
    assert_eq!(top, vec!["scenic", "foodie"]);
}

#[test]
fn top_intent_personas_breaks_ties_by_name_ascending() {
    let mut intent: BTreeMap<String, f64> = BTreeMap::new();
    intent.insert("foodie".into(), 0.5);
    intent.insert("photographer".into(), 0.5);
    intent.insert("scenic".into(), 0.5);
    intent.insert("hiker".into(), 0.4);
    let top = top_intent_personas(&intent);
    assert_eq!(top, vec!["foodie", "photographer", "scenic"]);
}

#[test]
fn top_intent_personas_excludes_non_finite_scores() {
    let mut intent: BTreeMap<String, f64> = BTreeMap::new();
    intent.insert("nan".into(), f64::NAN);
    intent.insert("inf".into(), f64::INFINITY);
    intent.insert("scenic".into(), 0.5);
    let top = top_intent_personas(&intent);
    assert_eq!(top, vec!["scenic"]);
}

// =====================================================================
// fixtures
// =====================================================================

fn pass_graph(passes: &[(&str, f64)]) -> LeisureGraph {
    let nodes: Vec<Value> = passes
        .iter()
        .map(|(id, elev)| {
            json!({
                "id": id, "kind": "pass", "name": id,
                "lat": 0.0, "lon": 0.0, "elev": elev,
            })
        })
        .collect();
    graph_with(nodes, vec![])
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
    .expect("graph parses")
}
