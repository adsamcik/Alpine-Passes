#![allow(dead_code)]

#[path = "../src/types.rs"]
mod types;

#[path = "../src/graph.rs"]
mod graph;

use graph::dedupe_indices_by_haversine;

#[test]
fn dedupe_empty_returns_empty() {
    let result = dedupe_indices_by_haversine(&[]);
    assert_eq!(result, Vec::<usize>::new());
}

#[test]
fn dedupe_single_point_returns_index_0() {
    let result = dedupe_indices_by_haversine(&[(0.0, 0.0)]);
    assert_eq!(result, vec![0]);
}

#[test]
fn dedupe_all_coincident_keeps_only_first() {
    let pts = vec![(0.0, 0.0), (0.0, 0.0), (0.0, 0.0)];
    let result = dedupe_indices_by_haversine(&pts);
    assert_eq!(
        result,
        vec![0],
        "coincident points dedupe to only the first"
    );
}

#[test]
fn dedupe_1m_strict_inequality() {
    let pts_under = vec![(0.0, 0.0), (0.0, 8.0e-6)];
    let pts_over = vec![(0.0, 0.0), (0.0, 1.0e-5)];
    assert_eq!(
        dedupe_indices_by_haversine(&pts_under),
        vec![0],
        "≤1m dedupes"
    );
    assert_eq!(
        dedupe_indices_by_haversine(&pts_over),
        vec![0, 1],
        ">1m keeps"
    );
}
