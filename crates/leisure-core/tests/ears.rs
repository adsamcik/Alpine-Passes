use leisure_core::{
    decompose_ears, Ear, EarDecomposition, EarKind, LeisureGraph, NodeId, NodeKind,
};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

static REAL_GRAPH: Lazy<LeisureGraph> = Lazy::new(load_real_graph);
static REAL_DECOMP: Lazy<EarDecomposition> = Lazy::new(|| decompose_ears(&REAL_GRAPH));

#[test]
fn diamond_graph_decomposes_to_one_loop_ear_containing_both_passes() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("end", "junction", 1),
            node("A", "pass", 2),
            node("B", "pass", 3),
        ],
        vec![
            connector("start", "A", 1.0),
            connector("A", "end", 1.0),
            connector("start", "B", 1.0),
            connector("B", "end", 1.0),
        ],
    );
    let decomposition = decompose_ears(&graph);
    let loops: Vec<&Ear> = decomposition
        .ears
        .iter()
        .filter(|ear| ear.kind == EarKind::Loop)
        .collect();

    assert_eq!(loops.len(), 1);
    assert_eq!(loops[0].passes, vec!["A".to_owned(), "B".to_owned()]);
    assert_eq!(
        loops[0].edges.iter().copied().collect::<BTreeSet<_>>(),
        edge_set(
            &graph,
            &[("start", "A"), ("A", "end"), ("start", "B"), ("B", "end")]
        )
    );
}

#[test]
fn linear_chain_decomposes_to_single_path_ear_and_no_loops() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("A", "pass", 1),
            node("B", "pass", 2),
            node("C", "pass", 3),
            node("end", "junction", 4),
        ],
        vec![
            connector("start", "A", 1.0),
            connector("A", "B", 1.0),
            connector("B", "C", 1.0),
            connector("C", "end", 1.0),
        ],
    );
    let ears = decompose_ears(&graph).ears;

    assert_eq!(
        ears.iter().filter(|ear| ear.kind == EarKind::Loop).count(),
        0
    );
    assert_eq!(ears.len(), 1);
    assert_eq!(ears[0].kind, EarKind::Path);
    assert_eq!(
        ears[0].passes,
        vec!["A".to_owned(), "B".to_owned(), "C".to_owned()]
    );
}

#[test]
fn bridge_path_compression_keeps_four_edge_chain_as_one_path_ear() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("j-A", "poi", 1),
            node("pass-X", "pass", 2),
            node("j-B", "poi", 3),
            node("end", "junction", 4),
        ],
        vec![
            connector("start", "j-A", 1.0),
            connector("j-A", "pass-X", 1.0),
            connector("pass-X", "j-B", 1.0),
            connector("j-B", "end", 1.0),
        ],
    );
    let ears = decompose_ears(&graph).ears;
    let path_ears: Vec<&Ear> = ears
        .iter()
        .filter(|ear| ear.kind == EarKind::Path && ear.passes.contains(&"pass-X".to_owned()))
        .collect();

    assert_eq!(path_ears.len(), 1);
    assert_eq!(path_ears[0].edges.len(), 4);
    assert_eq!(
        path_ears[0].edges.iter().copied().collect::<BTreeSet<_>>(),
        edge_set(
            &graph,
            &[
                ("start", "j-A"),
                ("j-A", "pass-X"),
                ("pass-X", "j-B"),
                ("j-B", "end"),
            ]
        )
    );
}

#[test]
fn y_shape_exposes_fork_edges_as_structurally_distinct_ears() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("A", "pass", 1),
            node("B", "pass", 2),
            node("end", "junction", 3),
        ],
        vec![
            connector("start", "A", 1.0),
            connector("B", "A", 1.0),
            connector("A", "end", 1.0),
        ],
    );
    let ears = decompose_ears(&graph).ears;
    let edge_sets: Vec<BTreeSet<usize>> = ears
        .iter()
        .map(|ear| ear.edges.iter().copied().collect())
        .collect();

    assert_eq!(
        ears.iter().filter(|ear| ear.kind == EarKind::Loop).count(),
        0
    );
    assert!(edge_sets
        .iter()
        .any(|edges| edges.contains(&edge_index(&graph, "B", "A"))));
    assert!(edge_sets
        .iter()
        .any(|edges| edges.contains(&edge_index(&graph, "start", "A"))));
    assert!(edge_sets
        .iter()
        .any(|edges| edges.contains(&edge_index(&graph, "A", "end"))));
    assert!(ears.iter().all(|ear| {
        ear.attachment_nodes.contains(&node_id("A")) || ear.passes.contains(&"A".to_owned())
    }));
}

