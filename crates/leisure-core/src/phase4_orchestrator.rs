//! Phase 4 orchestration (Rust-side consolidation).
//!
//! Mirrors the JS shim at `assets/js/leisure/wasm-shim.js:333-405`,
//! and the helpers at `assets/js/leisure/lib/ui-translation.js:650`
//! (`safePhase`) and `:661` (`phaseStartTime`).
//!
//! C1 ships skeleton + helpers + the `safe_phase!` macro. The orchestrator
//! body in `phase4_outputs` is a stub returning the empty default — C2 will
//! fill it in.

use crate::corridor::CorridorItem;
use crate::graph::LeisureGraph;
use crate::intent::{IntentCandidate, IntentEntity};
use crate::optimizer::PublicTour;
use crate::types::{
    UiBreakItem, UiCorridor, UiCorridorItem, UiIntentSurface, UiLunchZone, UiOverlays,
    UiPhase4Outputs,
};
use crate::ui_options::UiOptions;
use std::collections::BTreeMap;

/// Resolve the Phase 4 start time from `UiOptions`.
///
/// Returns an ISO-8601 string (or empty string if no usable input).
/// JS analogue: `phaseStartTime` in `assets/js/leisure/lib/ui-translation.js:661`.
///
/// 1. If `ui.start_time` looks like an ISO-8601 timestamp → return it verbatim.
/// 2. Else if `ui.trip_date` is a strict `YYYY-MM-DD` (10 chars) → return
///    `"{trip_date}T08:00:00.000Z"`.
/// 3. Else `""` (downstream stages apply their own defaults).
pub fn phase_start_time(ui: &UiOptions) -> String {
    if let Some(s) = ui.start_time.as_deref() {
        if is_iso_8601_like(s) {
            return s.to_owned();
        }
    }
    if let Some(d) = ui.trip_date.as_deref() {
        if is_iso_date_yyyy_mm_dd(d) {
            return format!("{d}T08:00:00.000Z");
        }
    }
    String::new()
}

fn is_iso_date_yyyy_mm_dd(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[8..10].iter().all(|b| b.is_ascii_digit())
}

fn is_iso_8601_like(s: &str) -> bool {
    // Permissive: must start with YYYY-MM-DD; either exactly that, or
    // followed by 'T' and more characters (datetime). Disallows slashes,
    // epoch numbers, or empty strings.
    //
    // Operates strictly on bytes — never str-slices — so multi-byte UTF-8
    // codepoints near the boundary cannot trigger a non-char-boundary panic.
    let b = s.as_bytes();
    if b.len() < 10 {
        return false;
    }
    if b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !(b[0..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    b.len() == 10 || b[10] == b'T'
}

/// Build an `IntentCandidate` from a `CorridorItem`.
///
/// JS analogue: `intentCandidateFromCorridorItem` in
/// `assets/js/leisure/wasm-shim.js:478-489`.
pub fn intent_candidate_from_corridor_item(item: &CorridorItem) -> IntentCandidate {
    IntentCandidate {
        poi_id: item.poi_id.clone(),
        id: item.poi_id.clone(),
        kind: "poi".to_owned(),
        name: item.poi_name.clone(),
        score: item.score,
        themes: item.themes.clone(),
        categories: item.categories.clone(),
        viewpoints: Vec::new(),
    }
}

/// Per-stage error containment, mirroring JS `safePhase`
/// (`assets/js/leisure/lib/ui-translation.js:650`).
///
/// On non-WASM targets, wraps the body in `panic::catch_unwind` and returns
/// `$fallback` if the body panics. On WASM targets, evaluates the body
/// directly (the algorithm crates are panic-free by design and WASM cannot
/// unwind across the FFI boundary).
macro_rules! safe_phase {
    ($label:expr, $fallback:expr, $body:expr) => {{
        #[cfg(not(target_arch = "wasm32"))]
        {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $body));
            match result {
                Ok(v) => v,
                Err(_) => {
                    $crate::phase4_orchestrator::log_phase_failure($label);
                    $fallback
                }
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            $body
        }
    }};
}
pub(crate) use safe_phase;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn log_phase_failure(label: &str) {
    eprintln!("[phase4] stage `{label}` panicked; using fallback");
}

pub fn phase4_outputs(
    graph: &LeisureGraph,
    tour: &PublicTour,
    tour_stops: &[IntentEntity],
    ui: &UiOptions,
) -> UiPhase4Outputs {
    phase4_outputs_with_hooks(graph, tour, tour_stops, ui, Phase4Hooks::default())
}

type StageHook<T> = Option<Box<dyn FnOnce() -> T>>;

#[derive(Default)]
struct Phase4Hooks {
    corridor: StageHook<crate::corridor::CorridorSuggestions>,
    lunch: StageHook<crate::lunch::LunchSuggestion>,
    breaks: StageHook<crate::breaks::BreakSuggestions>,
    intent: StageHook<crate::intent::IntentDistribution>,
    intent_surface: StageHook<crate::intent::SurfaceIntentResult>,
}

/// Runtime equivalent of `safe_phase!` that also supports one-shot test hooks.
fn run_stage<T>(
    label: &'static str,
    fallback: T,
    hook: &mut StageHook<T>,
    prod: impl FnOnce() -> T,
) -> T {
    let body = move || -> T {
        match hook.take() {
            Some(h) => h(),
            None => prod(),
        }
    };

    #[cfg(not(target_arch = "wasm32"))]
    {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
            Ok(v) => v,
            Err(_) => {
                log_phase_failure(label);
                fallback
            }
        }
    }
    #[cfg(target_arch = "wasm32")]
    {
        body()
    }
}

