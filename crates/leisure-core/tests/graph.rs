// Native regression tests for the Rust leisure graph loader and indexes.

use leisure_core::{
    haversine_m, Edge, GraphData, GraphStats, LeisureGraph, Node, NodeId, NodeKind,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

const KNOWN_NODE_KINDS: [NodeKind; 5] = [
    NodeKind::Pass,
    NodeKind::PassBase,
    NodeKind::PassSummit,
    NodeKind::Poi,
    NodeKind::Junction,
];

fn real_graph_json() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("data")
        .join("leisure-graph.v1.json");
    fs::read_to_string(path).expect("real leisure graph JSON should be readable")
}

fn load_real_graph() -> LeisureGraph {
    LeisureGraph::load_from_json(&real_graph_json()).expect("real graph should parse")
}

#[test]
fn loader_loads_real_graph_with_expected_counts_and_schema_version() {
    // What this verifies: the native loader can parse the production asset and
    // its high-level shape remains inside an evolution-tolerant envelope.
    let graph = load_real_graph();

    assert_eq!(graph.version, "1");
    assert!(
        (955..=1055).contains(&graph.node_count()),
        "unexpected node count {}",
        graph.node_count()
    );
    assert!(
        (7600..=8000).contains(&graph.edge_count()),
        "unexpected edge count {}",
        graph.edge_count()
    );
    assert_eq!(graph.stats.nodes, Some(graph.raw_nodes.len()));
    assert_eq!(graph.stats.edges, Some(graph.raw_edges.len()));
}

#[test]
fn loader_nodes_by_kind_partitions_all_known_real_nodes() {
    // What this verifies: the kind index is a lossless partition for the schema
    // kinds R4 will expose through wasm-bindgen.
    let graph = load_real_graph();

    let indexed_total: usize = KNOWN_NODE_KINDS
        .iter()
        .map(|kind| graph.nodes_of_kind(kind.clone()).len())
        .sum();

    assert_eq!(indexed_total, graph.node_count());
}

#[test]
fn loader_precomputes_positive_edge_stats_for_real_graph() {
    // What this verifies: Rust exposes the same lower-bound edge metrics the JS
    // A* heuristic uses for duration, leisure, and distance-ratio estimates.
    let graph = load_real_graph();
    let stats = &graph.edge_stats;

    assert!(stats.n_edges_considered > 0, "{stats:?}");
    assert!(
        stats.min_duration_per_m.is_finite() && stats.min_duration_per_m > 0.0,
        "{stats:?}"
    );
    assert!(
        stats.min_leisure_per_m.is_finite() && stats.min_leisure_per_m > 0.0,
        "{stats:?}"
    );
    assert!(
        stats.min_distance_ratio.is_finite() && stats.min_distance_ratio > 0.0,
        "{stats:?}"
    );
}

#[test]
fn loader_out_edges_match_edge_scan_for_seeded_sample() {
    // What this verifies: outgoing adjacency entries are built directly from
    // raw edges, checked across a deterministic 50-node pseudo-random sample.
    let graph = load_real_graph();

    for sample_index in 0..50 {
        let id = &graph.node_ids[(sample_index * 37) % graph.node_ids.len()];
        let expected = graph.edges.iter().filter(|edge| &edge.from == id).count();
        assert_eq!(
            graph.outgoing_edges(id).len(),
            expected,
            "outgoing edge count mismatch for {id}"
        );
    }
}

#[test]
fn loader_in_edges_mirror_every_outgoing_edge() {
    // What this verifies: every directed edge is discoverable from both the
    // outgoing index of its source and incoming index of its destination.
    let graph = load_real_graph();

    for edge in &graph.edges {
        assert!(
            graph.outgoing_edges(&edge.from).contains(edge),
            "missing outgoing mirror for {}",
            edge.key()
        );
        assert!(
            graph.incoming_edges(&edge.to).contains(edge),
            "missing incoming mirror for {}",
            edge.key()
        );
    }
}

