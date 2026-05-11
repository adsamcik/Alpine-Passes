use leisure_core::{
    find_lunch_area, BudgetFit, LeisureGraph, LunchOptions, LunchPolicy, NodeId, PublicStop,
    PublicTour, ThemeCoverage,
};
use serde_json::{json, Value};

#[test]
fn lunch_area_between_consecutive_stops_in_midday_window() {
    let (graph, tour) = midday_fixture(vec![food("cafe", 0.0, 0.31, &["cafe"], 4.5)]);

    let result = find_lunch_area(&graph, &tour, lunch_options("2026-06-15T08:00:00.000Z"));

    assert!(!result.zones.is_empty());
    assert_eq!(result.zones[0].candidates[0].poi_id, "cafe");
}

#[test]
fn short_early_tour_still_uses_hunger_curve_window() {
    let (graph, tour) = short_fixture(vec![food("cafe", 0.0, 0.02, &["cafe"], 5.0)], 30.0);

    let result = find_lunch_area(&graph, &tour, lunch_options("2026-06-15T08:00:00.000Z"));

    assert_eq!(result.zones[0].candidates[0].poi_id, "cafe");
    assert!(result.desert.is_none());
}

#[test]
fn multiple_candidate_areas_returns_highest_scored_first() {
    let (graph, tour) = midday_fixture(vec![
        food("plain", 0.0, 0.25, &["restaurant"], 2.0),
        food("excellent", 0.0, 0.36, &["restaurant"], 5.0),
    ]);

    let result = find_lunch_area(&graph, &tour, lunch_options("2026-06-15T08:00:00.000Z"));

    assert_eq!(result.zones[0].candidates[0].poi_id, "excellent");
}

#[test]
fn deterministic_ordering_for_same_seedless_input() {
    let (graph, tour) = midday_fixture(vec![
        food("a", 0.0, 0.31, &["restaurant"], 4.0),
        food("b", 0.002, 0.31, &["cafe"], 4.0),
    ]);
    let options = lunch_options("2026-06-15T08:00:00.000Z");

    let first = find_lunch_area(&graph, &tour, options.clone());
    let second = find_lunch_area(&graph, &tour, options);

    assert_eq!(zone_signature(&first), zone_signature(&second));
}

#[test]
fn empty_tour_no_panic() {
    let graph = graph_with(vec![food("cafe", 0.0, 0.0, &["cafe"], 4.0)], vec![]);

    let result = find_lunch_area(
        &graph,
        &empty_tour(),
        lunch_options("2026-06-15T08:00:00.000Z"),
    );

    assert!(result.zones.is_empty());
    assert!(result.hunger_curve.is_empty());
}

#[test]
fn tour_after_clock_lunch_hours_still_uses_hunger_window() {
    let (graph, tour) = midday_fixture(vec![food("late-food", 0.0, 0.52, &["restaurant"], 5.0)]);

    let result = find_lunch_area(&graph, &tour, lunch_options("2026-06-15T16:00:00.000Z"));

    assert!(!result.zones.is_empty());
    assert_eq!(result.zones[0].candidates[0].poi_id, "late-food");
}

#[test]
fn lunch_hunger_curve_advances_date_after_midnight() {
    let (graph, tour) = short_fixture(Vec::new(), 18.0 * 60.0);

    let result = find_lunch_area(&graph, &tour, lunch_options("2025-06-14T22:00:00.000Z"));

    assert_eq!(
        result.hunger_curve.last().map(|point| point.t.as_str()),
        Some("2025-06-15T16:00:00.000Z")
    );
}

