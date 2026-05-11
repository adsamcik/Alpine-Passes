use leisure_core::{
    decompose_ears, double_bridge_node_order, improve_node_order_or_opt,
    improve_node_order_two_opt, leisure_plan_open, leisure_plan_selected, plan_leisure_tour,
    route_leisure_cost, side_stop_detour_cost, LeisureGraph, Mulberry32, NodeId, PlanOptions,
    PlanStatus,
};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

static REAL_GRAPH: Lazy<LeisureGraph> = Lazy::new(load_real_graph);

#[test]
fn deterministic_seed_returns_same_primary_path_across_three_runs() {
    let graph = choice_graph(6, false);
    let ears = decompose_ears(&graph);
    let mut options = auto_options("base", 10_000.0, Some(123), 3);
    options.iteration_cap = Some(30);

    let first = plan_leisure_tour(&graph, &ears, options.clone());
    let second = plan_leisure_tour(&graph, &ears, options.clone());
    let third = plan_leisure_tour(&graph, &ears, options);

    assert_eq!(first.status, PlanStatus::Ok);
    assert_eq!(path_of(&second), path_of(&first));
    assert_eq!(path_of(&third), path_of(&first));
}

#[test]
fn same_seed_replays_primary_and_alternatives_in_order() {
    let graph = choice_graph(7, false);
    let ears = decompose_ears(&graph);
    let mut options = auto_options("base", 100_000.0, Some(33), 5);
    options.iteration_cap = Some(80);

    let first = plan_leisure_tour(&graph, &ears, options.clone());
    let second = plan_leisure_tour(&graph, &ears, options);

    assert_eq!(first.status, PlanStatus::Ok);
    assert_eq!(first.primary, second.primary);
    assert_eq!(first.alternatives, second.alternatives);
    assert_eq!(first.alternatives.len(), 4);
}

#[test]
fn k_alternatives_five_returns_four_distinct_alternatives() {
    let graph = choice_graph(7, false);
    let ears = decompose_ears(&graph);
    let mut options = auto_options("base", 20_000.0, Some(33), 5);
    options.iteration_cap = Some(80);

    let result = plan_leisure_tour(&graph, &ears, options);
    let primary = result.primary.as_ref().expect("primary");
    let mut signatures = BTreeSet::from([stop_signature(primary)]);
    for alternative in &result.alternatives {
        signatures.insert(stop_signature(alternative));
    }

    assert_eq!(result.alternatives.len(), 4);
    assert_eq!(signatures.len(), 5);
}

#[test]
fn k_alternatives_one_returns_no_alternatives() {
    let graph = choice_graph(5, false);
    let ears = decompose_ears(&graph);
    let options = auto_options("base", 10_000.0, Some(33), 1);

    let result = plan_leisure_tour(&graph, &ears, options);

    assert!(result.alternatives.is_empty());
}

#[test]
fn k_alternatives_zero_keeps_primary_without_alternatives() {
    let graph = choice_graph(4, false);
    let ears = decompose_ears(&graph);
    let result = plan_leisure_tour(&graph, &ears, auto_options("base", 10_000.0, Some(33), 0));

    assert!(
        result.primary.is_some(),
        "k=0 should only suppress alternatives, not primary"
    );
    assert!(result.alternatives.is_empty());
}

#[test]
fn huge_k_alternatives_deduplicates_without_padding() {
    let graph = choice_graph(3, false);
    let ears = decompose_ears(&graph);
    let must = vec![
        "pass-0".to_owned(),
        "pass-1".to_owned(),
        "pass-2".to_owned(),
    ];
    let mut options = auto_options("base", 100_000.0, Some(19), 100);
    options.iteration_cap = Some(80);

    let result = leisure_plan_selected(&graph, &ears, &must, options);
    let primary = result.primary.as_ref().expect("primary tour should exist");
    let mut signatures = BTreeSet::from([stop_signature(primary)]);
    let mut tour_count = 1usize;
    for alternative in &result.alternatives {
        tour_count += 1;
        assert!(
            signatures.insert(stop_signature(alternative)),
            "duplicate alternative signature: {}",
            stop_signature(alternative)
        );
    }

    assert_eq!(result.status, PlanStatus::Ok);
    assert!(
        tour_count <= 6,
        "three required stops have at most 3! tours"
    );
    assert!(
        result.alternatives.len() < 99,
        "JS parity: alternatives are deduped, not padded"
    );
}

