use leisure_core::{
    haversine_m, leisure_astar, AStarOptions, AStarStatus, CostMode, LeisureGraph, NodeId,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

#[test]
fn trivial_from_equals_to_returns_zero_cost_singleton_path() {
    let graph = synthetic_graph(&["a"], vec![]);
    let result = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("a"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a"]);
    assert!(result.edges.is_empty());
    assert_eq!(result.total_leisure_cost, 0.0);
}

#[test]
fn from_equals_to_on_populated_graph_ignores_forbidden_edges() {
    let graph = synthetic_graph(&["a", "b"], vec![connector("a", "b", 3.0, 30.0, 9.0)]);
    let mut options = AStarOptions::default();
    options.forbidden_edges.insert(edge_index(&graph, "a", "b"));
    options.budget_cost = Some(0.0);

    let result = leisure_astar(&graph, &node_id("a"), &node_id("a"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a"]);
    assert!(result.edges.is_empty());
    assert_eq!(result.total_leisure_cost, 0.0);
}

#[test]
fn direct_connector_edge_returns_that_edge_index() {
    let graph = synthetic_graph(&["a", "b"], vec![connector("a", "b", 7.0, 70.0, 17.0)]);
    let result = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("b"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "b"]);
    assert_eq!(result.edges, vec![edge_index(&graph, "a", "b")]);
    assert_eq!(result.total_leisure_cost, 7.0);
    assert_eq!(result.total_distance_m, 70.0);
    assert_eq!(result.total_duration_s, 17.0);
}

#[test]
fn three_node_chain_returns_expected_shortest_path() {
    let graph = synthetic_graph(
        &["a", "b", "c"],
        vec![
            connector("a", "b", 2.0, 100.0, 60.0),
            connector("b", "c", 3.0, 100.0, 60.0),
            connector("a", "c", 9.0, 100.0, 60.0),
        ],
    );
    let result = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("c"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "b", "c"]);
    assert_eq!(
        result.edges,
        edge_indices(&graph, &[("a", "b"), ("b", "c")])
    );
    assert_eq!(result.total_leisure_cost, 5.0);
}

#[test]
fn one_way_edges_do_not_make_reverse_route_reachable() {
    let graph = synthetic_graph(&["a", "b"], vec![connector("b", "a", 1.0, 100.0, 60.0)]);
    let result = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("b"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Unreachable);
    assert!(result.path.is_empty());
    assert!(result.edges.is_empty());
}

#[test]
fn disconnected_islands_return_unreachable() {
    let graph = synthetic_graph(
        &["a", "b", "x", "y"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("x", "y", 1.0, 100.0, 60.0),
        ],
    );
    let result = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("y"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Unreachable);
    assert!(result.path.is_empty());
    assert!(result.edges.is_empty());
}

#[test]
fn cost_mode_selects_leisure_distance_or_duration_paths() {
    let graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 50.0, 1.0, 50.0),
            connector("a", "c", 1.0, 50.0, 50.0),
            connector("c", "b", 1.0, 50.0, 50.0),
            connector("a", "d", 10.0, 5.0, 1.0),
            connector("d", "b", 10.0, 5.0, 1.0),
        ],
    );

    assert_eq!(
        ids(&leisure_astar(
            &graph,
            &node_id("a"),
            &node_id("b"),
            &mode(CostMode::Leisure)
        )
        .path),
        vec!["a", "c", "b"]
    );
    assert_eq!(
        ids(&leisure_astar(
            &graph,
            &node_id("a"),
            &node_id("b"),
            &mode(CostMode::Distance)
        )
        .path),
        vec!["a", "b"]
    );
    assert_eq!(
        ids(&leisure_astar(
            &graph,
            &node_id("a"),
            &node_id("b"),
            &mode(CostMode::Duration)
        )
        .path),
        vec!["a", "d", "b"]
    );
}

