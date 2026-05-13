//! F4 — Phase 4 orchestration WASM export.
//!
//! Replaces the JS shim's `phase4Outputs` orchestrator
//! (`assets/js/leisure/wasm-shim.js:333-405`). One WASM call replaces five.
//!
//! `wasm_phase4_outputs` returns `Err` only on hard input failures (invalid
//! handle, unparseable JSON). All per-stage failures are absorbed inside
//! `phase4_orchestrator::phase4_outputs` (which always returns a populated
//! `UiPhase4Outputs`, falling back to default values per stage on failure)
//! and surface as a successful `Ok(serialized UiPhase4Outputs)`.

use crate::intent::IntentEntity;
use crate::optimizer::PublicTour;
use crate::phase4_orchestrator::phase4_outputs;
use crate::ui_options::UiOptions;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn wasm_phase4_outputs(
    graph_handle: u32,
    tour_value: JsValue,
    tour_stops_value: JsValue,
    ui_options_value: JsValue,
) -> Result<JsValue, JsValue> {
    super::wasm_boundary(|| {
        super::with_graph(graph_handle, |graph| {
            let tour: PublicTour = super::parse_js(tour_value, "tour")?;
            let tour_stops: Vec<IntentEntity> =
                super::parse_js_or_default(tour_stops_value, "tour stops")?;
            let ui: UiOptions = super::parse_js_or_default(ui_options_value, "ui options")?;
            Ok(phase4_outputs(graph, &tour, &tour_stops, &ui))
        })
    })
}