#[test]
fn pass_triplet_contraction_expands_loop_with_pass_climb_edges() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("end", "junction", 1),
            node("q", "pass", 2),
            node("p", "pass", 3),
            pass_node("p:A", "pass-base", "p", Some("A"), 4),
            pass_node("p:S", "pass-summit", "p", None, 5),
            pass_node("p:B", "pass-base", "p", Some("B"), 6),
        ],
        vec![
            connector("start", "p:A", 1.0),
            connector("p:B", "end", 1.0),
            connector("end", "q", 1.0),
            connector("q", "start", 1.0),
            pass_climb("p:A", "p:S", "p", 2.0),
            pass_climb("p:S", "p:B", "p", 3.0),
        ],
    );
    let decomposition = decompose_ears(&graph);
    let ear = decomposition
        .ears
        .iter()
        .find(|ear| ear.kind == EarKind::Loop && ear.passes.contains(&"p".to_owned()))
        .expect("loop through p should be emitted");

    assert!(ear.edges.contains(&edge_index(&graph, "p:A", "p:S")));
    assert!(ear.edges.contains(&edge_index(&graph, "p:S", "p:B")));
    assert!((ear.total_leisure_cost - sum_leisure(&graph, &ear.edges)).abs() <= 1e-9);
}

#[test]
fn isolated_pass_stub_is_emitted_for_uncovered_pass() {
    let graph = synthetic_graph(vec![node("lonely", "pass", 0)], vec![]);
    let ears = decompose_ears(&graph).ears;

    assert_eq!(ears.len(), 1);
    assert_eq!(ears[0].kind, EarKind::IsolatedPass);
    assert_eq!(ears[0].passes, vec!["lonely".to_owned()]);
    assert!(ears[0].edges.is_empty());
    assert_eq!(ears[0].attachment_nodes, vec![node_id("lonely")]);
    assert_eq!(ears[0].total_leisure_cost, 0.0);
}

#[test]
fn empty_graph_decomposes_to_no_ears() {
    let graph = synthetic_graph(vec![], vec![]);
    let decomposition = decompose_ears(&graph);

    assert!(decomposition.ears.is_empty());
    assert!(decomposition.pass_to_ears.is_empty());
    assert!(decomposition.junction_to_ears.is_empty());
}

#[test]
fn single_non_pass_node_decomposes_to_no_ears() {
    let graph = synthetic_graph(vec![node("viewpoint", "poi", 0)], vec![]);
    let decomposition = decompose_ears(&graph);

    assert!(decomposition.ears.is_empty());
    assert!(decomposition.pass_to_ears.is_empty());
}

#[test]
fn nested_bridge_chain_has_no_loops_and_keeps_full_pass_coverage() {
    let graph = synthetic_graph(
        vec![
            node("A", "pass", 0),
            node("B", "pass", 1),
            node("C", "pass", 2),
            node("D", "pass", 3),
        ],
        vec![
            connector("A", "B", 1.0),
            connector("B", "C", 1.0),
            connector("C", "D", 1.0),
        ],
    );
    let decomposition = decompose_ears(&graph);

    assert_eq!(
        decomposition
            .ears
            .iter()
            .filter(|ear| ear.kind == EarKind::Loop)
            .count(),
        0
    );
    assert_eq!(decomposition.pass_to_ears.len(), 4);
    for pass_id in ["A", "B", "C", "D"] {
        let indices = decomposition
            .pass_to_ears
            .get(pass_id)
            .unwrap_or_else(|| panic!("{pass_id} should be covered"));
        assert!(indices.iter().any(|&index| decomposition.ears[index]
            .passes
            .contains(&pass_id.to_owned())));
    }
}