#[test]
fn open_a_to_b_preserves_start_and_end_after_many_iterations() {
    let graph = choice_graph(6, true);
    let ears = decompose_ears(&graph);
    let mut options = auto_options("base", 20_000.0, Some(44), 3);
    options.iteration_cap = Some(100);

    let result = leisure_plan_open(&graph, &ears, "base", "finish", options);
    let stops = &result.primary.as_ref().expect("primary").stops;

    assert_eq!(
        stops.first().map(|stop| stop.node_id.as_str()),
        Some("base")
    );
    assert_eq!(
        stops.last().map(|stop| stop.node_id.as_str()),
        Some("finish")
    );
}

#[test]
fn closed_loop_repeats_start_as_terminal_return_stop() {
    let graph = choice_graph(3, false);
    let ears = decompose_ears(&graph);
    let must = vec!["pass-0".to_owned()];
    let options = auto_options("base", 10_000.0, Some(7), 1);

    let result = leisure_plan_selected(&graph, &ears, &must, options);
    let stops = &result.primary.as_ref().expect("primary").stops;

    assert_eq!(
        stops.first().map(|stop| stop.node_id.as_str()),
        Some("base")
    );
    assert_eq!(stops.last().map(|stop| stop.node_id.as_str()), Some("base"));
    assert!(stops.last().is_some_and(|stop| stop.return_to_start));
}

#[test]
fn empty_stop_list_closed_is_single_start_and_open_is_start_to_end() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);
    let closed = plan_leisure_tour(&graph, &ears, auto_options("start", 100.0, Some(1), 1));
    let open = leisure_plan_open(
        &graph,
        &ears,
        "start",
        "finish",
        auto_options("start", 100.0, Some(1), 1),
    );

    assert_eq!(
        stop_ids(closed.primary.as_ref().expect("closed")),
        vec!["start"]
    );
    assert_eq!(
        stop_ids(open.primary.as_ref().expect("open")),
        vec!["start", "finish"]
    );
}

#[test]
fn degenerate_empty_closed_loop_has_zero_cost_and_path() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);
    let result = plan_leisure_tour(&graph, &ears, auto_options("start", 100.0, Some(1), 1));
    let primary = result
        .primary
        .as_ref()
        .expect("closed primary should exist");

    assert_eq!(result.status, PlanStatus::Degraded);
    assert_eq!(stop_ids(primary), vec!["start"]);
    assert_eq!(
        primary
            .path
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        vec!["start"]
    );
    assert!(primary.edges.is_empty());
    assert_eq!(primary.total_leisure_cost, 0.0);
    assert_eq!(primary.total_distance_km, 0.0);
    assert_eq!(primary.total_duration_h, 0.0);
    assert_eq!(primary.retraced_connector_count, 0);
    assert_eq!(primary.budget_fit.used, 0.0);
}

#[test]
fn empty_open_ab_routes_directly_and_populates_fields() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);
    let result = leisure_plan_open(
        &graph,
        &ears,
        "start",
        "finish",
        auto_options("start", 1_000.0, Some(1), 1),
    );
    let primary = result.primary.as_ref().expect("open primary should exist");

    assert_eq!(result.status, PlanStatus::Degraded);
    assert_eq!(stop_ids(primary), vec!["start", "finish"]);
    assert_eq!(
        primary.path.first().map(ToString::to_string).as_deref(),
        Some("start")
    );
    assert_eq!(
        primary.path.last().map(ToString::to_string).as_deref(),
        Some("finish")
    );
    assert!(!primary.path.is_empty());
    assert!(!primary.edges.is_empty());
    assert!(primary.total_leisure_cost.is_finite() && primary.total_leisure_cost > 0.0);
    assert!(primary.total_distance_km.is_finite() && primary.total_distance_km > 0.0);
    assert!(primary.total_duration_h.is_finite() && primary.total_duration_h > 0.0);
    assert_eq!(primary.retraced_connector_count, 0);
    assert!(primary.budget_fit.used.is_finite() && primary.budget_fit.used >= 0.0);
}

