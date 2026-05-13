//! Extras + scenic + helper math — Rust port of the pure-data layer of
//! `assets/js/leisure/lib/ui-translation.js` (computeExtrasApprox,
//! scenicStopsApprox, roundHours, finiteOr, qualityOf).
//!
//! See `crates/leisure-core/architecture.md` (F2) for the contract and the
//! ADRs F2-001 / F2-002 / F2-003 / F2-005 for the deliberate behavior choices.
//!
//! All public functions return owned values. The frozen `Ui*` types in
//! `crate::types` are not modified; richer per-call data lives in
//! `ExtrasPartsApprox`, a Rust-side intermediate (ADR-F2-002).

use crate::types::{UiMode, UiPoint, UiScenicStop, UiTourStop};
use crate::ui_options::TargetMode;

// ===========================================================================
// Configuration & outputs
// ===========================================================================

/// User-configurable lunch policy — mirrors JS `cfg.lunchBreak` which is
/// either the string "auto", missing/null (treated as "auto"), the string
/// "skip", or a numeric minute count.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LunchBreakOption {
    Auto,
    Skip,
    Minutes(f64),
}

impl Default for LunchBreakOption {
    fn default() -> Self {
        Self::Auto
    }
}

/// Configuration bundle for `compute_extras_approx`. See ADR-F2-003: this is
/// a F2-local struct rather than an extension of the frozen `StopsConfig`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtrasConfig {
    /// Minutes spent at each pass stop. Negative / NaN are coerced to 0.
    pub pass_stop_min: f64,
    pub lunch_break: LunchBreakOption,
    /// Hours between rest breaks. Non-positive / NaN disables rest breaks.
    pub rest_interval_h: f64,
    /// Minutes per rest break. Negative / NaN are coerced to 0.
    pub rest_duration_min: f64,
    pub rest_break_on: bool,
}

/// Output of `compute_extras_approx` — the rounded total plus the richer
/// breakdown that downstream callers (e.g. `scenic_stops_approx`) consume.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtrasOutput {
    pub extras_h: f64,
    pub parts: ExtrasPartsApprox,
}

/// Rust-side intermediate. NOT the same as the frozen wire DTO
/// `crate::types::UiExtrasParts`; F5 will project the relevant numbers onto
/// the wire DTO at composition time (ADR-F2-002).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtrasPartsApprox {
    pub pass_stop_h: f64,
    pub lunch_h: f64,
    pub rest_h: f64,
    pub lunch_auto: bool,
    pub rest_count: u32,
    pub pass_n: u32,
    pub pass_stop_mins: Vec<f64>,
    pub pass_stop_uniform: bool,
}

// ===========================================================================
// Public API
// ===========================================================================