fn phase4_outputs_with_hooks(
    graph: &LeisureGraph,
    tour: &PublicTour,
    tour_stops: &[IntentEntity],
    ui: &UiOptions,
    mut hooks: Phase4Hooks,
) -> UiPhase4Outputs {
    let themes: Vec<String> = if !ui.themes.is_empty() {
        ui.themes.clone()
    } else {
        ui.poi_prefs
            .as_ref()
            .map(|p| p.themes.clone())
            .unwrap_or_default()
    };
    let personas: Vec<String> = if !ui.personas.is_empty() {
        ui.personas.clone()
    } else {
        ui.poi_prefs
            .as_ref()
            .map(|p| p.preset.clone())
            .unwrap_or_default()
    };
    let weather: Option<String> = ui.weather.clone();
    let with_child: bool = ui
        .with_child
        .unwrap_or_else(|| personas.iter().any(|p| p == "family"));
    let start_time: String = phase_start_time(ui);
    let tz_offset_minutes: i32 = ui.tz_offset_minutes.unwrap_or(0);
    let lunch_persona: String = crate::heuristics::lunch_persona_for(&personas)
        .as_str()
        .to_owned();
    let break_persona: String = crate::heuristics::break_persona_for(&personas);
    let lunch_policy: crate::lunch::LunchPolicy =
        crate::heuristics::lunch_policy_for(ui.lunch.as_deref());

    let corridor_opts = crate::corridor::CorridorOptions {
        themes: themes.clone(),
        personas: personas.clone(),
        max_auto_include_per_hour: 1,
        max_suggestions_total: 12,
        ..crate::corridor::CorridorOptions::default()
    };
    let corridor_result = run_stage(
        "corridor",
        crate::corridor::CorridorSuggestions::default(),
        &mut hooks.corridor,
        || crate::corridor::suggest_corridor(graph, tour, corridor_opts),
    );

    let lunch_opts = crate::lunch::LunchOptions {
        start_time: start_time.clone(),
        tz_offset_minutes,
        persona: lunch_persona,
        lunch_policy,
        narrative_mode: true,
        weather: weather.clone(),
    };
    let lunch_result = run_stage(
        "lunch",
        crate::lunch::LunchSuggestion::default(),
        &mut hooks.lunch,
        || crate::lunch::find_lunch_area(graph, tour, lunch_opts),
    );

    let break_corridor_pois: Vec<crate::breaks::BreakPoiInput> = corridor_result
        .suggestions
        .iter()
        .map(corridor_item_to_break_poi_input)
        .collect();
    let break_opts = crate::breaks::BreakOptions {
        start_time: start_time.clone(),
        tz_offset_minutes,
        persona: break_persona,
        weather: weather.clone(),
        tour_packed: tour_stops.len() >= 8,
        corridor_pois: break_corridor_pois,
        max_breaks_total: 4,
        ..crate::breaks::BreakOptions::default()
    };
    let breaks_result = run_stage(
        "breaks",
        crate::breaks::BreakSuggestions::default(),
        &mut hooks.breaks,
        || crate::breaks::detect_breaks(graph, tour, break_opts),
    );

    let intent_state = crate::intent::IntentState {
        pinned_stops: tour_stops.to_vec(),
        theme_chips: themes.clone(),
        history: crate::intent::IntentHistory::default(),
        budget_tier: None,
        weather: weather.clone(),
        group_size: None,
        with_child: Some(with_child),
    };
    let intent_dist = run_stage(
        "intent",
        crate::intent::IntentDistribution::default(),
        &mut hooks.intent,
        || crate::intent::infer_intent(intent_state),
    );

    let intent_candidates: Vec<crate::intent::IntentCandidate> = corridor_result
        .auto_include
        .iter()
        .chain(corridor_result.suggestions.iter())
        .map(intent_candidate_from_corridor_item)
        .collect();
    let surface_opts = crate::intent::SurfaceIntentOptions {
        top_k: 12,
        serendipity_fraction: 2.0 / 12.0,
        corridor_pois: intent_candidates,
    };
    let surfaced = run_stage(
        "intent-surface",
        crate::intent::SurfaceIntentResult::default(),
        &mut hooks.intent_surface,
        || crate::intent::surface_intent_pois(graph, Some(tour), Some(&intent_dist), surface_opts),
    );

    let corridor_items_ui: Vec<UiCorridorItem> = corridor_result
        .suggestions
        .iter()
        .map(corridor_item_to_ui)
        .collect();
    let corridor_auto_include_ui: Vec<UiCorridorItem> = corridor_result
        .auto_include
        .iter()
        .map(corridor_item_to_ui)
        .collect();
    let lunch_zones_ui: Vec<UiLunchZone> = lunch_result
        .zones
        .into_iter()
        .take(2)
        .map(lunch_zone_to_ui)
        .collect();
    let breaks_ui: Vec<UiBreakItem> = breaks_result
        .breaks
        .iter()
        .map(|stop| {
            let item = break_stop_to_ui(stop);
            crate::tour_dto::enrich_break_point(item, &tour.path, graph)
        })
        .collect();
    let lookup: BTreeMap<String, CorridorItem> = corridor_result
        .auto_include
        .iter()
        .chain(corridor_result.suggestions.iter())
        .map(|c| (c.poi_id.clone(), c.clone()))
        .collect();
    let primary_ui: Vec<UiCorridorItem> = surfaced
        .primary
        .iter()
        .map(|i| surface_item_to_ui_corridor(i, &lookup))
        .collect();
    let serendipity_ui: Vec<UiCorridorItem> = surfaced
        .serendipity
        .iter()
        .map(|i| surface_item_to_ui_corridor(i, &lookup))
        .collect();
    let top_persona = if !intent_dist.top_persona.is_empty() {
        intent_dist.top_persona.clone()
    } else if !surfaced.diagnostics.top_persona.is_empty() {
        surfaced.diagnostics.top_persona.clone()
    } else {
        "Balanced".to_owned()
    };
    let top_personas = crate::heuristics::top_intent_personas(&intent_dist.personas);

    UiPhase4Outputs {
        corridor: UiCorridor {
            items: corridor_items_ui.clone(),
            auto_include: corridor_auto_include_ui.clone(),
        },
        lunch_zones: lunch_zones_ui.clone(),
        breaks: breaks_ui.clone(),
        intent: UiIntentSurface {
            top_persona,
            ambiguous: intent_dist.ambiguous,
            primary: primary_ui,
            serendipity: serendipity_ui,
            top_personas,
        },
        overlays: UiOverlays {
            lunch_zones: lunch_zones_ui,
            breaks: breaks_ui,
            corridor_suggestions: corridor_items_ui,
            corridor_auto_include: corridor_auto_include_ui,
        },
    }
}