#[test]
fn open_start_equals_end_without_stops_is_closed_zero_cost() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);
    let result = leisure_plan_open(
        &graph,
        &ears,
        "start",
        "start",
        auto_options("start", 100.0, Some(1), 1),
    );
    let primary = result
        .primary
        .as_ref()
        .expect("same-end primary should exist");

    assert_eq!(result.status, PlanStatus::Degraded);
    assert_eq!(result.diagnostics["openTrip"].as_bool(), Some(false));
    assert_eq!(stop_ids(primary), vec!["start"]);
    assert_eq!(primary.total_leisure_cost, 0.0);
    assert_eq!(primary.total_distance_km, 0.0);
    assert_eq!(primary.total_duration_h, 0.0);
}

#[test]
fn single_selected_stop_is_visited_and_returns_to_start() {
    let graph = choice_graph(1, false);
    let ears = decompose_ears(&graph);
    let must = vec!["pass-0".to_owned()];

    let result = leisure_plan_selected(
        &graph,
        &ears,
        &must,
        auto_options("base", 10_000.0, Some(11), 1),
    );

    assert_eq!(result.status, PlanStatus::Ok);
    assert_eq!(
        stop_ids(result.primary.as_ref().expect("primary")),
        vec!["base", "pass-0", "base"]
    );
}

#[test]
fn duplicate_required_stop_aliases_are_deduped() {
    let graph = choice_graph(2, false);
    let ears = decompose_ears(&graph);
    let must = vec![
        "pass-0".to_owned(),
        "pass-0:S".to_owned(),
        "pass-0".to_owned(),
    ];

    let result = leisure_plan_selected(
        &graph,
        &ears,
        &must,
        auto_options("base", 10_000.0, Some(11), 1),
    );
    let primary = result.primary.as_ref().expect("primary should exist");
    let pass_ids = primary
        .stops
        .iter()
        .filter_map(|stop| stop.pass_id.as_deref())
        .collect::<Vec<_>>();

    assert_eq!(result.status, PlanStatus::Ok);
    assert_eq!(pass_ids, vec!["pass-0"]);
}

#[test]
fn required_stops_sharing_coordinates_remain_finite() {
    let graph = same_location_pass_graph();
    let ears = decompose_ears(&graph);
    let must = vec!["pass-a".to_owned(), "pass-b".to_owned()];

    let result = leisure_plan_selected(
        &graph,
        &ears,
        &must,
        auto_options("base", 10_000.0, Some(17), 1),
    );
    let primary = result.primary.as_ref().expect("primary should exist");
    let pass_ids = primary
        .stops
        .iter()
        .filter_map(|stop| stop.pass_id.as_deref())
        .collect::<BTreeSet<_>>();

    assert_eq!(result.status, PlanStatus::Ok);
    assert!(pass_ids.contains("pass-a"));
    assert!(pass_ids.contains("pass-b"));
    assert!(primary.total_leisure_cost.is_finite());
    assert!(primary.total_distance_km.is_finite());
    assert!(primary.total_duration_h.is_finite());
    assert!(primary.score.is_finite());
}

#[test]
fn forbidden_edges_blocking_only_open_path_returns_infeasible() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);
    let mut options = auto_options("start", 100.0, Some(1), 1);
    options.end_node = Some("finish".into());
    options
        .forbidden_edges
        .insert(*graph.edge_by_key.get("start->finish").expect("edge"));

    let result = plan_leisure_tour(&graph, &ears, options);

    assert_eq!(result.status, PlanStatus::Infeasible);
    assert!(result.primary.is_none());
}

#[test]
fn forbidden_edges_between_required_stops_return_infeasible() {
    let graph = line_retrace_graph();
    let ears = decompose_ears(&graph);
    let must = vec!["near-pass".to_owned(), "far-pass".to_owned()];
    let mut options = auto_options("base", 10_000.0, Some(9), 1);
    for key in ["near-pass->far-pass", "far-pass->near-pass"] {
        options
            .forbidden_edges
            .insert(*graph.edge_by_key.get(key).expect("edge should exist"));
    }

    let result = leisure_plan_selected(&graph, &ears, &must, options);

    assert_eq!(result.status, PlanStatus::Infeasible);
    assert!(result.primary.is_none());
}

#[test]
fn forbidden_node_on_only_bridge_to_required_stop_returns_infeasible() {
    let graph = bridge_to_required_stop_graph();
    let ears = decompose_ears(&graph);
    let must = vec!["isolated-pass".to_owned()];
    let mut options = auto_options("base", 10_000.0, Some(9), 1);
    options.forbidden_nodes.insert(node_id("bridge"));

    let result = leisure_plan_selected(&graph, &ears, &must, options);

    assert_eq!(result.status, PlanStatus::Infeasible);
    assert!(result.primary.is_none());
}

