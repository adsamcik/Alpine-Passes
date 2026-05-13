//! Tests for `crate::extras` — F2-C2.
//!
//! Coverage targets: round_hours boundary battery (ADR-F2-001),
//! finite_or, quality_of (ADR-F2-005), compute_extras_approx (auto/skip/
//! fixed lunch + rest math + boundary cases), scenic_stops_approx
//! (passIndex side effect, gating on stop_min/rest_h, summit_parking
//! fallback).

use leisure_core::extras::{
    compute_extras_approx, finite_or, quality_of, round_hours, scenic_stops_approx,
    ExtrasConfig, ExtrasPartsApprox, LunchBreakOption,
};
use leisure_core::types::{
    Point, UiEndpointStop, UiMode, UiPassStop, UiPoiStop, UiPoint, UiTourStop,
};
use leisure_core::ui_options::TargetMode;

// ---------- helpers ----------

fn pass(id: &str, name: &str, lat: f64, lon: f64) -> UiTourStop {
    UiTourStop::Pass(UiPassStop {
        id: id.into(),
        name: name.into(),
        lat,
        lon,
        elev: None,
        quality: 0.42,
        q_scenic: 0.0,
        q_summit: 0.0,
        q_approach: 0.0,
        scenic_score: 0.0,
        themes: Vec::new(),
        viewpoints: Vec::new(),
        base_a: None,
        base_b: None,
        summit_parking: None,
    })
}

fn pass_with_summit(id: &str, name: &str, sp: UiPoint) -> UiTourStop {
    let mut s = pass(id, name, 1.0, 2.0);
    if let UiTourStop::Pass(p) = &mut s {
        p.summit_parking = Some(sp);
    }
    s
}

fn poi(id: &str) -> UiTourStop {
    UiTourStop::Poi(UiPoiStop {
        id: id.into(),
        name: "p".into(),
        lat: 0.0,
        lon: 0.0,
        is_poi: true,
        visit_dwell_sec: 0,
        dwell_min: 0,
        dwell_h: 0.0,
        poi_category: String::new(),
        poi_themes: Vec::new(),
        quality: 0.0,
        scenic_score: 0.0,
    })
}

fn endpoint() -> UiTourStop {
    UiTourStop::Endpoint(UiEndpointStop {
        id: None,
        name: None,
        lat: 0.0,
        lon: 0.0,
        is_endpoint: true,
    })
}

fn cfg(pass_min: f64, lunch: LunchBreakOption, ri: f64, rd: f64, on: bool) -> ExtrasConfig {
    ExtrasConfig {
        pass_stop_min: pass_min,
        lunch_break: lunch,
        rest_interval_h: ri,
        rest_duration_min: rd,
        rest_break_on: on,
    }
}

// =====================================================================
// round_hours — ADR-F2-001 boundary battery
// =====================================================================

#[test]
fn round_hours_zero() {
    assert_eq!(round_hours(0.0), 0.0);
}

#[test]
fn round_hours_half_positive() {
    // 0.005*100 ~= 0.5; due to FP, may round either way — accept observed.
    let r = round_hours(0.005);
    assert!(r == 0.0 || r == 0.01, "got {r}");
}

#[test]
fn round_hours_half_negative() {
    let r = round_hours(-0.005);
    assert!(r == 0.0 || r == -0.01, "got {r}");
}

#[test]
fn round_hours_015() {
    // 0.015 stored as ~0.015000000000000001; *100 = 1.5000... → rounds to 2.
    assert_eq!(round_hours(0.015), 0.02);
}

#[test]
fn round_hours_neg_015() {
    assert_eq!(round_hours(-0.015), -0.02);
}

#[test]
fn round_hours_025() {
    // f64::round is half-away-from-zero; (0.025*100).round()/100 = 0.03.
    assert_eq!(round_hours(0.025), 0.03);
}

#[test]
fn round_hours_neg_025() {
    assert_eq!(round_hours(-0.025), -0.03);
}

#[test]
fn round_hours_below_half() {
    assert_eq!(round_hours(0.0049), 0.0);
}

#[test]
fn round_hours_neg_below_half() {
    assert_eq!(round_hours(-0.0049), 0.0);
}

