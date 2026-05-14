// Canonical serde types for the Itinera leisure graph JSON schema.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::ops::Deref;

#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(String);

impl NodeId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<String> for NodeId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for NodeId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl AsRef<str> for NodeId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Deref for NodeId {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NodeKind {
    Pass,
    PassBase,
    PassSummit,
    Poi,
    Junction,
    Unknown(String),
}

impl NodeKind {
    fn from_wire(value: String) -> Self {
        match value.as_str() {
            "pass" => Self::Pass,
            "pass-base" => Self::PassBase,
            "pass-summit" => Self::PassSummit,
            "poi" => Self::Poi,
            "junction" => Self::Junction,
            _ => Self::Unknown(value),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Pass => "pass",
            Self::PassBase => "pass-base",
            Self::PassSummit => "pass-summit",
            Self::Poi => "poi",
            Self::Junction => "junction",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for NodeKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NodeKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::from_wire)
    }
}

impl fmt::Display for NodeKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PassSide {
    #[serde(rename = "A")]
    A,
    #[serde(rename = "B")]
    B,
}

impl PassSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
        }
    }

    pub fn from_suffix(value: &str) -> Option<Self> {
        match value {
            "A" => Some(Self::A),
            "B" => Some(Self::B),
            _ => None,
        }
    }
}

impl fmt::Display for PassSide {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

pub type LatLon = [f64; 2];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub elev: Option<f64>,
    #[serde(default, rename = "baseA")]
    pub base_a: Option<LatLon>,
    #[serde(default, rename = "baseB")]
    pub base_b: Option<LatLon>,
    #[serde(default, rename = "passId")]
    pub pass_id: Option<NodeId>,
    #[serde(default)]
    pub side: Option<PassSide>,
    #[serde(default, rename = "scenicScore")]
    pub scenic_score: Option<f64>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default, rename = "summitParking")]
    pub summit_parking: Option<Point>,
    #[serde(default)]
    pub viewpoints: Vec<Point>,
    #[serde(default, rename = "visitDwellSec")]
    pub visit_dwell_sec: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    PassClimb,
    PassOutAndBack,
    Connector,
    Unknown(String),
}

impl EdgeKind {
    fn from_wire(value: String) -> Self {
        match value.as_str() {
            "pass-climb" => Self::PassClimb,
            "pass-out-and-back" => Self::PassOutAndBack,
            "connector" => Self::Connector,
            _ => Self::Unknown(value),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::PassClimb => "pass-climb",
            Self::PassOutAndBack => "pass-out-and-back",
            Self::Connector => "connector",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for EdgeKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EdgeKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::from_wire)
    }
}

impl fmt::Display for EdgeKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    #[serde(default)]
    pub id: Option<String>,
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
    #[serde(rename = "distanceM")]
    pub distance_m: f64,
    #[serde(rename = "durationS")]
    pub duration_s: f64,
    #[serde(rename = "leisureCost")]
    pub leisure_cost: f64,
    #[serde(default, rename = "passId")]
    pub pass_id: Option<NodeId>,
    #[serde(default)]
    pub side: Option<PassSide>,
    #[serde(default, rename = "scenicScore")]
    pub scenic_score: Option<f64>,
    #[serde(default)]
    pub season: Option<String>,
    #[serde(default)]
    pub geometry: Vec<LatLon>,
    #[serde(default, rename = "roadClass")]
    pub road_class: Option<String>,
    #[serde(default, rename = "isHighway")]
    pub is_highway: Option<bool>,
    #[serde(default)]
    pub source: Option<String>,
}

impl Edge {
    pub fn key(&self) -> String {
        format!("{}->{}", self.from, self.to)
    }

