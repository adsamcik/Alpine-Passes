use leisure_core::{
    detect_breaks, find_corridor_pois, find_lunch_area, leisure_astar, AStarOptions, AStarStatus,
    BreakOptions, BreakPoiInput, BudgetFit, CorridorOptions, LeisureGraph, LunchOptions, NodeId,
    PublicStop, PublicTour, ThemeCoverage,
};
use once_cell::sync::Lazy;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

static REAL_GRAPH: Lazy<LeisureGraph> = Lazy::new(load_real_graph);

#[test]
#[ignore = "manual real-graph Phase 4 perf check; timing can be noisy on shared machines"]
fn real_graph_phase4_combined_perf_under_100ms() {
    let graph = Lazy::force(&REAL_GRAPH);
    let tour = real_five_stop_tour(graph);
    let started = Instant::now();
    let corridor = find_corridor_pois(graph, &tour, CorridorOptions::default());
    let lunch = find_lunch_area(
        graph,
        &tour,
        LunchOptions {
            start_time: "2026-06-15T08:00:00.000Z".to_owned(),
            ..Default::default()
        },
    );
    let corridor_pois = corridor
        .auto_include
        .iter()
        .chain(corridor.suggestions.iter())
        .map(|item| BreakPoiInput {
            poi_id: item.poi_id.clone(),
            name: item.poi_name.clone(),
            lat: item.lat,
            lon: item.lon,
            score: item.score,
            detour_min: item.detour_min,
            categories: item.categories.clone(),
            themes: item.themes.clone(),
            scenic_score: Some(item.score),
            popularity: None,
        })
        .collect();
    let breaks = detect_breaks(
        graph,
        &tour,
        BreakOptions {
            corridor_pois,
            ..Default::default()
        },
    );
    let elapsed = started.elapsed();
    eprintln!(
        "phase4 real graph perf: {:.3}ms (corridor {} suggestions, lunch {} zones, breaks {})",
        elapsed.as_secs_f64() * 1000.0,
        corridor.suggestions.len(),
        lunch.zones.len(),
        breaks.breaks.len()
    );
    assert!(elapsed.as_secs_f64() < 0.1);
}

fn real_five_stop_tour(graph: &LeisureGraph) -> PublicTour {
    let stop_ids = [
        "furkapass:A",
        "grimselpass:B",
        "sustenpass:A",
        "oberalppass:S",
        "nufenenpass-passo-della-novena:S",
    ];
    let mut path = Vec::<NodeId>::new();
    let mut edges = Vec::<String>::new();
    let mut total_duration_s = 0.0;
    let mut total_distance_m = 0.0;
    let mut total_leisure_cost = 0.0;
    for pair in stop_ids.windows(2) {
        let leg = leisure_astar(
            graph,
            &NodeId::from(pair[0]),
            &NodeId::from(pair[1]),
            &AStarOptions::default(),
        );
        assert_eq!(leg.status, AStarStatus::Ok, "{} -> {}", pair[0], pair[1]);
        if path.is_empty() {
            path.extend(leg.path.iter().cloned());
        } else {
            path.extend(leg.path.iter().skip(1).cloned());
        }
        edges.extend(
            leg.edges
                .iter()
                .filter_map(|index| graph.edges.get(*index).map(|edge| edge.canonical_id())),
        );
        total_duration_s += leg.total_duration_s;
        total_distance_m += leg.total_distance_m;
        total_leisure_cost += leg.total_leisure_cost;
    }
    let stops = stop_ids
        .iter()
        .enumerate()
        .map(|(order, id)| {
            let node = graph.node(&NodeId::from(*id)).expect("real stop exists");
            PublicStop {
                id: (*id).to_owned(),
                node_id: node.id.clone(),
                pass_id: node.pass_id.as_ref().map(ToString::to_string),
                kind: node.kind.as_str().to_owned(),
                name: node.name.clone(),
                lat: node.lat,
                lon: node.lon,
                themes: node.themes.clone(),
                scenic_score: node.scenic_score,
                order,
                return_to_start: false,
            }
        })
        .collect();
    PublicTour {
        end_node: NodeId::from(*stop_ids.last().expect("last")),
        stops,
        edges,
        total_leisure_cost,
        total_distance_km: total_distance_m / 1000.0,
        total_duration_h: total_duration_s / 3600.0,
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
            budget: total_duration_s,
            used: total_duration_s,
            remaining: 0.0,
            ratio: 1.0,
            within: true,
        },
        path,
        score: 0.0,
    }
}

fn load_real_graph() -> LeisureGraph {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("data")
        .join("leisure-graph.v1.json");
    let json = fs::read_to_string(path).expect("real graph JSON readable");
    LeisureGraph::load_from_json(&json).expect("real graph parses")
}