#[test]
fn round_hours_nan_yields_zero() {
    // Per ADR-F2-001 — non-finite input maps to 0.
    assert_eq!(round_hours(f64::NAN), 0.0);
}

#[test]
fn round_hours_pos_infinity_yields_zero() {
    assert_eq!(round_hours(f64::INFINITY), 0.0);
}

#[test]
fn round_hours_neg_infinity_yields_zero() {
    assert_eq!(round_hours(f64::NEG_INFINITY), 0.0);
}

#[test]
fn round_hours_typical_two_decimals() {
    assert_eq!(round_hours(1.234), 1.23);
    assert_eq!(round_hours(1.236), 1.24);
}

// =====================================================================
// finite_or
// =====================================================================

#[test]
fn finite_or_uses_primary_when_finite() {
    assert_eq!(finite_or(2.5, 9.0), 2.5);
    assert_eq!(finite_or(0.0, 9.0), 0.0);
    assert_eq!(finite_or(-1.0, 9.0), -1.0);
}

#[test]
fn finite_or_falls_back_when_primary_nan() {
    assert_eq!(finite_or(f64::NAN, 7.0), 7.0);
}

#[test]
fn finite_or_falls_back_when_primary_inf() {
    assert_eq!(finite_or(f64::INFINITY, 7.0), 7.0);
    assert_eq!(finite_or(f64::NEG_INFINITY, 7.0), 7.0);
}

#[test]
fn finite_or_zero_when_both_non_finite() {
    assert_eq!(finite_or(f64::NAN, f64::NAN), 0.0);
    assert_eq!(finite_or(f64::INFINITY, f64::NEG_INFINITY), 0.0);
}

// =====================================================================
// quality_of — ADR-F2-005 priority + clamp
// =====================================================================

#[test]
fn quality_priority_quality_first() {
    // quality wins over scenic_score and score.
    assert_eq!(quality_of(Some(0.9), Some(0.5), Some(0.3)), 0.3);
}

#[test]
fn quality_priority_scenic_second() {
    assert_eq!(quality_of(Some(0.7), Some(0.5), None), 0.7);
}

#[test]
fn quality_priority_score_third() {
    assert_eq!(quality_of(None, Some(0.4), None), 0.4);
}

#[test]
fn quality_priority_default_zero() {
    assert_eq!(quality_of(None, None, None), 0.0);
}

#[test]
fn quality_clamps_above_one() {
    // value > 1 → divide by 10, cap at 1.
    assert!((quality_of(None, None, Some(8.0)) - 0.8).abs() < 1e-12);
    assert_eq!(quality_of(None, None, Some(20.0)), 1.0);
}

#[test]
fn quality_clamps_negative_to_zero() {
    assert_eq!(quality_of(None, None, Some(-5.0)), 0.0);
}

#[test]
fn quality_some_nan_collapses_to_zero() {
    // Some(NaN) is taken (?? semantics) then `Number(NaN) || 0` → 0.
    assert_eq!(quality_of(Some(0.5), None, Some(f64::NAN)), 0.0);
}

#[test]
fn quality_in_range_passthrough() {
    assert_eq!(quality_of(None, None, Some(0.5)), 0.5);
    assert_eq!(quality_of(None, None, Some(1.0)), 1.0);
    assert_eq!(quality_of(None, None, Some(0.0)), 0.0);
}

// =====================================================================
// compute_extras_approx — pass stops
// =====================================================================