#[test]
fn two_opt_improves_deliberately_bad_node_order() {
    let graph = complete_line_graph(5);
    let start = node_id("n0");
    let route = vec![node_id("n1"), node_id("n3"), node_id("n2"), node_id("n4")];
    let before = route_leisure_cost(&graph, &start, &route, &start).expect("before");
    let improved = improve_node_order_two_opt(&graph, &start, &route, &start);
    let after = route_leisure_cost(&graph, &start, &improved, &start).expect("after");

    assert!(after < before, "{after} should be < {before}: {improved:?}");
}

#[test]
fn or_opt_improves_deliberately_bad_node_order() {
    let graph = complete_line_graph(6);
    let start = node_id("n0");
    let end = node_id("n5");
    let route = vec![node_id("n1"), node_id("n3"), node_id("n4"), node_id("n2")];
    let before = route_leisure_cost(&graph, &start, &route, &end).expect("before");
    let improved = improve_node_order_or_opt(&graph, &start, &route, &end);
    let after = route_leisure_cost(&graph, &start, &improved, &end).expect("after");

    assert!(after < before, "{after} should be < {before}: {improved:?}");
}

#[test]
fn double_bridge_fires_after_no_improvement_threshold() {
    let graph = choice_graph(8, false);
    let ears = decompose_ears(&graph);
    let must = (0..8)
        .map(|index| format!("pass-{index}"))
        .collect::<Vec<_>>();
    let mut options = auto_options("base", 100_000.0, Some(5), 1);
    options.iteration_cap = Some(4);
    options.max_no_improvement = 1;

    let result = leisure_plan_selected(&graph, &ears, &must, options);
    let count = result.diagnostics["materialization"]["doubleBridgeCount"]
        .as_u64()
        .unwrap_or(0);

    assert!(count > 0, "diagnostics: {}", result.diagnostics);
}

#[test]
fn iteration_cap_zero_and_one_return_primary_and_report_caps() {
    let graph = choice_graph(5, false);
    let ears = decompose_ears(&graph);

    let mut zero = auto_options("base", 100_000.0, Some(5), 3);
    zero.iteration_cap = Some(0);
    let zero_result = plan_leisure_tour(&graph, &ears, zero);

    let mut one = auto_options("base", 100_000.0, Some(5), 3);
    one.iteration_cap = Some(1);
    let one_result = plan_leisure_tour(&graph, &ears, one);

    assert!(zero_result.primary.is_some());
    assert_eq!(
        zero_result.diagnostics["searchBound"]["perturbationCap"].as_u64(),
        Some(0)
    );
    assert!(one_result.primary.is_some());
    assert_eq!(
        one_result.diagnostics["searchBound"]["perturbationCap"].as_u64(),
        Some(1)
    );
}

#[test]
fn closed_side_stop_detour_cost_is_doubled_but_open_is_one_way() {
    assert_eq!(side_stop_detour_cost(12.5, false), 25.0);
    assert_eq!(side_stop_detour_cost(12.5, true), 12.5);
}

#[test]
fn invalid_budget_seconds_nan_or_negative_is_infeasible() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);

    for (label, budget_seconds) in [("nan", f64::NAN), ("negative", -1.0)] {
        let mut options = PlanOptions::with_start("start");
        options.budget_seconds = Some(budget_seconds);
        options.seed = Some(1);
        options.k_alternatives = 1;

        let result = plan_leisure_tour(&graph, &ears, options);

        assert_eq!(result.status, PlanStatus::Infeasible, "{label}");
        assert!(result.primary.is_none(), "{label}");
        assert_eq!(
            result.diagnostics["reason"].as_str(),
            Some("invalid-budget")
        );
    }
}

#[test]
fn invalid_time_budget_ms_clamps_without_panicking() {
    let graph = simple_open_graph(false);
    let ears = decompose_ears(&graph);

    for (label, time_budget_ms) in [("nan", f64::NAN), ("negative", -5.0)] {
        let mut options = auto_options("start", 100.0, Some(1), 1);
        options.time_budget_ms = time_budget_ms;
        options.iteration_cap = Some(0);

        let result = plan_leisure_tour(&graph, &ears, options);

        assert_ne!(result.status, PlanStatus::Infeasible, "{label}");
        assert!(result.primary.is_some(), "{label}");
        assert!(
            result.diagnostics["stageTimingContractMs"]["total"]
                .as_f64()
                .expect("diagnostic total should be numeric")
                >= 1.0,
            "{label}"
        );
    }
}

