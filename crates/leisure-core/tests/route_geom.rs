use leisure_core::route_geom::{
    build_route_request, haversine_route_km, merge_route_facts, route_points, APPROX_ROUTE_WARNING,
    AVG_SPEED_KMH, FALLBACK_SPEED_KMH,
};
use leisure_core::ui_options::RouteFacts;
use leisure_core::{
    BudgetFit, LeisureGraph, NodeId, PublicStop, PublicTour, ThemeCoverage, UiPoint,
};
use serde_json::{json, Value};

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

fn node(id: &str, lat: f64, lon: f64) -> Value {
    json!({ "id": id, "kind": "junction", "name": id, "lat": lat, "lon": lon })
}

fn coord(lat: f64, lon: f64) -> UiPoint {
    UiPoint::Coord {
        lat,
        lon,
        name: None,
    }
}

fn point_lat_lon(point: &UiPoint) -> (f64, f64) {
    match point {
        UiPoint::Coord { lat, lon, .. } => (*lat, *lon),
        UiPoint::Id(_) => panic!("expected coordinate point"),
    }
}

fn public_stop(node_id: &str, order: usize, return_to_start: bool) -> PublicStop {
    PublicStop {
        id: node_id.to_owned(),
        node_id: NodeId::from(node_id),
        pass_id: None,
        kind: "junction".to_owned(),
        name: node_id.to_owned(),
        lat: 0.0,
        lon: 0.0,
        themes: vec![],
        scenic_score: None,
        order,
        return_to_start,
    }
}

fn public_tour(end_node: &str, stops: Vec<PublicStop>, path: Vec<&str>) -> PublicTour {
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
        path: path.into_iter().map(NodeId::from).collect(),
        score: 0.0,
    }
}

#[test]
fn route_points_open_a_to_b() {
    let graph = graph_with(vec![node("A", 0.0, 0.0), node("B", 1.0, 1.0)]);
    let tour = public_tour("B", vec![public_stop("A", 0, false)], vec!["A"]);

    let points = route_points(&graph, &tour, &coord(0.0, 0.0));

    assert_eq!(points.len(), 2);
    assert_eq!(point_lat_lon(&points[1]), (1.0, 1.0));
}

#[test]
fn route_points_closed_loop_returns_to_start() {
    let graph = graph_with(vec![
        node("A", 0.0, 0.0),
        node("B", 1.0, 1.0),
        node("C", 2.0, 2.0),
    ]);
    let tour = public_tour("A", vec![public_stop("A", 0, false)], vec!["A", "B", "C"]);

    let points = route_points(&graph, &tour, &coord(0.0, 0.0));

    assert_eq!(
        point_lat_lon(points.last().expect("last point")),
        (0.0, 0.0)
    );
}

#[test]
fn route_points_dedupes_consecutive_duplicates() {
    let graph = graph_with(vec![node("X", 3.0, 4.0)]);
    let tour = public_tour(
        "missing-end",
        vec![public_stop("X", 0, false)],
        vec!["X", "X"],
    );

    let points = route_points(&graph, &tour, &coord(0.0, 0.0));

    assert_eq!(points.len(), 2);
    assert_eq!(point_lat_lon(&points[1]), (3.0, 4.0));
}

#[test]
fn route_points_skips_non_finite_node() {
    let mut graph = graph_with(vec![node("A", 0.0, 0.0), node("N", 9.0, 1.0)]);
    graph.nodes.get_mut(&NodeId::from("N")).expect("N").lat = f64::NAN;
    let tour = public_tour("", vec![public_stop("A", 0, false)], vec!["A", "N"]);

    let points = route_points(&graph, &tour, &coord(0.0, 0.0));

    assert_eq!(points.len(), 1);
    assert_eq!(point_lat_lon(&points[0]), (0.0, 0.0));
}

#[test]
fn haversine_route_km_zero_for_short() {
    assert_eq!(haversine_route_km(&[]), 0.0);
    assert_eq!(haversine_route_km(&[coord(0.0, 0.0)]), 0.0);
}

#[test]
fn haversine_route_km_two_points_known_distance() {
    let distance = haversine_route_km(&[coord(0.0, 0.0), coord(0.0, 1.0)]);

    assert!((distance - 111.195).abs() < 0.1);
}

#[test]
fn haversine_route_km_multi_segment_sums() {
    let ab = haversine_route_km(&[coord(0.0, 0.0), coord(0.0, 1.0)]);
    let bc = haversine_route_km(&[coord(0.0, 1.0), coord(1.0, 1.0)]);
    let total = haversine_route_km(&[coord(0.0, 0.0), coord(0.0, 1.0), coord(1.0, 1.0)]);

    assert!((total - (ab + bc)).abs() < 1e-9);
}

#[test]
fn haversine_route_km_skips_non_finite_segment() {
    let total = haversine_route_km(&[coord(0.0, 0.0), coord(f64::NAN, 1.0), coord(0.0, 1.0)]);

    assert_eq!(total, 0.0);
}