#[test]
fn extras_no_passes_no_extras() {
    let stops = vec![poi("a"), endpoint()];
    let out = compute_extras_approx(
        &stops,
        2.0,
        &cfg(15.0, LunchBreakOption::Skip, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.pass_n, 0);
    assert!(out.parts.pass_stop_mins.is_empty());
    assert_eq!(out.parts.pass_stop_h, 0.0);
    assert_eq!(out.extras_h, 0.0);
}

#[test]
fn extras_pass_stop_mins_uniform_fill() {
    let stops = vec![pass("p1", "P1", 0.0, 0.0), pass("p2", "P2", 0.0, 0.0), poi("x")];
    let out = compute_extras_approx(
        &stops,
        1.0,
        &cfg(20.0, LunchBreakOption::Skip, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.pass_n, 2);
    assert_eq!(out.parts.pass_stop_mins, vec![20.0, 20.0]);
    assert!((out.parts.pass_stop_h - (40.0 / 60.0)).abs() < 1e-12);
    assert!(out.parts.pass_stop_uniform);
}

#[test]
fn extras_pass_stop_min_zero_short_circuits() {
    let stops = vec![pass("p1", "P1", 0.0, 0.0)];
    let out = compute_extras_approx(
        &stops,
        1.0,
        &cfg(0.0, LunchBreakOption::Skip, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.pass_stop_mins, vec![0.0]);
    assert_eq!(out.parts.pass_stop_h, 0.0);
}

#[test]
fn extras_pass_stop_min_negative_clamped_to_zero() {
    let stops = vec![pass("p1", "P1", 0.0, 0.0)];
    let out = compute_extras_approx(
        &stops,
        1.0,
        &cfg(-10.0, LunchBreakOption::Skip, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.pass_stop_mins, vec![0.0]);
}

#[test]
fn extras_pass_stop_min_nan_clamped_to_zero() {
    let stops = vec![pass("p1", "P1", 0.0, 0.0)];
    let out = compute_extras_approx(
        &stops,
        1.0,
        &cfg(f64::NAN, LunchBreakOption::Skip, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.pass_stop_mins, vec![0.0]);
}

// =====================================================================
// compute_extras_approx — lunch (Auto)
// =====================================================================

#[test]
fn extras_lunch_auto_time_uses_target_value_anchor() {
    // target_value=5 truthy → anchor=5 ≥ 4 → lunch fires even if drive_h<4.
    let out = compute_extras_approx(
        &[],
        2.0,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Time,
        Some(5.0),
    );
    assert_eq!(out.parts.lunch_h, 0.75);
    assert!(out.parts.lunch_auto);
}

#[test]
fn extras_lunch_auto_time_target_value_3_no_lunch() {
    // anchor=3 < 4, even though drive_h=10 — JS uses `Number(tv) || driveH`
    // and 3 is truthy, so anchor=3.
    let out = compute_extras_approx(
        &[],
        10.0,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Time,
        Some(3.0),
    );
    assert_eq!(out.parts.lunch_h, 0.0);
    assert!(!out.parts.lunch_auto);
}

#[test]
fn extras_lunch_auto_time_target_none_falls_back_to_drive_h() {
    let out = compute_extras_approx(
        &[],
        4.5,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Time,
        None,
    );
    assert_eq!(out.parts.lunch_h, 0.75);
    assert!(out.parts.lunch_auto);
}

#[test]
fn extras_lunch_auto_time_target_zero_falls_back_to_drive_h() {
    // 0 is falsy in JS `Number(0) || driveH` → drive_h=4.5 ≥ 4 → lunch fires.
    let out = compute_extras_approx(
        &[],
        4.5,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Time,
        Some(0.0),
    );
    assert_eq!(out.parts.lunch_h, 0.75);
}

#[test]
fn extras_lunch_auto_time_target_nan_falls_back_to_drive_h() {
    let out = compute_extras_approx(
        &[],
        4.5,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Time,
        Some(f64::NAN),
    );
    assert_eq!(out.parts.lunch_h, 0.75);
}

#[test]
fn extras_lunch_auto_distance_uses_drive_h_anchor() {
    let out = compute_extras_approx(
        &[],
        4.5,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Distance,
        Some(100.0), // ignored in distance mode
    );
    assert_eq!(out.parts.lunch_h, 0.75);
    assert!(out.parts.lunch_auto);
}

#[test]
fn extras_lunch_auto_distance_below_threshold_no_lunch() {
    let out = compute_extras_approx(
        &[],
        3.99,
        &cfg(0.0, LunchBreakOption::Auto, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.lunch_h, 0.0);
    assert!(!out.parts.lunch_auto);
}

// =====================================================================
// compute_extras_approx — lunch (Skip / Minutes)
// =====================================================================

#[test]
fn extras_lunch_skip_zero() {
    let out = compute_extras_approx(
        &[],
        10.0,
        &cfg(0.0, LunchBreakOption::Skip, 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.lunch_h, 0.0);
    assert!(!out.parts.lunch_auto);
}

#[test]
fn extras_lunch_minutes_60() {
    let out = compute_extras_approx(
        &[],
        2.0,
        &cfg(0.0, LunchBreakOption::Minutes(60.0), 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.lunch_h, 1.0);
    assert!(!out.parts.lunch_auto);
}

#[test]
fn extras_lunch_minutes_zero() {
    let out = compute_extras_approx(
        &[],
        2.0,
        &cfg(0.0, LunchBreakOption::Minutes(0.0), 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.lunch_h, 0.0);
}

#[test]
fn extras_lunch_minutes_negative_clamped() {
    let out = compute_extras_approx(
        &[],
        2.0,
        &cfg(0.0, LunchBreakOption::Minutes(-30.0), 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.lunch_h, 0.0);
}

#[test]
fn extras_lunch_minutes_nan_clamped() {
    let out = compute_extras_approx(
        &[],
        2.0,
        &cfg(0.0, LunchBreakOption::Minutes(f64::NAN), 0.0, 0.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.lunch_h, 0.0);
}

// =====================================================================
// compute_extras_approx — rest count math
// =====================================================================

#[test]
fn extras_rest_off_yields_zero() {
    let out = compute_extras_approx(
        &[],
        10.0,
        &cfg(0.0, LunchBreakOption::Skip, 2.0, 15.0, false),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 0);
    assert_eq!(out.parts.rest_h, 0.0);
}

#[test]
fn extras_rest_drive_h_eq_interval_no_rest() {
    // drive_h > restInterval is strict; equal means no rest.
    let out = compute_extras_approx(
        &[],
        2.0,
        &cfg(0.0, LunchBreakOption::Skip, 2.0, 15.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 0);
    assert_eq!(out.parts.rest_h, 0.0);
}

#[test]
fn extras_rest_drive_h_2_5x_interval() {
    // ceil(5.0/2.0)-1 = 3-1 = 2.
    let out = compute_extras_approx(
        &[],
        5.0,
        &cfg(0.0, LunchBreakOption::Skip, 2.0, 15.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 2);
    assert!((out.parts.rest_h - (30.0 / 60.0)).abs() < 1e-12);
}

#[test]
fn extras_rest_just_above_interval() {
    // ceil(2.01/2.0)-1 = 2-1 = 1.
    let out = compute_extras_approx(
        &[],
        2.01,
        &cfg(0.0, LunchBreakOption::Skip, 2.0, 10.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 1);
}

#[test]
fn extras_rest_interval_zero_disables() {
    let out = compute_extras_approx(
        &[],
        10.0,
        &cfg(0.0, LunchBreakOption::Skip, 0.0, 15.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 0);
}

#[test]
fn extras_rest_interval_nan_disables() {
    let out = compute_extras_approx(
        &[],
        10.0,
        &cfg(0.0, LunchBreakOption::Skip, f64::NAN, 15.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 0);
}

#[test]
fn extras_rest_duration_negative_clamped() {
    let out = compute_extras_approx(
        &[],
        5.0,
        &cfg(0.0, LunchBreakOption::Skip, 2.0, -5.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 2);
    assert_eq!(out.parts.rest_h, 0.0);
}

#[test]
fn extras_negative_drive_h_no_rest() {
    let out = compute_extras_approx(
        &[],
        -1.0,
        &cfg(0.0, LunchBreakOption::Skip, 2.0, 15.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.rest_count, 0);
}

// =====================================================================
// compute_extras_approx — totals
// =====================================================================

#[test]
fn extras_total_rounding_combines_parts() {
    // 2 passes × 15min = 30min = 0.5h; lunch 0.75h; rest_count
    // ceil(5/2)-1=2, *15min=30min=0.5h. Total = 1.75h.
    let stops = vec![pass("p1", "P1", 0.0, 0.0), pass("p2", "P2", 0.0, 0.0)];
    let out = compute_extras_approx(
        &stops,
        5.0,
        &cfg(15.0, LunchBreakOption::Auto, 2.0, 15.0, true),
        TargetMode::Distance,
        None,
    );
    assert_eq!(out.parts.pass_n, 2);
    assert_eq!(out.parts.rest_count, 2);
    assert_eq!(out.extras_h, 1.75);
}

// =====================================================================
// scenic_stops_approx
// =====================================================================

#[test]
fn scenic_skips_poi_and_endpoint_without_consuming_index() {
    // Order: POI, Pass(p1), Endpoint, Pass(p2). passIndex must only
    // advance for Pass entries: p1 → mins[0], p2 → mins[1].
    let stops = vec![
        poi("x"),
        pass("p1", "P1", 1.0, 2.0),
        endpoint(),
        pass("p2", "P2", 3.0, 4.0),
    ];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![15.0, 0.0], // only p1 emits (rest_h==0)
        pass_n: 2,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "p1:leisure-scenic:1");
    assert_eq!(out[0].lat, 1.0);
}

#[test]
fn scenic_emits_when_rest_h_positive_even_if_stop_min_zero() {
    let stops = vec![pass("p1", "P1", 1.0, 2.0)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![0.0],
        rest_h: 0.5,
        pass_n: 1,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert_eq!(out.len(), 1);
}

#[test]
fn scenic_skips_when_stop_min_zero_and_rest_zero() {
    let stops = vec![pass("p1", "P1", 1.0, 2.0)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![0.0],
        rest_h: 0.0,
        pass_n: 1,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert!(out.is_empty());
}

#[test]
fn scenic_uses_summit_parking_when_present() {
    let sp = UiPoint::Coord {
        lat: 9.0,
        lon: 8.0,
        name: Some("Lookout".into()),
    };
    let stops = vec![pass_with_summit("p1", "P1", sp)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![10.0],
        pass_n: 1,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].lat, 9.0);
    assert_eq!(out[0].lon, 8.0);
    assert_eq!(out[0].name, "Lookout");
}

#[test]
fn scenic_falls_back_to_pass_coord_when_no_summit_parking() {
    let stops = vec![pass("p1", "Stelvio", 1.5, 2.5)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![10.0],
        pass_n: 1,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].lat, 1.5);
    assert_eq!(out[0].lon, 2.5);
    assert_eq!(out[0].name, "Stelvio viewpoint");
    assert_eq!(out[0].id, "p1:leisure-scenic:0");
}

#[test]
fn scenic_uses_pass_quality_for_scenic_score() {
    let stops = vec![pass("p1", "P1", 1.0, 2.0)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![10.0],
        pass_n: 1,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert!((out[0].scenic_score - 0.42).abs() < 1e-12);
}

#[test]
fn scenic_handles_modes_shorter_than_tour_stops() {
    // Even if `modes` is empty / shorter, we don't panic — we don't currently
    // consume modes (frozen `UiScenicStop` has no `side` field).
    let stops = vec![pass("p1", "P1", 1.0, 2.0), pass("p2", "P2", 3.0, 4.0)];
    let modes: Vec<UiMode> = Vec::new();
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![5.0, 5.0],
        pass_n: 2,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &modes, &parts);
    assert_eq!(out.len(), 2);
}

#[test]
fn scenic_summit_parking_with_unnamed_point_uses_default_name() {
    let sp = UiPoint::Coord {
        lat: 9.0,
        lon: 8.0,
        name: None,
    };
    let stops = vec![pass_with_summit("p1", "Furka", sp)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![10.0],
        pass_n: 1,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert_eq!(out[0].name, "Furka viewpoint");
    assert_eq!(out[0].lat, 9.0);
}

#[test]
fn scenic_pass_stop_mins_shorter_than_passes_uses_zero_default() {
    // pass_stop_mins shorter than pass count → out-of-range slots default
    // to 0, and (with rest_h=0) those passes are skipped silently.
    let stops = vec![pass("p1", "P1", 1.0, 2.0), pass("p2", "P2", 3.0, 4.0)];
    let parts = ExtrasPartsApprox {
        pass_stop_mins: vec![10.0],
        pass_n: 2,
        ..Default::default()
    };
    let out = scenic_stops_approx(&stops, &[], &parts);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "p1:leisure-scenic:0");
}

// Touch the unused import so this test file's intent is clear.
#[test]
fn _point_type_is_in_scope() {
    let _ = Point {
        lat: 0.0,
        lon: 0.0,
        name: None,
    };
}
