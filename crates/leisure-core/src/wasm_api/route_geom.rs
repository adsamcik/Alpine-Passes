//! F6-C1 — OSRM coord extraction wasm export (resolves BL-F6-001 per
//! ADR-F6-001).
//!
//! Exposes `crate::route_geom::build_route_request` to JS so the slim
//! shim can request OSRM facts per alternative without re-implementing
//! the path-walk logic in JavaScript. The JS-facing contract returns one
//! `RouteRequest` per tour in `[primary, ...alternatives]` order.
//!
//! The pure-Rust helper `build_route_requests` carries the orchestration
//! logic so it can be exercised by native unit tests; the
//! `wasm_build_route_requests` export is a thin JsValue parsing wrapper.

use crate::optimizer::{PlanResult, PlanStatus};
use crate::ui_options::{RouteRequest, UiOptions};
use wasm_bindgen::prelude::*;

use super::{parse_js, parse_js_or_default, wasm_boundary, with_graph};

/// Build one `RouteRequest` per tour in `[primary, ...alternatives]`,
/// in order. Returns an empty `Vec` when the plan is `Infeasible` or has
/// no `primary` tour.
///
/// `start` is resolved via `crate::finalize::normalize_start` so behavior
/// matches the rest of the F5 finalize pipeline (UiOptions.start preferred;
/// otherwise the primary tour's first stop coords; otherwise NaN coords).
pub fn build_route_requests(
    graph: &crate::LeisureGraph,
    plan_result: &PlanResult,
    ui_options: &UiOptions,
) -> Vec<RouteRequest> {
    if plan_result.status == PlanStatus::Infeasible {
        return Vec::new();
    }
    let Some(primary) = plan_result.primary.as_ref() else {
        return Vec::new();
    };

    let start = crate::finalize::normalize_start(ui_options.start.as_ref(), Some(graph), Some(primary));

    let tours = std::iter::once(primary).chain(plan_result.alternatives.iter());
    tours
        .map(|tour| crate::route_geom::build_route_request(graph, tour, &start))
        .collect()
}

#[wasm_bindgen]
pub fn wasm_build_route_requests(
    graph_handle: u32,
    plan_result_value: JsValue,
    ui_options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        // `plan_result` is mandatory by contract — `null`/`undefined` from JS
        // surfaces as a `parse_js` error, intentionally; `ui_options` is
        // optional and defaults via `parse_js_or_default`.
        let plan_result: PlanResult = parse_js(plan_result_value, "plan result")?;
        let ui_options: UiOptions = parse_js_or_default(ui_options_value, "ui options")?;
        with_graph(graph_handle, |graph| {
            Ok(build_route_requests(graph, &plan_result, &ui_options))
        })
    })
}