#[test]
fn loader_edge_between_matches_outgoing_scan() {
    // What this verifies: the O(1) directed edge lookup returns the same edge
    // object that a caller would find by scanning the source adjacency list.
    let graph = load_real_graph();

    for edge in &graph.edges {
        let scanned = graph
            .outgoing_edges(&edge.from)
            .iter()
            .find(|candidate| *candidate == edge);
        assert_eq!(
            graph.edge_between(&edge.from, &edge.to),
            scanned,
            "edge_between disagrees for {}",
            edge.key()
        );
    }
}

#[test]
fn loader_rejects_malformed_json_with_clear_errors() {
    // What this verifies: malformed graph documents fail at load time with the
    // loader's contextual parse-error prefix preserved for callers.
    let cases = [
        (
            "missing nodes",
            r#"{"version":"test","generatedAt":"2026-01-01T00:00:00.000Z","stats":{"nodes":0,"edges":0},"edges":[]}"#,
            "missing field `nodes`",
        ),
        (
            "missing version",
            r#"{"generatedAt":"2026-01-01T00:00:00.000Z","stats":{"nodes":0,"edges":0},"nodes":[],"edges":[]}"#,
            "missing field `version`",
        ),
        (
            "nan latitude",
            r#"{"version":"test","generatedAt":"2026-01-01T00:00:00.000Z","stats":{"nodes":1,"edges":0},"nodes":[{"id":"bad","kind":"junction","name":"bad","lat":NaN,"lon":8.0}],"edges":[]}"#,
            "expected value",
        ),
    ];

    for (name, data, expected_detail) in cases {
        let message = LeisureGraph::load_from_json(data)
            .expect_err(name)
            .to_string();
        assert!(
            message.contains("failed to parse leisure graph JSON"),
            "{name}: {message}"
        );
        assert!(
            message.contains(expected_detail),
            "{name}: expected detail {expected_detail:?} in {message}"
        );
    }
}

#[test]
fn loader_parses_unknown_node_kind_then_validation_flags_it() {
    // What this verifies: forward-compatible schema evolution is a validation
    // concern, not a serde load failure, so wasm callers can receive diagnostics.
    let data = r#"{
        "version":"test",
        "generatedAt":"2026-01-01T00:00:00.000Z",
        "stats":{"nodes":1,"edges":0},
        "nodes":[{"id":"mystery","kind":"trailhead","name":"Mystery","lat":46.0,"lon":8.0}],
        "edges":[]
    }"#;

    let graph = LeisureGraph::load_from_json(data)
        .expect("loader should preserve unknown node kinds for validation");
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("unknown") && message.contains("trailhead")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn loader_is_idempotent_for_structural_counts() {
    // What this verifies: repeated parsing of the same graph string produces
    // identical structural index sizes, which R4 can cache safely.
    let data = real_graph_json();
    let first = LeisureGraph::load_from_json(&data).expect("first parse should succeed");
    let second = LeisureGraph::load_from_json(&data).expect("second parse should succeed");

    assert_eq!(first.node_count(), second.node_count());
    assert_eq!(first.edge_count(), second.edge_count());
    assert_eq!(first.edge_by_key.len(), second.edge_by_key.len());
    assert_eq!(first.edge_by_id.len(), second.edge_by_id.len());
    assert_eq!(first.pass_triplets.len(), second.pass_triplets.len());
    for kind in &KNOWN_NODE_KINDS {
        assert_eq!(
            first.nodes_of_kind(kind.clone()).len(),
            second.nodes_of_kind(kind.clone()).len(),
            "kind {kind}"
        );
    }
}

#[test]
fn validate_accepts_real_graph() {
    // What this verifies: the checked-in production graph satisfies all current
    // structural invariants before wasm-bindgen wiring consumes it.
    let graph = load_real_graph();
    let validation = graph.validate();

    assert!(
        validation.is_ok(),
        "real graph validation failed:\n{}",
        validation.errors.join("\n")
    );
}

#[test]
fn validation_reports_only_orphan_edge_endpoint() {
    // What this verifies: an edge pointing to a missing node is isolated to the
    // endpoint diagnostic instead of producing noisy secondary failures.
    let graph = synthetic_graph(
        vec![node("a", "junction", 46.0, 8.0)],
        vec![edge("a", "missing", "connector", 1.0, None)],
    );
    let validation = graph.validate();

    assert_eq!(validation.errors.len(), 1, "{:?}", validation.errors);
    assert!(
        validation.errors[0].contains("references unknown to missing"),
        "{:?}",
        validation.errors
    );
}