#[test]
fn forbidden_direct_edge_takes_detour_with_direct_route_blocked() {
    let graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("a", "c", 2.0, 100.0, 60.0),
            connector("c", "d", 2.0, 100.0, 60.0),
            connector("d", "b", 2.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.forbidden_edges.insert(edge_index(&graph, "a", "b"));

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "c", "d", "b"]);
    assert_eq!(
        result.edges,
        edge_indices(&graph, &[("a", "c"), ("c", "d"), ("d", "b")])
    );
}

#[test]
fn forbidden_edges_excludes_index_and_finds_alternative() {
    let graph = synthetic_graph(
        &["a", "b", "c"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("a", "c", 2.0, 100.0, 60.0),
            connector("c", "b", 2.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.forbidden_edges.insert(edge_index(&graph, "a", "b"));

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "c", "b"]);
    assert_eq!(
        result.edges,
        edge_indices(&graph, &[("a", "c"), ("c", "b")])
    );
}

#[test]
fn forbidden_edges_can_exhaust_all_routes_without_panicking() {
    let graph = synthetic_graph(
        &["a", "b", "c"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("a", "c", 1.0, 100.0, 60.0),
            connector("c", "b", 1.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.forbidden_edges.insert(edge_index(&graph, "a", "b"));
    options.forbidden_edges.insert(edge_index(&graph, "a", "c"));

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(result.status, AStarStatus::Unreachable);
    assert!(result.path.is_empty());
    assert!(result.edges.is_empty());
}

#[test]
fn forbidden_nodes_excludes_named_node_and_skips_it() {
    let graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("b", "d", 1.0, 100.0, 60.0),
            connector("a", "c", 3.0, 100.0, 60.0),
            connector("c", "d", 3.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.forbidden_nodes.insert(node_id("b"));

    let result = leisure_astar(&graph, &node_id("a"), &node_id("d"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "c", "d"]);
    assert!(!result.path.contains(&node_id("b")));
}

#[test]
fn forbidden_node_detour_also_works_in_unidirectional_astar() {
    let graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("b", "d", 1.0, 100.0, 60.0),
            connector("a", "c", 3.0, 100.0, 60.0),
            connector("c", "d", 3.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.bidirectional = false;
    options.forbidden_nodes.insert(node_id("b"));

    let result = leisure_astar(&graph, &node_id("a"), &node_id("d"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "c", "d"]);
    assert!(!result.path.contains(&node_id("b")));
}

#[test]
fn forbidden_start_or_goal_is_unreachable() {
    let graph = synthetic_graph(&["a", "b"], vec![connector("a", "b", 1.0, 100.0, 60.0)]);
    let mut options = AStarOptions::default();
    options.forbidden_nodes.insert(node_id("a"));

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(result.status, AStarStatus::Unreachable);
    assert!(result.path.is_empty());
}

#[test]
fn missing_endpoint_is_unreachable() {
    let graph = synthetic_graph(&["a"], vec![]);
    let result = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("missing"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Unreachable);
}

#[test]
fn used_edges_penalty_chooses_more_expensive_fresh_alternative() {
    let graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("b", "d", 1.0, 100.0, 60.0),
            connector("a", "c", 3.0, 100.0, 60.0),
            connector("c", "d", 3.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.used_edges.insert(edge_index(&graph, "a", "b"));
    options.used_edges_penalty = 10.0;

    let result = leisure_astar(&graph, &node_id("a"), &node_id("d"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "c", "d"]);
    assert_eq!(result.total_leisure_cost, 6.0);
    assert_eq!(result.retraced_edge_count, 0);
}

#[test]
fn used_edges_penalty_is_clamped_to_at_least_one() {
    let graph = synthetic_graph(
        &["a", "b", "c"],
        vec![
            connector("a", "b", 2.0, 100.0, 60.0),
            connector("a", "c", 3.0, 100.0, 60.0),
            connector("c", "b", 3.0, 100.0, 60.0),
        ],
    );
    let mut options = AStarOptions::default();
    options.used_edges.insert(edge_index(&graph, "a", "b"));
    options.used_edges_penalty = 0.25;

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(ids(&result.path), vec!["a", "b"]);
    // retraced_edge_count only counts when the leisure retrace penalty is active.
    assert_eq!(result.retraced_edge_count, 0);
}

#[test]
fn budget_exceeded_returns_budget_exhausted() {
    let graph = synthetic_graph(&["a", "b"], vec![connector("a", "b", 5.0, 100.0, 60.0)]);
    let mut options = AStarOptions::default();
    options.budget_cost = Some(4.0);

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(result.status, AStarStatus::BudgetExhausted);
    assert!(result.path.is_empty());
}

#[test]
fn distance_budget_uses_raw_distance_cost() {
    let graph = synthetic_graph(&["a", "b"], vec![connector("a", "b", 1.0, 150.0, 60.0)]);
    let mut options = mode(CostMode::Distance);
    options.budget_cost = Some(149.0);

    let result = leisure_astar(&graph, &node_id("a"), &node_id("b"), &options);

    assert_eq!(result.status, AStarStatus::BudgetExhausted);
}

#[test]
fn leisure_heuristic_formula_is_admissible_on_small_graph() {
    let graph = synthetic_graph_with_step(
        &["n0", "n1", "n2", "n3", "goal"],
        vec![
            connector("n0", "n1", 12.0, 120.0, 60.0),
            connector("n1", "goal", 12.0, 120.0, 60.0),
            connector("n0", "n2", 15.0, 130.0, 60.0),
            connector("n2", "n3", 6.0, 80.0, 60.0),
            connector("n3", "goal", 6.0, 80.0, 60.0),
            connector("n1", "n3", 10.0, 100.0, 60.0),
        ],
        0.0001,
    );
    let exact = exact_remaining_costs(&graph, "goal", CostMode::Leisure);
    let goal = graph.node(&node_id("goal")).expect("goal node");

    for node_id in &graph.node_ids {
        let actual = exact[node_id];
        if !actual.is_finite() {
            continue;
        }
        let node = graph.node(node_id).expect("node should exist");
        let heuristic = haversine_m(node.lat, node.lon, goal.lat, goal.lon)
            * graph.edge_stats.min_leisure_per_m;
        assert!(
            heuristic <= actual + 1e-6,
            "{node_id} heuristic {heuristic} > actual {actual}"
        );
    }
}

#[test]
fn duration_heuristic_is_admissible_for_every_pair_on_five_node_grid() {
    let coords = [
        ("center", 46.0, 8.0),
        ("north", 46.01, 8.0),
        ("east", 46.0, 8.01),
        ("south", 45.99, 8.0),
        ("west", 46.0, 7.99),
    ];
    let undirected_pairs = [
        ("center", "north"),
        ("center", "east"),
        ("center", "south"),
        ("center", "west"),
        ("north", "east"),
        ("east", "south"),
        ("south", "west"),
        ("west", "north"),
    ];
    let coord = |id: &str| -> (f64, f64) {
        coords
            .iter()
            .find(|(candidate, _, _)| *candidate == id)
            .map(|(_, lat, lon)| (*lat, *lon))
            .unwrap_or_else(|| panic!("missing coordinate for {id}"))
    };
    let mut edges = Vec::new();
    for (from, to) in undirected_pairs {
        let (from_lat, from_lon) = coord(from);
        let (to_lat, to_lon) = coord(to);
        let distance_m = haversine_m(from_lat, from_lon, to_lat, to_lon) * 1.10;
        let duration_s = distance_m * 2.0;
        edges.push(connector(
            from,
            to,
            distance_m / 1000.0,
            distance_m,
            duration_s,
        ));
        edges.push(connector(
            to,
            from,
            distance_m / 1000.0,
            distance_m,
            duration_s,
        ));
    }
    let graph = synthetic_graph_with_coords(&coords, edges);

    for (target_id, _, _) in coords {
        let exact = exact_remaining_costs(&graph, target_id, CostMode::Duration);
        let target = graph.node(&node_id(target_id)).expect("target node");
        for source_id in &graph.node_ids {
            let actual = exact[source_id];
            if !actual.is_finite() {
                continue;
            }
            let source = graph.node(source_id).expect("source node");
            let heuristic = haversine_m(source.lat, source.lon, target.lat, target.lon)
                * graph.edge_stats.min_duration_per_m;
            assert!(
                heuristic <= actual + 1e-6,
                "{source_id}->{target_id} heuristic {heuristic} > actual {actual}"
            );
        }
    }
}

#[test]
fn bidirectional_and_unidirectional_searches_agree_on_finite_cost() {
    let graph = synthetic_graph_with_step(
        &["a", "b", "c", "d", "e"],
        vec![
            connector("a", "b", 2.0, 100.0, 60.0),
            connector("b", "e", 5.0, 100.0, 60.0),
            connector("a", "c", 3.0, 100.0, 60.0),
            connector("c", "d", 1.0, 100.0, 60.0),
            connector("d", "e", 1.0, 100.0, 60.0),
            connector("b", "d", 2.0, 100.0, 60.0),
        ],
        0.0001,
    );
    let bidirectional = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("e"),
        &AStarOptions::default(),
    );
    let mut unidirectional_options = AStarOptions::default();
    unidirectional_options.bidirectional = false;
    let unidirectional = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("e"),
        &unidirectional_options,
    );

    assert_eq!(bidirectional.status, AStarStatus::Ok);
    assert_eq!(unidirectional.status, AStarStatus::Ok);
    assert_eq!(
        bidirectional.total_leisure_cost,
        unidirectional.total_leisure_cost
    );
}

#[test]
fn bidirectional_barbell_route_crosses_the_single_bridge_edge() {
    let left = ["l0", "l1", "l2"];
    let right = ["r0", "r1", "r2"];
    let mut edges = Vec::new();
    for from in left {
        for to in left {
            if from != to {
                edges.push(connector(from, to, 1.0, 100.0, 60.0));
            }
        }
    }
    for from in right {
        for to in right {
            if from != to {
                edges.push(connector(from, to, 1.0, 100.0, 60.0));
            }
        }
    }
    edges.push(connector("l2", "r0", 1.0, 100.0, 60.0));
    let graph = synthetic_graph(&["l0", "l1", "l2", "r0", "r1", "r2"], edges);

    let result = leisure_astar(
        &graph,
        &node_id("l0"),
        &node_id("r2"),
        &AStarOptions::default(),
    );

    assert_eq!(result.status, AStarStatus::Ok);
    assert!(result.edges.contains(&edge_index(&graph, "l2", "r0")));
    assert_eq!(
        result
            .edges
            .iter()
            .filter(|&&edge| edge == edge_index(&graph, "l2", "r0"))
            .count(),
        1
    );
    assert_eq!(result.total_leisure_cost, 3.0);
}

#[test]
fn astar_is_deterministic_across_three_runs_on_tied_graph() {
    let graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("b", "d", 1.0, 100.0, 60.0),
            connector("a", "c", 1.0, 100.0, 60.0),
            connector("c", "d", 1.0, 100.0, 60.0),
        ],
    );
    let first = leisure_astar(
        &graph,
        &node_id("a"),
        &node_id("d"),
        &AStarOptions::default(),
    );

    for _ in 0..2 {
        let next = leisure_astar(
            &graph,
            &node_id("a"),
            &node_id("d"),
            &AStarOptions::default(),
        );
        assert_eq!(next, first);
    }
    assert_eq!(ids(&first.path), vec!["a", "b", "d"]);
}

#[test]
fn zero_leisure_heuristic_unidirectional_search_still_finds_optimal_path() {
    let mut graph = synthetic_graph(
        &["a", "b", "c", "d"],
        vec![
            connector("a", "b", 1.0, 100.0, 60.0),
            connector("b", "d", 1.0, 100.0, 60.0),
            connector("a", "c", 3.0, 100.0, 60.0),
            connector("c", "d", 3.0, 100.0, 60.0),
            connector("a", "d", 5.0, 100.0, 60.0),
        ],
    );
    graph.edge_stats.min_leisure_per_m = 0.0;
    let mut options = AStarOptions::default();
    options.bidirectional = false;

    let result = leisure_astar(&graph, &node_id("a"), &node_id("d"), &options);

    assert_eq!(result.status, AStarStatus::Ok);
    assert_eq!(ids(&result.path), vec!["a", "b", "d"]);
    assert_eq!(result.total_leisure_cost, 2.0);
}

#[test]
fn real_hero_query_succeeds_and_restricted_path_matches_manual_cost() {
    let graph = load_real_graph();
    let started = Instant::now();
    let result = leisure_astar(
        &graph,
        &node_id("furkapass:A"),
        &node_id("grimselpass:B"),
        &AStarOptions::default(),
    );
    let elapsed = started.elapsed();
    eprintln!(
        "A* furkapass:A→grimselpass:B runtime: {:.3}ms",
        elapsed.as_secs_f64() * 1000.0
    );

    assert_eq!(result.status, AStarStatus::Ok);
    assert!(result.total_leisure_cost.is_finite());

    let curated = [
        "furkapass:A",
        "grimselpass:A",
        "grimselpass:S",
        "grimselpass:B",
    ];
    let allowed: HashSet<NodeId> = curated.iter().map(|id| node_id(id)).collect();
    let mut restricted_options = AStarOptions::default();
    restricted_options.forbidden_nodes = graph
        .node_ids
        .iter()
        .filter(|id| !allowed.contains(*id))
        .cloned()
        .collect();
    let restricted = leisure_astar(
        &graph,
        &node_id("furkapass:A"),
        &node_id("grimselpass:B"),
        &restricted_options,
    );
    let expected_edges = edge_indices(
        &graph,
        &[
            ("furkapass:A", "grimselpass:A"),
            ("grimselpass:A", "grimselpass:S"),
            ("grimselpass:S", "grimselpass:B"),
        ],
    );
    let manual_cost: f64 = expected_edges
        .iter()
        .map(|&index| graph.edges[index].leisure_cost)
        .sum();

    assert_eq!(restricted.status, AStarStatus::Ok);
    assert_eq!(ids(&restricted.path), curated);
    assert_eq!(restricted.edges, expected_edges);
    assert!((restricted.total_leisure_cost - manual_cost).abs() <= 1e-9);
}

#[test]
#[ignore = "manual performance guard; timing can be noisy on shared CI"]
fn real_hero_query_stays_under_sixty_ms_when_run_manually() {
    let graph = load_real_graph();
    let started = Instant::now();
    let result = leisure_astar(
        &graph,
        &node_id("furkapass:A"),
        &node_id("grimselpass:B"),
        &AStarOptions::default(),
    );
    let elapsed = started.elapsed();

    assert_eq!(result.status, AStarStatus::Ok);
    assert!(
        elapsed.as_millis() < 60,
        "hero query took {:.3}ms",
        elapsed.as_secs_f64() * 1000.0
    );
}

fn synthetic_graph(ids: &[&str], edges: Vec<Value>) -> LeisureGraph {
    synthetic_graph_with_step(ids, edges, 0.001)
}

fn synthetic_graph_with_coords(coords: &[(&str, f64, f64)], edges: Vec<Value>) -> LeisureGraph {
    let nodes: Vec<Value> = coords
        .iter()
        .map(|(id, lat, lon)| {
            json!({
                "id": id,
                "kind": "junction",
                "name": id,
                "lat": lat,
                "lon": lon,
            })
        })
        .collect();
    let data = json!({
        "version": "test",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": nodes.len(), "edges": edges.len() },
        "nodes": nodes,
        "edges": edges,
    });
    LeisureGraph::load_from_json(&data.to_string())
        .expect("synthetic coordinate graph should parse")
}

fn synthetic_graph_with_step(
    ids: &[&str],
    edges: Vec<Value>,
    coordinate_step: f64,
) -> LeisureGraph {
    let nodes: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            json!({
                "id": id,
                "kind": "junction",
                "name": id,
                "lat": 46.0,
                "lon": 8.0 + index as f64 * coordinate_step,
            })
        })
        .collect();
    let data = json!({
        "version": "test",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": nodes.len(), "edges": edges.len() },
        "nodes": nodes,
        "edges": edges,
    });
    LeisureGraph::load_from_json(&data.to_string()).expect("synthetic graph should parse")
}

fn connector(from: &str, to: &str, leisure_cost: f64, distance_m: f64, duration_s: f64) -> Value {
    json!({
        "id": format!("{from}->{to}"),
        "from": from,
        "to": to,
        "kind": "connector",
        "distanceM": distance_m,
        "durationS": duration_s,
        "leisureCost": leisure_cost,
    })
}

fn mode(cost_mode: CostMode) -> AStarOptions {
    AStarOptions {
        cost_mode,
        ..AStarOptions::default()
    }
}

fn raw_cost(edge: &leisure_core::Edge, mode: CostMode) -> f64 {
    match mode {
        CostMode::Leisure => edge.leisure_cost,
        CostMode::Distance => edge.distance_m,
        CostMode::Duration => edge.duration_s,
    }
}

fn exact_remaining_costs(
    graph: &LeisureGraph,
    goal_id: &str,
    cost_mode: CostMode,
) -> HashMap<NodeId, f64> {
    let mut costs: HashMap<NodeId, f64> = graph
        .node_ids
        .iter()
        .cloned()
        .map(|id| (id, f64::INFINITY))
        .collect();
    costs.insert(node_id(goal_id), 0.0);
    let mut unsettled: HashSet<NodeId> = graph.node_ids.iter().cloned().collect();

    while !unsettled.is_empty() {
        let current = unsettled
            .iter()
            .min_by(|left, right| {
                costs[*left]
                    .total_cmp(&costs[*right])
                    .then_with(|| left.cmp(right))
            })
            .cloned()
            .expect("unsettled node");
        if !costs[&current].is_finite() {
            break;
        }
        unsettled.remove(&current);
        for edge in graph.incoming_edges(&current) {
            let candidate = costs[&current] + raw_cost(edge, cost_mode);
            if candidate < costs[&edge.from] {
                costs.insert(edge.from.clone(), candidate);
            }
        }
    }
    costs
}

fn real_graph_json() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("data")
        .join("leisure-graph.v1.json");
    fs::read_to_string(path).expect("real leisure graph should be readable")
}

fn load_real_graph() -> LeisureGraph {
    LeisureGraph::load_from_json(&real_graph_json()).expect("real graph should parse")
}

fn node_id(value: &str) -> NodeId {
    NodeId::from(value)
}

fn ids(nodes: &[NodeId]) -> Vec<&str> {
    nodes.iter().map(NodeId::as_str).collect()
}

fn edge_index(graph: &LeisureGraph, from: &str, to: &str) -> usize {
    *graph
        .edge_by_key
        .get(&format!("{from}->{to}"))
        .unwrap_or_else(|| panic!("missing edge {from}->{to}"))
}

fn edge_indices(graph: &LeisureGraph, pairs: &[(&str, &str)]) -> Vec<usize> {
    pairs
        .iter()
        .map(|(from, to)| edge_index(graph, from, to))
        .collect()
}
