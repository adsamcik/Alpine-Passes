//! Top-level finalize orchestrator wiring (F5).
//!
//! This cell (F5-C1) ships the public/internal types, the JS-shaped
//! infeasibility / wasm-failure builders, and the small helper layer that
//! later cells (F5-C2 `translate_tour`, F5-C3 `finalize_plan`) will build on.
//!
//! See `architecture.md` (F5) and ADR-F5-001..F5-006.

use serde::{Deserialize, Serialize};

use crate::extras::{
    compute_extras_approx, finite_or, round_hours, scenic_stops_approx, ExtrasConfig,
    ExtrasPartsApprox,
};
use crate::graph::LeisureGraph;
use crate::heuristics::is_in_range;
use crate::intent::IntentEntity;
use crate::optimizer::{PlanResult, PlanStatus, PublicStop, PublicTour};
use crate::phase4_orchestrator::phase4_outputs;
use crate::route_geom::{merge_route_facts, route_points};
use crate::tour_dto::{
    derive_modes, display_stops, implicit_passes_from_path, map_leisure_stop, open_route_tour_stops,
    EndNode, PlannerStopInput,
};
use crate::types::{
    UiCorridor, UiDrawMeta, UiExtrasParts, UiIntentSurface, UiOverlays, UiPhase4Outputs,
    UiPlanResult, UiPoint, UiTourStop,
};
use crate::ui_options::{RouteFacts, UiOptions};

// ===========================================================================
// Public wire types — see ADR-F5-001 / F5-003 / F5-005.
// ===========================================================================

