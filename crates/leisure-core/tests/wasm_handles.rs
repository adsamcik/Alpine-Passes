use leisure_core::{
    GraphData, __wasm_handle_test_decompose_ears, __wasm_handle_test_free_ears,
    __wasm_handle_test_free_graph, __wasm_handle_test_load_graph, __wasm_handle_test_require_graph,
    __wasm_handle_test_require_graph_and_ears,
};
use serde_json::json;

fn graph_data() -> GraphData {
    serde_json::from_value(json!({
        "version": "test",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "stats": { "nodes": 3, "edges": 3 },
        "nodes": [
            { "id": "a", "kind": "pass", "name": "a", "lat": 46.0, "lon": 8.0 },
            { "id": "b", "kind": "junction", "name": "b", "lat": 46.1, "lon": 8.1 },
            { "id": "c", "kind": "junction", "name": "c", "lat": 46.2, "lon": 8.2 }
        ],
        "edges": [
            { "from": "a", "to": "b", "kind": "road", "distanceM": 100.0, "durationS": 60.0, "leisureCost": 1.0 },
            { "from": "b", "to": "c", "kind": "road", "distanceM": 100.0, "durationS": 60.0, "leisureCost": 1.0 },
            { "from": "c", "to": "a", "kind": "road", "distanceM": 100.0, "durationS": 60.0, "leisureCost": 1.0 }
        ]
    }))
    .expect("test graph should parse")
}

fn load_graph_handle() -> u32 {
    __wasm_handle_test_load_graph(graph_data()).expect("graph should load")
}

fn decompose_ears_handle(graph_handle: u32) -> u32 {
    __wasm_handle_test_decompose_ears(graph_handle).expect("ears should decompose")
}

#[test]
fn free_graph_returns_true_for_valid_handle() {
    let graph = load_graph_handle();
    assert!(__wasm_handle_test_free_graph(graph).expect("graph handle kind should match"));
}

#[test]
fn free_graph_returns_false_for_already_freed() {
    let graph = load_graph_handle();
    assert!(__wasm_handle_test_free_graph(graph).expect("graph handle kind should match"));
    assert!(!__wasm_handle_test_free_graph(graph).expect("graph handle kind should match"));
}

#[test]
fn free_graph_returns_false_for_out_of_range() {
    assert!(!__wasm_handle_test_free_graph(123_456).expect("graph handle kind should match"));
}

#[test]
fn plan_after_free_returns_error() {
    let graph = load_graph_handle();
    let ears = decompose_ears_handle(graph);
    assert!(__wasm_handle_test_free_graph(graph).expect("graph handle kind should match"));

    let error = __wasm_handle_test_require_graph_and_ears(graph, ears)
        .expect_err("freed graph should fail");
    assert!(error.contains(&format!("graph handle {graph} was freed")));
}

#[test]
fn free_ears_independent_of_graph() {
    let graph = load_graph_handle();
    let ears = decompose_ears_handle(graph);
    assert!(__wasm_handle_test_free_ears(ears).expect("ears handle kind should match"));

    __wasm_handle_test_require_graph(graph).expect("graph should remain usable after freeing ears");
    let error =
        __wasm_handle_test_require_graph_and_ears(graph, ears).expect_err("freed ears should fail");
    assert!(error.contains(&format!("ears handle {ears} was freed")));
}

#[test]
fn free_wrong_kind_returns_error_without_corrupting_other_table() {
    let graph = load_graph_handle();
    let ears = decompose_ears_handle(graph);

    let result = __wasm_handle_test_free_ears(graph);
    assert!(result
        .expect_err("graph handle should not free ears table")
        .contains("not a ears handle"));

    __wasm_handle_test_require_graph_and_ears(graph, ears)
        .expect("graph and ears should remain usable after wrong-kind ears free attempt");

    let result = __wasm_handle_test_free_graph(ears);
    assert!(result
        .expect_err("ears handle should not free graph table")
        .contains("not a graph handle"));

    __wasm_handle_test_require_graph_and_ears(graph, ears)
        .expect("graph and ears should remain usable after wrong-kind graph free attempt");
}

#[test]
fn multiple_load_after_free_allocates_new_slot() {
    let first = load_graph_handle();
    let second = load_graph_handle();
    let third = load_graph_handle();
    assert!(__wasm_handle_test_free_graph(second).expect("graph handle kind should match"));

    let fourth = load_graph_handle();
    assert_eq!(fourth, third + 1, "simple allocation appends new slots");
    assert_ne!(fourth, second, "freed slots are tombstoned, not reused");

    let _ = __wasm_handle_test_free_graph(first);
    let _ = __wasm_handle_test_free_graph(third);
    let _ = __wasm_handle_test_free_graph(fourth);
}

#[test]
fn wasm_load_graph_object_branch_gap_is_documented() {
    // The browser shim has a compatibility fallback that retries wasm_load_graph
    // with a parsed object when an older bundle rejects string input. Native
    // cargo tests cannot construct a real JsValue, so this covers the same
    // GraphData-owned path used after serde-wasm-bindgen object deserialization.
    // Follow-up: add wasm-bindgen-test coverage for the production JsValue branch.
    let graph = load_graph_handle();
    assert_ne!(graph, u32::MAX, "graph handle should be valid");
}