#[test]
fn mulberry32_u32_output_is_stable_for_reference_seed() {
    let mut rng = Mulberry32::new(0xDEAD_BEEF);
    let values = (0..10).map(|_| rng.next_u32()).collect::<Vec<_>>();

    assert_eq!(
        values,
        vec![
            4_043_151_706,
            1_147_597_007,
            3_315_858_022,
            1_538_288_752,
            2_042_435_954,
            3_600_176_436,
            484_360_372,
            1_362_401_224,
            379_893_202,
            1_051_950_098,
        ]
    );
}

#[test]
fn mulberry32_next_f64_matches_js_reference_seed_deadbeef() {
    let expected = [
        "0.941369614098221",
        "0.267195749795064",
        "0.772033357527107",
        "0.358160760253668",
        "0.475541677791625",
        "0.838231396861374",
        "0.112773937173188",
        "0.317208753898740",
        "0.088450778741390",
        "0.244926218409091",
    ];
    let mut rng = Mulberry32::new(0xDEAD_BEEF);

    for (index, expected_value) in expected.iter().enumerate() {
        assert_eq!(
            format!("{:.15}", rng.next_f64()),
            *expected_value,
            "JS mulberry32 output {index}"
        );
    }
}

#[test]
fn real_graph_three_stop_ab_chain_has_finite_cost_under_five_seconds() {
    let start = node_id("furkapass:A");
    let route = vec![node_id("grimselpass:B")];
    let end = node_id("sustenpass:A");
    let started = Instant::now();
    let cost = route_leisure_cost(&REAL_GRAPH, &start, &route, &end).expect("real route");
    let elapsed = started.elapsed();
    eprintln!(
        "optimizer real A→B chain furka→grimsel→susten: {:.3}ms",
        elapsed.as_secs_f64() * 1000.0
    );

    assert!(cost.is_finite());
    assert!(elapsed.as_secs_f64() < 5.0);
}

#[test]
fn retrace_stats_report_for_forced_line_topology() {
    let graph = line_retrace_graph();
    let ears = decompose_ears(&graph);
    let must = vec!["near-pass".to_owned(), "far-pass".to_owned()];

    let result = leisure_plan_selected(
        &graph,
        &ears,
        &must,
        auto_options("base", 10_000.0, Some(9), 1),
    );
    let primary = result.primary.as_ref().expect("primary");
    let expected = count_retraced_connectors(&graph, &primary.edges);

    assert!(expected > 0);
    assert_eq!(primary.retraced_connector_count, expected);
}

#[test]
fn optimizer_real_graph_performance() {
    let graph = Lazy::force(&REAL_GRAPH);
    let ab_start = node_id("furkapass:A");
    let ab_end = node_id("grimselpass:B");
    let ab_started = Instant::now();
    let ab_cost = route_leisure_cost(graph, &ab_start, &[], &ab_end).expect("A→B");
    let ab_elapsed = ab_started.elapsed();

    let closed_start = node_id("j-andermatt");
    let closed_route = vec![
        node_id("furkapass:S"),
        node_id("grimselpass:S"),
        node_id("sustenpass:S"),
        node_id("oberalppass:S"),
        node_id("nufenenpass-passo-della-novena:S"),
    ];
    let tour_started = Instant::now();
    let closed_cost = route_leisure_cost(graph, &closed_start, &closed_route, &closed_start)
        .expect("5-stop closed route");
    let tour_elapsed = tour_started.elapsed();

    eprintln!(
        "optimizer perf A→B: {:.3}ms cost {:.3}; 5-stop closed: {:.3}ms cost {:.3}",
        ab_elapsed.as_secs_f64() * 1000.0,
        ab_cost,
        tour_elapsed.as_secs_f64() * 1000.0,
        closed_cost
    );

    assert!(ab_cost.is_finite());
    assert!(closed_cost.is_finite());
    let limit = if cfg!(debug_assertions) { 10.0 } else { 2.0 };
    assert!(
        tour_elapsed.as_secs_f64() < limit,
        "5-stop tour took {:.3}s",
        tour_elapsed.as_secs_f64()
    );
}

