use leisure_core::{
    find_corridor_pois, BudgetFit, CorridorOptions, LeisureGraph, NodeId, PublicStop, PublicTour,
    ThemeCoverage,
};
use serde_json::{json, Value};

#[test]
fn side_stop_on_explicit_mid_edge_geometry_is_found() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            node("b", "junction", 0.0, 0.2, 0.0),
            poi("mid", 0.005, 0.1, 8.0),
        ],
        vec![edge_geom(
            "a",
            "b",
            22_000.0,
            1_800.0,
            vec![[0.0, 0.0], [0.0, 0.1], [0.0, 0.2]],
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());

    assert!(all_items(&result).iter().any(|item| item.poi_id == "mid"));
}

#[test]
fn side_stop_outside_detour_radius_is_not_included() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            node("b", "junction", 0.0, 0.1, 0.0),
            poi("far", 0.2, 0.05, 10.0),
        ],
        vec![edge_geom(
            "a",
            "b",
            11_000.0,
            900.0,
            vec![[0.0, 0.0], [0.0, 0.05], [0.0, 0.1]],
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());

    assert!(all_items(&result).is_empty());
}

#[test]
fn closed_loop_detour_math_is_doubled() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            node("b", "junction", 0.0, 0.1, 0.0),
            poi("near", km_deg(1.0), 0.05, 9.0),
        ],
        vec![
            edge_geom(
                "a",
                "b",
                11_000.0,
                900.0,
                vec![[0.0, 0.0], [0.0, 0.05], [0.0, 0.1]],
            ),
            edge_geom(
                "b",
                "a",
                11_000.0,
                900.0,
                vec![[0.0, 0.1], [0.0, 0.05], [0.0, 0.0]],
            ),
        ],
    );
    let closed = public_tour(&graph, &["a", "b", "a"]);
    let open = public_tour(&graph, &["a", "b"]);

    let closed_item = all_items(&find_corridor_pois(
        &graph,
        &closed,
        CorridorOptions::default(),
    ))
    .into_iter()
    .find(|item| item.poi_id == "near")
    .expect("closed item");
    let open_item = all_items(&find_corridor_pois(
        &graph,
        &open,
        CorridorOptions::default(),
    ))
    .into_iter()
    .find(|item| item.poi_id == "near")
    .expect("open item");

    for item in [&closed_item, &open_item] {
        assert!(
            (3.2..=3.5).contains(&item.detour_min),
            "{}",
            item.detour_min
        );
    }
    assert!((closed_item.detour_min - open_item.detour_min).abs() < 1e-9);
}

#[test]
fn open_ab_detour_math_is_also_doubled() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            node("b", "junction", 0.0, 0.1, 0.0),
            poi("near", km_deg(1.0), 0.05, 9.0),
        ],
        vec![edge_geom(
            "a",
            "b",
            11_000.0,
            900.0,
            vec![[0.0, 0.0], [0.0, 0.05], [0.0, 0.1]],
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let item = all_items(&find_corridor_pois(
        &graph,
        &tour,
        CorridorOptions::default(),
    ))
    .into_iter()
    .find(|item| item.poi_id == "near")
    .expect("open item");

    assert!(
        (3.2..=3.5).contains(&item.detour_min),
        "{}",
        item.detour_min
    );
}

#[test]
fn empty_tour_returns_empty_without_panic() {
    let graph = graph_with(vec![poi("p", 0.0, 0.0, 9.0)], vec![]);
    let tour = empty_tour();

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());

    assert!(result.auto_include.is_empty());
    assert!(result.suggestions.is_empty());
    assert!(result.drawer.is_empty());
}

#[test]
fn single_stop_tour_is_handled_cleanly() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            poi("p", 0.0, 0.0, 9.0),
        ],
        vec![],
    );
    let tour = public_tour(&graph, &["a"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());

    assert_eq!(
        result.auto_include.first().map(|item| item.poi_id.as_str()),
        Some("p")
    );
}

#[test]
fn plannable_corridor_suggestions_are_flagged_true() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            node("b", "junction", 0.0, 0.1, 0.0),
            poi("suggest", km_deg(4.0), 0.05, 8.0),
        ],
        vec![edge_geom(
            "a",
            "b",
            11_000.0,
            900.0,
            vec![[0.0, 0.0], [0.0, 0.05], [0.0, 0.1]],
        )],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let result = find_corridor_pois(
        &graph,
        &tour,
        CorridorOptions {
            auto_include_max_detour_min: 0.0,
            ..Default::default()
        },
    );

    assert_eq!(result.suggestions[0].poi_id, "suggest");
    assert!(result.suggestions[0].plannable);
}

#[test]
fn non_plannable_drawer_suggestions_render_as_text() {
    let graph = graph_with(
        vec![
            node("a", "junction", 0.0, 0.0, 0.0),
            node("b", "junction", 0.0, 0.1, 0.0),
            poi("drawer", km_deg(4.0), 0.05, 5.5),
        ],
        vec![edge("a", "b", 11_000.0, 900.0)],
    );
    let tour = public_tour(&graph, &["a", "b"]);

    let result = find_corridor_pois(&graph, &tour, CorridorOptions::default());

    assert_eq!(result.drawer[0].poi_id, "drawer");
    assert!(!result.drawer[0].plannable);
    assert!(result.drawer[0]
        .render_text
        .as_deref()
        .unwrap_or("")
        .contains("Explore"));
}

fn all_items(result: &leisure_core::CorridorSuggestions) -> Vec<leisure_core::CorridorItem> {
    result
        .auto_include
        .iter()
        .chain(result.suggestions.iter())
        .chain(result.drawer.iter())
        .cloned()
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

fn node(id: &str, kind: &str, lat: f64, lon: f64, score: f64) -> Value {
    json!({ "id": id, "kind": kind, "name": id, "lat": lat, "lon": lon, "score": score })
}

fn poi(id: &str, lat: f64, lon: f64, score: f64) -> Value {
    json!({ "id": id, "kind": "poi", "name": id, "lat": lat, "lon": lon, "score": score, "categories": ["viewpoint"], "themes": [] })
}

fn edge(from: &str, to: &str, distance_m: f64, duration_s: f64) -> Value {
    edge_geom(from, to, distance_m, duration_s, vec![])
}

fn edge_geom(
    from: &str,
    to: &str,
    distance_m: f64,
    duration_s: f64,
    geometry: Vec<[f64; 2]>,
) -> Value {
    json!({ "id": format!("{from}->{to}"), "from": from, "to": to, "kind": "connector", "distanceM": distance_m, "durationS": duration_s, "leisureCost": duration_s, "geometry": geometry })
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
                return_to_start: order + 1 == ids.len() && ids.len() > 1 && ids[0] == *id,
            }
        })
        .collect::<Vec<_>>();
    let edges = ids
        .windows(2)
        .map(|pair| format!("{}->{}", pair[0], pair[1]))
        .collect::<Vec<_>>();
    PublicTour {
        end_node: NodeId::from(*ids.last().expect("last")),
        stops,
        edges,
        total_leisure_cost: 0.0,
        total_distance_km: 0.0,
        total_duration_h: 1.0,
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

fn km_deg(km: f64) -> f64 {
    km / 111.195
}