#[test]
fn loop_without_junction_or_articulation_uses_first_node_as_attachment_fallback() {
    let graph = synthetic_graph(
        vec![
            node("P0", "pass", 0),
            node("P1", "pass", 1),
            node("P2", "pass", 2),
        ],
        vec![
            connector("P0", "P1", 1.0),
            connector("P1", "P2", 1.0),
            connector("P2", "P0", 1.0),
        ],
    );
    let ears = decompose_ears(&graph).ears;
    let loop_ear = ears
        .iter()
        .find(|ear| ear.kind == EarKind::Loop)
        .expect("triangle loop should exist");

    assert_eq!(loop_ear.attachment_nodes.len(), 1);
    assert!(loop_ear
        .passes
        .contains(&loop_ear.attachment_nodes[0].to_string()));
}

#[test]
fn two_disjoint_cycle_components_each_emit_loop_ears() {
    let graph = synthetic_graph(
        vec![
            node("j0", "junction", 0),
            node("j1", "junction", 1),
            node("A", "pass", 2),
            node("B", "pass", 3),
            node("j2", "junction", 4),
            node("j3", "junction", 5),
            node("C", "pass", 6),
            node("D", "pass", 7),
        ],
        vec![
            connector("j0", "A", 1.0),
            connector("A", "j1", 1.0),
            connector("j1", "B", 1.0),
            connector("B", "j0", 1.0),
            connector("j2", "C", 2.0),
            connector("C", "j3", 2.0),
            connector("j3", "D", 2.0),
            connector("D", "j2", 2.0),
        ],
    );
    let loops: Vec<Ear> = decompose_ears(&graph)
        .ears
        .into_iter()
        .filter(|ear| ear.kind == EarKind::Loop)
        .collect();

    assert_eq!(loops.len(), 2);
    assert!(loops
        .iter()
        .any(|ear| ear.passes == vec!["A".to_owned(), "B".to_owned()]));
    assert!(loops
        .iter()
        .any(|ear| ear.passes == vec!["C".to_owned(), "D".to_owned()]));
}

#[test]
fn non_connector_self_loop_is_ignored_without_infinite_looping() {
    let graph = synthetic_graph(
        vec![node("poi", "poi", 0), node("pass", "pass", 1)],
        vec![
            edge("poi", "poi", "pass-out-and-back", 1.0, None),
            connector("poi", "pass", 2.0),
        ],
    );
    let decomposition = decompose_ears(&graph);

    assert_eq!(
        decomposition
            .ears
            .iter()
            .filter(|ear| ear.kind == EarKind::Loop)
            .count(),
        0
    );
    assert_eq!(decomposition.pass_to_ears.len(), 1);
    assert!(decomposition.pass_to_ears.contains_key("pass"));
}

#[test]
fn pass_and_junction_indexes_reference_emitted_ear_indices() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("end", "junction", 1),
            node("A", "pass", 2),
            node("B", "pass", 3),
        ],
        vec![
            connector("start", "A", 1.0),
            connector("A", "end", 1.0),
            connector("start", "B", 1.0),
            connector("B", "end", 1.0),
        ],
    );
    let decomposition = decompose_ears(&graph);
    let loop_index = decomposition
        .ears
        .iter()
        .position(|ear| ear.kind == EarKind::Loop)
        .expect("loop index");

    assert!(decomposition.pass_to_ears["A"].contains(&loop_index));
    assert!(decomposition.pass_to_ears["B"].contains(&loop_index));
    assert!(decomposition.junction_to_ears["start"].contains(&loop_index));
    assert!(decomposition.junction_to_ears["end"].contains(&loop_index));
}