#[test]
fn real_graph_smoke_paths_and_cache_are_consistent() {
    let graph = Lazy::force(&REAL_GRAPH);
    let ears = empty_ears();
    let direct_before = route_leisure_cost(
        graph,
        &node_id("furkapass:A"),
        &[],
        &node_id("grimselpass:B"),
    )
    .expect("fresh A→B route should be reachable");

    let mut open_options = auto_options("furkapass:A", 100_000.0, Some(66), 1);
    open_options.end_node = Some("grimselpass:B".into());
    open_options.iteration_cap = Some(0);
    let open = leisure_plan_selected(graph, &ears, &[], open_options);
    let open_primary = open.primary.as_ref().expect("open primary should exist");

    assert!(open_primary.total_leisure_cost > 0.0);
    assert_eq!(
        open_primary
            .path
            .first()
            .map(ToString::to_string)
            .as_deref(),
        Some("furkapass:A")
    );
    assert_eq!(
        open_primary.path.last().map(ToString::to_string).as_deref(),
        Some("grimselpass:B")
    );

    let mut closed_options = auto_options("j-andermatt", 200_000.0, Some(67), 1);
    closed_options.iteration_cap = Some(0);
    let closed_must = vec![
        "furkapass".to_owned(),
        "grimselpass".to_owned(),
        "sustenpass".to_owned(),
    ];
    let closed = leisure_plan_selected(graph, &ears, &closed_must, closed_options);
    let closed_primary = closed
        .primary
        .as_ref()
        .expect("closed primary should exist");
    let pass_ids = closed_primary
        .stops
        .iter()
        .filter_map(|stop| stop.pass_id.as_deref())
        .collect::<BTreeSet<_>>();

    assert_eq!(closed.status, PlanStatus::Ok);
    for pass_id in ["furkapass", "grimselpass", "sustenpass"] {
        assert!(
            pass_ids.contains(pass_id),
            "missing {pass_id}: {pass_ids:?}"
        );
    }

    let direct_after = route_leisure_cost(
        graph,
        &node_id("furkapass:A"),
        &[],
        &node_id("grimselpass:B"),
    )
    .expect("A→B route should remain reachable after planner calls");
    assert_eq!(direct_before, direct_after);
}

#[test]
fn selected_primary_has_no_duplicate_or_missing_stops() {
    let graph = choice_graph(4, false);
    let ears = decompose_ears(&graph);
    let must = vec![
        "pass-0".to_owned(),
        "pass-1".to_owned(),
        "pass-2".to_owned(),
    ];

    let result = leisure_plan_selected(
        &graph,
        &ears,
        &must,
        auto_options("base", 100_000.0, Some(12), 1),
    );
    let primary = result.primary.as_ref().expect("primary");
    let pass_ids = primary
        .stops
        .iter()
        .filter_map(|stop| stop.pass_id.clone())
        .collect::<Vec<_>>();
    let unique = pass_ids.iter().collect::<BTreeSet<_>>();

    assert_eq!(pass_ids.len(), unique.len());
    for id in must {
        assert!(pass_ids.contains(&id), "missing {id}: {pass_ids:?}");
    }
}

#[test]
fn alternatives_are_pairwise_diverse_by_at_least_one_stop() {
    let graph = choice_graph(7, false);
    let ears = decompose_ears(&graph);
    let mut options = auto_options("base", 100_000.0, Some(77), 5);
    options.iteration_cap = Some(80);

    let result = plan_leisure_tour(&graph, &ears, options);
    let tours = std::iter::once(result.primary.as_ref().expect("primary"))
        .chain(result.alternatives.iter())
        .collect::<Vec<_>>();
    let mut total_pairs = 0usize;
    let mut diverse_pairs = 0usize;
    for i in 0..tours.len() {
        for j in i + 1..tours.len() {
            total_pairs += 1;
            if stop_signature(tours[i]) != stop_signature(tours[j]) {
                diverse_pairs += 1;
            }
        }
    }

    assert!(total_pairs > 0);
    assert!(diverse_pairs * 2 >= total_pairs);
}

