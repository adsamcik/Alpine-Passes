// F1-C1 — round-trip and discriminator tests for the UI boundary DTOs.

use leisure_core::{
    OptimizerOptions, PoiPrefs, RouteFacts, RouteRequest, StopsConfig, TargetMode, UiCorridor,
    UiDrawMeta, UiEndpointStop, UiExtrasParts, UiIntentSurface, UiOptions, UiOverlays, UiPassStop,
    UiPlanResult, UiPoiStop, UiPoint, UiTourStop,
};
use serde_json::{json, Value};

#[test]
fn ui_options_default_round_trip_drops_optional_fields() {
    let opts = UiOptions::default();
    let value = serde_json::to_value(&opts).expect("serialize default");
    // Optional fields (Option::None) MUST be skipped.
    let obj = value.as_object().expect("object");
    assert!(!obj.contains_key("start"));
    assert!(!obj.contains_key("endNode"));
    assert!(!obj.contains_key("tripDate"));
    assert!(!obj.contains_key("targetValue"));
    // Required defaults are present.
    assert_eq!(obj.get("themes"), Some(&json!([])));
    assert_eq!(obj.get("personas"), Some(&json!([])));
    assert_eq!(obj.get("forbiddenPassIds"), Some(&json!([])));
    assert_eq!(obj.get("openOnly"), Some(&json!(false)));
    assert_eq!(obj.get("targetMode"), Some(&json!("distance")));
    let back: UiOptions = serde_json::from_value(value).expect("deserialize default");
    assert_eq!(back, opts);
}

#[test]
fn ui_options_full_camel_case_round_trip() {
    let raw = json!({
        "start": "node-A",
        "endNode": {"lat": 47.1, "lon": 11.4},
        "endSnapMaxDistanceM": 250.0,
        "themes": ["scenic"],
        "personas": ["family"],
        "forbiddenPassIds": ["p-stelvio"],
        "tripDate": "2026-07-01",
        "openOnly": true,
        "targetMode": "time",
        "targetValue": 6.0,
        "targetTol": 0.1,
        "budgetSeconds": 21600.0,
        "budgetKm": 200.0,
        "kAlternatives": 3,
        "timeBudgetMs": 1000,
        "seed": 42,
        "startTime": "2026-07-01T08:00:00Z",
        "weather": "sun",
        "withChild": true,
        "poiPrefs": {"themes": ["food"], "preset": ["foodie"]},
        "stops": {
            "maxPassStops": 3,
            "maxPoiStops": 4,
            "includePasses": ["p-x"],
            "excludePasses": ["p-y"]
        },
        "lunch": "auto",
        "tzOffsetMinutes": 120
    });
    let parsed: UiOptions = serde_json::from_value(raw.clone()).expect("deserialize");
    assert_eq!(parsed.target_mode, TargetMode::Time);
    assert_eq!(parsed.themes, vec!["scenic".to_string()]);
    assert_eq!(parsed.tz_offset_minutes, Some(120));
    assert!(matches!(parsed.start, Some(UiPoint::Id(ref s)) if s == "node-A"));
    assert!(
        matches!(parsed.end_node, Some(UiPoint::Coord { lat, lon, .. }) if lat == 47.1 && lon == 11.4)
    );
    assert_eq!(
        parsed.poi_prefs.as_ref().map(|p| p.themes.clone()),
        Some(vec!["food".to_string()])
    );

    // Round-trip equivalence (re-serialize and re-deserialize → same struct).
    let value = serde_json::to_value(&parsed).expect("serialize");
    let back: UiOptions = serde_json::from_value(value).expect("re-deserialize");
    assert_eq!(parsed, back);
}

#[test]
fn target_mode_serializes_lowercase() {
    assert_eq!(
        serde_json::to_value(TargetMode::Time).unwrap(),
        json!("time")
    );
    assert_eq!(
        serde_json::to_value(TargetMode::Distance).unwrap(),
        json!("distance")
    );
    let parsed: TargetMode = serde_json::from_value(json!("time")).unwrap();
    assert_eq!(parsed, TargetMode::Time);
}

