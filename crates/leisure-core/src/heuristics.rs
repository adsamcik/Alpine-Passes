// F1 — UI heuristics ported from `assets/js/leisure/lib/ui-translation.js`.
//
// Pure helpers; no I/O, no globals. Each function mirrors a JS counterpart
// (line ranges noted per item) so that the JS shim can be deleted once the
// Rust planner is wired to the WASM API. See `architecture.md` (F1) and
// ADR-F1-001..ADR-F1-008.

use crate::graph::LeisureGraph;
use crate::lunch::LunchPolicy;
use crate::types::{NodeId, NodeKind};
use crate::ui_options::{OptimizerOptions, TargetMode, UiOptions};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LunchPersona {
    Family,
    Foodie,
    Normal,
}

impl LunchPersona {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Family => "family",
            Self::Foodie => "foodie",
            Self::Normal => "normal",
        }
    }
}

/// Mirrors `optimizerOptions` (ui-translation.js:19-45).
pub fn optimizer_options(ui: &UiOptions) -> OptimizerOptions {
    let default_k = OptimizerOptions::default().k_alternatives;
    let default_tbms = OptimizerOptions::default().time_budget_ms;

    let mut opts = OptimizerOptions {
        start: ui.start.clone(),
        end_node: ui.end_node.clone(),
        end_snap_max_distance_m: ui.end_snap_max_distance_m,
        themes: ui.themes.clone(),
        personas: ui.personas.clone(),
        forbidden_pass_ids: ui.forbidden_pass_ids.clone(),
        seasonal_cutoff: if ui.open_only {
            ui.trip_date.clone()
        } else {
            None
        },
        k_alternatives: ui.k_alternatives.unwrap_or(default_k),
        time_budget_ms: ui.time_budget_ms.unwrap_or(default_tbms),
        seed: ui.seed,
        budget_seconds: None,
        budget_km: None,
    };

    let has_budget_seconds = ui.budget_seconds.is_some();
    let has_budget_km = ui.budget_km.is_some();

    if has_budget_seconds || has_budget_km {
        opts.budget_seconds = ui.budget_seconds;
        opts.budget_km = ui.budget_km;
    } else {
        match ui.target_mode {
            TargetMode::Time => {
                let v = positive_or(ui.target_value, 6.0);
                opts.budget_seconds = Some(v * 3600.0);
            }
            TargetMode::Distance => {
                let v = positive_or(ui.target_value, 200.0);
                opts.budget_km = Some(v);
            }
        }
    }

    opts
}

/// Mirrors `isSeasonallyClosedPass` (ui-translation.js:254-262).
pub fn is_seasonally_closed_pass(
    graph: &LeisureGraph,
    pass_id: &NodeId,
    trip_date: Option<&str>,
) -> bool {
    let Some(month) = parse_iso_month(trip_date) else {
        return false;
    };
    if !matches!(month, 11 | 12 | 1 | 2 | 3 | 4) {
        return false;
    }

    let elev = pass_elevation(graph, pass_id);
    matches!(elev, Some(e) if e > 1700.0)
}

/// Mirrors `projectedOpenPassCount` (ui-translation.js:239-249).
pub fn projected_open_pass_count(graph: &LeisureGraph, ui: &UiOptions) -> u32 {
    let forbidden = resolve_pass_id_set(graph, &ui.forbidden_pass_ids);
    let trip_date = ui.trip_date.as_deref();

    let mut count: u32 = 0;
    for id in graph.nodes_of_kind(NodeKind::Pass) {
        if id.is_empty() || forbidden.contains(id) {
            continue;
        }
        if ui.open_only && is_seasonally_closed_pass(graph, id, trip_date) {
            continue;
        }
        count += 1;
    }
    count
}

/// Mirrors `isInRange` (ui-translation.js:551-559).
pub fn is_in_range(
    km: f64,
    total_h: f64,
    fit_within: Option<bool>,
    fit_mode_seconds: bool,
    ui: &UiOptions,
) -> bool {
    let target = positive_or(ui.target_value, f64::NAN);
    let raw_tol = ui.target_tol.unwrap_or(0.2);
    let tol = if raw_tol.is_finite() && raw_tol > 0.0 {
        raw_tol.max(0.05)
    } else {
        0.2_f64.max(0.05)
    };

    if !target.is_finite() {
        return fit_within.unwrap_or(false);
    }

    // JS infers `mode` from `tour.budgetFit.mode` only when `uiOptions.targetMode`
    // is undefined. Rust's `TargetMode` enum always has a value (default
    // Distance), so we honour `ui.target_mode` directly. `fit_mode_seconds`
    // remains in the frozen signature for callers that may need it once we
    // expose an Option<TargetMode> variant.
    let _ = fit_mode_seconds;
    let mode = ui.target_mode;

    match mode {
        TargetMode::Time => (total_h - target).abs() <= target * tol,
        TargetMode::Distance => (km - target).abs() <= target * tol,
    }
}

/// Mirrors `lunchPersonaFor` (ui-translation.js:738-743).
pub fn lunch_persona_for(personas: &[String]) -> LunchPersona {
    let lower: Vec<String> = personas.iter().map(|p| p.to_lowercase()).collect();
    if lower.iter().any(|p| p == "family") {
        return LunchPersona::Family;
    }
    if lower
        .iter()
        .any(|p| matches!(p.as_str(), "food" | "foodie" | "gourmet" | "wine"))
    {
        return LunchPersona::Foodie;
    }
    LunchPersona::Normal
}

