use leisure_core::{
    detect_breaks, BreakOptions, BreakPoiInput, BudgetFit, LeisureGraph, NodeId, PublicStop,
    PublicTour, ThemeCoverage,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[test]
fn two_stops_with_inter_stop_dwell_under_15_minutes_merge_into_one() {
    let (graph, tour) = line_fixture(&[100.0, 100.0]);
    let mut dwell = BTreeMap::new();
    dwell.insert("b".to_owned(), 5.0 * 60.0);

    let result = detect_breaks(
        &graph,
        &tour,
        BreakOptions {
            stop_dwell_sec: dwell,
            ..Default::default()
        },
    );

    assert_eq!(result.diagnostics.segment_count, 1);
}

#[test]
fn two_stops_with_inter_stop_dwell_over_15_minutes_stay_separate() {
    let (graph, tour) = line_fixture(&[100.0, 100.0]);
    let mut dwell = BTreeMap::new();
    dwell.insert("b".to_owned(), 20.0 * 60.0);

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
fn empty_tour_has_no_breaks() {
    let graph = graph_with(vec![], vec![]);

    let result = detect_breaks(&graph, &empty_tour(), BreakOptions::default());

    assert!(result.breaks.is_empty());
}

#[test]
fn single_stop_tour_has_no_breaks() {
    let graph = graph_with(vec![node("a", 0.0, 0.0)], vec![]);
    let tour = public_tour(&graph, &["a"]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());

    assert!(result.breaks.is_empty());
}

#[test]
fn hundred_minute_leg_suggests_breaks_from_load_threshold() {
    let (graph, tour) = line_fixture(&[100.0]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());

    assert!(!result.breaks.is_empty());
}

#[test]
fn sub_ninety_minute_leg_can_suggest_break_from_load_threshold() {
    let (graph, tour) = line_fixture(&[80.0]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());

    assert_eq!(result.breaks.len(), 1);
}

#[test]
fn single_segment_can_emit_multiple_breaks_after_cooldown() {
    let (graph, tour) = line_fixture(&[180.0]);

    let result = detect_breaks(&graph, &tour, BreakOptions::default());

    assert!(result.breaks.len() >= 2, "{:?}", result.breaks);
    assert!(result
        .breaks
        .iter()
        .all(|break_stop| break_stop.at_segment_idx == 0));
}

#[test]
fn break_load_curve_advances_date_after_midnight() {
    let (graph, tour) = line_fixture(&[18.0 * 60.0]);

    let result = detect_breaks(
        &graph,
        &tour,
        BreakOptions {
            start_time: "2025-06-14T22:00:00.000Z".to_owned(),
            max_breaks_total: 0,
            ..Default::default()
        },
    );

    assert_eq!(
        result.load_curve.last().map(|point| point.t.as_str()),
        Some("2025-06-15T16:00:00.000Z")
    );
}

#[test]
fn break_suggestion_includes_poi_candidate() {
    let (graph, tour) = line_fixture(&[120.0]);
    let poi = BreakPoiInput {
        poi_id: "cafe".to_owned(),
        name: "Cafe".to_owned(),
        lat: 0.0,
        lon: 0.05,
        score: 0.8,
        detour_min: 0.0,
        categories: vec!["cafe".to_owned()],
        themes: vec![],
        scenic_score: Some(0.8),
        popularity: None,
    };

    let result = detect_breaks(
        &graph,
        &tour,
        BreakOptions {
            corridor_pois: vec![poi],
            ..Default::default()
        },
    );

    assert_eq!(
        result.breaks[0]
            .poi_candidate
            .as_ref()
            .map(|p| p.poi_id.as_str()),
        Some("cafe")
    );
}

#[test]
fn deterministic_for_same_input() {
    let (graph, tour) = line_fixture(&[120.0, 120.0]);
    let options = BreakOptions {
        corridor_pois: vec![BreakPoiInput {
            poi_id: "view".to_owned(),
            name: "View".to_owned(),
            lat: 0.0,
            lon: 0.05,
            score: 0.9,
            detour_min: 0.0,
            categories: vec!["viewpoint".to_owned()],
            themes: vec![],
            scenic_score: Some(0.9),
            popularity: None,
        }],
        ..Default::default()
    };

    let first = detect_breaks(&graph, &tour, options.clone());
    let second = detect_breaks(&graph, &tour, options);

    assert_eq!(first.breaks, second.breaks);
}

fn line_fixture(edge_minutes: &[f64]) -> (LeisureGraph, PublicTour) {
    let mut nodes = Vec::new();
    for index in 0..=edge_minutes.len() {
        nodes.push(node(
            &format!("{}", (b'a' + index as u8) as char),
            0.0,
            index as f64 * 0.1,
        ));
    }
    let mut edges = Vec::new();
    for (index, minutes) in edge_minutes.iter().enumerate() {
        let from = format!("{}", (b'a' + index as u8) as char);
        let to = format!("{}", (b'a' + index as u8 + 1) as char);
        edges.push(edge(&from, &to, *minutes));
    }
    let ids = (0..=edge_minutes.len())
        .map(|index| format!("{}", (b'a' + index as u8) as char))
        .collect::<Vec<_>>();
    let graph = graph_with(nodes, edges);
    let refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let tour = public_tour(&graph, &refs);
    (graph, tour)
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

fn node(id: &str, lat: f64, lon: f64) -> Value {
    json!({ "id": id, "kind": "junction", "name": id, "lat": lat, "lon": lon, "elev": 700.0 })
}

fn edge(from: &str, to: &str, minutes: f64) -> Value {
    json!({
        "id": format!("{from}->{to}"),
        "from": from,
        "to": to,
        "kind": "connector",
        "roadClass": "secondary",
        "distanceM": minutes * 1000.0,
        "durationS": minutes * 60.0,
        "leisureCost": minutes * 60.0,
        "scenicScore": 0.02,
        "geometry": [[0.0, 0.0], [0.0, 0.1]]
    })
}

fn public_tour(graph: &LeisureGraph, ids: &[&str]) -> PublicTour {
    if ids.is_empty() {
        return empty_tour();
    }
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