#[test]
fn target_mode_rejects_uppercase() {
    let err = serde_json::from_value::<TargetMode>(json!("Time"));
    assert!(err.is_err(), "expected lowercase tag enforcement");
}

#[test]
fn optimizer_options_default_and_round_trip() {
    let opts = OptimizerOptions::default();
    assert_eq!(opts.k_alternatives, 3);
    assert_eq!(opts.time_budget_ms, 1_000);
    let value = serde_json::to_value(&opts).unwrap();
    let obj = value.as_object().unwrap();
    assert_eq!(obj.get("kAlternatives"), Some(&json!(3)));
    assert_eq!(obj.get("timeBudgetMs"), Some(&json!(1000)));
    assert!(!obj.contains_key("budgetSeconds"));
    let back: OptimizerOptions = serde_json::from_value(value).unwrap();
    assert_eq!(opts, back);

    let raw = json!({
        "start": {"lat": 47.0, "lon": 11.0, "name": "Innsbruck"},
        "themes": ["scenic"],
        "personas": ["foodie"],
        "forbiddenPassIds": [],
        "seasonalCutoff": "2026-07-01",
        "kAlternatives": 5,
        "timeBudgetMs": 2000,
        "budgetSeconds": 18000.0
    });
    let parsed: OptimizerOptions = serde_json::from_value(raw).unwrap();
    assert_eq!(parsed.k_alternatives, 5);
    assert_eq!(parsed.budget_seconds, Some(18000.0));
    match parsed.start {
        Some(UiPoint::Coord { lat, lon, ref name }) => {
            assert_eq!(lat, 47.0);
            assert_eq!(lon, 11.0);
            assert_eq!(name.as_deref(), Some("Innsbruck"));
        }
        _ => panic!("expected coord variant"),
    }
}

#[test]
fn ui_point_untagged_id_and_coord() {
    let id: UiPoint = serde_json::from_value(json!("some-node-id")).unwrap();
    assert!(matches!(id, UiPoint::Id(ref s) if s == "some-node-id"));

    let coord: UiPoint = serde_json::from_value(json!({"lat": 47.0, "lon": 11.0})).unwrap();
    assert!(matches!(coord, UiPoint::Coord { lat, lon, name: None } if lat == 47.0 && lon == 11.0));

    let named: UiPoint =
        serde_json::from_value(json!({"lat": 47.0, "lon": 11.0, "name": "X"})).unwrap();
    assert!(
        matches!(named, UiPoint::Coord { name: Some(ref n), .. } if n == "X"),
        "named coord variant"
    );

    // Serializing back: Id → string; Coord → object.
    assert_eq!(
        serde_json::to_value(&UiPoint::Id("a".into())).unwrap(),
        json!("a")
    );
    assert_eq!(
        serde_json::to_value(&UiPoint::Coord {
            lat: 1.0,
            lon: 2.0,
            name: None
        })
        .unwrap(),
        json!({"lat": 1.0, "lon": 2.0})
    );
}

#[test]
fn route_request_and_facts_round_trip() {
    let req = RouteRequest {
        coords: vec![[47.0, 11.0], [47.1, 11.2]],
    };
    let value = serde_json::to_value(&req).unwrap();
    assert_eq!(value, json!({"coords": [[47.0, 11.0], [47.1, 11.2]]}));
    let back: RouteRequest = serde_json::from_value(value).unwrap();
    assert_eq!(req, back);

    let facts = RouteFacts {
        geom: vec![[47.0, 11.0]],
        distance_km: Some(123.4),
        duration_h: Some(2.5),
    };
    let value = serde_json::to_value(&facts).unwrap();
    assert_eq!(value.get("distanceKm"), Some(&json!(123.4)));
    assert_eq!(value.get("durationH"), Some(&json!(2.5)));
    let back: RouteFacts = serde_json::from_value(value).unwrap();
    assert_eq!(facts, back);

    // Optional fields absent → defaults to None on the way back.
    let minimal: RouteFacts = serde_json::from_value(json!({"geom": []})).unwrap();
    assert!(minimal.distance_km.is_none() && minimal.duration_h.is_none());
}