#[test]
fn merge_none_uses_haversine_and_warning() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);

    let merged = merge_route_facts(&points, None, &tour);
    let expected_distance = haversine_route_km(&points);

    assert_eq!(merged.route_warning, Some(APPROX_ROUTE_WARNING));
    assert_eq!(merged.geom, vec![[0.0, 0.0], [1.0, 0.0]]);
    assert!(merged.distance_km > 0.0);
    assert_close(merged.distance_km, expected_distance);
    assert_close(merged.duration_h, merged.distance_km / AVG_SPEED_KMH);
}

#[test]
fn merge_some_with_valid_geom_uses_osrm() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    let route_facts = RouteFacts {
        geom: vec![[10.0, 11.0], [12.0, 13.0]],
        distance_km: Some(7.5),
        duration_h: Some(0.4),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_eq!(merged.geom, vec![[10.0, 11.0], [12.0, 13.0]]);
    assert_eq!(merged.distance_km, 7.5);
    assert_eq!(merged.duration_h, 0.4);
    assert_eq!(merged.route_warning, None);
}

#[test]
fn merge_some_prefers_osrm_distance_over_tour() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let mut tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    tour.total_distance_km = 99.0;
    let route_facts = RouteFacts {
        geom: vec![[0.0, 0.0], [1.0, 0.0]],
        distance_km: Some(42.0),
        duration_h: Some(0.5),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_eq!(merged.distance_km, 42.0);
}

#[test]
fn merge_some_invalid_geom_falls_back_to_points() {
    let points = vec![coord(11.0, 10.0), coord(13.0, 12.0)];
    let tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    let route_facts = RouteFacts {
        geom: vec![[99.0, 99.0]],
        distance_km: Some(5.0),
        duration_h: Some(0.1),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_eq!(merged.geom, vec![[10.0, 11.0], [12.0, 13.0]]);
    assert_eq!(merged.distance_km, 5.0);
    assert_eq!(merged.route_warning, None);
}

#[test]
fn merge_some_nan_distance_falls_back_to_tour() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let mut tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    tour.total_distance_km = 33.0;
    let route_facts = RouteFacts {
        geom: vec![[0.0, 0.0], [1.0, 0.0]],
        distance_km: Some(f64::NAN),
        duration_h: Some(0.5),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_eq!(merged.distance_km, 33.0);
}

#[test]
fn merge_some_nan_distance_and_nan_tour_falls_back_to_haversine() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let mut tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    tour.total_distance_km = f64::NAN;
    let route_facts = RouteFacts {
        geom: vec![[0.0, 0.0], [1.0, 0.0]],
        distance_km: Some(f64::NAN),
        duration_h: Some(0.5),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_close(merged.distance_km, haversine_route_km(&points));
}

#[test]
fn merge_some_nan_duration_with_finite_tour_uses_tour() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let mut tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    tour.total_duration_h = 2.5;
    let route_facts = RouteFacts {
        geom: vec![[0.0, 0.0], [1.0, 0.0]],
        distance_km: Some(90.0),
        duration_h: Some(f64::NAN),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_eq!(merged.duration_h, 2.5);
}

#[test]
fn merge_some_nan_duration_and_nan_tour_uses_distance_over_fallback_speed() {
    let points = vec![coord(0.0, 0.0), coord(0.0, 1.0)];
    let mut tour = public_tour("B", vec![public_stop("A", 0, false)], vec![]);
    tour.total_duration_h = f64::NAN;
    let route_facts = RouteFacts {
        geom: vec![[0.0, 0.0], [1.0, 0.0]],
        distance_km: Some(90.0),
        duration_h: Some(f64::NAN),
    };

    let merged = merge_route_facts(&points, Some(&route_facts), &tour);

    assert_close(merged.duration_h, 90.0 / FALLBACK_SPEED_KMH);
    assert_eq!(merged.duration_h, 2.0);
}

#[test]
fn build_route_request_emits_lon_lat_pairs() {
    let graph = graph_with(vec![node("A", 46.0, 7.0), node("B", 47.0, 8.0)]);
    let tour = public_tour("B", vec![public_stop("A", 0, false)], vec!["A"]);
    let start = coord(46.0, 7.0);

    let request = build_route_request(&graph, &tour, &start);

    assert_eq!(request.coords.first(), Some(&[7.0, 46.0]));
}

#[test]
fn build_route_request_basic_two_node_open_tour() {
    let graph = graph_with(vec![node("A", 46.0, 7.0), node("B", 47.0, 8.0)]);
    let tour = public_tour("B", vec![public_stop("A", 0, false)], vec!["A"]);
    let start = coord(46.0, 7.0);

    let request = build_route_request(&graph, &tour, &start);

    assert!(request.coords.len() >= 2);
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {actual} to be within 1e-9 of {expected}"
    );
}