#[test]
fn pass_index_entries_reference_ears_that_contain_that_pass() {
    for (pass_id, ear_indices) in &REAL_DECOMP.pass_to_ears {
        assert!(
            !ear_indices.is_empty(),
            "{pass_id} should map to at least one ear"
        );
        for &ear_index in ear_indices {
            let ear = REAL_DECOMP
                .ears
                .get(ear_index)
                .unwrap_or_else(|| panic!("{pass_id} references missing ear {ear_index}"));
            assert!(
                ear.passes.contains(pass_id),
                "{pass_id} mapped to {} without naming the pass",
                ear.id
            );
        }
    }
}

#[test]
fn every_synthetic_ear_total_equals_sum_of_referenced_edge_costs() {
    let graph = synthetic_graph(
        vec![
            node("start", "junction", 0),
            node("end", "junction", 1),
            node("A", "pass", 2),
            node("B", "pass", 3),
        ],
        vec![
            connector("start", "A", 1.25),
            connector("A", "end", 2.5),
            connector("start", "B", 3.75),
            connector("B", "end", 4.0),
        ],
    );
    let decomposition = decompose_ears(&graph);

    for ear in &decomposition.ears {
        assert!((ear.total_leisure_cost - sum_leisure(&graph, &ear.edges)).abs() <= 1e-9);
        assert!(
            (ear.total_distance_km - sum_distance_m(&graph, &ear.edges) / 1000.0).abs() <= 1e-9
        );
    }
}

#[test]
fn cycle_cap_emits_32_cheapest_loop_ears_for_dense_biconnected_component() {
    let nodes: Vec<Value> = (0..8)
        .map(|index| node(&format!("P{index}"), "pass", index))
        .collect();
    let mut edges = Vec::new();
    let mut cost = 1.0;
    for i in 0..nodes.len() {
        for j in (i + 1)..nodes.len() {
            edges.push(connector(
                nodes[i]["id"].as_str().expect("id"),
                nodes[j]["id"].as_str().expect("id"),
                cost,
            ));
            cost += 1.0;
        }
    }
    let graph = synthetic_graph(nodes, edges);
    let ears = decompose_ears(&graph).ears;

    assert_eq!(ears.len(), 32);
    assert!(ears.iter().all(|ear| ear.kind == EarKind::Loop));
    for pair in ears.windows(2) {
        assert!(pair[0].total_leisure_cost <= pair[1].total_leisure_cost);
    }
}

#[test]
fn cycle_coverage_extension_admits_extra_loops_to_cover_all_bcc_passes() {
    let cheap_nodes: Vec<Value> = (0..12)
        .map(|index| node(&format!("P{index}"), "pass", index))
        .collect();
    let rare = node("P-rare", "pass", cheap_nodes.len());
    let mut nodes = cheap_nodes.clone();
    nodes.push(rare);
    let mut edges = Vec::new();
    for i in 0..cheap_nodes.len() {
        for j in (i + 1)..cheap_nodes.len() {
            edges.push(connector(
                cheap_nodes[i]["id"].as_str().expect("id"),
                cheap_nodes[j]["id"].as_str().expect("id"),
                1.0,
            ));
        }
    }
    edges.push(connector("P0", "P-rare", 500.0));
    edges.push(connector("P-rare", "P1", 500.0));
    let graph = synthetic_graph(nodes, edges);
    let decomposition = decompose_ears(&graph);
    let loop_count = decomposition
        .ears
        .iter()
        .filter(|ear| ear.kind == EarKind::Loop)
        .count();

    assert!(
        loop_count > 32,
        "expected coverage extension beyond base cap, got {loop_count}"
    );
    assert!(decomposition.pass_to_ears["P-rare"]
        .iter()
        .any(|&ear_index| decomposition.ears[ear_index].kind == EarKind::Loop));
}