/// Wire wrapper that flattens `UiPlanResult` and adds the two JS-only fields
/// (`_routeAlternatives`, `error`) without modifying the frozen F1 DTO.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalizedPlan {
    #[serde(flatten)]
    pub plan: UiPlanResult,
    #[serde(
        default,
        rename = "_routeAlternatives",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub alternatives_internal: Vec<AlternativeData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for FinalizedPlan {
    fn default() -> Self {
        Self {
            plan: default_ui_plan_result(),
            alternatives_internal: Vec::new(),
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeData {
    pub label: String,
    pub result: UiPlanResult,
    pub draw: AlternativeDraw,
    pub tour: serde_json::Value,
    pub tour_stops: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeDraw {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<UiPoint>,
    #[serde(default)]
    pub tour_stops: Vec<UiTourStop>,
    #[serde(default)]
    pub latlngs: Vec<[f64; 2]>,
    #[serde(default)]
    pub meta: AlternativeDrawMeta,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeDrawMeta {
    pub drive_h: f64,
    pub dwell_h: f64,
    #[serde(default)]
    pub extras: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stops_config: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_node: Option<UiPoint>,
    #[serde(default)]
    pub leisure_overlays: UiOverlays,
}

/// Internal handoff carried from F5-C2 `translate_tour` to F5-C3 `finalize_plan`.
/// NOT part of the JS-facing freeze; F5-C3 collapses it into `FinalizedPlan`.
#[derive(Debug, Clone)]
pub struct TranslatedAlternative {
    pub label: String,
    pub result: UiPlanResult,
    pub draw: AlternativeDraw,
    pub tour_value: serde_json::Value,
    pub tour_stops_value: Vec<serde_json::Value>,
}

// ===========================================================================
// Public infeasibility / failure builders
// ===========================================================================

/// Build a JS-shaped infeasible plan envelope (mirrors `infeasibleResult` in
/// `assets/js/leisure/lib/ui-translation.js:589`).
pub fn infeasible_result(
    reason: &str,
    ui_options: &UiOptions,
    advanced: bool,
    plan_result: Option<&PlanResult>,
    total_open: u32,
) -> FinalizedPlan {
    let mut plan = default_ui_plan_result();
    plan.status = "infeasible".to_owned();
    plan.reason = Some(reason.to_owned());
    plan.start = Some(normalize_start(ui_options.start.as_ref(), None, None));
    plan.end_node = infeasible_end_node(ui_options.end_node.as_ref());
    plan.in_range = false;
    plan.advanced = advanced;
    plan.trip_date = ui_options.trip_date.clone();
    plan.total_open = total_open;
    plan.diagnostics = plan_result
        .map(|p| p.diagnostics.clone())
        .unwrap_or(serde_json::Value::Null);
    plan.wasm_unavailable = false;

    FinalizedPlan {
        plan,
        alternatives_internal: Vec::new(),
        error: Some(reason.to_owned()),
    }
}

/// Build a JS-shaped wasm-failure envelope (mirrors `wasm-shim.js:408`).
/// Identical to `infeasible_result("wasm-unavailable", ...)` plus warnings
/// and the `wasm_unavailable=true` flag.
pub fn wasm_failure_result(
    error_message: &str,
    ui_options: &UiOptions,
    advanced: bool,
) -> FinalizedPlan {
    let mut envelope = infeasible_result("wasm-unavailable", ui_options, advanced, None, 0);
    let warning = format!(
        "WebAssembly is required for the leisure planner: {}",
        error_message
    );
    envelope.plan.route_warning = Some(warning.clone());
    envelope.plan.status_warning = Some(warning);
    envelope.plan.wasm_unavailable = true;
    envelope
}

// ===========================================================================
// Helpers (private — exposed under __testing for unit tests)
// ===========================================================================

/// Build a pristine `UiPlanResult` with all numeric fields `0.0`, all vec
/// fields empty, all option fields `None`, and `status = ""`. Used as the
/// base for every finalize-side result builder. UiPlanResult does NOT derive
/// `Default` (frozen F1 DTO), so we synthesize the zero value here.
pub(crate) fn default_ui_plan_result() -> UiPlanResult {
    UiPlanResult {
        status: String::new(),
        reason: None,
        start: None,
        end_node: None,
        tour_stops: Vec::new(),
        modes: Vec::new(),
        implicit_passes: Vec::new(),
        scenic_stops: Vec::new(),
        km: 0.0,
        drive_h: 0.0,
        dwell_h: 0.0,
        extras_h: 0.0,
        extras_parts: UiExtrasParts::default(),
        total_h: 0.0,
        in_range: false,
        advanced: false,
        route_warning: None,
        status_warning: None,
        trip_date: None,
        total_open: 0,
        diagnostics: serde_json::Value::Null,
        wasm_unavailable: false,
        intent: UiIntentSurface::default(),
        corridor: UiCorridor::default(),
        lunch_zones: Vec::new(),
        breaks: Vec::new(),
        route_alternatives: Vec::new(),
        route_alternative_index: 0,
        latlngs: Vec::new(),
        draw_meta: UiDrawMeta::default(),
    }
}

/// Adapt a `PublicStop` (optimizer surface) to a `PlannerStopInput` (F2's
/// permissive bag-of-optionals) so F2 mappers can consume it. See
/// ADR-F5-002. The `_graph` parameter is accepted for forward-compat with
/// future enrichment (e.g. backfilling categories from a node lookup).
pub(crate) fn planner_stop_from_public(stop: &PublicStop, _graph: &LeisureGraph) -> PlannerStopInput {
    PlannerStopInput {
        kind: Some(stop.kind.clone()),
        id: Some(stop.id.clone()),
        node_id: Some(stop.node_id.to_string()),
        pass_id: stop.pass_id.clone(),
        name: Some(stop.name.clone()),
        lat: Some(stop.lat),
        lon: Some(stop.lon),
        themes: stop.themes.clone(),
        categories: Vec::new(),
        visit_dwell_sec: None,
        return_to_start: stop.return_to_start,
    }
}

/// Resolve the UI `start` field. Mirrors JS `normalizeStart`
/// (`ui-translation.js:809`).
///
/// Divergence from JS (documented): the JS shape carries
/// `{id, name, displayName, lat, lon}`; Rust returns a single
/// `UiPoint::Coord{lat, lon, name}` with the displayName folded into `name`.
/// The frozen F1 `UiPoint` enum is the contract.
pub(crate) fn normalize_start(
    start: Option<&UiPoint>,
    graph: Option<&LeisureGraph>,
    tour: Option<&PublicTour>,
) -> UiPoint {
    let tour_first_node = tour
        .and_then(|t| t.stops.first())
        .map(|s| s.node_id.clone());
    let tour_first_coord = tour.and_then(|t| t.stops.first()).map(|s| (s.lat, s.lon));

    match start {
        Some(UiPoint::Id(s)) => {
            let node = graph
                .and_then(|g| g.nodes.get(&crate::types::NodeId::from(s.as_str())))
                .or_else(|| {
                    let nid = tour_first_node.as_ref()?;
                    graph?.nodes.get(nid)
                });
            if let Some(node) = node {
                UiPoint::Coord {
                    lat: node.lat,
                    lon: node.lon,
                    name: Some(node.name.clone()),
                }
            } else {
                UiPoint::Coord {
                    lat: f64::NAN,
                    lon: f64::NAN,
                    name: Some(s.clone()),
                }
            }
        }
        Some(UiPoint::Coord { lat, lon, name }) => {
            let resolved_name = name
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Start".to_owned());
            let (resolved_lat, resolved_lon) = if lat.is_finite() && lon.is_finite() {
                (*lat, *lon)
            } else if let Some((tlat, tlon)) = tour_first_coord {
                (tlat, tlon)
            } else {
                (*lat, *lon)
            };
            UiPoint::Coord {
                lat: resolved_lat,
                lon: resolved_lon,
                name: Some(resolved_name),
            }
        }
        None => {
            if let Some((tlat, tlon)) = tour_first_coord {
                UiPoint::Coord {
                    lat: tlat,
                    lon: tlon,
                    name: Some("Start".to_owned()),
                }
            } else {
                UiPoint::Coord {
                    lat: f64::NAN,
                    lon: f64::NAN,
                    name: Some("Start".to_owned()),
                }
            }
        }
    }
}

/// Resolve the UI `endNode` field for a translated tour. Mirrors JS
/// `resultEndNode` (`ui-translation.js:837`).
pub(crate) fn result_end_node(tour: &PublicTour, start: &UiPoint) -> Option<UiPoint> {
    if is_closed_tour(tour) {
        match start {
            UiPoint::Id(_) => Some(start.clone()),
            UiPoint::Coord { .. } => Some(start.clone()),
        }
    } else if tour.end_node.is_empty() {
        None
    } else {
        Some(UiPoint::Id(tour.end_node.to_string()))
    }
}

/// Whether a tour ends at its start. Triple-OR matching JS `isClosedTour`
/// (`ui-translation.js:844`); also mirrors the private predicate in
/// `route_geom.rs:120` (parallel implementation — that one is module-private,
/// so reuse without modifying F3 is impossible).
pub(crate) fn is_closed_tour(tour: &PublicTour) -> bool {
    tour.end_node.is_empty()
        || tour.stops.first().map(|s| &s.node_id) == Some(&tour.end_node)
        || tour.stops.iter().any(|s| s.return_to_start)
}

/// Pass-through guard for an infeasible-result `endNode`. Mirrors JS
/// `infeasibleEndNode` (`ui-translation.js:621`): keep string ids;
/// keep coords with finite lat/lon; otherwise drop.
pub(crate) fn infeasible_end_node(end_node: Option<&UiPoint>) -> Option<UiPoint> {
    match end_node? {
        UiPoint::Id(s) => Some(UiPoint::Id(s.clone())),
        UiPoint::Coord { lat, lon, name } if lat.is_finite() && lon.is_finite() => {
            Some(UiPoint::Coord {
                lat: *lat,
                lon: *lon,
                name: name.clone(),
            })
        }
        _ => None,
    }
}

/// Project the F2 internal `ExtrasPartsApprox` onto the frozen wire DTO
/// `UiExtrasParts`. `corridor_h` has no analog in the approx output (it is
/// derived from corridor enrichment in Phase 4), so we emit `0.0` here and
/// F5-C3 may overwrite if a corridor extras estimate becomes available.
pub(crate) fn project_extras_parts(parts: &ExtrasPartsApprox) -> UiExtrasParts {
    UiExtrasParts {
        corridor_h: 0.0,
        lunch_h: parts.lunch_h,
        breaks_h: parts.rest_h,
    }
}

// ===========================================================================
// F5-C2 — translate_tour (mirrors JS `translateTour`,
// `assets/js/leisure/lib/ui-translation.js:105`).
// ===========================================================================

/// Caller-supplied context for `translate_tour`. Mirrors the JS `ctx` bag
/// destructured at `ui-translation.js:106`. Lives behind a borrow so a single
/// `UiOptions` / graph can drive every alternative in a plan.
pub struct TranslateTourCtx<'a> {
    pub graph: &'a LeisureGraph,
    pub ui_options: &'a UiOptions,
    pub advanced: bool,
    pub status: PlanStatus,
    pub total_open: u32,
    pub reason: &'a str,
    pub include_phase4: bool,
    pub route_facts: Option<&'a RouteFacts>,
}

/// Translate one optimizer `PublicTour` into a `TranslatedAlternative`
/// (UiPlanResult + draw payload + JS-shaped tour/tourStops carriers for
/// F6's lazy phase4 enrichment). Mirrors JS `translateTour`.
///
/// Deliberate divergences from JS (carried over from F1-F4 freezes):
/// * `extras_h` is computed with `ExtrasConfig::default()` because the
///   frozen Rust `StopsConfig` does not yet carry the per-trip extras
///   knobs (`passStopMin`, `lunchBreak`, `restInterval`, `restDuration`,
///   `restBreakOn`). Wiring those is out of scope for F5; downstream UI
///   currently overrides extras client-side.
/// * `dwell_h` sums `PlannerStopInput::visit_dwell_sec`, but C1's
///   `planner_stop_from_public` always emits `None` (the optimizer surface
///   `PublicStop` has no dwell field), so the result is always `0.0` for
///   tours produced by the Rust optimizer. The formula and field still
///   match the JS contract for callers that hand-craft stops.
/// * `result.implicit_passes` is the frozen `Vec<String>` of pass-ids,
///   not the full `UiPassStop` shape JS emits (F1 contract).
/// * `result.route_alternatives` is left empty here; F5-C3 fills the
///   summary list across all translated alternatives.
pub fn translate_tour(
    tour: &PublicTour,
    index: u32,
    ctx: &TranslateTourCtx<'_>,
) -> TranslatedAlternative {
    let start = normalize_start(ctx.ui_options.start.as_ref(), Some(ctx.graph), Some(tour));
    let end_node = result_end_node(tour, &start);

    let planner_stops_full: Vec<PlannerStopInput> = tour
        .stops
        .iter()
        .map(|s| planner_stop_from_public(s, ctx.graph))
        .collect();
    let visible_stops: Vec<PlannerStopInput> = display_stops(&planner_stops_full)
        .into_iter()
        .cloned()
        .collect();
    let planner_stops_ui: Vec<UiTourStop> = visible_stops
        .iter()
        .filter_map(|s| map_leisure_stop(s, ctx.graph))
        .collect();

    let closed = is_closed_tour(tour);
    let end_node_ref = end_node.as_ref().map(|p| match p {
        UiPoint::Id(s) => EndNode::Id(s.as_str()),
        UiPoint::Coord { .. } => EndNode::Point(p),
    });
    let tour_stops = open_route_tour_stops(
        planner_stops_ui.clone(),
        &start,
        end_node_ref,
        closed,
        ctx.graph,
    );

    let path = tour.path.clone();
    let modes = derive_modes(&path, &tour_stops, ctx.graph);
    let planner_modes = derive_modes(&path, &planner_stops_ui, ctx.graph);

    let route_pts = route_points(ctx.graph, tour, &start);
    let route = merge_route_facts(&route_pts, ctx.route_facts, tour);
    let latlngs: Vec<[f64; 2]> = route.geom.iter().map(|[lon, lat]| [*lat, *lon]).collect();

    let km = finite_or(route.distance_km, tour.total_distance_km);
    let drive_h = finite_or(route.duration_h, tour.total_duration_h);
    let dwell_sec_total: f64 = visible_stops
        .iter()
        .map(|s| s.visit_dwell_sec.unwrap_or(0) as f64)
        .sum();
    let dwell_h = round_hours(dwell_sec_total / 3600.0);

    // ADR-F2-003: ExtrasConfig is F2-local; the frozen StopsConfig does not
    // carry extras knobs, so we use the (Auto/no-rest) default.
    let extras_cfg = ExtrasConfig::default();
    let extras_output = compute_extras_approx(
        &planner_stops_ui,
        drive_h,
        &extras_cfg,
        ctx.ui_options.target_mode,
        ctx.ui_options.target_value,
    );
    let total_h = round_hours(drive_h + dwell_h + extras_output.extras_h);

    let intent_entities: Vec<IntentEntity> = visible_stops
        .iter()
        .map(planner_stop_to_intent_entity)
        .collect();
    let phase4 = if ctx.include_phase4 {
        phase4_outputs(ctx.graph, tour, &intent_entities, ctx.ui_options)
    } else {
        empty_phase4_outputs()
    };

    let status_str = plan_status_str(ctx.status);
    let route_warning = match route.route_warning {
        Some(w) => Some(w.to_owned()),
        None if status_str == "degraded" => {
            Some("Leisure optimizer returned a degraded tour.".to_owned())
        }
        None => None,
    };

    let in_range = if ctx.advanced {
        true
    } else {
        let fit_within = Some(tour.budget_fit.within);
        let fit_mode_seconds = tour.budget_fit.mode == "seconds";
        is_in_range(km, total_h, fit_within, fit_mode_seconds, ctx.ui_options)
    };

    let implicit_pass_ids: Vec<String> =
        implicit_passes_from_path(&path, &planner_stops_ui, ctx.graph)
            .into_iter()
            .map(|p| p.id)
            .collect();
    let scenic_stops = scenic_stops_approx(&planner_stops_ui, &planner_modes, &extras_output.parts);

    let result = UiPlanResult {
        status: status_str.clone(),
        reason: if ctx.reason.is_empty() {
            None
        } else {
            Some(ctx.reason.to_owned())
        },
        start: Some(start.clone()),
        end_node: end_node.clone(),
        tour_stops: tour_stops.clone(),
        modes,
        implicit_passes: implicit_pass_ids,
        scenic_stops,
        km,
        drive_h,
        dwell_h,
        extras_h: extras_output.extras_h,
        extras_parts: project_extras_parts(&extras_output.parts),
        total_h,
        in_range,
        advanced: ctx.advanced,
        route_warning,
        status_warning: None,
        trip_date: ctx.ui_options.trip_date.clone(),
        total_open: ctx.total_open,
        diagnostics: serde_json::Value::Null,
        wasm_unavailable: false,
        intent: phase4.intent.clone(),
        corridor: phase4.corridor.clone(),
        lunch_zones: phase4.lunch_zones.clone(),
        breaks: phase4.breaks.clone(),
        route_alternatives: Vec::new(),
        route_alternative_index: index,
        latlngs: latlngs.clone(),
        draw_meta: UiDrawMeta {
            leisure_overlays: phase4.overlays.clone(),
        },
    };

    let extras_json = serde_json::to_value(serde_extras_view(&extras_output))
        .unwrap_or(serde_json::Value::Null);
    let stops_config_json = ctx
        .ui_options
        .stops
        .as_ref()
        .and_then(|s| serde_json::to_value(s).ok());
    let draw = AlternativeDraw {
        start: Some(start.clone()),
        tour_stops: tour_stops.clone(),
        latlngs,
        meta: AlternativeDrawMeta {
            drive_h,
            dwell_h,
            extras: extras_json,
            stops_config: stops_config_json,
            start: Some(start.clone()),
            end_node: end_node.clone(),
            leisure_overlays: phase4.overlays.clone(),
        },
    };

    let tour_value = serde_json::to_value(tour).unwrap_or(serde_json::Value::Null);
    let tour_stops_value: Vec<serde_json::Value> = intent_entities
        .iter()
        .map(|e| serde_json::to_value(e).unwrap_or(serde_json::Value::Null))
        .collect();

    let label = if index == 0 {
        "Leisure best".to_owned()
    } else {
        format!("Leisure alternative {}", index + 1)
    };

    TranslatedAlternative {
        label,
        result,
        draw,
        tour_value,
        tour_stops_value,
    }
}

/// Empty `UiPhase4Outputs` for the `include_phase4=false` branch
/// (mirrors JS `emptyPhase4Outputs`).
pub(crate) fn empty_phase4_outputs() -> UiPhase4Outputs {
    UiPhase4Outputs {
        corridor: UiCorridor::default(),
        lunch_zones: Vec::new(),
        breaks: Vec::new(),
        intent: UiIntentSurface::default(),
        overlays: UiOverlays::default(),
    }
}

/// Convert a `PlannerStopInput` (the F2 optimizer-stop projection) into the
/// `IntentEntity` shape that F4's `phase4_outputs` consumes. JS feeds the
/// raw optimizer stop directly; the equivalent Rust path is to keep the
/// id / poi-id / kind / themes / categories and leave score & viewpoints
/// empty (no equivalent fields on PublicStop).
pub(crate) fn planner_stop_to_intent_entity(stop: &PlannerStopInput) -> IntentEntity {
    IntentEntity {
        id: stop.id.clone(),
        poi_id: stop.id.clone(),
        kind: stop.kind.clone(),
        name: stop.name.clone(),
        score: None,
        themes: stop.themes.clone(),
        categories: stop.categories.clone(),
        viewpoints: Vec::new(),
    }
}

/// Map a `PlanStatus` to the lowercase string the wire DTO uses.
pub(crate) fn plan_status_str(status: PlanStatus) -> String {
    match status {
        PlanStatus::Ok => "ok",
        PlanStatus::Degraded => "degraded",
        PlanStatus::Infeasible => "infeasible",
    }
    .to_owned()
}

/// Serializable projection of `ExtrasOutput` for the `_drawMeta.extras` slot.
/// `ExtrasOutput`/`ExtrasPartsApprox` are not `Serialize`, so we shape an
/// inline serializable view to stay JS-compatible.
fn serde_extras_view(out: &crate::extras::ExtrasOutput) -> serde_json::Value {
    serde_json::json!({
        "extrasH": out.extras_h,
        "parts": {
            "passStopH": out.parts.pass_stop_h,
            "lunchH": out.parts.lunch_h,
            "restH": out.parts.rest_h,
            "lunchAuto": out.parts.lunch_auto,
            "restCount": out.parts.rest_count,
            "passN": out.parts.pass_n,
            "passStopMins": out.parts.pass_stop_mins,
            "passStopUniform": out.parts.pass_stop_uniform,
        }
    })
}

// ===========================================================================
// F5-C3 — finalize_plan orchestrator (mirrors JS `translatePlannerResult`,
// `assets/js/leisure/lib/ui-translation.js:50`).
// ===========================================================================

/// Read the `diagnostics.reason` field from a `PlanResult` if present, falling
/// back to `"infeasible"` when missing. Mirrors JS access of
/// `planResult?.diagnostics?.reason ?? "infeasible"`.
pub(crate) fn diagnostics_reason(plan_result: &PlanResult) -> String {
    plan_result
        .diagnostics
        .get("reason")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| "infeasible".to_owned())
}

/// Top-level orchestrator that converts a planner `PlanResult` into the
/// JS-shaped `FinalizedPlan` envelope consumed by `app.js`.
///
/// Mirrors JS `translatePlannerResult` (`assets/js/leisure/lib/ui-translation.js:50`):
/// short-circuits infeasible plans, runs `translate_tour` over `[primary, ...alternatives]`
/// (with `include_phase4 = (i == 0)`), assembles the per-alternative summary list,
/// cross-references it back onto every alternative's result, and composes the
/// top-level result from `alternatives[0]` plus the optimizer-level diagnostics.
///
/// `route_facts.len()` may be 0 (no OSRM facts), 1 (primary only), or `tours.len()`
/// (one per alt). Out-of-bounds reads default to `None` (approximate route).
///
/// `advanced` is taken as an explicit parameter because `UiOptions` does not
/// carry an "advanced" flag — see ADR-F5-008.
pub fn finalize_plan(
    plan_result: &PlanResult,
    route_facts: &[Option<RouteFacts>],
    ui_options: &UiOptions,
    graph: &LeisureGraph,
    advanced: bool,
) -> FinalizedPlan {
    let total_open = crate::heuristics::projected_open_pass_count(graph, ui_options);

    if plan_result.status == PlanStatus::Infeasible || plan_result.primary.is_none() {
        let reason = diagnostics_reason(plan_result);
        return infeasible_result(&reason, ui_options, advanced, Some(plan_result), total_open);
    }

    let primary = plan_result
        .primary
        .as_ref()
        .expect("primary checked above");
    let tours: Vec<&PublicTour> = std::iter::once(primary)
        .chain(plan_result.alternatives.iter())
        .collect();

    let mut translated: Vec<TranslatedAlternative> = Vec::with_capacity(tours.len());
    for (i, tour) in tours.iter().enumerate() {
        let ctx = TranslateTourCtx {
            graph,
            ui_options,
            advanced,
            status: plan_result.status,
            total_open,
            reason: "",
            include_phase4: i == 0,
            route_facts: route_facts.get(i).and_then(|opt| opt.as_ref()),
        };
        translated.push(translate_tour(tour, i as u32, &ctx));
    }

    let summaries: Vec<crate::types::UiRouteAlternativeSummary> = translated
        .iter()
        .enumerate()
        .map(|(i, alt)| crate::types::UiRouteAlternativeSummary {
            index: i as u32,
            km: alt.result.km,
            total_h: alt.result.total_h,
            label: alt.label.clone(),
            in_range: alt.result.in_range,
        })
        .collect();

    for (i, alt) in translated.iter_mut().enumerate() {
        alt.result.route_alternatives = summaries.clone();
        alt.result.route_alternative_index = i as u32;
    }

    let primary_alt = translated.first().expect("at least primary present");
    let mut top = primary_alt.result.clone();
    top.route_alternatives = summaries.clone();
    top.latlngs = primary_alt.draw.latlngs.clone();
    top.draw_meta = UiDrawMeta {
        leisure_overlays: primary_alt.draw.meta.leisure_overlays.clone(),
    };
    top.diagnostics = plan_result.diagnostics.clone();

    let alternatives_internal: Vec<AlternativeData> = translated
        .into_iter()
        .map(|alt| AlternativeData {
            label: alt.label,
            result: alt.result,
            draw: alt.draw,
            tour: alt.tour_value,
            tour_stops: alt.tour_stops_value,
        })
        .collect();

    FinalizedPlan {
        plan: top,
        alternatives_internal,
        error: None,
    }
}

// ===========================================================================
// Test-only re-exports
// ===========================================================================

#[doc(hidden)]
pub mod __testing {
    //! Test-only wrappers for private helpers. Not part of the stable API.
    use super::*;

    pub fn default_ui_plan_result() -> UiPlanResult {
        super::default_ui_plan_result()
    }
    pub fn planner_stop_from_public(stop: &PublicStop, graph: &LeisureGraph) -> PlannerStopInput {
        super::planner_stop_from_public(stop, graph)
    }
    pub fn normalize_start(
        start: Option<&UiPoint>,
        graph: Option<&LeisureGraph>,
        tour: Option<&PublicTour>,
    ) -> UiPoint {
        super::normalize_start(start, graph, tour)
    }
    pub fn result_end_node(tour: &PublicTour, start: &UiPoint) -> Option<UiPoint> {
        super::result_end_node(tour, start)
    }
    pub fn is_closed_tour(tour: &PublicTour) -> bool {
        super::is_closed_tour(tour)
    }
    pub fn infeasible_end_node(end_node: Option<&UiPoint>) -> Option<UiPoint> {
        super::infeasible_end_node(end_node)
    }
    pub fn project_extras_parts(parts: &ExtrasPartsApprox) -> UiExtrasParts {
        super::project_extras_parts(parts)
    }
    pub fn diagnostics_reason(plan_result: &PlanResult) -> String {
        super::diagnostics_reason(plan_result)
    }
}