#[test]
fn poi_prefs_and_stops_config_camel_case() {
    let prefs = PoiPrefs {
        themes: vec!["food".into()],
        preset: vec!["foodie".into()],
    };
    let v = serde_json::to_value(&prefs).unwrap();
    assert_eq!(v, json!({"themes": ["food"], "preset": ["foodie"]}));

    let stops = StopsConfig {
        max_pass_stops: Some(3),
        max_poi_stops: None,
        include_passes: vec!["a".into()],
        exclude_passes: vec![],
    };
    let v = serde_json::to_value(&stops).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.get("maxPassStops"), Some(&json!(3)));
    assert!(!obj.contains_key("maxPoiStops"));
    assert_eq!(obj.get("includePasses"), Some(&json!(["a"])));
    assert_eq!(obj.get("excludePasses"), Some(&json!([])));
}

fn sample_plan_result() -> UiPlanResult {
    UiPlanResult {
        status: "ok".into(),
        reason: None,
        start: Some(UiPoint::Id("start".into())),
        end_node: Some(UiPoint::Coord {
            lat: 47.5,
            lon: 11.5,
            name: None,
        }),
        tour_stops: vec![
            UiTourStop::Endpoint(UiEndpointStop {
                id: Some("start".into()),
                name: Some("Start".into()),
                lat: 47.0,
                lon: 11.0,
                is_endpoint: true,
            }),
            UiTourStop::Pass(UiPassStop {
                id: "p-stelvio".into(),
                name: "Stelvio".into(),
                lat: 46.5,
                lon: 10.5,
                elev: Some(2757.0),
                quality: 0.9,
                q_scenic: 0.95,
                q_summit: 0.9,
                q_approach: 0.85,
                scenic_score: 0.95,
                themes: vec!["scenic".into()],
                viewpoints: vec![],
                base_a: None,
                base_b: None,
                summit_parking: None,
            }),
            UiTourStop::Poi(UiPoiStop {
                id: "poi-x".into(),
                name: "Cafe".into(),
                lat: 47.1,
                lon: 11.1,
                is_poi: true,
                visit_dwell_sec: 1800,
                dwell_min: 30,
                dwell_h: 0.5,
                poi_category: "food".into(),
                poi_themes: vec!["food".into()],
                quality: 0.7,
                scenic_score: 0.6,
            }),
        ],
        modes: vec![],
        implicit_passes: vec![],
        scenic_stops: vec![],
        km: 250.0,
        drive_h: 5.0,
        dwell_h: 1.0,
        extras_h: 0.5,
        extras_parts: UiExtrasParts {
            corridor_h: 0.2,
            lunch_h: 0.2,
            breaks_h: 0.1,
        },
        total_h: 6.5,
        in_range: true,
        advanced: false,
        route_warning: None,
        status_warning: None,
        trip_date: Some("2026-07-01".into()),
        total_open: 12,
        diagnostics: json!({"tries": 3}),
        wasm_unavailable: false,
        intent: UiIntentSurface::default(),
        corridor: UiCorridor::default(),
        lunch_zones: vec![],
        breaks: vec![],
        route_alternatives: vec![],
        route_alternative_index: 0,
        latlngs: vec![[47.0, 11.0], [46.5, 10.5]],
        draw_meta: UiDrawMeta {
            leisure_overlays: UiOverlays::default(),
        },
    }
}