#[test]
fn coverage_extension_stops_at_256_loop_hard_cap_and_stubs_the_rest() {
    let pass_count = 300usize;
    let mut nodes = vec![node("left", "junction", 0), node("right", "junction", 1)];
    nodes.extend((0..pass_count).map(|index| node(&format!("P{index:03}"), "pass", index + 2)));

    let mut edges = vec![connector("left", "right", 1.0)];
    for index in 0..pass_count {
        let pass_id = format!("P{index:03}");
        let spoke_cost = 1000.0 + index as f64;
        edges.push(connector("left", &pass_id, spoke_cost));
        edges.push(connector(&pass_id, "right", spoke_cost));
    }
    let decomposition = decompose_ears(&synthetic_graph(nodes, edges));
    let loop_count = decomposition
        .ears
        .iter()
        .filter(|ear| ear.kind == EarKind::Loop)
        .count();
    let isolated_count = decomposition
        .ears
        .iter()
        .filter(|ear| ear.kind == EarKind::IsolatedPass)
        .count();

    assert_eq!(loop_count, 256);
    assert_eq!(isolated_count, pass_count - 256);
    assert_eq!(decomposition.pass_to_ears.len(), pass_count);
    assert!(decomposition.pass_to_ears["P255"]
        .iter()
        .any(|&ear_index| decomposition.ears[ear_index].kind == EarKind::Loop));
    assert!(decomposition.pass_to_ears["P256"]
        .iter()
        .any(|&ear_index| decomposition.ears[ear_index].kind == EarKind::IsolatedPass));
}

#[test]
fn real_graph_decomposes_to_js_parity_ear_count_and_full_pass_coverage() {
    let pass_count = REAL_GRAPH.nodes_of_kind(NodeKind::Pass).len();
    let missing: Vec<String> = REAL_GRAPH
        .nodes_of_kind(NodeKind::Pass)
        .iter()
        .filter(|pass_id| !REAL_DECOMP.pass_to_ears.contains_key(pass_id.as_str()))
        .map(ToString::to_string)
        .collect();

    assert_eq!(REAL_DECOMP.ears.len(), 205);
    assert_eq!(REAL_DECOMP.pass_to_ears.len(), pass_count);
    assert!(missing.is_empty(), "missing passes: {missing:?}");
}

#[test]
fn every_real_ear_has_unique_passes_and_totals_match_edge_sums() {
    for ear in &REAL_DECOMP.ears {
        assert!(
            !ear.passes.is_empty(),
            "{} should include at least one pass",
            ear.id
        );
        let unique: BTreeSet<&String> = ear.passes.iter().collect();
        assert_eq!(
            unique.len(),
            ear.passes.len(),
            "{} has duplicate passes",
            ear.id
        );
        if ear.kind == EarKind::IsolatedPass {
            assert!(ear.edges.is_empty());
            assert_eq!(ear.total_leisure_cost, 0.0);
            continue;
        }
        assert!(!ear.edges.is_empty(), "{} should reference edges", ear.id);
        assert!((ear.total_leisure_cost - sum_leisure(&REAL_GRAPH, &ear.edges)).abs() <= 1e-6);
        assert!(
            (ear.total_distance_km - sum_distance_m(&REAL_GRAPH, &ear.edges) / 1000.0).abs()
                <= 1e-6
        );
    }
}

#[test]
fn decompose_ears_is_deterministic_for_real_graph_order_and_ids() {
    let second = decompose_ears(&REAL_GRAPH);
    let first_signatures: Vec<_> = REAL_DECOMP.ears.iter().map(ear_signature).collect();
    let second_signatures: Vec<_> = second.ears.iter().map(ear_signature).collect();

    assert_eq!(second_signatures, first_signatures);
}

#[test]
fn decompose_ears_is_deterministic_across_three_runs_on_tied_synthetic_graph() {
    let graph = synthetic_graph(
        vec![
            node("j0", "junction", 0),
            node("j1", "junction", 1),
            node("A", "pass", 2),
            node("B", "pass", 3),
            node("C", "pass", 4),
            node("D", "pass", 5),
        ],
        vec![
            connector("j0", "A", 1.0),
            connector("A", "j1", 1.0),
            connector("j1", "B", 1.0),
            connector("B", "j0", 1.0),
            connector("j0", "C", 1.0),
            connector("C", "j1", 1.0),
            connector("j1", "D", 1.0),
            connector("D", "j0", 1.0),
        ],
    );
    let first = decompose_ears(&graph);
    let first_signatures: Vec<_> = first.ears.iter().map(ear_signature).collect();

    for _ in 0..2 {
        let next = decompose_ears(&graph);
        let next_signatures: Vec<_> = next.ears.iter().map(ear_signature).collect();
        assert_eq!(next_signatures, first_signatures);
    }
}