/// Approximate UI extra time (pass stops + lunch + rest breaks).
///
/// Mirrors `computeExtrasApprox` in `ui-translation.js`. Behaviour notes:
/// * Only `UiTourStop::Pass` variants count toward `pass_n` / pass_stop_mins.
/// * `pass_stop_min` is clamped to `>= 0`; NaN coerces to 0 (JS `|| 0`).
/// * Lunch:
///   * `Auto` + `target_mode=Time` uses `target_value` as the anchor when
///     it is finite and non-zero (matches JS `Number(targetValue) || driveH`),
///     otherwise falls back to `drive_h`.
///   * `Auto` + `target_mode=Distance` uses `drive_h` directly.
///   * `Skip` zeroes the lunch contribution.
///   * `Minutes(m)` uses `max(0, m) / 60`; NaN coerces to 0.
/// * Rest count: `ceil(drive_h / rest_interval) - 1` clamped to `>= 0`,
///   gated on `rest_break_on && rest_interval_h > 0 && drive_h > rest_interval_h`.
pub fn compute_extras_approx(
    tour_stops: &[UiTourStop],
    drive_h: f64,
    cfg: &ExtrasConfig,
    target_mode: TargetMode,
    target_value: Option<f64>,
) -> ExtrasOutput {
    let pass_n = tour_stops
        .iter()
        .filter(|stop| matches!(stop, UiTourStop::Pass(_)))
        .count();

    let pass_stop_min = sanitize_nonneg(cfg.pass_stop_min);
    let pass_stop_mins: Vec<f64> = (0..pass_n).map(|_| pass_stop_min).collect();
    let pass_stop_h: f64 = pass_stop_mins.iter().sum::<f64>() / 60.0;

    let mut lunch_h = 0.0_f64;
    let mut lunch_auto = false;
    match cfg.lunch_break {
        LunchBreakOption::Auto => {
            // JS: `targetMode === "time" ? Number(targetValue) || driveH : driveH`.
            // `Number(x) || y` falls through to `y` for NaN, 0 and -0.
            let anchor = match target_mode {
                TargetMode::Time => match target_value {
                    Some(v) if v.is_finite() && v != 0.0 => v,
                    _ => drive_h,
                },
                TargetMode::Distance => drive_h,
            };
            if anchor >= 4.0 {
                lunch_h = 0.75;
                lunch_auto = true;
            }
        }
        LunchBreakOption::Skip => {
            lunch_h = 0.0;
        }
        LunchBreakOption::Minutes(m) => {
            lunch_h = sanitize_nonneg(m) / 60.0;
        }
    }

    // JS: `Number(cfg.restInterval) || 0` — NaN coerces to 0; negatives kept
    // (then filtered out by the `> 0` guard below).
    let rest_interval = if cfg.rest_interval_h.is_nan() {
        0.0
    } else {
        cfg.rest_interval_h
    };
    let rest_duration = sanitize_nonneg(cfg.rest_duration_min);
    let rest_count: u32 = if cfg.rest_break_on && rest_interval > 0.0 && drive_h > rest_interval {
        let raw = (drive_h / rest_interval).ceil() - 1.0;
        if raw.is_finite() && raw > 0.0 {
            raw as u32
        } else {
            0
        }
    } else {
        0
    };
    let rest_h = (rest_count as f64) * rest_duration / 60.0;

    // JS: `new Set(passStopMins).size <= 1`. With a uniform fill above the
    // set always has size 0 or 1, but we compute generically so the rule
    // remains correct if we ever vary per-pass mins.
    let pass_stop_uniform = is_uniform(&pass_stop_mins);

    ExtrasOutput {
        extras_h: round_hours(pass_stop_h + lunch_h + rest_h),
        parts: ExtrasPartsApprox {
            pass_stop_h,
            lunch_h,
            rest_h,
            lunch_auto,
            rest_count,
            pass_n: pass_n as u32,
            pass_stop_mins,
            pass_stop_uniform,
        },
    }
}

/// Build approximate scenic/rest stops from pass stops and extra-time parts.
///
/// Mirrors JS `scenicStopsApprox`. The returned shape is the *frozen*
/// `UiScenicStop` (5 fields); richer per-stop bookkeeping (side, stopMin,
/// restMin, …) is reconstituted by F5 at composition time (ADR-F2-002).
///
/// Important: the JS code uses a `passIndex++` side effect — only Pass-kind
/// stops consume a `pass_stop_mins` slot. POI / endpoint stops are skipped
/// without advancing the index. We mirror that behaviour exactly.
pub fn scenic_stops_approx(
    tour_stops: &[UiTourStop],
    _modes: &[UiMode],
    extras_parts: &ExtrasPartsApprox,
) -> Vec<UiScenicStop> {
    // Note: `_modes` is accepted for API parity with the JS function and the
    // architecture contract, but the frozen `UiScenicStop` does not carry a
    // `side` field, so we currently do not consume it. F5 will use modes
    // directly when reconstructing the richer JS-shape scenic stop.
    let mut pass_index: usize = 0;
    let mut out = Vec::new();
    for (order, stop) in tour_stops.iter().enumerate() {
        let pass = match stop {
            UiTourStop::Pass(p) => p,
            _ => continue, // POI/endpoint: skip WITHOUT consuming pass_index.
        };
        let stop_min = extras_parts
            .pass_stop_mins
            .get(pass_index)
            .copied()
            .unwrap_or(0.0);
        pass_index += 1;
        if stop_min <= 0.0 && extras_parts.rest_h == 0.0 {
            continue;
        }
        let (lat, lon, point_name) = match &pass.summit_parking {
            Some(UiPoint::Coord { lat, lon, name }) => (*lat, *lon, name.clone()),
            // `UiPoint::Id` carries no coords — fall back to the pass coord.
            Some(UiPoint::Id(_)) | None => (pass.lat, pass.lon, None),
        };
        let display_name = point_name.unwrap_or_else(|| format!("{} viewpoint", pass.name));
        out.push(UiScenicStop {
            id: format!("{}:leisure-scenic:{}", pass.id, order),
            name: display_name,
            lat,
            lon,
            // JS: `quality: stop.quality || 0` — `pass.quality` is already
            // produced by `quality_of`, so it is finite & in [0,1].
            scenic_score: if pass.quality.is_finite() {
                pass.quality
            } else {
                0.0
            },
        });
    }
    out
}

