// Canonical serde types for the Alpine Passes leisure graph JSON schema.

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
