// Boundary DTOs for the JS↔Rust leisure planner contract.
//
// All public types serialize with serde camelCase to mirror the JS shape
// verbatim. See `crates/leisure-core/architecture.md` (F1) for provenance and
// `assets/js/leisure/lib/ui-translation.js` for the JS originals.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetMode {
    Time,
    Distance,
}

impl Default for TargetMode {
    fn default() -> Self {
        Self::Distance
    }
}

// `UiPoint` is defined in `crate::types` (so the new `Ui*` types appended to
// `types.rs` can reference it without an outward import — pre-existing tests
// inline `types.rs` via `#[path]`). It is re-exported here so that the public
// frozen contract `leisure_core::ui_options::UiPoint` still holds.
pub use crate::types::UiPoint;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoiPrefs {
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub preset: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_pass_stops: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_poi_stops: Option<u32>,
    #[serde(default)]
    pub include_passes: Vec<String>,
    #[serde(default)]
    pub exclude_passes: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_km: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_node: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_snap_max_distance_m: Option<f64>,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub forbidden_pass_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip_date: Option<String>,
    #[serde(default)]
    pub open_only: bool,
    #[serde(default)]
    pub target_mode: TargetMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_tol: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_km: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k_alternatives: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_budget_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weather: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with_child: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poi_prefs: Option<PoiPrefs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stops: Option<StopsConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lunch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz_offset_minutes: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_node: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_snap_max_distance_m: Option<f64>,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub forbidden_pass_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seasonal_cutoff: Option<String>,
    pub k_alternatives: u32,
    pub time_budget_ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_km: Option<f64>,
}

impl Default for OptimizerOptions {
    fn default() -> Self {
        Self {
            start: None,
            end_node: None,
            end_snap_max_distance_m: None,
            themes: Vec::new(),
            personas: Vec::new(),
            forbidden_pass_ids: Vec::new(),
            seasonal_cutoff: None,
            k_alternatives: 3,
            time_budget_ms: 1_000,
            seed: None,
            budget_seconds: None,
            budget_km: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRequest {
    #[serde(default)]
    pub coords: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFacts {
    #[serde(default)]
    pub geom: Vec<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_km: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_h: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase4Inputs {
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weather: Option<String>,
    #[serde(default)]
    pub tz_offset_minutes: i32,
}