#[test]
fn open_mode_with_end_equal_start_and_stops_degrades_to_closed_gracefully() {
    let graph = choice_graph(2, false);
    let ears = decompose_ears(&graph);
    let must = vec!["pass-0".to_owned()];
    let result = leisure_plan_open(
        &graph,
        &ears,
        "base",
        "base",
        auto_options("base", 10_000.0, Some(18), 1),
    );
    let selected = leisure_plan_selected(
        &graph,
        &ears,
        &must,
        PlanOptions {
            end_node: Some("base".into()),
            ..auto_options("base", 10_000.0, Some(18), 1)
        },
    );

    assert!(matches!(
        result.status,
        PlanStatus::Ok | PlanStatus::Degraded
    ));
    assert_eq!(selected.status, PlanStatus::Ok);
    assert!(selected
        .primary
        .as_ref()
        .expect("primary")
        .stops
        .last()
        .is_some_and(|stop| stop.return_to_start));
}

#[test]
fn double_bridge_node_order_known_seed_changes_order_without_losing_nodes() {
    let route = (0..8)
        .map(|index| node_id(&format!("n{index}")))
        .collect::<Vec<_>>();
    let mut rng = Mulberry32::new(1234);
    let bridged = double_bridge_node_order(&route, &mut rng);

    assert_ne!(bridged, route);
    assert_eq!(
        bridged.iter().collect::<BTreeSet<_>>(),
        route.iter().collect()
    );
}

fn auto_options(start: &str, budget_seconds: f64, seed: Option<u64>, k: usize) -> PlanOptions {
    let mut options = PlanOptions::with_start(start);
    options.budget_seconds = Some(budget_seconds);
    options.seed = seed;
    options.k_alternatives = k;
    options.time_budget_ms = 50.0;
    options
}

fn choice_graph(pass_count: usize, include_finish: bool) -> LeisureGraph {
    let mut nodes = vec![node("base", "junction", 0, 0.5)];
    if include_finish {
        nodes.push(node("finish", "junction", pass_count + 2, 0.5));
    }
    for index in 0..pass_count {
        nodes.push(node(
            &format!("pass-{index}"),
            "pass",
            index + 1,
            0.95 - index as f64 * 0.03,
        ));
    }
    let ids = nodes
        .iter()
        .map(|node| node["id"].as_str().expect("id").to_owned())
        .collect::<Vec<_>>();
    let mut edges = Vec::new();
    for i in 0..ids.len() {
        for j in 0..ids.len() {
            if i == j {
                continue;
            }
            let distance = ((i as i32 - j as i32).unsigned_abs() as f64 + 1.0) * 100.0;
            edges.push(edge(
                &ids[i],
                &ids[j],
                "connector",
                distance / 100.0,
                distance,
                distance,
                None,
            ));
        }
    }
    synthetic_graph(nodes, edges)
}

fn simple_open_graph(with_pass: bool) -> LeisureGraph {
    let mut nodes = vec![
        node("start", "junction", 0, 0.5),
        node("finish", "junction", 2, 0.5),
    ];
    let mut edges = bidirectional("start", "finish", 5.0, 100.0, 100.0);
    if with_pass {
        nodes.push(node("view-pass", "pass", 1, 0.9));
        edges.extend(bidirectional("start", "view-pass", 2.0, 50.0, 50.0));
        edges.extend(bidirectional("view-pass", "finish", 2.0, 50.0, 50.0));
    }
    synthetic_graph(nodes, edges)
}

fn complete_line_graph(count: usize) -> LeisureGraph {
    let nodes = (0..count)
        .map(|index| node(&format!("n{index}"), "junction", index, 0.5))
        .collect::<Vec<_>>();
    let mut edges = Vec::new();
    for i in 0..count {
        for j in 0..count {
            if i == j {
                continue;
            }
            let cost = (i as i32 - j as i32).unsigned_abs() as f64;
            edges.push(edge(
                &format!("n{i}"),
                &format!("n{j}"),
                "connector",
                cost,
                cost * 100.0,
                cost * 60.0,
                None,
            ));
        }
    }
    synthetic_graph(nodes, edges)
}

fn line_retrace_graph() -> LeisureGraph {
    synthetic_graph(
        vec![
            node("base", "junction", 0, 0.5),
            node("near-pass", "pass", 1, 0.8),
            node("far-pass", "pass", 2, 0.8),
        ],
        [
            bidirectional("base", "near-pass", 1.0, 100.0, 60.0),
            bidirectional("near-pass", "far-pass", 1.0, 100.0, 60.0),
        ]
        .concat(),
    )
}