#[test]
#[ignore = "manual stress test for iterative BCC DFS on very deep bridge chains"]
fn deep_bridge_chain_over_10000_nodes_does_not_stack_overflow() {
    let node_count = 10_250usize;
    let nodes: Vec<Value> = (0..node_count)
        .map(|index| node(&format!("P{index:05}"), "pass", index))
        .collect();
    let edges: Vec<Value> = (0..node_count - 1)
        .map(|index| connector(&format!("P{index:05}"), &format!("P{:05}", index + 1), 1.0))
        .collect();
    let decomposition = decompose_ears(&synthetic_graph(nodes, edges));

    assert_eq!(decomposition.pass_to_ears.len(), node_count);
    assert_eq!(
        decomposition
            .ears
            .iter()
            .filter(|ear| ear.kind == EarKind::Loop)
            .count(),
        0
    );
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

fn node(id: &str, kind: &str, index: usize) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "name": id,
        "lat": 46.0 + index as f64 * 0.001,
        "lon": 8.0 + index as f64 * 0.001,
    })
}

fn pass_node(id: &str, kind: &str, pass_id: &str, side: Option<&str>, index: usize) -> Value {
    let mut value = node(id, kind, index);
    value["passId"] = json!(pass_id);
    if let Some(side) = side {
        value["side"] = json!(side);
    }
    value
}

fn connector(from: &str, to: &str, leisure_cost: f64) -> Value {
    edge(from, to, "connector", leisure_cost, None)
}

fn pass_climb(from: &str, to: &str, pass_id: &str, leisure_cost: f64) -> Value {
    edge(from, to, "pass-climb", leisure_cost, Some(pass_id))
}

fn edge(from: &str, to: &str, kind: &str, leisure_cost: f64, pass_id: Option<&str>) -> Value {
    let mut value = json!({
        "id": format!("{from}->{to}"),
        "from": from,
        "to": to,
        "kind": kind,
        "distanceM": leisure_cost * 100.0,
        "durationS": leisure_cost * 60.0,
        "leisureCost": leisure_cost,
    });
    if let Some(pass_id) = pass_id {
        value["passId"] = json!(pass_id);
    }
    value
}

fn load_real_graph() -> LeisureGraph {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("data")
        .join("leisure-graph.v1.json");
    let json = fs::read_to_string(path).expect("real leisure graph should be readable");
    LeisureGraph::load_from_json(&json).expect("real graph should parse")
}

fn edge_index(graph: &LeisureGraph, from: &str, to: &str) -> usize {
    *graph
        .edge_by_key
        .get(&format!("{from}->{to}"))
        .unwrap_or_else(|| panic!("missing edge {from}->{to}"))
}

fn edge_set(graph: &LeisureGraph, pairs: &[(&str, &str)]) -> BTreeSet<usize> {
    pairs
        .iter()
        .map(|(from, to)| edge_index(graph, from, to))
        .collect()
}

fn sum_leisure(graph: &LeisureGraph, edges: &[usize]) -> f64 {
    edges
        .iter()
        .map(|&index| graph.edges[index].leisure_cost)
        .sum()
}

fn sum_distance_m(graph: &LeisureGraph, edges: &[usize]) -> f64 {
    edges
        .iter()
        .map(|&index| graph.edges[index].distance_m)
        .sum()
}

fn node_id(value: &str) -> NodeId {
    NodeId::from(value)
}

fn ear_signature(
    ear: &Ear,
) -> (
    String,
    String,
    Vec<String>,
    Vec<usize>,
    Vec<String>,
    u64,
    u64,
) {
    (
        ear.id.clone(),
        format!("{:?}", ear.kind),
        ear.passes.clone(),
        ear.edges.clone(),
        ear.attachment_nodes
            .iter()
            .map(ToString::to_string)
            .collect(),
        ear.total_leisure_cost.to_bits(),
        ear.total_distance_km.to_bits(),
    )
}
