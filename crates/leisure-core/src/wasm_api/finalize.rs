//! F5-C3 — finalize plan WASM exports.
//!
//! `wasm_finalize_plan` collapses the JS-side `translatePlannerResult`
//! orchestrator (`assets/js/leisure/lib/ui-translation.js:50`) into a single
//! WASM call that takes the optimizer's `PlanResult`, optional OSRM route
//! facts (per alternative), and the active `UiOptions`, and returns the
//! JS-shaped `FinalizedPlan` envelope app.js consumes directly.
//!
//! `wasm_infeasible_result` exposes the standalone infeasibility envelope
//! builder for the planner-shim path that needs to surface validation
//! failures without running the full optimizer.
//!
//! Per ADR-F4-008, `wasm_boundary`, `with_graph`, `parse_js`, and
//! `parse_js_or_default` are `pub(super)` and reused here as-is.

use crate::optimizer::PlanResult;
use crate::ui_options::{RouteFacts, UiOptions};
use wasm_bindgen::prelude::*;

use super::{parse_js, parse_js_or_default, wasm_boundary, with_graph};

#[wasm_bindgen]
pub fn wasm_finalize_plan(
    graph_handle: u32,
    plan_result_value: JsValue,
    route_facts_value: JsValue,
    ui_options_value: JsValue,
    advanced: bool,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        let plan_result: PlanResult = parse_js(plan_result_value, "plan result")?;
        let route_facts = parse_route_facts(route_facts_value)?;
        let ui_options: UiOptions = parse_js_or_default(ui_options_value, "ui options")?;
        with_graph(graph_handle, |graph| {
            Ok(crate::finalize::finalize_plan(
                &plan_result,
                &route_facts,
                &ui_options,
                graph,
                advanced,
            ))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_infeasible_result(
    reason: String,
    ui_options_value: JsValue,
    advanced: bool,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        let ui_options: UiOptions = parse_js_or_default(ui_options_value, "ui options")?;
        Ok(crate::finalize::infeasible_result(
            &reason,
            &ui_options,
            advanced,
            None,
            0,
        ))
    })
}

/// Permissive `route_facts` parser. Accepts:
/// * `null` / `undefined` → empty vec (all alternatives use approximate route)
/// * `Vec<Option<RouteFacts>>` (canonical shape, one slot per alternative,
///   `null` allowed)
/// * `Vec<RouteFacts>` (compact shape, every alt has facts)
/// * single `RouteFacts` (primary-only legacy shape)
fn parse_route_facts(value: JsValue) -> Result<Vec<Option<RouteFacts>>, String> {
    if value.is_null() || value.is_undefined() {
        return Ok(Vec::new());
    }
    if let Ok(arr) = serde_wasm_bindgen::from_value::<Vec<Option<RouteFacts>>>(value.clone()) {
        return Ok(arr);
    }
    if let Ok(arr) = serde_wasm_bindgen::from_value::<Vec<RouteFacts>>(value.clone()) {
        return Ok(arr.into_iter().map(Some).collect());
    }
    let single: RouteFacts = serde_wasm_bindgen::from_value(value)
        .map_err(|e| format!("failed to parse route facts: {e}"))?;
    Ok(vec![Some(single)])
}
