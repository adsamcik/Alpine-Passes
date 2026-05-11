// Runtime graph loader, indexes, spatial lookup, and structural validation.

use crate::types::{Edge, EdgeKind, GraphData, GraphStats, Node, NodeId, NodeKind, PassSide};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;

const EARTH_RADIUS_M: f64 = 6_371_000.0;

#[derive(Debug)]
pub enum LoadError {
    Json(serde_json::Error),
}

impl fmt::Display for LoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "failed to parse leisure graph JSON: {error}"),
        }
    }
}

impl Error for LoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
        }
    }
}

impl From<serde_json::Error> for LoadError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ValidationResult {
    pub errors: Vec<String>,
}

impl ValidationResult {
    pub fn ok() -> Self {
        Self { errors: Vec::new() }
    }

    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }

    pub fn is_err(&self) -> bool {
        !self.is_ok()
    }

    fn push(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PassSides {
    pub pass: Option<NodeId>,
    pub a: Option<NodeId>,
    pub summit: Option<NodeId>,
    pub b: Option<NodeId>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EdgeStats {
    pub min_duration_per_m: f64,
    pub min_leisure_per_m: f64,
    pub min_distance_ratio: f64,
    pub n_edges_considered: usize,
}

#[derive(Clone, Debug)]
pub struct LeisureGraph {
    pub version: String,
    pub generated_at: String,
    pub stats: GraphStats,
    pub raw_nodes: Vec<Node>,
    pub raw_edges: Vec<Edge>,
    pub nodes: HashMap<NodeId, Node>,
    pub nodes_by_kind: HashMap<NodeKind, Vec<NodeId>>,
    pub node_list: Vec<NodeId>,
    pub node_ids: Vec<NodeId>,
    pub node_index: HashMap<NodeId, usize>,
    pub out_edges: HashMap<NodeId, Vec<Edge>>,
    pub in_edges: HashMap<NodeId, Vec<Edge>>,
    pub edges: Vec<Edge>,
    pub edge_by_key: HashMap<String, usize>,
    pub edge_by_id: HashMap<String, usize>,
    pub edge_stats: EdgeStats,
    pub pass_triplets: HashMap<NodeId, PassSides>,
    pub pass_id_by_node_id: HashMap<NodeId, NodeId>,
}

impl LeisureGraph {
    pub fn load_from_json(json: &str) -> Result<Self, LoadError> {
        let data: GraphData = serde_json::from_str(json)?;
        Ok(Self::from_data(data))
    }

    pub fn from_data(data: GraphData) -> Self {
        let mut graph = Self {
            version: data.version,
            generated_at: data.generated_at,
            stats: data.stats,
            raw_nodes: data.nodes,
            raw_edges: data.edges,
            nodes: HashMap::new(),
            nodes_by_kind: HashMap::new(),
            node_list: Vec::new(),
            node_ids: Vec::new(),
            node_index: HashMap::new(),
            out_edges: HashMap::new(),
            in_edges: HashMap::new(),
            edges: Vec::new(),
            edge_by_key: HashMap::new(),
            edge_by_id: HashMap::new(),
            edge_stats: EdgeStats::default(),
            pass_triplets: HashMap::new(),
            pass_id_by_node_id: HashMap::new(),
        };

        graph.build_node_indexes();
        graph.build_edge_indexes();
        graph.edge_stats = graph.compute_edge_stats();
        graph.build_pass_indexes();
        graph
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn nodes_of_kind(&self, kind: NodeKind) -> &[NodeId] {
        self.nodes_by_kind
            .get(&kind)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn outgoing_edges(&self, id: &NodeId) -> &[Edge] {
        self.out_edges.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn incoming_edges(&self, id: &NodeId) -> &[Edge] {
        self.in_edges.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn edge_between(&self, from: &NodeId, to: &NodeId) -> Option<&Edge> {
        self.edge_by_key
            .get(&edge_key(from, to))
            .and_then(|index| self.edges.get(*index))
    }

    pub fn pass_sides_for(&self, pass_id: &str) -> Option<PassSides> {
        let requested = NodeId::from(pass_id);
        let resolved = self
            .pass_id_by_node_id
            .get(&requested)
            .cloned()
            .or_else(|| pass_id_from_synthetic_id(pass_id))
            .unwrap_or(requested);
        self.pass_triplets.get(&resolved).cloned()
    }

    pub fn node_kind_of(&self, id: &NodeId) -> Option<NodeKind> {
        self.nodes.get(id).map(|node| node.kind.clone())
    }

    pub fn nearest_nodes(
        &self,
        lat: f64,
        lon: f64,
        kinds: &[NodeKind],
        k: usize,
    ) -> Vec<(NodeId, f64)> {
        if k == 0 || !is_valid_coord(lat, lon) {
            return Vec::new();
        }

        let kind_filter: HashSet<NodeKind> = kinds.iter().cloned().collect();
        let mut results: Vec<(NodeId, f64)> = self
            .node_list
            .iter()
            .filter_map(|id| self.nodes.get(id))
            .filter(|node| kind_filter.is_empty() || kind_filter.contains(&node.kind))
            .filter(|node| is_valid_coord(node.lat, node.lon))
            .map(|node| (node.id.clone(), haversine_m(lat, lon, node.lat, node.lon)))
            .filter(|(_, distance)| distance.is_finite())
            .collect();

        results.sort_by(|left, right| compare_nearest(left, right));
        results.truncate(k);
        results
    }

    pub fn validate(&self) -> ValidationResult {
        let mut result = ValidationResult::ok();
        self.validate_top_level(&mut result);
        self.validate_nodes(&mut result);
        self.validate_edges(&mut result);
        self.validate_edge_endpoints(&mut result);
        self.validate_pass_triplets(&mut result);
        self.validate_pass_edges(&mut result);
        result
    }

    fn build_node_indexes(&mut self) {
        for node in &self.raw_nodes {
            let index = self.node_list.len();
            self.node_list.push(node.id.clone());
            self.node_ids.push(node.id.clone());
            self.node_index.insert(node.id.clone(), index);
            self.nodes.insert(node.id.clone(), node.clone());
            self.nodes_by_kind
                .entry(node.kind.clone())
                .or_default()
                .push(node.id.clone());
        }

        for id in self.nodes.keys() {
            self.out_edges.entry(id.clone()).or_default();
            self.in_edges.entry(id.clone()).or_default();
        }
    }

    fn build_edge_indexes(&mut self) {
        for edge in &self.raw_edges {
            let index = self.edges.len();
            let key = edge.key();
            self.edge_by_key.insert(key, index);
            self.edge_by_id.insert(edge.canonical_id(), index);
            self.edges.push(edge.clone());
            self.out_edges
                .entry(edge.from.clone())
                .or_default()
                .push(edge.clone());
            self.in_edges
                .entry(edge.to.clone())
                .or_default()
                .push(edge.clone());
        }
    }

    fn compute_edge_stats(&self) -> EdgeStats {
        let mut min_duration_per_m = f64::INFINITY;
        let mut min_leisure_per_m = f64::INFINITY;
        let mut min_distance_ratio = f64::INFINITY;
        let mut n_edges_considered = 0;

        for edge in &self.edges {
            let distance_m = edge.distance_m;
            if !distance_m.is_finite() || distance_m <= 0.0 {
                continue;
            }
            n_edges_considered += 1;

            if edge.duration_s.is_finite() && edge.duration_s > 0.0 {
                min_duration_per_m = min_duration_per_m.min(edge.duration_s / distance_m);
            }
            if edge.leisure_cost.is_finite() && edge.leisure_cost > 0.0 {
                min_leisure_per_m = min_leisure_per_m.min(edge.leisure_cost / distance_m);
            }

            if edge.from != edge.to {
                if let (Some(from), Some(to)) =
                    (self.nodes.get(&edge.from), self.nodes.get(&edge.to))
                {
                    let direct_m = haversine_m(from.lat, from.lon, to.lat, to.lon);
                    if direct_m > 0.0 {
                        min_distance_ratio = min_distance_ratio.min(distance_m / direct_m);
                    }
                }
            }
        }

        EdgeStats {
            min_duration_per_m: finite_or_zero(min_duration_per_m),
            min_leisure_per_m: finite_or_zero(min_leisure_per_m),
            min_distance_ratio: finite_or_zero(min_distance_ratio),
            n_edges_considered,
        }
    }

    fn build_pass_indexes(&mut self) {
        let pass_ids = self.nodes_of_kind(NodeKind::Pass).to_vec();
        for pass_id in pass_ids {
            self.pass_triplets.insert(
                pass_id.clone(),
                PassSides {
                    pass: Some(pass_id.clone()),
                    ..PassSides::default()
                },
            );
            self.pass_id_by_node_id
                .insert(pass_id.clone(), pass_id.clone());
        }

        let node_ids = self.node_ids.clone();
        for node_id in node_ids {
            let Some(node) = self.nodes.get(&node_id).cloned() else {
                continue;
            };
            if !matches!(&node.kind, NodeKind::PassBase | NodeKind::PassSummit) {
                continue;
            }

            let Some(pass_id) = node
                .pass_id
                .clone()
                .or_else(|| pass_id_from_synthetic_id(node.id.as_str()))
            else {
                continue;
            };

            let pass = self.nodes.get(&pass_id).map(|_| pass_id.clone());
            let triplet = self
                .pass_triplets
                .entry(pass_id.clone())
                .or_insert_with(|| PassSides {
                    pass,
                    ..PassSides::default()
                });

            match &node.kind {
                NodeKind::PassBase => {
                    let side = node.side.or_else(|| {
                        synthetic_suffix(node.id.as_str()).and_then(PassSide::from_suffix)
                    });
                    match side {
                        Some(PassSide::A) => triplet.a = Some(node.id.clone()),
                        Some(PassSide::B) => triplet.b = Some(node.id.clone()),
                        None => {}
                    }
                }
                NodeKind::PassSummit => {
                    triplet.summit = Some(node.id.clone());
                }
                _ => {}
            }

            self.pass_id_by_node_id
                .insert(node.id.clone(), pass_id.clone());
        }
    }

    fn validate_top_level(&self, result: &mut ValidationResult) {
        if self.version.is_empty() {
            result.push("missing top-level version");
        }
        if self.generated_at.is_empty() {
            result.push("missing top-level generatedAt");
        }
        if let Some(expected) = self.stats.nodes {
            if expected != self.raw_nodes.len() {
                result.push(format!(
                    "stats.nodes {expected} does not match node count {}",
                    self.raw_nodes.len()
                ));
            }
        }
        if let Some(expected) = self.stats.edges {
            if expected != self.raw_edges.len() {
                result.push(format!(
                    "stats.edges {expected} does not match edge count {}",
                    self.raw_edges.len()
                ));
            }
        }
    }

    fn validate_nodes(&self, result: &mut ValidationResult) {
        let mut seen = HashSet::new();
        for (index, node) in self.raw_nodes.iter().enumerate() {
            if node.id.is_empty() {
                result.push(format!("node {index} missing string id"));
            }
            if !is_valid_coord(node.lat, node.lon) {
                result.push(format!("node {} has invalid coordinates", node.id));
            }
            if !seen.insert(node.id.clone()) {
                result.push(format!("duplicate node id {}", node.id));
            }
            if let NodeKind::Unknown(kind) = &node.kind {
                result.push(format!("node {} has unknown kind {kind}", node.id));
            }
        }
    }

    fn validate_edges(&self, result: &mut ValidationResult) {
        let mut seen_keys = HashSet::new();
        let mut seen_ids = HashSet::new();
        for (index, edge) in self.raw_edges.iter().enumerate() {
            if edge.from.is_empty() || edge.to.is_empty() {
                result.push(format!("edge {index} missing endpoints"));
            }
            if !is_positive_finite(edge.distance_m) {
                result.push(format!("edge {index} {} invalid distanceM", edge.key()));
            }
            if !is_positive_finite(edge.duration_s) {
                result.push(format!("edge {index} {} invalid durationS", edge.key()));
            }
            if !is_non_negative_finite(edge.leisure_cost) {
                result.push(format!("edge {index} {} invalid leisureCost", edge.key()));
            }
            if let EdgeKind::Unknown(kind) = &edge.kind {
                result.push(format!(
                    "edge {index} {} has unknown kind {kind}",
                    edge.key()
                ));
            }
            if matches!(&edge.kind, EdgeKind::Connector) && edge.from == edge.to {
                result.push(format!(
                    "connector edge {index} {} is a self-loop",
                    edge.key()
                ));
            }

            let key = edge.key();
            if !seen_keys.insert(key.clone()) {
                result.push(format!("duplicate edge key {key}"));
            }
            if let Some(id) = &edge.id {
                if !seen_ids.insert(id.clone()) {
                    result.push(format!("duplicate edge id {id}"));
                }
            }
        }
    }

    fn validate_edge_endpoints(&self, result: &mut ValidationResult) {
        let node_ids: HashSet<NodeId> = self.raw_nodes.iter().map(|node| node.id.clone()).collect();
        for edge in &self.raw_edges {
            if !node_ids.contains(&edge.from) {
                result.push(format!(
                    "edge {} references unknown from {}",
                    edge.key(),
                    edge.from
                ));
            }
            if !node_ids.contains(&edge.to) {
                result.push(format!(
                    "edge {} references unknown to {}",
                    edge.key(),
                    edge.to
                ));
            }
        }
    }

    fn validate_pass_triplets(&self, result: &mut ValidationResult) {
        for pass_id in self.nodes_of_kind(NodeKind::Pass) {
            let triplet = self.pass_triplets.get(pass_id);
            if triplet.and_then(|sides| sides.a.as_ref()).is_none() {
                result.push(format!("pass {pass_id} missing base A node"));
            }
            if triplet.and_then(|sides| sides.summit.as_ref()).is_none() {
                result.push(format!("pass {pass_id} missing summit node"));
            }
            if triplet.and_then(|sides| sides.b.as_ref()).is_none() {
                result.push(format!("pass {pass_id} missing base B node"));
            }
        }
    }

    fn validate_pass_edges(&self, result: &mut ValidationResult) {
        for pass_id in self.nodes_of_kind(NodeKind::Pass) {
            let a = NodeId::new(format!("{pass_id}:A"));
            let summit = NodeId::new(format!("{pass_id}:S"));
            let b = NodeId::new(format!("{pass_id}:B"));

            for (from, to) in [(&a, &summit), (&summit, &a), (&summit, &b), (&b, &summit)] {
                let edge = self.edge_between(from, to);
                if !matches!(
                    edge,
                    Some(edge)
                        if matches!(&edge.kind, EdgeKind::PassClimb)
                            && edge.pass_id.as_ref() == Some(pass_id)
                ) {
                    result.push(format!(
                        "pass {pass_id} missing pass-climb {}",
                        edge_key(from, to)
                    ));
                }
            }

            let a_out = self.edge_between(&a, &a);
            let b_out = self.edge_between(&b, &b);
            if !matches!(a_out, Some(edge) if matches!(&edge.kind, EdgeKind::PassOutAndBack)) {
                result.push(format!(
                    "pass {pass_id} missing out-and-back {}",
                    edge_key(&a, &a)
                ));
            }
            if !matches!(b_out, Some(edge) if matches!(&edge.kind, EdgeKind::PassOutAndBack)) {
                result.push(format!(
                    "pass {pass_id} missing out-and-back {}",
                    edge_key(&b, &b)
                ));
            }

            let a_traverse = self
                .edge_between(&a, &summit)
                .map(|edge| edge.leisure_cost)
                .unwrap_or(f64::NAN)
                + self
                    .edge_between(&summit, &b)
                    .map(|edge| edge.leisure_cost)
                    .unwrap_or(f64::NAN);
            let b_traverse = self
                .edge_between(&b, &summit)
                .map(|edge| edge.leisure_cost)
                .unwrap_or(f64::NAN)
                + self
                    .edge_between(&summit, &a)
                    .map(|edge| edge.leisure_cost)
                    .unwrap_or(f64::NAN);

            if let Some(edge) = a_out {
                if a_traverse.is_finite() && !(edge.leisure_cost > a_traverse) {
                    result.push(format!(
                        "pass {pass_id} A out-and-back is not costlier than traverse"
                    ));
                }
            }
            if let Some(edge) = b_out {
                if b_traverse.is_finite() && !(edge.leisure_cost > b_traverse) {
                    result.push(format!(
                        "pass {pass_id} B out-and-back is not costlier than traverse"
                    ));
                }
            }
        }
    }
}

pub fn edge_key(from: &NodeId, to: &NodeId) -> String {
    format!("{from}->{to}")
}

pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    if !is_valid_coord(lat1, lon1) || !is_valid_coord(lat2, lon2) {
        return f64::INFINITY;
    }
    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let sin_lat = (d_lat / 2.0).sin();
    let sin_lon = (d_lon / 2.0).sin();
    let h = sin_lat * sin_lat + lat1_rad.cos() * lat2_rad.cos() * sin_lon * sin_lon;
    2.0 * EARTH_RADIUS_M * h.sqrt().min(1.0).asin()
}

fn compare_nearest(left: &(NodeId, f64), right: &(NodeId, f64)) -> Ordering {
    left.1
        .partial_cmp(&right.1)
        .unwrap_or(Ordering::Equal)
        .then_with(|| left.0.cmp(&right.0))
}

fn pass_id_from_synthetic_id(node_id: &str) -> Option<NodeId> {
    let (pass_id, suffix) = node_id.rsplit_once(':')?;
    matches!(suffix, "A" | "S" | "B").then(|| NodeId::from(pass_id))
}

fn synthetic_suffix(node_id: &str) -> Option<&str> {
    let (_, suffix) = node_id.rsplit_once(':')?;
    matches!(suffix, "A" | "S" | "B").then_some(suffix)
}

fn is_valid_coord(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0
}

fn is_positive_finite(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn is_non_negative_finite(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}