fn corridor_item_to_break_poi_input(
    item: &crate::corridor::CorridorItem,
) -> crate::breaks::BreakPoiInput {
    crate::breaks::BreakPoiInput {
        poi_id: item.poi_id.clone(),
        name: item.poi_name.clone(),
        lat: item.lat,
        lon: item.lon,
        score: item.score,
        detour_min: item.detour_min,
        categories: item.categories.clone(),
        themes: item.themes.clone(),
        scenic_score: None,
        popularity: None,
    }
}

fn corridor_item_to_ui(item: &crate::corridor::CorridorItem) -> crate::types::UiCorridorItem {
    crate::types::UiCorridorItem {
        id: item.poi_id.clone(),
        name: item.poi_name.clone(),
        lat: item.lat,
        lon: item.lon,
        themes: item.themes.clone(),
        score: item.score,
        detour_km: Some(item.detour_km),
        detour_min: Some(item.detour_min),
    }
}

fn lunch_candidate_to_ui(c: &crate::lunch::LunchCandidate) -> crate::types::UiCorridorItem {
    crate::types::UiCorridorItem {
        id: c.poi_id.clone(),
        name: c.name.clone(),
        lat: c.lat,
        lon: c.lon,
        themes: c.themes.clone(),
        score: c.score,
        detour_km: None,
        detour_min: Some(c.detour_min),
    }
}

