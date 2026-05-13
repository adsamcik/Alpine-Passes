// Crate entry point and minimal WASM exports for the leisure graph core.

pub mod astar;
pub mod breaks;
pub mod corridor;
pub mod ears;
pub mod extras;
pub mod graph;
pub mod heuristics;
pub mod intent;
pub mod lunch;
pub mod optimizer;
pub mod route_geom;
pub mod tour_dto;
pub mod types;
pub mod ui_options;
pub mod wasm_api;

pub use astar::{leisure_astar, AStarOptions, AStarResult, AStarStatus, CostMode};
pub use breaks::{detect_breaks, suggest_breaks, BreakOptions, BreakPoiInput, BreakStop};
pub use corridor::{
    find_corridor_pois, suggest_corridor, CorridorItem, CorridorOptions, CorridorSuggestions,
};
pub use ears::{decompose_ears, Ear, EarDecomposition, EarKind};
pub use graph::{haversine_m, LeisureGraph};
pub use heuristics::{
    break_persona_for, is_in_range, is_seasonally_closed_pass, lunch_persona_for, lunch_policy_for,
    optimizer_options, projected_open_pass_count, top_intent_personas, LunchPersona,
};
pub use intent::{
    infer_intent, surface_intent_pois, tags_from_entity, tags_from_target, IntentCandidate,
    IntentDistribution, IntentEntity, IntentState, IntentTarget, SurfaceIntentOptions,
};
pub use lunch::{find_lunch_area, LunchOptions, LunchPolicy, LunchSuggestion};
pub use optimizer::{
    double_bridge_node_order, improve_node_order_or_opt, improve_node_order_two_opt,
    leisure_plan_auto, leisure_plan_open, leisure_plan_selected, plan_leisure_tour,
    route_leisure_cost, side_stop_detour_cost, BudgetFit, Mulberry32, PlanOptions, PlanResult,
    PlanStatus, PublicStop, PublicTour, ThemeCoverage,
};
pub use types::{
    Edge, GraphData, GraphStats, Node, NodeId, NodeKind, UiBreakItem, UiCorridor, UiCorridorItem,
    UiDrawMeta, UiEndpointStop, UiExtrasParts, UiIntentSurface, UiLunchZone, UiMode, UiOverlays,
    UiPassStop, UiPhase4Outputs, UiPlanResult, UiPoiStop, UiPoint, UiRouteAlternativeSummary,
    UiScenicStop, UiTourStop,
};
pub use ui_options::*;
pub use wasm_api::*;

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub fn leisure_core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