#[test]
fn ui_plan_result_uses_underscore_prefixed_legacy_keys() {
    let plan = sample_plan_result();
    let value: Value = serde_json::to_value(&plan).expect("serialize plan");
    let obj = value.as_object().expect("object");

    // The two legacy underscore keys MUST be present verbatim.
    assert!(obj.contains_key("_latlngs"), "expected `_latlngs` key");
    assert!(obj.contains_key("_drawMeta"), "expected `_drawMeta` key");
    // And the camelCased forms must NOT leak.
    assert!(!obj.contains_key("latlngs"));
    assert!(!obj.contains_key("drawMeta"));

    // Container-level rename remains camelCase for everything else.
    assert!(obj.contains_key("tourStops"));
    assert!(obj.contains_key("driveH"));
    assert!(obj.contains_key("totalH"));
    assert!(obj.contains_key("routeAlternativeIndex"));
    assert!(obj.contains_key("wasmUnavailable"));

    // _drawMeta inner field uses camelCase too.
    let draw_meta = obj.get("_drawMeta").unwrap().as_object().unwrap();
    assert!(draw_meta.contains_key("leisureOverlays"));

    // Round-trip back into the struct.
    let back: UiPlanResult = serde_json::from_value(value).expect("deserialize plan");
    assert_eq!(plan, back);
}

#[test]
fn ui_tour_stop_discriminator_pass_kind() {
    let raw = json!({
        "kind": "pass",
        "id": "p-stelvio",
        "name": "Stelvio",
        "lat": 46.5,
        "lon": 10.5,
        "elev": 2757.0,
        "quality": 0.9,
        "qScenic": 0.95,
        "qSummit": 0.9,
        "qApproach": 0.85,
        "scenicScore": 0.95,
        "themes": [],
        "viewpoints": []
    });
    let stop: UiTourStop = serde_json::from_value(raw).expect("deserialize pass");
    match stop {
        UiTourStop::Pass(ref p) => {
            assert_eq!(p.id, "p-stelvio");
            assert_eq!(p.elev, Some(2757.0));
        }
        _ => panic!("expected Pass variant"),
    }
    // Re-serializing keeps `kind` flat at the top alongside the inner fields.
    let value = serde_json::to_value(&stop).unwrap();
    let obj = value.as_object().unwrap();
    assert_eq!(obj.get("kind"), Some(&json!("pass")));
    assert_eq!(obj.get("id"), Some(&json!("p-stelvio")));
    assert_eq!(obj.get("scenicScore"), Some(&json!(0.95)));
}

#[test]
fn ui_tour_stop_discriminator_poi_and_endpoint_kinds() {
    let poi: UiTourStop = serde_json::from_value(json!({
        "kind": "poi",
        "id": "poi-x",
        "name": "Cafe",
        "lat": 47.0,
        "lon": 11.0,
        "isPoi": true,
        "visitDwellSec": 1800,
        "dwellMin": 30,
        "dwellH": 0.5,
        "poiCategory": "food",
        "poiThemes": ["food"],
        "quality": 0.7,
        "scenicScore": 0.6
    }))
    .unwrap();
    assert!(matches!(poi, UiTourStop::Poi(_)));

    let endpoint: UiTourStop = serde_json::from_value(json!({
        "kind": "endpoint",
        "lat": 47.0,
        "lon": 11.0,
        "isEndpoint": true
    }))
    .unwrap();
    assert!(matches!(endpoint, UiTourStop::Endpoint(_)));
    let v = serde_json::to_value(&endpoint).unwrap();
    assert_eq!(v.get("kind"), Some(&json!("endpoint")));
    assert_eq!(v.get("isEndpoint"), Some(&json!(true)));
    // None-valued optional fields skip.
    assert!(v.as_object().unwrap().get("id").is_none());
    assert!(v.as_object().unwrap().get("name").is_none());
}

#[test]
fn ui_tour_stop_rejects_unknown_kind() {
    let raw = json!({
        "kind": "spaceship",
        "id": "x",
        "name": "X",
        "lat": 0.0,
        "lon": 0.0,
        "isEndpoint": true
    });
    let result: Result<UiTourStop, _> = serde_json::from_value(raw);
    assert!(result.is_err(), "unknown discriminator must fail");
}

#[test]
fn ui_tour_stop_rejects_missing_kind() {
    let raw = json!({
        "lat": 47.0,
        "lon": 11.0,
        "isEndpoint": true
    });
    let result: Result<UiTourStop, _> = serde_json::from_value(raw);
    assert!(result.is_err(), "missing discriminator must fail");
}