fn lunch_zone_to_ui(zone: crate::lunch::LunchZone) -> crate::types::UiLunchZone {
    let start_h = parse_iso_hour_of_day(&zone.t_arrive_min).unwrap_or(0.0);
    let end_h = parse_iso_hour_of_day(&zone.t_arrive_max).unwrap_or(0.0);
    let center_h = if start_h.is_finite() && end_h.is_finite() {
        (start_h + end_h) / 2.0
    } else if start_h.is_finite() {
        start_h
    } else if end_h.is_finite() {
        end_h
    } else {
        0.0
    };
    let label = if zone.vibe_tag.is_empty() {
        None
    } else {
        Some(zone.vibe_tag.clone())
    };
    let picks = zone.candidates.iter().map(lunch_candidate_to_ui).collect();
    crate::types::UiLunchZone {
        start_h,
        end_h,
        center_h,
        picks,
        label,
    }
}

fn parse_iso_hour_of_day(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let t_pos = bytes.iter().position(|&b| b == b'T')?;
    if bytes.len() < t_pos + 6 {
        return None;
    }
    let hh = std::str::from_utf8(&bytes[t_pos + 1..t_pos + 3])
        .ok()?
        .parse::<u32>()
        .ok()?;
    if bytes[t_pos + 3] != b':' {
        return None;
    }
    let mm = std::str::from_utf8(&bytes[t_pos + 4..t_pos + 6])
        .ok()?
        .parse::<u32>()
        .ok()?;
    if hh >= 24 || mm >= 60 {
        return None;
    }
    Some(hh as f64 + (mm as f64) / 60.0)
}

fn break_stop_to_ui(stop: &crate::breaks::BreakStop) -> crate::types::UiBreakItem {
    let stop_min = parse_minutes_between(&stop.t_start, &stop.t_end)
        .unwrap_or(0.0)
        .max(0.0)
        .round() as u32;
    let kind = stop.poi_candidate.as_ref().map(|_| "poi".to_owned());
    crate::types::UiBreakItem {
        at_tour_vertex_idx: stop.at_tour_vertex_idx as u32,
        at_km: 0.0,
        at_h: 0.0,
        source: stop.break_type.clone(),
        stop_min,
        rest_min: 0,
        rest_numbers: Vec::new(),
        lat: None,
        lon: None,
        kind,
        reason: Some(stop.reason.clone()),
    }
}

fn parse_minutes_between(start: &str, end: &str) -> Option<f64> {
    let s = parse_iso_hour_of_day(start)?;
    let e = parse_iso_hour_of_day(end)?;
    Some((e - s) * 60.0)
}

fn surface_item_to_ui_corridor(
    item: &crate::intent::SurfaceIntentItem,
    lookup: &std::collections::BTreeMap<String, crate::corridor::CorridorItem>,
) -> crate::types::UiCorridorItem {
    if let Some(src) = lookup.get(&item.poi_id) {
        crate::types::UiCorridorItem {
            id: item.poi_id.clone(),
            name: item.name.clone(),
            lat: src.lat,
            lon: src.lon,
            themes: src.themes.clone(),
            score: item.final_score,
            detour_km: Some(src.detour_km),
            detour_min: Some(src.detour_min),
        }
    } else {
        crate::types::UiCorridorItem {
            id: item.poi_id.clone(),
            name: item.name.clone(),
            lat: 0.0,
            lon: 0.0,
            themes: Vec::new(),
            score: item.final_score,
            detour_km: None,
            detour_min: None,
        }
    }
}