// ===========================================================================
// Helper math
// ===========================================================================

/// Round an hour value to two decimals.
///
/// JS contract (`Math.round((Number(value)||0) * 100) / 100`):
/// * Non-finite inputs (NaN, ±∞) coerce to `0.0` (ADR-F2-001). Note: JS
///   `Number(x) || 0` returns 0 for NaN but Infinity would survive (truthy),
///   so JS `roundHours(Infinity)` evaluates to `Math.round(Infinity)/100 =
///   Infinity`. Per ADR-F2-001 we deliberately tighten the contract: any
///   non-finite input maps to `0.0`. This is the spirit of "non-finite
///   output is fine to reject in Rust" called out in the ADR.
/// * For finite inputs we use `(value * 100.0).round() / 100.0`.
///   `f64::round` is half-away-from-zero, which matches `Math.round` for
///   positive values; negative `.5` cases differ in principle but are
///   irrelevant in practice because the multiply-by-100 step rarely yields
///   an exact `*.5` due to IEEE-754 representation.
pub fn round_hours(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 100.0).round() / 100.0
}

/// Return `primary` if it is finite, else `fallback` if finite, else `0.0`.
///
/// Mirrors JS `finiteOr(primary, fallback = 0)` which is
/// `Number.isFinite(value) ? value : (Number(fallback) || 0)`.
pub fn finite_or(primary: f64, fallback: f64) -> f64 {
    if primary.is_finite() {
        primary
    } else if fallback.is_finite() {
        fallback
    } else {
        0.0
    }
}

/// Normalize a graph-derived quality / scenic-score / score onto `[0, 1]`.
///
/// Priority (per ADR-F2-005, mirrors JS `node?.quality ?? node?.scenicScore
/// ?? node?.score ?? 0`): `raw_quality` → `scenic_score` → `score` → 0.
/// JS `??` only short-circuits on `null`/`undefined`, so a `Some(NaN)` is
/// taken (then collapses to 0 via `Number(NaN) || 0`).
///
/// Clamping: if `v > 1`, divide by 10 and cap at 1; otherwise floor at 0.
pub fn quality_of(scenic_score: Option<f64>, score: Option<f64>, raw_quality: Option<f64>) -> f64 {
    let raw = raw_quality.or(scenic_score).or(score).unwrap_or(0.0);
    // JS `Number(raw) || 0` — NaN (and 0/-0) collapse to 0.
    let value = if raw.is_finite() && raw != 0.0 {
        raw
    } else {
        0.0
    };
    if value > 1.0 {
        (value / 10.0).min(1.0)
    } else {
        value.max(0.0)
    }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/// JS `Math.max(0, Number(x) || 0)`: NaN → 0, negatives → 0, otherwise x.
fn sanitize_nonneg(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

/// JS `new Set(values).size <= 1`. We use bit-equality (transmute to u64) so
/// NaN compares equal to itself — matching `Set` semantics where NaN is its
/// own canonical bucket.
fn is_uniform(values: &[f64]) -> bool {
    if values.len() <= 1 {
        return true;
    }
    let first = values[0].to_bits();
    values.iter().skip(1).all(|v| v.to_bits() == first)
}