    pub fn canonical_id(&self) -> String {
        self.id.clone().unwrap_or_else(|| self.key())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GraphStats {
    #[serde(default)]
    pub passes: Option<usize>,
    #[serde(default, rename = "passBases")]
    pub pass_bases: Option<usize>,
    #[serde(default, rename = "passSummits")]
    pub pass_summits: Option<usize>,
    #[serde(default)]
    pub pois: Option<usize>,
    #[serde(default)]
    pub junctions: Option<usize>,
    #[serde(default)]
    pub nodes: Option<usize>,
    #[serde(default)]
    pub edges: Option<usize>,
    #[serde(default, rename = "gzipBytes")]
    pub gzip_bytes: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphData {
    pub version: String,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub stats: GraphStats,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

// =====================================================================
// UI boundary DTOs (F1) — output side of the JS↔Rust contract.
// Inputs live in `crate::ui_options`. See `architecture.md` (F1).
//
// `UiPoint` is defined here (rather than in `ui_options.rs`) so the
// `Ui*` types below can reference it without an outward `use` that would
// fail to resolve when pre-existing tests (`tests/dedupe.rs`) inline this
// file alone via `#[path]`. `ui_options.rs` re-exports it to keep the
// frozen public contract `leisure_core::ui_options::UiPoint` intact.
// =====================================================================

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UiPoint {
    Id(String),
    Coord {
        lat: f64,
        lon: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiTourStop {
    Pass(UiPassStop),
    Poi(UiPoiStop),
    Endpoint(UiEndpointStop),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPassStop {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elev: Option<f64>,
    pub quality: f64,
    pub q_scenic: f64,
    pub q_summit: f64,
    pub q_approach: f64,
    pub scenic_score: f64,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub viewpoints: Vec<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_a: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_b: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summit_parking: Option<UiPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPoiStop {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub is_poi: bool,
    pub visit_dwell_sec: u32,
    pub dwell_min: u32,
    pub dwell_h: f64,
    pub poi_category: String,
    #[serde(default)]
    pub poi_themes: Vec<String>,
    pub quality: f64,
    pub scenic_score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiEndpointStop {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub is_endpoint: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMode {
    pub pass_idx: u32,
    pub enter_side: u8,
    pub exit_side: u8,
    pub mode: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiScenicStop {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub scenic_score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRouteAlternativeSummary {
    pub index: u32,
    pub km: f64,
    pub total_h: f64,
    pub label: String,
    pub in_range: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiExtrasParts {
    #[serde(default)]
    pub corridor_h: f64,
    #[serde(default)]
    pub lunch_h: f64,
    #[serde(default)]
    pub breaks_h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCorridorItem {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub themes: Vec<String>,
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detour_km: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detour_min: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCorridor {
    #[serde(default)]
    pub items: Vec<UiCorridorItem>,
    #[serde(default)]
    pub auto_include: Vec<UiCorridorItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiBreakItem {
    pub at_tour_vertex_idx: u32,
    pub at_km: f64,
    pub at_h: f64,
    pub source: String,
    pub stop_min: u32,
    pub rest_min: u32,
    #[serde(default)]
    pub rest_numbers: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLunchZone {
    pub start_h: f64,
    pub end_h: f64,
    pub center_h: f64,
    #[serde(default)]
    pub picks: Vec<UiCorridorItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiIntentSurface {
    #[serde(default)]
    pub top_persona: String,
    #[serde(default)]
    pub ambiguous: bool,
    #[serde(default)]
    pub primary: Vec<UiCorridorItem>,
    #[serde(default)]
    pub serendipity: Vec<UiCorridorItem>,
    #[serde(default)]
    pub top_personas: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiOverlays {
    #[serde(default)]
    pub lunch_zones: Vec<UiLunchZone>,
    #[serde(default)]
    pub breaks: Vec<UiBreakItem>,
    #[serde(default)]
    pub corridor_suggestions: Vec<UiCorridorItem>,
    #[serde(default)]
    pub corridor_auto_include: Vec<UiCorridorItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiDrawMeta {
    #[serde(default)]
    pub leisure_overlays: UiOverlays,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPhase4Outputs {
    #[serde(default)]
    pub corridor: UiCorridor,
    #[serde(default)]
    pub lunch_zones: Vec<UiLunchZone>,
    #[serde(default)]
    pub breaks: Vec<UiBreakItem>,
    #[serde(default)]
    pub intent: UiIntentSurface,
    #[serde(default)]
    pub overlays: UiOverlays,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPlanResult {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<UiPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_node: Option<UiPoint>,
    #[serde(default)]
    pub tour_stops: Vec<UiTourStop>,
    #[serde(default)]
    pub modes: Vec<UiMode>,
    #[serde(default)]
    pub implicit_passes: Vec<String>,
    #[serde(default)]
    pub scenic_stops: Vec<UiScenicStop>,
    pub km: f64,
    pub drive_h: f64,
    pub dwell_h: f64,
    pub extras_h: f64,
    #[serde(default)]
    pub extras_parts: UiExtrasParts,
    pub total_h: f64,
    pub in_range: bool,
    pub advanced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip_date: Option<String>,
    pub total_open: u32,
    #[serde(default)]
    pub diagnostics: serde_json::Value,
    pub wasm_unavailable: bool,
    #[serde(default)]
    pub intent: UiIntentSurface,
    #[serde(default)]
    pub corridor: UiCorridor,
    #[serde(default)]
    pub lunch_zones: Vec<UiLunchZone>,
    #[serde(default)]
    pub breaks: Vec<UiBreakItem>,
    #[serde(default)]
    pub route_alternatives: Vec<UiRouteAlternativeSummary>,
    pub route_alternative_index: u32,
    #[serde(default, rename = "_latlngs")]
    pub latlngs: Vec<[f64; 2]>,
    #[serde(default, rename = "_drawMeta")]
    pub draw_meta: UiDrawMeta,
}