/// Mirrors `breakPersonaFor` (ui-translation.js:748-754).
pub fn break_persona_for(personas: &[String]) -> String {
    let lower: Vec<String> = personas.iter().map(|p| p.to_lowercase()).collect();
    if lower.iter().any(|p| p == "family") {
        return "family".to_owned();
    }
    if lower
        .iter()
        .any(|p| matches!(p.as_str(), "photo" | "photographer"))
    {
        return "photographer".to_owned();
    }
    if lower
        .iter()
        .any(|p| matches!(p.as_str(), "food" | "foodie" | "gourmet" | "wine"))
    {
        return "gourmet".to_owned();
    }
    lower.into_iter().next().unwrap_or_else(|| "default".to_owned())
}

/// Mirrors `lunchPolicyFor` (ui-translation.js:719-722). Returns the typed
/// `LunchPolicy` enum (see ADR-F1-001 / ADR-F1-008): unlike JS, numeric
/// strings (e.g. "45") parse to `WindowMinutes(45.0)`; unparseable values
/// fall back to `Auto`.
pub fn lunch_policy_for(value: Option<&str>) -> LunchPolicy {
    let Some(raw) = value else {
        return LunchPolicy::Auto;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return LunchPolicy::Auto;
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "auto" => LunchPolicy::Auto,
        "0" | "none" | "skip" => LunchPolicy::Skip,
        _ => match trimmed.parse::<f64>() {
            Ok(n) if n.is_finite() && n > 0.0 => LunchPolicy::WindowMinutes(n),
            _ => LunchPolicy::Auto,
        },
    }
}

/// Mirrors `topIntentPersonas` (ui-translation.js:759-765).
pub fn top_intent_personas(intent: &BTreeMap<String, f64>) -> Vec<String> {
    let mut entries: Vec<(&String, f64)> = intent
        .iter()
        .filter(|(k, v)| k.as_str() != "entropy" && v.is_finite())
        .map(|(k, v)| (k, *v))
        .collect();

    entries.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(b.0))
    });

    entries
        .into_iter()
        .take(3)
        .map(|(k, _)| k.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn positive_or(value: Option<f64>, default: f64) -> f64 {
    match value {
        Some(v) if v.is_finite() && v > 0.0 => v,
        _ => default,
    }
}

/// Resolve a UI trip-date string (either `YYYY-MM-DD` or an RFC3339 timestamp
/// like `2026-12-04T10:00:00.000Z`) to its UTC month (1..=12). Returns `None`
/// for unparseable input. Mirrors `parseTripDate` + `getUTCMonth() + 1`.
fn parse_iso_month(value: Option<&str>) -> Option<u32> {
    let raw = value?.trim();
    if raw.len() < 10 {
        return None;
    }
    let bytes = raw.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let month_str = std::str::from_utf8(&bytes[5..7]).ok()?;
    let month: u32 = month_str.parse().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    let year_str = std::str::from_utf8(&bytes[0..4]).ok()?;
    year_str.parse::<u32>().ok()?;
    let day_str = std::str::from_utf8(&bytes[8..10]).ok()?;
    let day: u32 = day_str.parse().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    Some(month)
}

fn pass_elevation(graph: &LeisureGraph, pass_id: &NodeId) -> Option<f64> {
    if let Some(node) = graph.node(pass_id) {
        if let Some(e) = node.elev {
            if e.is_finite() {
                return Some(e);
            }
        }
    }
    let sides = graph.pass_sides_for(pass_id.as_str())?;
    let summit_id = sides.summit?;
    let summit = graph.node(&summit_id)?;
    summit.elev.filter(|v| v.is_finite())
}

/// Build the canonical pass-id set referenced by `forbidden_pass_ids`.
/// Mirrors `resolvePassIdSet` + `resolvePassId` + `passIdForms` in the JS
/// shim (lines 670-700) so that side/summit/`p-` synonyms collapse to the
/// same canonical pass node id used by `nodes_of_kind(NodeKind::Pass)`.
fn resolve_pass_id_set(graph: &LeisureGraph, ids: &[String]) -> HashSet<NodeId> {
    let mut out = HashSet::new();
    for id in ids {
        if let Some(canonical) = resolve_pass_id(graph, id) {
            out.insert(canonical);
        }
    }
    out
}

fn resolve_pass_id(graph: &LeisureGraph, id: &str) -> Option<NodeId> {
    if id.is_empty() {
        return None;
    }
    for form in pass_id_forms(id) {
        let key = NodeId::from(form.as_str());
        if let Some(canonical) = graph.pass_id_by_node_id.get(&key) {
            return Some(canonical.clone());
        }
        if graph.pass_triplets.contains_key(&key) {
            return Some(key);
        }
        if let Some(node) = graph.nodes.get(&key) {
            if matches!(node.kind, NodeKind::Pass) {
                return Some(key);
            }
        }
    }
    None
}

fn pass_id_forms(value: &str) -> Vec<String> {
    let mut forms: Vec<String> = Vec::new();
    fn push_unique(forms: &mut Vec<String>, form: String) {
        if !form.is_empty() && !forms.contains(&form) {
            forms.push(form);
        }
    }
    push_unique(&mut forms, value.to_owned());
    if let Some((stripped, suffix)) = value.rsplit_once(':') {
        if matches!(suffix, "A" | "S" | "B") {
            push_unique(&mut forms, stripped.to_owned());
        }
    }
    let snapshot = forms.clone();
    for form in snapshot {
        if let Some(rest) = form.strip_prefix("p-") {
            push_unique(&mut forms, rest.to_owned());
        } else {
            push_unique(&mut forms, format!("p-{form}"));
        }
    }
    forms
}