#[test]
fn lunch_candidates_are_filtered_by_food_tags() {
    let (graph, tour) = midday_fixture(vec![
        poi("view", 0.0, 0.31, &["viewpoint"], &[], 9.0),
        food("restaurant", 0.0, 0.31, &["restaurant"], 4.0),
    ]);

    let result = find_lunch_area(&graph, &tour, lunch_options("2026-06-15T08:00:00.000Z"));
    let ids = result.zones[0]
        .candidates
        .iter()
        .map(|c| c.poi_id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(ids, vec!["restaurant"]);
}

#[test]
fn lunch_suggestion_includes_distance_from_route() {
    let (graph, tour) = midday_fixture(vec![food("offset", 0.01, 0.31, &["restaurant"], 4.0)]);

    let result = find_lunch_area(&graph, &tour, lunch_options("2026-06-15T08:00:00.000Z"));

    assert!(result.zones[0].candidates[0].distance_from_route_km > 0.5);
}

fn midday_fixture(mut extra_nodes: Vec<Value>) -> (LeisureGraph, PublicTour) {
    let mut nodes = vec![
        node("start", "junction", 0.0, 0.0),
        node("morning", "junction", 0.0, 0.18),
        node("midday", "junction", 0.0, 0.32),
        node("afternoon", "junction", 0.0, 0.46),
        node("end", "junction", 0.0, 0.60),
    ];
    nodes.append(&mut extra_nodes);
    let edges = vec![
        edge("start", "morning", 2.0 * 3600.0),
        edge("morning", "midday", 2.0 * 3600.0),
        edge("midday", "afternoon", 90.0 * 60.0),
        edge("afternoon", "end", 2.0 * 3600.0),
    ];
    let graph = graph_with(nodes, edges);
    let tour = public_tour(&graph, &["start", "morning", "midday", "afternoon", "end"]);
    (graph, tour)
}

fn short_fixture(mut extra_nodes: Vec<Value>, minutes: f64) -> (LeisureGraph, PublicTour) {
    let mut nodes = vec![
        node("start", "junction", 0.0, 0.0),
        node("end", "junction", 0.0, 0.05),
    ];
    nodes.append(&mut extra_nodes);
    let graph = graph_with(nodes, vec![edge("start", "end", minutes * 60.0)]);
    let tour = public_tour(&graph, &["start", "end"]);
    (graph, tour)
}

fn lunch_options(start_time: &str) -> LunchOptions {
    LunchOptions {
        start_time: start_time.to_owned(),
        lunch_policy: LunchPolicy::Auto,
        ..Default::default()
    }
}

fn zone_signature(result: &leisure_core::LunchSuggestion) -> Vec<(String, Vec<String>)> {
    result
        .zones
        .iter()
        .map(|zone| {
            (
                zone.id.clone(),
                zone.candidates.iter().map(|c| c.poi_id.clone()).collect(),
            )
        })
        .collect()
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

fn node(id: &str, kind: &str, lat: f64, lon: f64) -> Value {
    json!({ "id": id, "kind": kind, "name": id, "lat": lat, "lon": lon, "elev": 600.0 })
}

fn poi(id: &str, lat: f64, lon: f64, categories: &[&str], themes: &[&str], score: f64) -> Value {
    json!({ "id": id, "kind": "poi", "name": id, "lat": lat, "lon": lon, "elev": 600.0, "score": score, "categories": categories, "themes": themes })
}

fn food(id: &str, lat: f64, lon: f64, categories: &[&str], score: f64) -> Value {
    poi(id, lat, lon, categories, &["food-drink"], score)
}

fn edge(from: &str, to: &str, duration_s: f64) -> Value {
    json!({ "id": format!("{from}->{to}"), "from": from, "to": to, "kind": "connector", "distanceM": duration_s / 3600.0 * 55_000.0, "durationS": duration_s, "leisureCost": duration_s, "scenicScore": 0.2 })
}

fn public_tour(graph: &LeisureGraph, ids: &[&str]) -> PublicTour {
    let stops = ids
        .iter()
        .enumerate()
        .map(|(order, id)| {
            let n = graph.node(&NodeId::from(*id)).expect("node");
            PublicStop {
                id: (*id).to_owned(),
                node_id: n.id.clone(),
                pass_id: None,
                kind: n.kind.as_str().to_owned(),
                name: n.name.clone(),
                lat: n.lat,
                lon: n.lon,
                themes: vec![],
                scenic_score: None,
                order,
                return_to_start: false,
            }
        })
        .collect::<Vec<_>>();
    let edges = ids
        .windows(2)
        .map(|pair| format!("{}->{}", pair[0], pair[1]))
        .collect::<Vec<_>>();
    let total_s = edges
        .iter()
        .filter_map(|id| {
            graph
                .edge_by_id
                .get(id)
                .and_then(|idx| graph.edges.get(*idx))
        })
        .map(|edge| edge.duration_s)
        .sum::<f64>();
    PublicTour {
        end_node: NodeId::from(*ids.last().expect("last")),
        stops,
        edges,
        total_leisure_cost: 0.0,
        total_distance_km: 0.0,
        total_duration_h: total_s / 3600.0,
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
        path: ids.iter().map(|id| NodeId::from(*id)).collect(),
        score: 0.0,
    }
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
        path: vec![],
        score: 0.0,
    }
}
