// Crate entry point and minimal WASM exports for the leisure graph core.

pub mod astar;
pub mod breaks;
pub mod corridor;
pub mod ears;
pub mod graph;
pub mod intent;
pub mod lunch;
pub mod optimizer;
pub mod types;
pub mod wasm_api;

pub use astar::{leisure_astar, AStarOptions, AStarResult, AStarStatus, CostMode};
pub use breaks::{
    detect_breaks, suggest_breaks, BreakDiagnostics, BreakLoad, BreakOptions, BreakPoiCandidate,
    BreakPoiInput, BreakStop, BreakSuggestions, LoadCurvePoint,
};
pub use corridor::{
    find_corridor_pois, suggest_corridor, CorridorDiagnostics, CorridorItem, CorridorMode,
    CorridorOptions, CorridorSuggestions,
};
pub use ears::{decompose_ears, Ear, EarDecomposition, EarKind};
pub use graph::{haversine_m, EdgeStats, LeisureGraph, LoadError, PassSides, ValidationResult};
pub use intent::{
    infer_intent, surface_intent_pois, tags_from_entity, tags_from_target, update_intent,
    IntentCandidate, IntentDistribution, IntentEntity, IntentHistory, IntentObservation,
    IntentState, IntentTarget, SurfaceIntentDiagnostics, SurfaceIntentItem, SurfaceIntentOptions,
    SurfaceIntentResult, Tag,
};
pub use lunch::{
    find_lunch_area, plan_lunch_zone, HungerPoint, LunchCandidate, LunchDesert, LunchOptions,
    LunchPolicy, LunchSuggestion, LunchZone,
};
pub use optimizer::{
    double_bridge_node_order, improve_node_order_or_opt, improve_node_order_two_opt,
    leisure_plan_auto, leisure_plan_open, leisure_plan_selected, plan_leisure_tour,
    plan_leisure_tour_advanced, route_leisure_cost, side_stop_detour_cost, BudgetFit, Mulberry32,
    PlanOptions, PlanPoint, PlanResult, PlanStatus, PublicStop, PublicTour, ThemeCoverage,
};
pub use types::{
    Edge, EdgeKind, GraphData, GraphStats, LatLon, Node, NodeId, NodeKind, PassSide, Point,
};
pub use wasm_api::*;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn leisure_core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[wasm_bindgen(js_name = validateGraphJson)]
pub fn validate_graph_json(value: JsValue) -> Result<(), JsValue> {
    let data: GraphData = serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let graph = LeisureGraph::from_data(data);
    let validation = graph.validate();
    if validation.is_ok() {
        Ok(())
    } else {
        Err(JsValue::from_str(&validation.errors.join("\n")))
    }
}