// ---- Test seams (non-WASM only) ----------------------------------------
//
// The `safe_phase!` macro is private to this module. Integration tests in
// `tests/phase4_orchestrator.rs` (a separate crate) cannot invoke it
// directly, so we expose two thin wrappers gated by `#[doc(hidden)]`. They
// are also useful to F4-C2 for stage-failure tests.

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_safe_phase_with_panicking_body<T>(label: &'static str, fallback: T) -> T
where
    T: Clone + std::panic::UnwindSafe + 'static,
{
    crate::phase4_orchestrator::safe_phase!(label, fallback.clone(), {
        panic!("forced");
    })
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_safe_phase_happy<T>(value: T) -> T
where
    T: Clone + std::panic::UnwindSafe + 'static,
{
    crate::phase4_orchestrator::safe_phase!("test", value.clone(), { value.clone() })
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_hooks(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    corridor: Option<crate::corridor::CorridorSuggestions>,
    lunch: Option<crate::lunch::LunchSuggestion>,
    breaks_in: Option<crate::breaks::BreakSuggestions>,
    intent: Option<crate::intent::IntentDistribution>,
    surface: Option<crate::intent::SurfaceIntentResult>,
) -> crate::types::UiPhase4Outputs {
    let mut hooks = Phase4Hooks::default();
    if let Some(v) = corridor {
        hooks.corridor = Some(Box::new(move || v));
    }
    if let Some(v) = lunch {
        hooks.lunch = Some(Box::new(move || v));
    }
    if let Some(v) = breaks_in {
        hooks.breaks = Some(Box::new(move || v));
    }
    if let Some(v) = intent {
        hooks.intent = Some(Box::new(move || v));
    }
    if let Some(v) = surface {
        hooks.intent_surface = Some(Box::new(move || v));
    }
    phase4_outputs_with_hooks(graph, tour, tour_stops, ui, hooks)
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_panicking_stage(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    panic_in: &str,
) -> crate::types::UiPhase4Outputs {
    let mut hooks = Phase4Hooks::default();
    match panic_in {
        "corridor" => hooks.corridor = Some(Box::new(|| panic!("forced"))),
        "lunch" => hooks.lunch = Some(Box::new(|| panic!("forced"))),
        "breaks" => hooks.breaks = Some(Box::new(|| panic!("forced"))),
        "intent" => hooks.intent = Some(Box::new(|| panic!("forced"))),
        "intent-surface" => hooks.intent_surface = Some(Box::new(|| panic!("forced"))),
        _ => {}
    }
    phase4_outputs_with_hooks(graph, tour, tour_stops, ui, hooks)
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_panicking_corridor_and_lunch_hook(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    lunch: crate::lunch::LunchSuggestion,
) -> crate::types::UiPhase4Outputs {
    let mut hooks = Phase4Hooks::default();
    hooks.corridor = Some(Box::new(|| panic!("forced")));
    hooks.lunch = Some(Box::new(move || lunch));
    phase4_outputs_with_hooks(graph, tour, tour_stops, ui, hooks)
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_lunch_zones(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    lunch_result: crate::lunch::LunchSuggestion,
) -> crate::types::UiPhase4Outputs {
    __test_phase4_with_hooks(
        graph,
        tour,
        tour_stops,
        ui,
        None,
        Some(lunch_result),
        None,
        None,
        None,
    )
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_intent_dist(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    dist: crate::intent::IntentDistribution,
) -> crate::types::UiPhase4Outputs {
    __test_phase4_with_hooks(
        graph,
        tour,
        tour_stops,
        ui,
        None,
        None,
        None,
        Some(dist),
        None,
    )
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_surface_result(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    surface: crate::intent::SurfaceIntentResult,
) -> crate::types::UiPhase4Outputs {
    __test_phase4_with_hooks(
        graph,
        tour,
        tour_stops,
        ui,
        None,
        None,
        None,
        None,
        Some(surface),
    )
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __test_phase4_with_corridor_result(
    graph: &crate::graph::LeisureGraph,
    tour: &crate::optimizer::PublicTour,
    tour_stops: &[crate::intent::IntentEntity],
    ui: &crate::ui_options::UiOptions,
    corridor: crate::corridor::CorridorSuggestions,
) -> crate::types::UiPhase4Outputs {
    __test_phase4_with_hooks(
        graph,
        tour,
        tour_stops,
        ui,
        Some(corridor),
        None,
        None,
        None,
        None,
    )
}