#[test]
fn validation_flags_out_and_back_not_costlier_than_traverse() {
    // What this verifies: pass out-and-back costs must remain strictly greater
    // than crossing via the summit, preserving the structural retrace invariant.
    let graph = synthetic_graph(
        vec![
            node("pbad", "pass", 46.0, 8.0),
            pass_node("pbad:A", "pass-base", "pbad", Some("A")),
            pass_node("pbad:S", "pass-summit", "pbad", None),
            pass_node("pbad:B", "pass-base", "pbad", Some("B")),
        ],
        vec![
            edge("pbad:A", "pbad:S", "pass-climb", 10.0, Some("pbad")),
            edge("pbad:S", "pbad:A", "pass-climb", 10.0, Some("pbad")),
            edge("pbad:S", "pbad:B", "pass-climb", 10.0, Some("pbad")),
            edge("pbad:B", "pbad:S", "pass-climb", 10.0, Some("pbad")),
            edge("pbad:A", "pbad:A", "pass-out-and-back", 20.0, Some("pbad")),
            edge("pbad:B", "pbad:B", "pass-out-and-back", 25.0, Some("pbad")),
        ],
    );
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("pbad A out-and-back is not costlier")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn validation_flags_nan_leisure_cost() {
    // What this verifies: non-finite edge costs cannot silently enter validated
    // graph data, even when constructed after JSON parsing.
    let mut bad_edge = typed_edge("a", "b", "connector", 1.0, None);
    bad_edge.leisure_cost = f64::NAN;
    let graph = graph_from_typed(
        vec![
            typed_node("a", "junction", 46.0, 8.0),
            typed_node("b", "junction", 46.001, 8.0),
        ],
        vec![bad_edge],
    );
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("invalid leisureCost")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn validation_flags_negative_distance() {
    // What this verifies: distanceM must be positive and finite for all edges.
    let mut bad_edge = edge("a", "b", "connector", 1.0, None);
    bad_edge["distanceM"] = json!(-1.0);
    let graph = synthetic_graph(
        vec![
            node("a", "junction", 46.0, 8.0),
            node("b", "junction", 46.001, 8.0),
        ],
        vec![bad_edge],
    );
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("invalid distanceM")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn validation_flags_connector_self_loop() {
    // What this verifies: ordinary graph edges are not allowed to self-loop;
    // pass-out-and-back edges are the intentional self-loop shape.
    let graph = synthetic_graph(
        vec![node("a", "junction", 46.0, 8.0)],
        vec![edge("a", "a", "connector", 1.0, None)],
    );
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("self-loop") && message.contains("a->a")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn validation_rejects_duplicate_directed_edge_kind() {
    // What this verifies: policy is pinned to reject duplicate directed edges
    // with the same (from, to, kind) instead of allowing ambiguous adjacency.
    let graph = synthetic_graph(
        vec![
            node("a", "junction", 46.0, 8.0),
            node("b", "junction", 46.001, 8.0),
        ],
        vec![
            edge("a", "b", "connector", 1.0, None),
            edge("a", "b", "connector", 2.0, None),
        ],
    );
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("duplicate edge key a->b")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn validation_flags_pass_missing_required_synthetic_side() {
    // What this verifies: policy is pinned to flag incomplete pass triplets
    // rather than silently downgrading a pass with a missing :B node.
    let graph = synthetic_graph(
        vec![
            node("partial", "pass", 46.0, 8.0),
            pass_node("partial:A", "pass-base", "partial", Some("A")),
            pass_node("partial:S", "pass-summit", "partial", None),
        ],
        vec![],
    );
    let validation = graph.validate();

    assert!(
        validation
            .errors
            .iter()
            .any(|message| message.contains("pass partial missing base B node")),
        "{:?}",
        validation.errors
    );
}

#[test]
fn pass_sides_for_furkapass_returns_triplet_with_matching_summit_coordinates() {
    // What this verifies: a real pass resolves to pass/base/summit synthetic IDs,
    // and the synthetic summit carries the canonical pass coordinates.
    let graph = load_real_graph();
    let sides = graph
        .pass_sides_for("furkapass")
        .expect("furkapass triplet should exist");
    let pass_id = NodeId::from("furkapass");
    let pass = graph.node(&pass_id).expect("furkapass node should exist");
    let summit = graph
        .node(sides.summit.as_ref().expect("summit id should exist"))
        .expect("summit node should exist");

    assert_eq!(sides.pass.as_ref().map(NodeId::as_str), Some("furkapass"));
    assert_eq!(sides.a.as_ref().map(NodeId::as_str), Some("furkapass:A"));
    assert_eq!(
        sides.summit.as_ref().map(NodeId::as_str),
        Some("furkapass:S")
    );
    assert_eq!(sides.b.as_ref().map(NodeId::as_str), Some("furkapass:B"));
    assert_eq!(summit.lat, pass.lat);
    assert_eq!(summit.lon, pass.lon);
}

#[test]
fn pass_sides_for_nonexistent_pass_returns_none() {
    // What this verifies: unknown pass IDs produce an explicit None rather than
    // an empty triplet that could be mistaken for a valid pass.
    let graph = load_real_graph();

    assert_eq!(graph.pass_sides_for("nonexistent"), None);
}

#[test]
fn node_kind_of_returns_synthetic_pass_summit_kind() {
    // What this verifies: synthetic pass summit IDs are indexed as PassSummit
    // nodes for consumers that inspect node kinds by ID.
    let graph = load_real_graph();

    assert_eq!(
        graph.node_kind_of(&NodeId::from("furkapass:S")),
        Some(NodeKind::PassSummit)
    );
}

#[test]
fn pass_sides_for_single_base_pass_returns_partial_triplet() {
    // What this verifies: the pass-side index is usable for partial synthetic
    // graphs without requiring validate() to pass first.
    let graph = synthetic_graph(
        vec![
            node("onebase", "pass", 46.0, 8.0),
            pass_node("onebase:A", "pass-base", "onebase", Some("A")),
        ],
        vec![],
    );
    let sides = graph
        .pass_sides_for("onebase")
        .expect("partial pass should still have a triplet");

    assert_eq!(sides.pass.as_ref().map(NodeId::as_str), Some("onebase"));
    assert_eq!(sides.a.as_ref().map(NodeId::as_str), Some("onebase:A"));
    assert_eq!(sides.summit, None);
    assert_eq!(sides.b, None);
}

#[test]
fn nearest_nodes_returns_three_closest_passes_in_haversine_order() {
    // What this verifies: nearest_nodes ranks a small pass grid by exact
    // haversine distance and honors the requested result count.
    let graph = grid_graph();

    let results = graph.nearest_nodes(46.0, 8.0, &[NodeKind::Pass], 3);

    assert_eq!(
        ids(&results),
        vec![
            "pass-00".to_owned(),
            "pass-01".to_owned(),
            "pass-02".to_owned()
        ]
    );
    assert_eq!(results[0].1, haversine_m(46.0, 8.0, 46.0, 8.0));
    assert_eq!(results[1].1, haversine_m(46.0, 8.0, 46.0, 8.001));
    assert_eq!(results[2].1, haversine_m(46.0, 8.0, 46.0, 8.002));
}

#[test]
fn nearest_nodes_kind_filter_returns_only_junctions() {
    // What this verifies: the kind filter excludes closer nodes of other kinds
    // and returns only the requested schema kind.
    let graph = grid_graph();

    let results = graph.nearest_nodes(46.0, 8.0, &[NodeKind::Junction], 10);

    assert_eq!(results.len(), 5);
    assert!(results
        .iter()
        .all(|(id, _)| graph.node_kind_of(id) == Some(NodeKind::Junction)));
}

#[test]
fn nearest_nodes_clamps_k_to_available_nodes() {
    // What this verifies: requesting more neighbors than exist returns every
    // valid matching node exactly once instead of padding or failing.
    let graph = grid_graph();

    let results = graph.nearest_nodes(46.0, 8.0, &[], 100);

    assert_eq!(results.len(), 10);
}

#[test]
fn nearest_nodes_distances_are_monotonic() {
    // What this verifies: sorted nearest-neighbor output is monotonically
    // non-decreasing in distance for deterministic UI consumption.
    let graph = grid_graph();

    let results = graph.nearest_nodes(46.0, 8.0, &[], 10);

    for pair in results.windows(2) {
        assert!(
            pair[0].1 <= pair[1].1,
            "distance order regressed: {:?} then {:?}",
            pair[0],
            pair[1]
        );
    }
}

#[test]
fn nearest_nodes_breaks_equal_distance_ties_by_node_id() {
    // JS compareNearest falls back to String(node.id).localeCompare(...);
    // Rust mirrors that by returning the lexicographically smallest NodeId.
    let graph = synthetic_graph(
        vec![
            node("z-west", "pass", 46.0, 7.999),
            node("a-east", "pass", 46.0, 8.001),
        ],
        vec![],
    );

    for _ in 0..3 {
        let results = graph.nearest_nodes(46.0, 8.0, &[NodeKind::Pass], 1);
        assert_eq!(ids(&results), vec!["a-east".to_owned()]);
    }
}

fn synthetic_graph(nodes: Vec<serde_json::Value>, edges: Vec<serde_json::Value>) -> LeisureGraph {
    let data = json!({
        "version": "test",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": nodes.len(), "edges": edges.len() },
        "nodes": nodes,
        "edges": edges,
    });
    LeisureGraph::load_from_json(&data.to_string()).expect("synthetic graph should parse")
}

fn graph_from_typed(nodes: Vec<Node>, edges: Vec<Edge>) -> LeisureGraph {
    let node_count = nodes.len();
    let edge_count = edges.len();
    LeisureGraph::from_data(GraphData {
        version: "test".to_owned(),
        generated_at: "2026-01-01T00:00:00.000Z".to_owned(),
        stats: GraphStats {
            nodes: Some(node_count),
            edges: Some(edge_count),
            ..GraphStats::default()
        },
        nodes,
        edges,
    })
}

fn node(id: &str, kind: &str, lat: f64, lon: f64) -> serde_json::Value {
    json!({
        "id": id,
        "kind": kind,
        "name": id,
        "lat": lat,
        "lon": lon,
    })
}

fn pass_node(id: &str, kind: &str, pass_id: &str, side: Option<&str>) -> serde_json::Value {
    let mut node = node(id, kind, 46.0, 8.0);
    node["passId"] = json!(pass_id);
    if let Some(side) = side {
        node["side"] = json!(side);
    }
    node
}

fn typed_node(id: &str, kind: &str, lat: f64, lon: f64) -> Node {
    serde_json::from_value(node(id, kind, lat, lon)).expect("typed node should parse")
}

fn edge(
    from: &str,
    to: &str,
    kind: &str,
    leisure_cost: f64,
    pass_id: Option<&str>,
) -> serde_json::Value {
    let mut edge = json!({
        "from": from,
        "to": to,
        "kind": kind,
        "distanceM": 100.0,
        "durationS": 60.0,
        "leisureCost": leisure_cost,
    });
    if let Some(pass_id) = pass_id {
        edge["passId"] = json!(pass_id);
    }
    edge
}

fn typed_edge(from: &str, to: &str, kind: &str, leisure_cost: f64, pass_id: Option<&str>) -> Edge {
    serde_json::from_value(edge(from, to, kind, leisure_cost, pass_id))
        .expect("typed edge should parse")
}

fn grid_graph() -> LeisureGraph {
    let mut nodes = Vec::new();
    for index in 0..5 {
        nodes.push(node(
            &format!("pass-{index:02}"),
            "pass",
            46.0,
            8.0 + index as f64 * 0.001,
        ));
    }
    for index in 0..5 {
        nodes.push(node(
            &format!("junction-{index:02}"),
            "junction",
            46.01,
            8.0 + index as f64 * 0.001,
        ));
    }
    synthetic_graph(nodes, vec![])
}

fn ids(results: &[(NodeId, f64)]) -> Vec<String> {
    results.iter().map(|(id, _)| id.to_string()).collect()
}