fn same_location_pass_graph() -> LeisureGraph {
    let mut nodes = vec![
        node("base", "junction", 0, 0.5),
        node("pass-a", "pass", 1, 0.9),
        node("pass-b", "pass", 2, 0.9),
    ];
    for value in &mut nodes {
        value["lat"] = json!(46.0);
        value["lon"] = json!(8.0);
    }
    let ids = nodes
        .iter()
        .map(|node| node["id"].as_str().expect("node id").to_owned())
        .collect::<Vec<_>>();
    let mut edges = Vec::new();
    for i in 0..ids.len() {
        for j in 0..ids.len() {
            if i == j {
                continue;
            }
            let cost = 1.0 + (i as i32 - j as i32).unsigned_abs() as f64;
            edges.push(edge(
                &ids[i],
                &ids[j],
                "connector",
                cost,
                cost * 100.0,
                cost * 60.0,
                None,
            ));
        }
    }
    synthetic_graph(nodes, edges)
}

fn bridge_to_required_stop_graph() -> LeisureGraph {
    synthetic_graph(
        vec![
            node("base", "junction", 0, 0.5),
            node("bridge", "junction", 1, 0.5),
            node("isolated-pass", "pass", 2, 0.9),
        ],
        [
            bidirectional("base", "bridge", 1.0, 100.0, 60.0),
            bidirectional("bridge", "isolated-pass", 1.0, 100.0, 60.0),
        ]
        .concat(),
    )
}

fn empty_ears() -> leisure_core::EarDecomposition {
    leisure_core::EarDecomposition {
        ears: Vec::new(),
        pass_to_ears: Default::default(),
        junction_to_ears: Default::default(),
    }
}

fn synthetic_graph(nodes: Vec<Value>, edges: Vec<Value>) -> LeisureGraph {
    let data = json!({
        "version": "test",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": nodes.len(), "edges": edges.len() },
        "nodes": nodes,
        "edges": edges,
    });
    LeisureGraph::load_from_json(&data.to_string()).expect("synthetic graph should parse")
}

fn node(id: &str, kind: &str, index: usize, scenic_score: f64) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "name": id,
        "lat": 46.0 + index as f64 * 0.01,
        "lon": 8.0 + index as f64 * 0.01,
        "scenicScore": scenic_score,
        "themes": if kind == "pass" { vec!["panoramic-view"] } else { Vec::<&str>::new() },
    })
}

fn bidirectional(
    a: &str,
    b: &str,
    leisure_cost: f64,
    distance_m: f64,
    duration_s: f64,
) -> Vec<Value> {
    vec![
        edge(
            a,
            b,
            "connector",
            leisure_cost,
            distance_m,
            duration_s,
            None,
        ),
        edge(
            b,
            a,
            "connector",
            leisure_cost,
            distance_m,
            duration_s,
            None,
        ),
    ]
}

fn edge(
    from: &str,
    to: &str,
    kind: &str,
    leisure_cost: f64,
    distance_m: f64,
    duration_s: f64,
    pass_id: Option<&str>,
) -> Value {
    let mut value = json!({
        "id": format!("{from}->{to}"),
        "from": from,
        "to": to,
        "kind": kind,
        "distanceM": distance_m,
        "durationS": duration_s,
        "leisureCost": leisure_cost,
        "season": "all",
    });
    if let Some(pass_id) = pass_id {
        value["passId"] = json!(pass_id);
    }
    value
}

fn path_of(result: &leisure_core::PlanResult) -> Vec<String> {
    result
        .primary
        .as_ref()
        .expect("primary")
        .path
        .iter()
        .map(ToString::to_string)
        .collect()
}

fn stop_ids(tour: &leisure_core::PublicTour) -> Vec<&str> {
    tour.stops.iter().map(|stop| stop.id.as_str()).collect()
}

fn stop_signature(tour: &leisure_core::PublicTour) -> String {
    tour.stops
        .iter()
        .map(|stop| stop.id.as_str())
        .collect::<Vec<_>>()
        .join(">")
}

fn count_retraced_connectors(graph: &LeisureGraph, edge_ids: &[String]) -> usize {
    let mut seen = HashSet::new();
    let mut count = 0;
    for edge_id in edge_ids {
        let Some(index) = graph.edge_by_id.get(edge_id) else {
            continue;
        };
        let edge = &graph.edges[*index];
        let key = if edge.from <= edge.to {
            format!("{}\0{}", edge.from, edge.to)
        } else {
            format!("{}\0{}", edge.to, edge.from)
        };
        if !seen.insert(key) {
            count += 1;
        }
    }
    count
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

fn node_id(value: &str) -> NodeId {
    NodeId::from(value)
}
