use leisure_core::{
    detect_breaks, types::EdgeKind, BreakOptions, BudgetFit, Edge, GraphData, GraphStats,
    LeisureGraph, Node, NodeId, NodeKind, PublicStop, PublicTour, ThemeCoverage,
};

#[test]
fn breaks_simple_time_wraps_to_24h_clock_intentionally() {
    let graph = LeisureGraph::from_data(GraphData {
        version: "test".to_owned(),
        generated_at: "2026-06-15T00:00:00.000Z".to_owned(),
        stats: GraphStats::default(),
        nodes: vec![node("a", 0.0), node("b", 1.0)],
        edges: vec![Edge {
            id: Some("a-b".to_owned()),
            from: NodeId::from("a"),
            to: NodeId::from("b"),
            kind: EdgeKind::Connector,
            distance_m: 111_320.0,
            duration_s: 24.0 * 3600.0 + 10.0 * 60.0,
            leisure_cost: 1.0,
            pass_id: None,
            side: None,
            scenic_score: Some(1.0),
            season: None,
            geometry: Vec::new(),
            road_class: None,
            is_highway: None,
            source: None,
        }],
    });
    let tour = tour();
    let options = BreakOptions {
        start_time: "2026-06-15T12:20:00.000Z".to_owned(),
        tz_offset_minutes: 120,
        max_breaks_total: 0,
        ..BreakOptions::default()
    };

    let result = detect_breaks(&graph, &tour, options);

    assert_eq!(result.load_curve[0].t, "2026-06-15T12:30:00.000Z");
    assert_eq!(
        result.load_curve[0].total, 0.4,
        "first chunk lands at local 14:30 and includes the circadian peak"
    );
    assert_eq!(result.load_curve[144].t, "2026-06-16T12:30:00.000Z");
    assert_eq!(
        result.load_curve[144].total, 0.4,
        "24h later must wrap back to local 14:30; absolute minutes would miss this peak"
    );
}

fn node(id: &str, lon: f64) -> Node {
    Node {
        id: NodeId::from(id),
        kind: NodeKind::Junction,
        name: id.to_owned(),
        lat: 0.0,
        lon,
        elev: None,
        base_a: None,
        base_b: None,
        pass_id: None,
        side: None,
        scenic_score: Some(1.0),
        score: None,
        categories: Vec::new(),
        themes: Vec::new(),
        summit_parking: None,
        viewpoints: Vec::new(),
        visit_dwell_sec: None,
    }
}

fn tour() -> PublicTour {
    PublicTour {
        end_node: NodeId::from("b"),
        stops: vec![stop("a", 0), stop("b", 1)],
        edges: vec!["a-b".to_owned()],
        total_leisure_cost: 1.0,
        total_distance_km: 111.32,
        total_duration_h: 24.0 + 10.0 / 60.0,
        scenic_sum: 1.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: Vec::new(),
        theme_coverage: ThemeCoverage {
            requested: Vec::new(),
            covered_themes: Vec::new(),
            covered_requested: Vec::new(),
            ratio: 0.0,
            score: 0.0,
        },
        budget_fit: BudgetFit {
            mode: "test".to_owned(),
            budget: 0.0,
            used: 0.0,
            remaining: 0.0,
            ratio: 0.0,
            within: true,
        },
        path: vec![NodeId::from("a"), NodeId::from("b")],
        score: 0.0,
    }
}

fn stop(id: &str, order: usize) -> PublicStop {
    PublicStop {
        id: id.to_owned(),
        node_id: NodeId::from(id),
        pass_id: None,
        kind: "junction".to_owned(),
        name: id.to_owned(),
        lat: 0.0,
        lon: if id == "a" { 0.0 } else { 1.0 },
        themes: Vec::new(),
        scenic_score: Some(1.0),
        order,
        return_to_start: false,
    }
}
