use crate::astar::{leisure_astar, AStarOptions, AStarResult, AStarStatus, CostMode};
use crate::ears::{EarDecomposition, EarKind};
use crate::graph::{haversine_m, LeisureGraph};
use crate::types::{EdgeKind, Node, NodeId, NodeKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::ops::Add;
#[cfg(not(target_arch = "wasm32"))]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn date_now() -> f64;
}

const DEFAULT_K_ALTERNATIVES: usize = 3;
const DEFAULT_TIME_BUDGET_MS: f64 = 800.0;
const DEFAULT_CACHE_ENTRIES: usize = 5_000;
const DEFAULT_SEEDED_ITERATION_CAP: usize = 250;
const STAGE1_MS: f64 = 50.0;
const STAGE1_ADVANCED_RETRY_MS: f64 = STAGE1_MS * 4.0;
const STAGE2_MS: f64 = 200.0;
const STAGE1_MOVES: usize = 200;
const STAGE2_MOVES: usize = 800;
const USED_EDGES_PENALTY: f64 = 4.0;
const MAX_AUTO_CANDIDATES: usize = 110;
const MAX_INSERTION_SCAN: usize = 70;
const END_SNAP_MAX_DISTANCE_M: f64 = 30_000.0;
const DEFAULT_MAX_NO_IMPROVEMENT: usize = 20;
const EPS: f64 = 1e-9;

const SCENIC_WEIGHT: f64 = 10_000.0;
const THEME_WEIGHT: f64 = 2_000.0;
const LEISURE_COST_WEIGHT: f64 = 1.0;
const RETRACED_CONNECTOR_PENALTY: f64 = 1_000.0;
const OUT_AND_BACK_PENALTY: f64 = 500.0;
const LOOP_EAR_BONUS: f64 = 150.0;
const BUDGET_FILL_WEIGHT: f64 = 350.0;

#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
struct ClockInstant(f64);

impl ClockInstant {
    fn now() -> Self {
        Self(now_ms())
    }

    fn elapsed_ms(self) -> f64 {
        (now_ms() - self.0).max(0.0)
    }

    fn min(self, other: Self) -> Self {
        if self <= other {
            self
        } else {
            other
        }
    }
}

impl Add<f64> for ClockInstant {
    type Output = Self;

    fn add(self, rhs: f64) -> Self::Output {
        Self(self.0 + rhs.max(0.0))
    }
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    date_now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlanPoint {
    Node(NodeId),
    Coordinates {
        lat: f64,
        lon: f64,
        name: Option<String>,
    },
}

impl From<&str> for PlanPoint {
    fn from(value: &str) -> Self {
        Self::Node(NodeId::from(value))
    }
}

impl From<String> for PlanPoint {
    fn from(value: String) -> Self {
        Self::Node(NodeId::from(value))
    }
}

impl From<NodeId> for PlanPoint {
    fn from(value: NodeId) -> Self {
        Self::Node(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlanOptions {
    pub start: PlanPoint,
    pub end_node: Option<PlanPoint>,
    pub budget_seconds: Option<f64>,
    pub budget_km: Option<f64>,
    pub themes: Vec<String>,
    pub personas: Vec<String>,
    pub forbidden_pass_ids: Vec<String>,
    pub forbidden_edges: HashSet<usize>,
    pub forbidden_nodes: HashSet<NodeId>,
    pub seasonal_cutoff: Option<String>,
    pub k_alternatives: usize,
    pub time_budget_ms: f64,
    pub seed: Option<u64>,
    pub iteration_cap: Option<usize>,
    pub max_cache_entries: usize,
    pub end_snap_max_distance_m: Option<f64>,
    pub max_no_improvement: usize,
}

impl Default for PlanOptions {
    fn default() -> Self {
        Self {
            start: PlanPoint::Node(NodeId::default()),
            end_node: None,
            budget_seconds: None,
            budget_km: None,
            themes: Vec::new(),
            personas: Vec::new(),
            forbidden_pass_ids: Vec::new(),
            forbidden_edges: HashSet::new(),
            forbidden_nodes: HashSet::new(),
            seasonal_cutoff: None,
            k_alternatives: DEFAULT_K_ALTERNATIVES,
            time_budget_ms: DEFAULT_TIME_BUDGET_MS,
            seed: None,
            iteration_cap: None,
            max_cache_entries: DEFAULT_CACHE_ENTRIES,
            end_snap_max_distance_m: None,
            max_no_improvement: DEFAULT_MAX_NO_IMPROVEMENT,
        }
    }
}

impl PlanOptions {
    pub fn with_start(start: impl Into<PlanPoint>) -> Self {
        Self {
            start: start.into(),
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    Ok,
    Degraded,
    Infeasible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    pub status: PlanStatus,
    pub primary: Option<PublicTour>,
    pub alternatives: Vec<PublicTour>,
    pub iterations: usize,
    pub elapsed_ms: f64,
    pub diagnostics: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTour {
    pub end_node: NodeId,
    pub stops: Vec<PublicStop>,
    pub edges: Vec<String>,
    pub total_leisure_cost: f64,
    pub total_distance_km: f64,
    pub total_duration_h: f64,
    pub scenic_sum: f64,
    pub retraced_connector_count: usize,
    pub out_and_back_count: usize,
    pub ears_traversed: Vec<String>,
    pub theme_coverage: ThemeCoverage,
    pub budget_fit: BudgetFit,
    pub path: Vec<NodeId>,
    pub score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicStop {
    pub id: String,
    pub node_id: NodeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenic_score: Option<f64>,
    pub order: usize,
    #[serde(default, skip_serializing_if = "is_false")]
    pub return_to_start: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCoverage {
    pub requested: Vec<String>,
    pub covered_themes: Vec<String>,
    pub covered_requested: Vec<String>,
    pub ratio: f64,
    pub score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BudgetFit {
    pub mode: String,
    pub budget: f64,
    pub used: f64,
    pub remaining: f64,
    pub ratio: f64,
    pub within: bool,
}

/// Small deterministic PRNG matching the JavaScript optimizer's Mulberry32 stream.
///
/// Keeping this inline avoids adding RNG dependencies to the WASM bundle while
/// preserving seeded JS parity for search shuffling and perturbations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed as u32 }
    }

    pub fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    pub fn next_f64(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4_294_967_296.0
    }

    fn index(&mut self, upper_exclusive: usize) -> usize {
        if upper_exclusive == 0 {
            0
        } else {
            (self.next_f64() * upper_exclusive as f64).floor() as usize
        }
    }
}

/// Plans an automatic leisure tour from `options.start`, selecting
/// pass/POI stops opportunistically under exactly one of
/// `budget_seconds` or `budget_km`.
///
/// Closed loops are the default: when `options.end_node` is omitted,
/// `None`, or resolves to the start, the tour returns to the start.
/// When `options.end_node` resolves to a different graph or snapped
/// endpoint, the result is an open A→B tour ending at `primary.end_node`.
///
/// `options.k_alternatives` is the total requested tour count including
/// the primary; alternatives are capped at `k_alternatives - 1`.
///
/// With `options.seed = Some(_)`, output is deterministic across runs.
/// Without a seed, Rust uses a graph-derived fallback seed documented in
/// `README.md` under "Deliberate Divergences from JS".
///
/// Returns `PlanStatus::Infeasible` for invalid budgets, missing starts,
/// unreachable endpoints, or routes that cannot be materialized.
pub fn plan_leisure_tour(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    options: PlanOptions,
) -> PlanResult {
    plan_internal(graph, ears, &[], options, false)
}

/// Plans an advanced/selected leisure tour that must include every
/// requested pass or POI id in `must_visit_ids`.
///
/// Each id is resolved through the candidate alias index, including pass
/// aliases when available. Duplicate resolved candidates are collapsed
/// before search so each must-visit appears once in the planned route.
///
/// Closed loops are the default. Supplying an `options.end_node` that
/// resolves away from the start produces an open A→B tour ending at
/// `primary.end_node` without an implicit return leg.
///
/// `options.k_alternatives` is the total requested tour count including
/// the primary; alternatives are capped at `k_alternatives - 1`.
///
/// Returns `PlanStatus::Infeasible` for invalid inputs, missing or
/// unreachable starts/endpoints, invalid budgets, or must-visits that
/// cannot be materialized within a closed-loop budget.
pub(crate) fn plan_leisure_tour_advanced(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    must_visit_ids: &[String],
    options: PlanOptions,
) -> PlanResult {
    plan_internal(graph, ears, must_visit_ids, options, true)
}

/// Builds an automatic leisure plan using the Rust planner façade.
///
/// This mirrors the JavaScript `leisurePlanAuto` entry point at planner
/// level: callers provide already-normalized graph, ear decomposition,
/// start/end, budget, seasonal filters, forbidden sets, and preference
/// options through `PlanOptions`.
///
/// The function returns the core `PlanResult` directly rather than the
/// legacy UI-shaped wrapper produced by JavaScript. Closed and open A→B
/// semantics are inherited from `plan_leisure_tour`.
///
/// Use this when no explicit selected-stop/must-visit list is being
/// forced and the optimizer should choose pass stops opportunistically.
pub fn leisure_plan_auto(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    options: PlanOptions,
) -> PlanResult {
    plan_leisure_tour(graph, ears, options)
}

/// Builds a selected-stop leisure plan through caller-provided
/// must-visit ids.
///
/// This mirrors the planner portion of JavaScript `leisurePlanSelected`:
/// UI-selected stops should already have been converted to pass, POI, or
/// node ids before calling this function. The ids are passed to
/// `plan_leisure_tour_advanced` and must all resolve to candidates.
///
/// Closed and open A→B behavior is controlled by `options.end_node`, and
/// alternatives are counted the same way as `plan_leisure_tour`.
///
/// Returns the core `PlanResult` directly, leaving UI translation,
/// "no selected stops" handling, and route rendering to the caller.
pub fn leisure_plan_selected(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    must_visit_ids: &[String],
    options: PlanOptions,
) -> PlanResult {
    plan_leisure_tour_advanced(graph, ears, must_visit_ids, options)
}

/// Convenience entry point for planning an open A→B leisure trip.
///
/// The provided `start` and `end` override the same fields in `options`
/// before dispatching to `plan_leisure_tour`. Each point may be a graph
/// node id or an ad-hoc coordinate endpoint represented by `PlanPoint`.
///
/// If the resolved end is the same as the resolved start, planner
/// semantics collapse back to a closed loop; otherwise the returned tour
/// ends at `primary.end_node` without adding a return leg.
///
/// Budget, seed, alternatives, seasonal filters, forbidden sets, and
/// preference options are otherwise inherited from `options`.
pub fn leisure_plan_open(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    start: impl Into<PlanPoint>,
    end: impl Into<PlanPoint>,
    mut options: PlanOptions,
) -> PlanResult {
    options.start = start.into();
    options.end_node = Some(end.into());
    plan_leisure_tour(graph, ears, options)
}

/// Computes the detour cost contribution for inserting a side stop.
///
/// In closed-loop planning, a side stop must be reached and then left
/// again, so the edge contribution is doubled. In open A→B planning, the
/// side stop can lie on the one-way progression and contributes only the
/// single edge cost.
///
/// `edge_cost` should already be expressed in the caller's optimization
/// units, typically duration seconds, distance metres/kilometres, or
/// leisure cost depending on the scoring context.
///
/// The helper is deliberately small and deterministic so JS and Rust
/// insertion heuristics can share the same open-trip adjustment.
pub fn side_stop_detour_cost(edge_cost: f64, open_trip: bool) -> f64 {
    if open_trip {
        edge_cost
    } else {
        edge_cost * 2.0
    }
}

/// Sums leisure-routing cost for a fixed node order.
///
/// The evaluated path is `start`, every node in `route` in order, and
/// then `end`. Each adjacent pair is materialized with `leisure_astar`
/// using default A* options and `CostMode::Leisure`.
///
/// Returns `Some(total_cost)` when every leg is reachable and
/// `None` as soon as any leg cannot be routed successfully.
///
/// This helper ignores tour budgets and stop scoring; it is intended for
/// deterministic node-order improvement primitives such as 2-opt and
/// Or-opt where only relative path cost matters.
pub fn route_leisure_cost(
    graph: &LeisureGraph,
    start: &NodeId,
    route: &[NodeId],
    end: &NodeId,
) -> Option<f64> {
    let mut nodes = Vec::with_capacity(route.len() + 2);
    nodes.push(start.clone());
    nodes.extend(route.iter().cloned());
    nodes.push(end.clone());
    let mut total = 0.0;
    for pair in nodes.windows(2) {
        let leg = leisure_astar(graph, &pair[0], &pair[1], &AStarOptions::default());
        if leg.status != AStarStatus::Ok {
            return None;
        }
        total += leg.total_leisure_cost;
    }
    Some(total)
}

/// Improves a fixed node order with first-improvement 2-opt moves.
///
/// The start and end nodes are held fixed while contiguous subsections
/// of `route` are reversed. After each improving reversal, the search
/// restarts from the new best order until no further improvement exists.
///
/// Costs are computed by `route_leisure_cost`; if the initial route is
/// not fully reachable, the original order is returned unchanged.
///
/// This is a deterministic local optimizer with no random choices and
/// no budget checks, suitable for polishing a candidate ordering before
/// full tour materialization.
pub fn improve_node_order_two_opt(
    graph: &LeisureGraph,
    start: &NodeId,
    route: &[NodeId],
    end: &NodeId,
) -> Vec<NodeId> {
    let mut best_route = route.to_vec();
    let Some(mut best_cost) = route_leisure_cost(graph, start, &best_route, end) else {
        return best_route;
    };

    loop {
        let mut improved = false;
        'moves: for i in 0..best_route.len().saturating_sub(1) {
            for j in i + 1..best_route.len() {
                let mut candidate = best_route[..i].to_vec();
                candidate.extend(best_route[i..=j].iter().rev().cloned());
                candidate.extend(best_route[j + 1..].iter().cloned());
                if let Some(cost) = route_leisure_cost(graph, start, &candidate, end) {
                    if cost + EPS < best_cost {
                        best_route = candidate;
                        best_cost = cost;
                        improved = true;
                        break 'moves;
                    }
                }
            }
        }
        if !improved {
            return best_route;
        }
    }
}

/// Improves a fixed node order with first-improvement Or-opt moves.
///
/// The start and end nodes are held fixed while route segments of length
/// one through three are relocated to every possible insertion position.
/// After each improving relocation, the search restarts from the new
/// best order until a local optimum is reached.
///
/// Costs are computed by `route_leisure_cost`; if the initial route is
/// not fully reachable, the original order is returned unchanged.
///
/// This deterministic pass complements 2-opt by moving short blocks
/// without reversing their internal order.
pub fn improve_node_order_or_opt(
    graph: &LeisureGraph,
    start: &NodeId,
    route: &[NodeId],
    end: &NodeId,
) -> Vec<NodeId> {
    let mut best_route = route.to_vec();
    let Some(mut best_cost) = route_leisure_cost(graph, start, &best_route, end) else {
        return best_route;
    };

    loop {
        let mut improved = false;
        'moves: for len in 1..=3 {
            if best_route.len() <= len {
                continue;
            }
            for i in 0..=best_route.len() - len {
                let segment = best_route[i..i + len].to_vec();
                let mut rest = best_route[..i].to_vec();
                rest.extend(best_route[i + len..].iter().cloned());
                for pos in 0..=rest.len() {
                    if pos == i {
                        continue;
                    }
                    let mut candidate = rest[..pos].to_vec();
                    candidate.extend(segment.iter().cloned());
                    candidate.extend(rest[pos..].iter().cloned());
                    if let Some(cost) = route_leisure_cost(graph, start, &candidate, end) {
                        if cost + EPS < best_cost {
                            best_route = candidate;
                            best_cost = cost;
                            improved = true;
                            break 'moves;
                        }
                    }
                }
            }
        }
        if !improved {
            return best_route;
        }
    }
}

/// Applies a double-bridge perturbation to a node-order route.
///
/// Four interior cut points are sampled with the provided deterministic
/// `Mulberry32` stream. When all four cuts are distinct, the middle
/// segments are rearranged in double-bridge order while preserving the
/// route's first and final slices.
///
/// If the route is too small to perturb, it is returned unchanged. If
/// random sampling produces fewer than four distinct cuts, the route is
/// reversed as the same degenerate fallback used by the JS optimizer.
///
/// The input should contain only intermediate route nodes; callers keep
/// fixed start/end endpoints outside this slice.
pub fn double_bridge_node_order(route: &[NodeId], rng: &mut Mulberry32) -> Vec<NodeId> {
    let n = route.len();
    if n < 2 {
        return route.to_vec();
    }
    let mut cuts = BTreeSet::new();
    for _ in 0..4 {
        cuts.insert(1 + rng.index(n - 1));
    }
    if cuts.len() < 4 {
        let mut reversed = route.to_vec();
        reversed.reverse();
        return reversed;
    }
    let cuts: Vec<usize> = cuts.into_iter().collect();
    let (a, b, c, d) = (cuts[0], cuts[1], cuts[2], cuts[3]);
    let mut out = Vec::with_capacity(n);
    out.extend_from_slice(&route[..a]);
    out.extend_from_slice(&route[c..d]);
    out.extend_from_slice(&route[b..c]);
    out.extend_from_slice(&route[a..b]);
    out.extend_from_slice(&route[d..]);
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BudgetMode {
    Duration,
    Distance,
}

impl BudgetMode {
    fn cost_mode(self) -> CostMode {
        match self {
            Self::Duration => CostMode::Duration,
            Self::Distance => CostMode::Distance,
        }
    }

    fn public_units(self) -> &'static str {
        match self {
            Self::Duration => "seconds",
            Self::Distance => "km",
        }
    }

    fn diagnostics_mode(self) -> &'static str {
        match self {
            Self::Duration => "duration",
            Self::Distance => "distance",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Budget {
    mode: BudgetMode,
    value: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct ThemeProfile {
    requested: Vec<String>,
    personas: Vec<String>,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    node_id: NodeId,
    pass_id: Option<String>,
    kind: String,
    name: String,
    lat: f64,
    lon: f64,
    scenic_score: f64,
    themes: Vec<String>,
    ear_indices: Vec<usize>,
    base_reward: f64,
}

#[derive(Clone, Debug)]
struct ResolvedPoint {
    node_id: NodeId,
    name: String,
    lat: f64,
    lon: f64,
    snapped: bool,
    snap_distance_m: f64,
}

#[derive(Clone, Debug)]
struct ResolvedEnd {
    point: ResolvedPoint,
    open: bool,
    requested: String,
}

#[derive(Clone, Debug)]
struct LegOptions {
    budget: AStarResult,
    leisure: Option<AStarResult>,
}

#[derive(Clone, Debug)]
struct MaterializedRoute {
    ok: bool,
    legs: Vec<AStarResult>,
    edge_ids: Vec<usize>,
    path_nodes: Vec<NodeId>,
    total_leisure_cost: f64,
    total_distance_m: f64,
    total_duration_s: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterializationStats {
    leisure_retries: usize,
    leisure_accepted: usize,
    degenerate_perturbations: usize,
    double_bridge_count: usize,
}

#[derive(Clone, Debug)]
struct InternalTour {
    feasible: bool,
    route: Vec<Candidate>,
    signature: String,
    end_node: NodeId,
    stops: Vec<PublicStop>,
    edges: Vec<usize>,
    total_leisure_cost: f64,
    total_distance_km: f64,
    total_duration_h: f64,
    scenic_sum: f64,
    retraced_connector_count: usize,
    out_and_back_count: usize,
    ears_traversed: Vec<String>,
    theme_coverage: ThemeCoverage,
    budget_fit: BudgetFit,
    path: Vec<NodeId>,
    score: f64,
    duration_s: f64,
}

struct Env<'a> {
    graph: &'a LeisureGraph,
    ears: &'a EarDecomposition,
    budget: Budget,
    start: ResolvedPoint,
    end: ResolvedEnd,
    open_end: bool,
    advanced: bool,
    theme_profile: ThemeProfile,
    forbidden_nodes: HashSet<NodeId>,
    forbidden_edges: HashSet<usize>,
    rng: Mulberry32,
    iterations: usize,
    leg_cache: LruBounded<String, LegOptions>,
    route_cache: LruBounded<String, InternalTour>,
    cache_limit: usize,
    materialization_stats: MaterializationStats,
}

struct LruBounded<K: Ord + Clone, V> {
    map: BTreeMap<K, V>,
    order: VecDeque<K>,
    max_entries: usize,
}

impl<K: Ord + Clone, V> LruBounded<K, V> {
    fn new(max_entries: usize) -> Self {
        Self {
            map: BTreeMap::new(),
            order: VecDeque::new(),
            max_entries,
        }
    }

    fn len(&self) -> usize {
        self.map.len()
    }

    fn recall(&mut self, key: &K) -> Option<&V> {
        if self.map.contains_key(key) {
            self.order.retain(|candidate| candidate != key);
            self.order.push_back(key.clone());
            self.map.get(key)
        } else {
            None
        }
    }

    fn remember(&mut self, key: K, value: V) {
        if self.max_entries == 0 {
            return;
        }
        if self.map.contains_key(&key) {
            self.order.retain(|candidate| candidate != &key);
            self.order.push_back(key.clone());
            self.map.insert(key, value);
            return;
        }
        if self.map.len() >= self.max_entries {
            while let Some(evicted) = self.order.pop_front() {
                if self.map.remove(&evicted).is_some() {
                    break;
                }
            }
        }
        self.order.push_back(key.clone());
        self.map.insert(key, value);
    }
}

#[derive(Clone, Copy)]
struct SearchLimiter {
    deadline: Option<ClockInstant>,
    move_cap: usize,
    moves: usize,
}

impl SearchLimiter {
    fn has_budget(&self) -> bool {
        if self.moves >= self.move_cap {
            return false;
        }
        self.deadline
            .map_or(true, |deadline| ClockInstant::now() < deadline)
    }

    fn count_move(&mut self) {
        self.moves = self.moves.saturating_add(1);
    }
}

fn plan_internal(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    must_visit_ids: &[String],
    options: PlanOptions,
    advanced: bool,
) -> PlanResult {
    let started = ClockInstant::now();
    let seeded = options.seed.is_some();
    let time_budget_ms = finite_or(options.time_budget_ms, DEFAULT_TIME_BUDGET_MS).max(1.0);
    let end_at = started + duration_from_ms(time_budget_ms);
    let iteration_cap = options.iteration_cap.unwrap_or(if seeded {
        DEFAULT_SEEDED_ITERATION_CAP
    } else {
        usize::MAX / 4
    });
    let mut diagnostics =
        base_diagnostics(&options, advanced, seeded, time_budget_ms, iteration_cap);

    let Some(budget) = parse_budget(&options) else {
        diag_insert(
            &mut diagnostics,
            "budgetError",
            json!("provide-exactly-one-of-budgetSeconds-or-budgetKm"),
        );
        return invalid_result(started, diagnostics, "invalid-budget", Map::new());
    };
    if budget.value <= 0.0 {
        let reason = if budget.mode == BudgetMode::Duration {
            "budgetSeconds-must-be-positive"
        } else {
            "budgetKm-must-be-positive"
        };
        diag_insert(&mut diagnostics, "budgetError", json!(reason));
        return invalid_result(started, diagnostics, "invalid-budget", Map::new());
    }

    let theme_profile = normalize_theme_profile(&options);
    let forbidden_pass_ids = resolve_pass_id_set(graph, &options.forbidden_pass_ids);
    let mut forbidden_nodes = blocked_nodes_for_passes(graph, &forbidden_pass_ids);
    forbidden_nodes.extend(options.forbidden_nodes.iter().cloned());
    let seasonal = seasonal_forbidden_edges(graph, options.seasonal_cutoff.as_deref());
    let mut forbidden_edges = options.forbidden_edges.clone();
    forbidden_edges.extend(seasonal.edges.iter().copied());

    diag_insert(&mut diagnostics, "seasonalMask", seasonal.diagnostics);
    diag_insert(
        &mut diagnostics,
        "forbiddenPassIds",
        json!(forbidden_pass_ids.iter().cloned().collect::<Vec<_>>()),
    );
    diag_insert(
        &mut diagnostics,
        "forbiddenNodeCount",
        json!(forbidden_nodes.len()),
    );
    diag_insert(
        &mut diagnostics,
        "forbiddenEdgeCount",
        json!(forbidden_edges.len()),
    );

    let Some(start) = resolve_start(graph, &options.start, &forbidden_nodes) else {
        return invalid_result(started, diagnostics, "missing-start", Map::new());
    };
    diag_insert(
        &mut diagnostics,
        "start",
        json!({
            "id": start.node_id,
            "name": start.name,
            "snapped": start.snapped,
            "snapDistanceM": round(start.snap_distance_m, 1),
        }),
    );

    let end_snap_max_distance_m = parse_end_snap_max_distance_m(options.end_snap_max_distance_m);
    let end = match resolve_end(
        graph,
        options.end_node.as_ref(),
        &start,
        &forbidden_nodes,
        &forbidden_edges,
        budget.mode,
        end_snap_max_distance_m,
    ) {
        Ok(end) => end,
        Err((reason, extra)) => return invalid_result(started, diagnostics, reason, extra),
    };
    diag_insert(
        &mut diagnostics,
        "end",
        json!({
            "id": end.point.node_id,
            "name": end.point.name,
            "open": end.open,
            "requested": end.requested,
            "snapped": end.point.snapped,
            "snapDistanceM": round(end.point.snap_distance_m, 1),
        }),
    );
    diag_insert(&mut diagnostics, "endNode", json!(end.point.node_id));
    diag_insert(&mut diagnostics, "openTrip", json!(end.open));
    diag_insert(
        &mut diagnostics,
        "budget",
        json!({
            "mode": budget.mode.diagnostics_mode(),
            "value": budget.value,
            "units": budget.mode.public_units(),
        }),
    );
    diag_insert(&mut diagnostics, "themes", json!(theme_profile));
    diag_insert(&mut diagnostics, "seed", json!(options.seed));

    let rng_seed = options
        .seed
        .unwrap_or(0x9E37_79B9_7F4A_7C15_u64 ^ graph.edge_count() as u64);
    let mut exclude_ids = BTreeSet::from([start.node_id.to_string()]);
    if end.point.node_id != start.node_id {
        exclude_ids.insert(end.point.node_id.to_string());
    }
    let expanded_exclusions = expand_pass_siblings(graph, &exclude_ids);
    let all_candidates: Vec<Candidate> =
        build_candidates(graph, ears, &forbidden_pass_ids, &theme_profile)
            .into_iter()
            .filter(|candidate| {
                !expanded_exclusions.contains(candidate.node_id.as_str())
                    && !expanded_exclusions.contains(candidate.id.as_str())
            })
            .collect();
    let candidate_by_alias = index_candidates(&all_candidates);
    let mut must = Vec::new();
    let mut must_seen = BTreeSet::new();
    for id in must_visit_ids {
        let resolved = candidate_by_alias.get(id).or_else(|| {
            resolve_pass_id(graph, id).and_then(|pass_id| candidate_by_alias.get(&pass_id))
        });
        let Some(candidate) = resolved else {
            let mut extra = Map::new();
            extra.insert("mustVisitId".to_owned(), json!(id));
            return invalid_result(started, diagnostics, "invalid-must-visit", extra);
        };
        if must_seen.insert(candidate.id.clone()) {
            must.push(candidate.clone());
        }
    }

    let cache_limit = options.max_cache_entries.max(100);
    let mut env = Env {
        graph,
        ears,
        budget,
        start: start.clone(),
        end: end.clone(),
        open_end: end.open,
        advanced,
        theme_profile,
        forbidden_nodes,
        forbidden_edges,
        rng: Mulberry32::new(rng_seed),
        iterations: 0,
        leg_cache: LruBounded::new(cache_limit),
        route_cache: LruBounded::new(cache_limit),
        cache_limit,
        materialization_stats: MaterializationStats::default(),
    };
    diag_insert(&mut diagnostics, "maxCacheEntries", json!(env.cache_limit));

    if let Some(from_id) = validate_end_reachability(&mut env, &must) {
        let mut extra = Map::new();
        extra.insert("endNode".to_owned(), json!(env.end.point.node_id));
        extra.insert("unreachableFrom".to_owned(), json!(from_id));
        return invalid_result(started, diagnostics, "end-unreachable", extra);
    }

    let mut pool = if advanced {
        must.clone()
    } else {
        rank_candidates(&mut env.rng, &all_candidates, graph, &start.node_id, budget)
            .into_iter()
            .take(MAX_AUTO_CANDIDATES)
            .collect()
    };
    if advanced {
        // Sort pool by id for input-order independence. JS preserves user-input
        // order; we sort to make output reproducible regardless of how the UI
        // serialized must-visit ids. This is a deliberate JS-parity divergence;
        // see crates/leisure-core/README.md "Deliberate Divergences from JS".
        pool.sort_by(|a, b| a.id.cmp(&b.id));
    }
    diag_insert(
        &mut diagnostics,
        "candidateCount",
        json!(all_candidates.len()),
    );
    diag_insert(&mut diagnostics, "searchCandidateCount", json!(pool.len()));
    let search_bound = diagnostics
        .get("searchBound")
        .cloned()
        .unwrap_or_else(|| json!({}));
    diag_insert(
        &mut diagnostics,
        "searchBound",
        enrich_search_bound(search_bound, advanced, pool.len()),
    );
    diag_insert(
        &mut diagnostics,
        "mustVisitIds",
        json!(must.iter().map(|item| item.id.clone()).collect::<Vec<_>>()),
    );

    let required_set: BTreeSet<String> = must.iter().map(|item| item.id.clone()).collect();
    let mut archive = BTreeMap::new();
    let mut primary = evaluate_route(&mut env, &[]);
    record_tour(&mut archive, &primary);

    let greedy_started = ClockInstant::now();
    let greedy_deadline = if seeded {
        None
    } else {
        Some(
            started
                + duration_from_ms(if must.is_empty() {
                    STAGE1_MS
                } else {
                    STAGE1_ADVANCED_RETRY_MS
                }),
        )
    };
    let mut greedy_limiter = SearchLimiter {
        deadline: greedy_deadline,
        move_cap: if seeded { STAGE1_MOVES } else { usize::MAX / 4 },
        moves: 0,
    };
    let mut route;
    if !must.is_empty() {
        let built = greedy_construct(
            &mut env,
            &[],
            &must,
            &required_set,
            &mut greedy_limiter,
            true,
            &mut archive,
        );
        if !built.complete {
            let remaining: Vec<Candidate> = built
                .remaining
                .iter()
                .filter(|candidate| !built.route.iter().any(|item| item.id == candidate.id))
                .cloned()
                .collect();
            let retry = greedy_construct(
                &mut env,
                &built.route,
                &remaining,
                &required_set,
                &mut greedy_limiter,
                true,
                &mut archive,
            );
            diag_insert(&mut diagnostics, "advancedGreedyRetried", json!(true));
            if !retry.complete {
                let mut extra = Map::new();
                extra.insert(
                    "missingMustVisitIds".to_owned(),
                    json!(retry
                        .remaining
                        .iter()
                        .map(|item| item.id.clone())
                        .collect::<Vec<_>>()),
                );
                return invalid_result(started, diagnostics, "unreachable-must-visits", extra);
            }
            route = retry.route;
        } else {
            route = built.route;
        }
    } else {
        route = greedy_construct(
            &mut env,
            &[],
            &pool,
            &required_set,
            &mut greedy_limiter,
            false,
            &mut archive,
        )
        .route;
    }
    primary = best_of(primary, evaluate_route(&mut env, &route));
    if env.open_end && advanced && contains_all(&route, &required_set) {
        primary = evaluate_route(&mut env, &route);
    }
    record_tour(&mut archive, &primary);
    let greedy_ms = round(greedy_started.elapsed_ms(), 3);

    let ls_started = ClockInstant::now();
    let mut ls_limiter = SearchLimiter {
        deadline: if seeded {
            None
        } else {
            Some((ClockInstant::now() + duration_from_ms(STAGE2_MS)).min(end_at))
        },
        move_cap: if seeded { STAGE2_MOVES } else { usize::MAX / 4 },
        moves: 0,
    };
    let searched = local_search(
        &mut env,
        &primary.route,
        &required_set,
        &pool,
        &mut ls_limiter,
        &mut archive,
    );
    route = searched.route;
    primary = best_of(primary, evaluate_route(&mut env, &route));
    let local_ms = round(ls_started.elapsed_ms(), 3);

    let perturb_started = ClockInstant::now();
    let mut perturbations = 0usize;
    let mut no_improvement = 0usize;
    while perturbations < iteration_cap && (seeded || ClockInstant::now() < end_at) {
        perturbations += 1;
        env.iterations = env.iterations.saturating_add(1);
        let force_double_bridge =
            options.max_no_improvement > 0 && no_improvement >= options.max_no_improvement;
        let seed_route = perturb_route(
            &mut env,
            &primary.route,
            &required_set,
            &pool,
            force_double_bridge,
        );
        let searched_route = if seeded {
            seed_route
        } else {
            let mut limiter = SearchLimiter {
                deadline: Some((ClockInstant::now() + duration_from_ms(45.0)).min(end_at)),
                move_cap: usize::MAX / 4,
                moves: 0,
            };
            local_search(
                &mut env,
                &seed_route,
                &required_set,
                &pool,
                &mut limiter,
                &mut archive,
            )
            .route
        };
        let candidate = evaluate_route(&mut env, &searched_route);
        record_tour(&mut archive, &candidate);
        let previous = primary.clone();
        primary = best_of(primary, candidate);
        if primary.signature == previous.signature {
            no_improvement = no_improvement.saturating_add(1);
        } else {
            no_improvement = 0;
        }
    }
    let perturb_ms = round(perturb_started.elapsed_ms(), 3);

    if advanced && !contains_all(&primary.route, &required_set) {
        let mut extra = Map::new();
        extra.insert(
            "missingMustVisitIds".to_owned(),
            json!(required_set
                .iter()
                .filter(|id| !primary.route.iter().any(|item| &item.id == *id))
                .cloned()
                .collect::<Vec<_>>()),
        );
        return invalid_result(started, diagnostics, "unreachable-must-visits", extra);
    }
    if advanced && !env.open_end && !primary.budget_fit.within {
        let mut extra = Map::new();
        extra.insert("budgetFit".to_owned(), json!(primary.budget_fit));
        return invalid_result(started, diagnostics, "must-visits-exceed-budget", extra);
    }
    if !primary.feasible {
        return invalid_result(started, diagnostics, "unreachable-route", Map::new());
    }

    let mut ranked: Vec<InternalTour> = archive
        .values()
        .filter(|tour| tour.feasible && (!advanced || contains_all(&tour.route, &required_set)))
        .cloned()
        .collect();
    ranked.sort_by(compare_tours);
    if let Some(best) = ranked.first().cloned() {
        primary = best;
    }
    let max_alternatives = options.k_alternatives.saturating_sub(1);
    let alternatives = ranked
        .iter()
        .filter(|tour| tour.signature != primary.signature)
        .take(max_alternatives)
        .map(|tour| public_tour(graph, tour))
        .collect::<Vec<_>>();
    let public_primary = public_tour(graph, &primary);

    diag_insert(
        &mut diagnostics,
        "stageTimingsMs",
        json!({
            "greedy": greedy_ms,
            "localSearch": local_ms,
            "perturbation": perturb_ms,
        }),
    );
    diag_insert(
        &mut diagnostics,
        "cache",
        json!({ "legs": env.leg_cache.len(), "routes": env.route_cache.len() }),
    );
    diag_insert(
        &mut diagnostics,
        "materialization",
        json!(env.materialization_stats),
    );

    let mut status = PlanStatus::Ok;
    if public_primary
        .stops
        .iter()
        .filter(|stop| !is_sentinel_stop(stop))
        .count()
        == 0
    {
        status = PlanStatus::Degraded;
        push_degraded_reason(&mut diagnostics, "no-pass-fit-budget-or-restrictions");
    }
    if env.open_end && !public_primary.budget_fit.within {
        status = PlanStatus::Degraded;
        push_degraded_reason(&mut diagnostics, "budget-exceeded-by-end");
        diag_insert(&mut diagnostics, "reason", json!("budget-exceeded-by-end"));
    }

    finalize(
        status,
        Some(public_primary),
        alternatives,
        env.iterations,
        started,
        diagnostics,
    )
}

struct GreedyResult {
    route: Vec<Candidate>,
    complete: bool,
    remaining: Vec<Candidate>,
}

struct SearchResult {
    route: Vec<Candidate>,
}

fn greedy_construct(
    env: &mut Env<'_>,
    seed_route: &[Candidate],
    candidates: &[Candidate],
    required_set: &BTreeSet<String>,
    limiter: &mut SearchLimiter,
    require_all: bool,
    archive: &mut BTreeMap<String, InternalTour>,
) -> GreedyResult {
    let mut route = seed_route.to_vec();
    let mut placed: BTreeSet<String> = route.iter().map(|item| item.id.clone()).collect();
    let mut current = evaluate_route(env, &route);
    record_tour(archive, &current);
    let mut remaining: Vec<Candidate> = candidates
        .iter()
        .filter(|item| !placed.contains(&item.id))
        .cloned()
        .collect();

    while !remaining.is_empty() && limiter.has_budget() {
        let mut best_move: Option<(Vec<Candidate>, InternalTour, Candidate, f64, f64)> = None;
        let scan_len = if require_all {
            remaining.len()
        } else {
            remaining.len().min(MAX_INSERTION_SCAN)
        };
        let scan = remaining.iter().take(scan_len).cloned().collect::<Vec<_>>();
        for candidate in scan {
            if !limiter.has_budget() {
                break;
            }
            let mut options = Vec::new();
            for pos in 0..=route.len() {
                if !limiter.has_budget() {
                    break;
                }
                let next_route = insert_at(&route, pos, candidate.clone());
                let tour = evaluate_route(env, &next_route);
                limiter.count_move();
                env.iterations = env.iterations.saturating_add(1);
                if !tour.feasible {
                    continue;
                }
                record_tour(archive, &tour);
                let delta = tour.score - current.score;
                options.push((next_route, tour, delta));
            }
            if options.is_empty() {
                continue;
            }
            options.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| compare_tours(&a.1, &b.1)));
            let second_delta = options.get(1).map(|item| item.2).unwrap_or(if require_all {
                -10_000.0
            } else {
                0.0
            });
            let priority = options[0].2 + 0.25 * (options[0].2 - second_delta);
            let replace = match &best_move {
                None => true,
                Some((_, best_tour, _, best_priority, _)) => {
                    priority > *best_priority + EPS
                        || ((priority - *best_priority).abs() <= EPS
                            && options[0].1.score > best_tour.score)
                }
            };
            if replace {
                best_move = Some((
                    options[0].0.clone(),
                    options[0].1.clone(),
                    candidate,
                    priority,
                    options[0].2,
                ));
            }
        }
        let Some((next_route, tour, candidate, _, delta)) = best_move else {
            break;
        };
        if !require_all && delta <= EPS {
            break;
        }
        route = next_route;
        current = tour;
        placed.insert(candidate.id.clone());
        remaining.retain(|item| item.id != candidate.id);
        if require_all && contains_all(&route, required_set) {
            remaining.retain(|item| !required_set.contains(&item.id));
        }
    }

    GreedyResult {
        route,
        complete: remaining.is_empty(),
        remaining,
    }
}

fn local_search(
    env: &mut Env<'_>,
    seed_route: &[Candidate],
    required_set: &BTreeSet<String>,
    pool: &[Candidate],
    limiter: &mut SearchLimiter,
    archive: &mut BTreeMap<String, InternalTour>,
) -> SearchResult {
    let mut route = seed_route.to_vec();
    let mut best = evaluate_route(env, &route);
    record_tour(archive, &best);

    loop {
        if !limiter.has_budget() {
            break;
        }
        if let Some((next_route, next_tour)) =
            try_two_opt(env, &route, &best, required_set, limiter, archive)
        {
            route = next_route;
            best = next_tour;
            continue;
        }
        if let Some((next_route, next_tour)) =
            try_or_opt(env, &route, &best, required_set, limiter, archive)
        {
            route = next_route;
            best = next_tour;
            continue;
        }
        if let Some((next_route, next_tour)) =
            try_removal(env, &route, &best, required_set, limiter, archive)
        {
            route = next_route;
            best = next_tour;
            continue;
        }
        if let Some((next_route, next_tour)) =
            try_insertion(env, &route, &best, required_set, pool, limiter, archive)
        {
            route = next_route;
            best = next_tour;
            continue;
        }
        break;
    }

    SearchResult { route }
}

fn try_two_opt(
    env: &mut Env<'_>,
    route: &[Candidate],
    best: &InternalTour,
    required_set: &BTreeSet<String>,
    limiter: &mut SearchLimiter,
    archive: &mut BTreeMap<String, InternalTour>,
) -> Option<(Vec<Candidate>, InternalTour)> {
    for i in 0..route.len().saturating_sub(1) {
        for j in i + 1..route.len() {
            if !limiter.has_budget() {
                return None;
            }
            let mut next = route[..i].to_vec();
            next.extend(route[i..=j].iter().rev().cloned());
            next.extend(route[j + 1..].iter().cloned());
            if let Some(accepted) = evaluate_move(env, next, best, required_set, limiter, archive) {
                return Some(accepted);
            }
        }
    }
    None
}

fn try_or_opt(
    env: &mut Env<'_>,
    route: &[Candidate],
    best: &InternalTour,
    required_set: &BTreeSet<String>,
    limiter: &mut SearchLimiter,
    archive: &mut BTreeMap<String, InternalTour>,
) -> Option<(Vec<Candidate>, InternalTour)> {
    for len in 1..=3 {
        if route.len() <= len {
            continue;
        }
        for i in 0..=route.len() - len {
            let segment = route[i..i + len].to_vec();
            let mut rest = route[..i].to_vec();
            rest.extend(route[i + len..].iter().cloned());
            for pos in 0..=rest.len() {
                if !limiter.has_budget() {
                    return None;
                }
                if pos == i {
                    continue;
                }
                let mut next = rest[..pos].to_vec();
                next.extend(segment.iter().cloned());
                next.extend(rest[pos..].iter().cloned());
                if let Some(accepted) =
                    evaluate_move(env, next, best, required_set, limiter, archive)
                {
                    return Some(accepted);
                }
            }
        }
    }
    None
}

fn try_removal(
    env: &mut Env<'_>,
    route: &[Candidate],
    best: &InternalTour,
    required_set: &BTreeSet<String>,
    limiter: &mut SearchLimiter,
    archive: &mut BTreeMap<String, InternalTour>,
) -> Option<(Vec<Candidate>, InternalTour)> {
    for i in 0..route.len() {
        if !limiter.has_budget() {
            return None;
        }
        if required_set.contains(&route[i].id) {
            continue;
        }
        let mut next = route[..i].to_vec();
        next.extend(route[i + 1..].iter().cloned());
        if let Some(accepted) = evaluate_move(env, next, best, required_set, limiter, archive) {
            return Some(accepted);
        }
    }
    None
}

fn try_insertion(
    env: &mut Env<'_>,
    route: &[Candidate],
    best: &InternalTour,
    required_set: &BTreeSet<String>,
    pool: &[Candidate],
    limiter: &mut SearchLimiter,
    archive: &mut BTreeMap<String, InternalTour>,
) -> Option<(Vec<Candidate>, InternalTour)> {
    let present: BTreeSet<String> = route.iter().map(|item| item.id.clone()).collect();
    for candidate in pool.iter().take(MAX_INSERTION_SCAN) {
        if present.contains(&candidate.id) {
            continue;
        }
        for pos in 0..=route.len() {
            if !limiter.has_budget() {
                return None;
            }
            let next = insert_at(route, pos, candidate.clone());
            if let Some(accepted) = evaluate_move(env, next, best, required_set, limiter, archive) {
                return Some(accepted);
            }
        }
    }
    None
}

fn evaluate_move(
    env: &mut Env<'_>,
    route: Vec<Candidate>,
    best: &InternalTour,
    required_set: &BTreeSet<String>,
    limiter: &mut SearchLimiter,
    archive: &mut BTreeMap<String, InternalTour>,
) -> Option<(Vec<Candidate>, InternalTour)> {
    let tour = evaluate_route(env, &route);
    limiter.count_move();
    env.iterations = env.iterations.saturating_add(1);
    if tour.feasible {
        record_tour(archive, &tour);
    }
    if tour.feasible && tour.score > best.score + EPS && contains_all(&route, required_set) {
        Some((route, tour))
    } else {
        None
    }
}

fn perturb_route(
    env: &mut Env<'_>,
    route: &[Candidate],
    required_set: &BTreeSet<String>,
    pool: &[Candidate],
    force_double_bridge: bool,
) -> Vec<Candidate> {
    if force_double_bridge && route.len() >= 4 {
        env.materialization_stats.double_bridge_count += 1;
        return double_bridge(route, &mut env.rng);
    }
    if route.len() >= 8 && env.rng.next_f64() < 0.3 {
        env.materialization_stats.double_bridge_count += 1;
        return double_bridge(route, &mut env.rng);
    }
    if env.rng.next_f64() < 0.3 {
        return random_restart(env, required_set, pool);
    }
    if env.rng.next_f64() < 0.5 {
        return kick_by_ear(env, route, required_set, pool);
    }
    random_kick(env, route, required_set, pool)
}

fn double_bridge(route: &[Candidate], rng: &mut Mulberry32) -> Vec<Candidate> {
    let n = route.len();
    if n < 2 {
        return route.to_vec();
    }
    let mut cuts = BTreeSet::new();
    for _ in 0..4 {
        cuts.insert(1 + rng.index(n - 1));
    }
    if cuts.len() < 4 {
        let mut reversed = route.to_vec();
        reversed.reverse();
        return reversed;
    }
    let cuts: Vec<usize> = cuts.into_iter().collect();
    let (a, b, c, d) = (cuts[0], cuts[1], cuts[2], cuts[3]);
    let mut out = Vec::with_capacity(n);
    out.extend_from_slice(&route[..a]);
    out.extend_from_slice(&route[c..d]);
    out.extend_from_slice(&route[b..c]);
    out.extend_from_slice(&route[a..b]);
    out.extend_from_slice(&route[d..]);
    out
}

fn random_restart(
    env: &mut Env<'_>,
    required_set: &BTreeSet<String>,
    pool: &[Candidate],
) -> Vec<Candidate> {
    let mut route = shuffle(
        &pool
            .iter()
            .filter(|item| required_set.contains(&item.id))
            .cloned()
            .collect::<Vec<_>>(),
        &mut env.rng,
    );
    for candidate in shuffle(
        &pool
            .iter()
            .filter(|item| !required_set.contains(&item.id))
            .cloned()
            .collect::<Vec<_>>(),
        &mut env.rng,
    )
    .into_iter()
    .take(12)
    {
        let pos = env.rng.index(route.len() + 1);
        let next = insert_at(&route, pos, candidate);
        if evaluate_route(env, &next).feasible {
            route = next;
        }
    }
    route
}

fn kick_by_ear(
    env: &mut Env<'_>,
    route: &[Candidate],
    required_set: &BTreeSet<String>,
    pool: &[Candidate],
) -> Vec<Candidate> {
    let ear_indices = route
        .iter()
        .flat_map(|item| item.ear_indices.iter().copied())
        .collect::<Vec<_>>();
    let Some(ear_index) = ear_indices.get(env.rng.index(ear_indices.len())).copied() else {
        return random_kick(env, route, required_set, pool);
    };
    let mut next: Vec<Candidate> = route
        .iter()
        .filter(|item| required_set.contains(&item.id) || !item.ear_indices.contains(&ear_index))
        .cloned()
        .collect();
    let additions: Vec<Candidate> = pool
        .iter()
        .filter(|item| {
            !next.iter().any(|route_item| route_item.id == item.id)
                && item.ear_indices.contains(&ear_index)
        })
        .cloned()
        .collect();
    for candidate in shuffle(&additions, &mut env.rng).into_iter().take(3) {
        let pos = env.rng.index(next.len() + 1);
        next = insert_at(&next, pos, candidate);
    }
    if !same_route_ids(&next, route) {
        return next;
    }
    env.materialization_stats.degenerate_perturbations += 1;
    random_kick(env, route, required_set, pool)
}

fn random_kick(
    env: &mut Env<'_>,
    route: &[Candidate],
    required_set: &BTreeSet<String>,
    pool: &[Candidate],
) -> Vec<Candidate> {
    let mut next: Vec<Candidate> = route
        .iter()
        .filter(|item| required_set.contains(&item.id) || env.rng.next_f64() > 0.35)
        .cloned()
        .collect();
    let mut present: BTreeSet<String> = next.iter().map(|item| item.id.clone()).collect();
    let additions: Vec<Candidate> = pool
        .iter()
        .filter(|item| !present.contains(&item.id))
        .cloned()
        .collect();
    for candidate in shuffle(&additions, &mut env.rng).into_iter().take(2) {
        let pos = env.rng.index(next.len() + 1);
        present.insert(candidate.id.clone());
        next = insert_at(&next, pos, candidate);
    }
    if same_route_ids(&next, route) && route.len() > 1 {
        next = route.iter().rev().cloned().collect();
    }
    if same_route_ids(&next, route) {
        env.materialization_stats.degenerate_perturbations += 1;
    }
    next
}

fn evaluate_route(env: &mut Env<'_>, route: &[Candidate]) -> InternalTour {
    let signature = route_signature(route);
    if let Some(cached) = env.route_cache.recall(&signature).cloned() {
        return cached;
    }

    let mut nodes = Vec::with_capacity(route.len() + 2);
    nodes.push(env.start.node_id.clone());
    nodes.extend(route.iter().map(|item| item.node_id.clone()));
    nodes.push(env.end.point.node_id.clone());
    let baseline = materialize_route(env, &nodes, false, 0.0);
    if !baseline.ok {
        let failed = failed_tour(env, route, signature);
        env.route_cache
            .remember(failed.signature.clone(), failed.clone());
        return failed;
    }

    let baseline_edges: Vec<usize> = baseline.edge_ids.clone();
    let baseline_used = budget_used(env.budget, &baseline);
    let baseline_fit = budget_fit_object(env.budget, baseline_used);
    let mut materialized = baseline;
    if baseline_fit.within && count_retraced_connectors(env.graph, &baseline_edges) > 0 {
        let retry = materialize_route(
            env,
            &nodes,
            true,
            (env.budget.value - baseline_used).max(0.0),
        );
        if retry.ok {
            materialized = retry;
        }
    }

    let retraced_connector_count = count_retraced_connectors(env.graph, &materialized.edge_ids);
    let out_and_back_count = count_out_and_back(env.graph, route, &materialized.legs);
    let scenic_sum = route.iter().map(|item| item.scenic_score).sum::<f64>();
    let theme_coverage = compute_theme_coverage(route, &env.theme_profile);
    let ear_indices = ears_for_route_indices(env, route, &materialized.edge_ids);
    let ears_traversed = ear_indices
        .iter()
        .filter_map(|&index| env.ears.ears.get(index).map(|ear| ear.id.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let loop_ear_count = ear_indices
        .iter()
        .filter(|&&index| env.ears.ears.get(index).map(|ear| ear.kind) == Some(EarKind::Loop))
        .count();
    let used = match env.budget.mode {
        BudgetMode::Duration => materialized.total_duration_s,
        BudgetMode::Distance => materialized.total_distance_m / 1000.0,
    };
    let budget_fit = budget_fit_object(env.budget, used);
    let score = score_tour(
        scenic_sum,
        &theme_coverage,
        materialized.total_leisure_cost,
        retraced_connector_count,
        out_and_back_count,
        loop_ear_count,
        &budget_fit,
    );
    let feasible = budget_fit.within || (env.open_end && (env.advanced || route.is_empty()));
    let tour = InternalTour {
        feasible,
        route: route.to_vec(),
        signature,
        end_node: env.end.point.node_id.clone(),
        stops: public_stops(&env.start, route, &env.end),
        edges: materialized.edge_ids,
        total_leisure_cost: round(materialized.total_leisure_cost, 3),
        total_distance_km: round(materialized.total_distance_m / 1000.0, 3),
        total_duration_h: round(materialized.total_duration_s / 3600.0, 4),
        scenic_sum: round(scenic_sum, 4),
        retraced_connector_count,
        out_and_back_count,
        ears_traversed,
        theme_coverage,
        budget_fit,
        path: materialized.path_nodes,
        score: round(score, 3),
        duration_s: round(materialized.total_duration_s, 3),
    };
    env.route_cache
        .remember(tour.signature.clone(), tour.clone());
    tour
}

fn materialize_route(
    env: &mut Env<'_>,
    nodes: &[NodeId],
    allow_leisure: bool,
    mut budget_slack: f64,
) -> MaterializedRoute {
    let mut edge_ids = Vec::new();
    let mut path_nodes = Vec::new();
    let mut legs = Vec::new();
    let mut used_connector_edges = BTreeSet::new();
    let mut total_leisure_cost = 0.0;
    let mut total_distance_m = 0.0;
    let mut total_duration_s = 0.0;

    for pair in nodes.windows(2) {
        let options = leg_between(
            env,
            &pair[0],
            &pair[1],
            &used_connector_edges,
            allow_leisure,
        );
        if options.budget.status != AStarStatus::Ok {
            return MaterializedRoute {
                ok: false,
                legs,
                edge_ids,
                path_nodes,
                total_leisure_cost,
                total_distance_m,
                total_duration_s,
            };
        }
        let mut leg = options.budget;
        if allow_leisure {
            if let Some(leisure) = options.leisure {
                let extra_budget =
                    leg_budget_metric(env.budget, &leisure) - leg_budget_metric(env.budget, &leg);
                if extra_budget <= budget_slack + EPS {
                    leg = leisure;
                    budget_slack -= extra_budget.max(0.0);
                    env.materialization_stats.leisure_accepted += 1;
                }
            }
        }
        edge_ids.extend(leg.edges.iter().copied());
        if path_nodes.is_empty() {
            path_nodes.extend(leg.path.iter().cloned());
        } else {
            path_nodes.extend(leg.path.iter().skip(1).cloned());
        }
        total_leisure_cost += leg.total_leisure_cost;
        total_distance_m += leg.total_distance_m;
        total_duration_s += leg.total_duration_s;
        for &edge_id in &leg.edges {
            add_used_connector_edge(env.graph, &mut used_connector_edges, edge_id);
        }
        legs.push(leg);
    }

    MaterializedRoute {
        ok: true,
        legs,
        edge_ids,
        path_nodes,
        total_leisure_cost,
        total_distance_m,
        total_duration_s,
    }
}

fn leg_between(
    env: &mut Env<'_>,
    from_id: &NodeId,
    to_id: &NodeId,
    used_edges: &BTreeSet<usize>,
    allow_leisure: bool,
) -> LegOptions {
    let used_key = stable_edge_set_key(used_edges);
    let key = format!(
        "options\x1F{}\x1F{}\x1F{}\x1F{}\x1F{}",
        usize::from(allow_leisure),
        env.budget.mode.diagnostics_mode(),
        from_id,
        to_id,
        used_key
    );
    if let Some(cached) = env.leg_cache.recall(&key).cloned() {
        return cached;
    }
    let budget = budget_leg_between(env, from_id, to_id);
    let mut result = LegOptions {
        budget: budget.clone(),
        leisure: None,
    };
    if allow_leisure && budget.status == AStarStatus::Ok && !used_edges.is_empty() {
        let leisure = leisure_leg_between(
            env,
            from_id,
            to_id,
            used_edges,
            &used_key,
            retry_leisure_cost_limit(&budget),
        );
        if leisure.status == AStarStatus::Ok
            && count_leg_used_connector_overlaps(env.graph, &leisure, used_edges)
                < count_leg_used_connector_overlaps(env.graph, &budget, used_edges)
        {
            result.leisure = Some(leisure);
        }
    }
    env.leg_cache.remember(key, result.clone());
    result
}

fn budget_leg_between(env: &mut Env<'_>, from_id: &NodeId, to_id: &NodeId) -> AStarResult {
    let key = format!(
        "budget\x1F{}\x1F{}\x1F{}",
        env.budget.mode.diagnostics_mode(),
        from_id,
        to_id
    );
    if let Some(cached) = env.leg_cache.recall(&key).map(|item| item.budget.clone()) {
        return cached;
    }
    let mut options = AStarOptions {
        cost_mode: env.budget.mode.cost_mode(),
        forbidden_edges: env.forbidden_edges.clone(),
        forbidden_nodes: env.forbidden_nodes.clone(),
        ..AStarOptions::default()
    };
    if !env.open_end {
        options.budget_cost = Some(match env.budget.mode {
            BudgetMode::Duration => env.budget.value,
            BudgetMode::Distance => env.budget.value * 1000.0,
        });
    }
    let result = leisure_astar(env.graph, from_id, to_id, &options);
    let wrapped = LegOptions {
        budget: result.clone(),
        leisure: None,
    };
    env.leg_cache.remember(key, wrapped);
    result
}

fn leisure_leg_between(
    env: &mut Env<'_>,
    from_id: &NodeId,
    to_id: &NodeId,
    used_edges: &BTreeSet<usize>,
    used_key: &str,
    max_leisure_cost: f64,
) -> AStarResult {
    let key = format!(
        "leisure\x1F{}\x1F{}\x1F{}\x1F{}",
        env.budget.mode.diagnostics_mode(),
        from_id,
        to_id,
        used_key
    );
    if let Some(cached) = env.leg_cache.recall(&key).map(|item| item.budget.clone()) {
        return cached;
    }
    env.materialization_stats.leisure_retries += 1;
    let mut options = AStarOptions {
        cost_mode: CostMode::Leisure,
        forbidden_edges: env.forbidden_edges.clone(),
        forbidden_nodes: env.forbidden_nodes.clone(),
        used_edges: used_edges.iter().copied().collect(),
        used_edges_penalty: USED_EDGES_PENALTY,
        ..AStarOptions::default()
    };
    if max_leisure_cost.is_finite() {
        options.budget_cost = Some(max_leisure_cost);
    }
    let result = leisure_astar(env.graph, from_id, to_id, &options);
    let wrapped = LegOptions {
        budget: result.clone(),
        leisure: None,
    };
    env.leg_cache.remember(key, wrapped);
    result
}

fn failed_tour(env: &Env<'_>, route: &[Candidate], signature: String) -> InternalTour {
    InternalTour {
        feasible: false,
        route: route.to_vec(),
        signature,
        end_node: env.end.point.node_id.clone(),
        stops: public_stops(&env.start, route, &env.end),
        edges: Vec::new(),
        total_leisure_cost: 0.0,
        total_distance_km: 0.0,
        total_duration_h: 0.0,
        scenic_sum: 0.0,
        retraced_connector_count: 0,
        out_and_back_count: 0,
        ears_traversed: Vec::new(),
        theme_coverage: compute_theme_coverage(&[], &env.theme_profile),
        budget_fit: BudgetFit {
            within: false,
            ..budget_fit_object(env.budget, 0.0)
        },
        path: Vec::new(),
        score: f64::NEG_INFINITY,
        duration_s: 0.0,
    }
}

fn public_tour(graph: &LeisureGraph, tour: &InternalTour) -> PublicTour {
    PublicTour {
        end_node: tour.end_node.clone(),
        stops: tour.stops.clone(),
        edges: tour
            .edges
            .iter()
            .filter_map(|&index| graph.edges.get(index).map(|edge| edge.canonical_id()))
            .collect(),
        total_leisure_cost: tour.total_leisure_cost,
        total_distance_km: tour.total_distance_km,
        total_duration_h: tour.total_duration_h,
        scenic_sum: tour.scenic_sum,
        retraced_connector_count: tour.retraced_connector_count,
        out_and_back_count: tour.out_and_back_count,
        ears_traversed: tour.ears_traversed.clone(),
        theme_coverage: tour.theme_coverage.clone(),
        budget_fit: tour.budget_fit.clone(),
        path: tour.path.clone(),
        score: tour.score,
    }
}

fn public_stops(start: &ResolvedPoint, route: &[Candidate], end: &ResolvedEnd) -> Vec<PublicStop> {
    let start_stop = PublicStop {
        id: start.node_id.to_string(),
        node_id: start.node_id.clone(),
        pass_id: None,
        kind: "start".to_owned(),
        name: start.name.clone(),
        lat: start.lat,
        lon: start.lon,
        themes: Vec::new(),
        scenic_score: None,
        order: 0,
        return_to_start: false,
    };
    let mut stops = vec![start_stop.clone()];
    stops.extend(route.iter().enumerate().map(|(index, item)| PublicStop {
        id: item.id.clone(),
        node_id: item.node_id.clone(),
        pass_id: item.pass_id.clone(),
        kind: item.kind.clone(),
        name: item.name.clone(),
        lat: item.lat,
        lon: item.lon,
        themes: item.themes.clone(),
        scenic_score: Some(item.scenic_score),
        order: index + 1,
        return_to_start: false,
    }));
    if end.open && end.point.node_id != start.node_id {
        stops.push(PublicStop {
            id: end.point.node_id.to_string(),
            node_id: end.point.node_id.clone(),
            pass_id: None,
            kind: "end".to_owned(),
            name: end.point.name.clone(),
            lat: end.point.lat,
            lon: end.point.lon,
            themes: Vec::new(),
            scenic_score: None,
            order: route.len() + 1,
            return_to_start: false,
        });
        return stops;
    }
    if route.is_empty() {
        return stops;
    }
    let mut return_stop = start_stop;
    return_stop.kind = "return".to_owned();
    return_stop.return_to_start = true;
    return_stop.order = route.len() + 1;
    stops.push(return_stop);
    stops
}

fn build_candidates(
    graph: &LeisureGraph,
    ears: &EarDecomposition,
    forbidden_pass_ids: &BTreeSet<String>,
    theme_profile: &ThemeProfile,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut pass_ids = graph.nodes_of_kind(NodeKind::Pass).to_vec();
    pass_ids.sort();
    for pass_id in pass_ids {
        if forbidden_pass_ids.contains(pass_id.as_str()) {
            continue;
        }
        let Some(pass) = graph.node(&pass_id) else {
            continue;
        };
        let node_id = graph
            .pass_sides_for(pass_id.as_str())
            .and_then(|sides| sides.summit)
            .or_else(|| {
                let synthetic = NodeId::new(format!("{pass_id}:S"));
                graph.nodes.contains_key(&synthetic).then_some(synthetic)
            })
            .unwrap_or_else(|| pass_id.clone());
        if !graph.nodes.contains_key(&node_id) {
            continue;
        }
        candidates.push(make_candidate(
            pass,
            "pass",
            node_id,
            Some(pass_id.to_string()),
            ears,
            theme_profile,
        ));
    }

    let mut poi_ids = graph.nodes_of_kind(NodeKind::Poi).to_vec();
    poi_ids.sort();
    for poi_id in poi_ids {
        if let Some(poi) = graph.node(&poi_id) {
            candidates.push(make_candidate(
                poi,
                "poi",
                poi.id.clone(),
                None,
                ears,
                theme_profile,
            ));
        }
    }

    candidates.sort_by(|a, b| {
        b.base_reward
            .total_cmp(&a.base_reward)
            .then_with(|| a.id.cmp(&b.id))
    });
    candidates
}

fn make_candidate(
    node: &Node,
    kind: &str,
    node_id: NodeId,
    pass_id: Option<String>,
    ears: &EarDecomposition,
    theme_profile: &ThemeProfile,
) -> Candidate {
    let themes = normalize_tokens(&node.themes);
    let scenic_score = clamp01(node.scenic_score.or(node.score).unwrap_or(0.5));
    let requested: BTreeSet<&String> = theme_profile.requested.iter().collect();
    let theme_hits = themes
        .iter()
        .filter(|theme| requested.contains(theme))
        .count();
    let ear_indices = pass_id
        .as_ref()
        .and_then(|id| ears.pass_to_ears.get(id))
        .cloned()
        .unwrap_or_default();
    Candidate {
        id: pass_id.clone().unwrap_or_else(|| node.id.to_string()),
        node_id,
        pass_id,
        kind: kind.to_owned(),
        name: node.name.clone(),
        lat: node.lat,
        lon: node.lon,
        scenic_score,
        themes,
        ear_indices,
        base_reward: scenic_score * 100.0 + theme_hits as f64 * 15.0 + node.themes.len() as f64,
    }
}

fn rank_candidates(
    rng: &mut Mulberry32,
    candidates: &[Candidate],
    graph: &LeisureGraph,
    start_node: &NodeId,
    budget: Budget,
) -> Vec<Candidate> {
    let Some(start) = graph.node(start_node) else {
        return candidates.to_vec();
    };
    let mut ranked = candidates
        .iter()
        .map(|candidate| {
            let direct_m = haversine_m(start.lat, start.lon, candidate.lat, candidate.lon);
            let rough = if budget.mode == BudgetMode::Distance {
                (2.0 * direct_m) / 1000.0
            } else {
                (2.0 * direct_m) / 22.0
            };
            let affordability = if rough.is_finite() && budget.value > 0.0 {
                (1.0 - rough / (budget.value * 1.25)).max(0.1)
            } else {
                0.1
            };
            (
                candidate.clone(),
                candidate.base_reward * affordability + rng.next_f64() * 1e-6,
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    ranked.into_iter().map(|item| item.0).collect()
}

fn index_candidates(candidates: &[Candidate]) -> BTreeMap<String, Candidate> {
    let mut index = BTreeMap::new();
    for candidate in candidates {
        index.insert(candidate.id.clone(), candidate.clone());
        index.insert(candidate.node_id.to_string(), candidate.clone());
        if let Some(pass_id) = &candidate.pass_id {
            index.insert(format!("{pass_id}:A"), candidate.clone());
            index.insert(format!("{pass_id}:S"), candidate.clone());
            index.insert(format!("{pass_id}:B"), candidate.clone());
        }
    }
    index
}

fn parse_budget(options: &PlanOptions) -> Option<Budget> {
    let seconds = options.budget_seconds.filter(|value| value.is_finite());
    let km = options.budget_km.filter(|value| value.is_finite());
    match (seconds, km) {
        (Some(value), None) => Some(Budget {
            mode: BudgetMode::Duration,
            value,
        }),
        (None, Some(value)) => Some(Budget {
            mode: BudgetMode::Distance,
            value,
        }),
        _ => None,
    }
}

fn resolve_start(
    graph: &LeisureGraph,
    start_option: &PlanPoint,
    forbidden_nodes: &HashSet<NodeId>,
) -> Option<ResolvedPoint> {
    match start_option {
        PlanPoint::Node(id) => {
            let node = graph.node(id)?;
            if forbidden_nodes.contains(&node.id) {
                return None;
            }
            Some(resolved_point_from_node(
                node,
                node.name.clone(),
                false,
                0.0,
            ))
        }
        PlanPoint::Coordinates { lat, lon, name } => {
            let (node_id, distance_m) = graph
                .nearest_nodes(*lat, *lon, &[NodeKind::Junction], 1)
                .into_iter()
                .next()?;
            if forbidden_nodes.contains(&node_id) {
                return None;
            }
            let node = graph.node(&node_id)?;
            Some(resolved_point_from_node(
                node,
                name.clone().unwrap_or_else(|| node.name.clone()),
                true,
                distance_m,
            ))
        }
    }
}

fn resolve_end(
    graph: &LeisureGraph,
    end_option: Option<&PlanPoint>,
    start: &ResolvedPoint,
    forbidden_nodes: &HashSet<NodeId>,
    forbidden_edges: &HashSet<usize>,
    cost_mode: BudgetMode,
    end_snap_max_distance_m: f64,
) -> Result<ResolvedEnd, (&'static str, Map<String, Value>)> {
    let Some(end_option) = end_option else {
        return Ok(closed_end(start, "unset"));
    };
    match end_option {
        PlanPoint::Node(value) => {
            if value == &start.node_id {
                return Ok(closed_end(start, "same-start"));
            }
            let node = graph_node_by_id(graph, value.as_str());
            let pass_id = resolve_pass_id(graph, value.as_str());
            let pass_like = pass_id.as_ref().is_some_and(|_| {
                matches!(
                    node.map(|node| &node.kind),
                    Some(NodeKind::Pass) | Some(NodeKind::PassSummit)
                ) || (node.is_none()
                    && (!value.as_str().contains(':') || value.as_str().ends_with(":S")))
            });
            if pass_like {
                if let Some(pass_id) = pass_id {
                    if let Some(base) = closest_pass_base_end(
                        graph,
                        &pass_id,
                        &start.node_id,
                        forbidden_nodes,
                        forbidden_edges,
                        cost_mode,
                    ) {
                        if base.id == start.node_id {
                            return Ok(closed_end(start, "same-start"));
                        }
                        return Ok(open_end(
                            resolved_point_from_node(base, base.name.clone(), false, 0.0),
                            value.to_string(),
                        ));
                    }
                }
                let mut extra = Map::new();
                extra.insert("endNode".to_owned(), json!(value));
                return Err(("end-unreachable", extra));
            }
            let Some(node) = node else {
                let mut extra = Map::new();
                extra.insert("endNode".to_owned(), json!(value));
                return Err(("end-unreachable", extra));
            };
            if forbidden_nodes.contains(&node.id) {
                let mut extra = Map::new();
                extra.insert("endNode".to_owned(), json!(value));
                return Err(("end-unreachable", extra));
            }
            if node.id == start.node_id {
                return Ok(closed_end(start, "same-start"));
            }
            Ok(open_end(
                resolved_point_from_node(node, node.name.clone(), false, 0.0),
                value.to_string(),
            ))
        }
        PlanPoint::Coordinates { lat, lon, name } => {
            let nearest = graph
                .nearest_nodes(*lat, *lon, &[NodeKind::Junction, NodeKind::PassBase], 32)
                .into_iter()
                .find(|(node_id, distance)| {
                    *distance <= end_snap_max_distance_m && !forbidden_nodes.contains(node_id)
                });
            let Some((node_id, distance_m)) = nearest else {
                let mut extra = Map::new();
                extra.insert(
                    "endNode".to_owned(),
                    json!({ "lat": lat, "lon": lon, "name": name }),
                );
                extra.insert(
                    "snapMaxDistanceM".to_owned(),
                    json!(end_snap_max_distance_m),
                );
                return Err(("end-snap-failed", extra));
            };
            let Some(node) = graph.node(&node_id) else {
                let mut extra = Map::new();
                extra.insert("endNode".to_owned(), json!(node_id));
                return Err(("end-unreachable", extra));
            };
            if node.id == start.node_id {
                return Ok(closed_end(start, "same-start"));
            }
            let mut point = resolved_point_from_node(
                node,
                name.clone().unwrap_or_else(|| node.name.clone()),
                true,
                distance_m,
            );
            point.snapped = true;
            Ok(open_end(point, "ad-hoc".to_owned()))
        }
    }
}

fn closest_pass_base_end<'a>(
    graph: &'a LeisureGraph,
    pass_id: &str,
    reference_node: &NodeId,
    forbidden_nodes: &HashSet<NodeId>,
    forbidden_edges: &HashSet<usize>,
    cost_mode: BudgetMode,
) -> Option<&'a Node> {
    let sides = graph.pass_sides_for(pass_id)?;
    let mut bases = [sides.a, sides.b]
        .into_iter()
        .flatten()
        .filter(|node_id| !forbidden_nodes.contains(node_id))
        .filter_map(|node_id| graph.node(&node_id))
        .collect::<Vec<_>>();
    bases.sort_by(|left, right| left.id.cmp(&right.id));
    bases
        .into_iter()
        .filter_map(|node| {
            let options = AStarOptions {
                cost_mode: cost_mode.cost_mode(),
                forbidden_edges: forbidden_edges.clone(),
                forbidden_nodes: forbidden_nodes.clone(),
                ..AStarOptions::default()
            };
            let leg = leisure_astar(graph, reference_node, &node.id, &options);
            (leg.status == AStarStatus::Ok).then_some((node, leg))
        })
        .min_by(|(left_node, left_leg), (right_node, right_leg)| {
            leg_cost_for_mode(left_leg, cost_mode)
                .total_cmp(&leg_cost_for_mode(right_leg, cost_mode))
                .then_with(|| {
                    left_leg
                        .total_leisure_cost
                        .total_cmp(&right_leg.total_leisure_cost)
                })
                .then_with(|| left_node.id.cmp(&right_node.id))
        })
        .map(|item| item.0)
}

fn graph_node_by_id<'a>(graph: &'a LeisureGraph, id: &str) -> Option<&'a Node> {
    graph.node(&NodeId::from(id)).or_else(|| {
        id.strip_prefix("p-")
            .and_then(|stripped| graph.node(&NodeId::from(stripped)))
    })
}

fn closed_end(start: &ResolvedPoint, requested: &str) -> ResolvedEnd {
    ResolvedEnd {
        point: start.clone(),
        open: false,
        requested: requested.to_owned(),
    }
}

fn open_end(point: ResolvedPoint, requested: String) -> ResolvedEnd {
    ResolvedEnd {
        point,
        open: true,
        requested,
    }
}

fn resolved_point_from_node(
    node: &Node,
    name: String,
    snapped: bool,
    snap_distance_m: f64,
) -> ResolvedPoint {
    ResolvedPoint {
        node_id: node.id.clone(),
        name,
        lat: node.lat,
        lon: node.lon,
        snapped,
        snap_distance_m,
    }
}

fn validate_end_reachability(env: &mut Env<'_>, must: &[Candidate]) -> Option<NodeId> {
    if !env.open_end {
        return None;
    }
    let sources = if must.is_empty() {
        vec![env.start.node_id.clone()]
    } else {
        must.iter().map(|item| item.node_id.clone()).collect()
    };
    for from_id in sources {
        if from_id == env.end.point.node_id {
            continue;
        }
        let result = budget_leg_between(env, &from_id, &env.end.point.node_id.clone());
        if result.status != AStarStatus::Ok {
            return Some(from_id);
        }
    }
    None
}

fn normalize_theme_profile(options: &PlanOptions) -> ThemeProfile {
    let mut requested = normalize_tokens(&options.themes)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let personas = normalize_tokens(&options.personas);
    for persona in &personas {
        for theme in persona_themes(persona) {
            requested.insert((*theme).to_owned());
        }
    }
    ThemeProfile {
        requested: requested.into_iter().collect(),
        personas,
    }
}

fn persona_themes(persona: &str) -> &'static [&'static str] {
    match persona {
        "scenic" => &["panoramic-view", "viewpoints", "iconic", "high-alpine"],
        "photographer" => &["panoramic-view", "viewpoints", "iconic", "alpine-lake"],
        "driver" => &["drivers-road", "iconic", "high-alpine"],
        "touring" => &["drivers-road", "panoramic-view", "historic"],
        "family" => &["alpine-lake", "viewpoints", "cultural"],
        "hiker" => &["glacier", "alpine-lake", "panoramic-view", "high-alpine"],
        _ => &[],
    }
}

fn normalize_tokens(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|item| item.split(','))
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

fn seasonal_forbidden_edges(graph: &LeisureGraph, cutoff: Option<&str>) -> SeasonalMask {
    let Some(cutoff) = cutoff.filter(|value| !value.trim().is_empty()) else {
        return SeasonalMask {
            edges: Vec::new(),
            diagnostics: json!({ "active": false, "forbiddenSummerEdges": 0 }),
        };
    };
    let Some(mmdd) = parse_mmdd(cutoff) else {
        return SeasonalMask {
            edges: Vec::new(),
            diagnostics: json!({ "active": false, "invalidCutoff": cutoff, "forbiddenSummerEdges": 0 }),
        };
    };
    let in_summer = (515..=1031).contains(&mmdd);
    let edges = if in_summer {
        Vec::new()
    } else {
        graph
            .edges
            .iter()
            .enumerate()
            .filter(|(_, edge)| edge.season.as_deref() == Some("summer"))
            .map(|(index, _)| index)
            .collect::<Vec<_>>()
    };
    SeasonalMask {
        diagnostics: json!({
            "active": true,
            "cutoff": cutoff,
            "summerWindow": "05-15..10-31",
            "inSummer": in_summer,
            "forbiddenSummerEdges": edges.len(),
        }),
        edges,
    }
}

struct SeasonalMask {
    edges: Vec<usize>,
    diagnostics: Value,
}

fn parse_mmdd(value: &str) -> Option<u32> {
    let date = value.get(..10).unwrap_or(value);
    let mut parts = date.split('-');
    let _year = parts.next()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    (1..=12).contains(&month).then_some(())?;
    (1..=31).contains(&day).then_some(())?;
    Some(month * 100 + day)
}

fn resolve_pass_id_set(graph: &LeisureGraph, ids: &[String]) -> BTreeSet<String> {
    ids.iter()
        .filter_map(|id| resolve_pass_id(graph, id))
        .collect()
}

fn resolve_pass_id(graph: &LeisureGraph, id: &str) -> Option<String> {
    if id.is_empty() {
        return None;
    }
    let mut forms = Vec::new();
    add_form(&mut forms, id.to_owned());
    if let Some(synthetic) = pass_id_from_synthetic_id(id) {
        add_form(&mut forms, synthetic);
    }
    for form in forms.clone() {
        if let Some(stripped) = form.strip_prefix("p-") {
            add_form(&mut forms, stripped.to_owned());
        } else {
            add_form(&mut forms, format!("p-{form}"));
        }
    }
    for form in forms {
        let node_id = NodeId::from(form.as_str());
        if let Some(mapped) = graph.pass_id_by_node_id.get(&node_id) {
            return Some(mapped.to_string());
        }
        if graph.pass_triplets.contains_key(&node_id)
            || graph.node(&node_id).map(|node| node.kind.clone()) == Some(NodeKind::Pass)
        {
            return Some(form);
        }
    }
    None
}

fn add_form(forms: &mut Vec<String>, form: String) {
    if !form.is_empty() && !forms.contains(&form) {
        forms.push(form);
    }
}

fn pass_id_from_synthetic_id(node_id: &str) -> Option<String> {
    let (pass_id, suffix) = node_id.rsplit_once(':')?;
    matches!(suffix, "A" | "S" | "B").then(|| pass_id.to_owned())
}

fn blocked_nodes_for_passes(graph: &LeisureGraph, pass_ids: &BTreeSet<String>) -> HashSet<NodeId> {
    let mut out = HashSet::new();
    for pass_id in pass_ids {
        out.insert(NodeId::from(pass_id.as_str()));
        out.insert(NodeId::new(format!("{pass_id}:A")));
        out.insert(NodeId::new(format!("{pass_id}:S")));
        out.insert(NodeId::new(format!("{pass_id}:B")));
        if let Some(sides) = graph.pass_sides_for(pass_id) {
            out.extend(sides.pass);
            out.extend(sides.a);
            out.extend(sides.summit);
            out.extend(sides.b);
        }
    }
    out
}

fn expand_pass_siblings(graph: &LeisureGraph, ids: &BTreeSet<String>) -> BTreeSet<String> {
    let mut expanded = BTreeSet::new();
    for id in ids {
        expanded.insert(id.clone());
        let Some(pass_id) = resolve_pass_id(graph, id) else {
            continue;
        };
        expanded.insert(pass_id.clone());
        expanded.insert(format!("{pass_id}:A"));
        expanded.insert(format!("{pass_id}:S"));
        expanded.insert(format!("{pass_id}:B"));
        if let Some(sides) = graph.pass_sides_for(&pass_id) {
            for node_id in [sides.pass, sides.a, sides.summit, sides.b]
                .into_iter()
                .flatten()
            {
                expanded.insert(node_id.to_string());
            }
        }
    }
    expanded
}

fn budget_fit_object(budget: Budget, used: f64) -> BudgetFit {
    let remaining = budget.value - used;
    BudgetFit {
        mode: budget.mode.public_units().to_owned(),
        budget: round(budget.value, 3),
        used: round(used, 3),
        remaining: round(remaining, 3),
        ratio: round(
            if budget.value > 0.0 {
                used / budget.value
            } else {
                0.0
            },
            4,
        ),
        within: used <= budget.value + EPS,
    }
}

fn compute_theme_coverage(route: &[Candidate], profile: &ThemeProfile) -> ThemeCoverage {
    let mut covered = BTreeSet::new();
    for item in route {
        for theme in &item.themes {
            covered.insert(theme.clone());
        }
    }
    let covered_requested = profile
        .requested
        .iter()
        .filter(|theme| covered.contains(*theme))
        .cloned()
        .collect::<Vec<_>>();
    let ratio = if profile.requested.is_empty() {
        (covered.len() as f64 / 5.0).min(1.0)
    } else {
        covered_requested.len() as f64 / profile.requested.len() as f64
    };
    ThemeCoverage {
        requested: profile.requested.clone(),
        covered_themes: covered.into_iter().collect(),
        covered_requested,
        ratio: round(ratio, 4),
        score: round(ratio, 4),
    }
}

fn ears_for_route_indices(env: &Env<'_>, route: &[Candidate], edges: &[usize]) -> BTreeSet<usize> {
    let mut ids = BTreeSet::new();
    for item in route {
        ids.extend(item.ear_indices.iter().copied());
    }
    for &edge_index in edges {
        let Some(pass_id) = env
            .graph
            .edges
            .get(edge_index)
            .and_then(|edge| edge.pass_id.as_ref())
        else {
            continue;
        };
        if let Some(ear_indices) = env.ears.pass_to_ears.get(pass_id.as_str()) {
            ids.extend(ear_indices.iter().copied());
        }
    }
    ids
}

fn score_tour(
    scenic_sum: f64,
    theme_coverage: &ThemeCoverage,
    total_leisure_cost: f64,
    retraced_connector_count: usize,
    out_and_back_count: usize,
    loop_ear_count: usize,
    budget_fit: &BudgetFit,
) -> f64 {
    let budget_fill = budget_fit.ratio.clamp(0.0, 1.0);
    scenic_sum * SCENIC_WEIGHT
        + theme_coverage.score * THEME_WEIGHT
        + budget_fill * BUDGET_FILL_WEIGHT
        - total_leisure_cost * LEISURE_COST_WEIGHT
        - retraced_connector_count as f64 * RETRACED_CONNECTOR_PENALTY
        - out_and_back_count as f64 * OUT_AND_BACK_PENALTY
        + loop_ear_count as f64 * LOOP_EAR_BONUS
}

fn count_retraced_connectors(graph: &LeisureGraph, edges: &[usize]) -> usize {
    let mut seen = BTreeSet::new();
    let mut retraced = 0;
    for &edge_index in edges {
        let Some(edge) = graph.edges.get(edge_index) else {
            continue;
        };
        if edge.kind != EdgeKind::Connector {
            continue;
        }
        let key = canonical_pair(&edge.from, &edge.to);
        if !seen.insert(key) {
            retraced += 1;
        }
    }
    retraced
}

fn count_out_and_back(graph: &LeisureGraph, route: &[Candidate], legs: &[AStarResult]) -> usize {
    let mut count = 0;
    for (i, candidate) in route.iter().enumerate() {
        let Some(pass_id) = &candidate.pass_id else {
            continue;
        };
        let inbound = legs.get(i).map(|leg| leg.path.as_slice()).unwrap_or(&[]);
        let outbound = legs
            .get(i + 1)
            .map(|leg| leg.path.as_slice())
            .unwrap_or(&[]);
        let before = if inbound.len() >= 2 {
            inbound.get(inbound.len() - 2)
        } else {
            None
        };
        let after = outbound.get(1);
        let before_node = before.and_then(|id| graph.node(id));
        let after_node = after.and_then(|id| graph.node(id));
        if before_node
            .and_then(|node| node.pass_id.as_ref())
            .map(NodeId::as_str)
            == Some(pass_id.as_str())
            && after_node
                .and_then(|node| node.pass_id.as_ref())
                .map(NodeId::as_str)
                == Some(pass_id.as_str())
            && before_node.and_then(|node| node.side) == after_node.and_then(|node| node.side)
            && before_node.and_then(|node| node.side).is_some()
        {
            count += 1;
        } else if before.is_some()
            && before == after
            && before_node.and_then(|node| node.side).is_none()
            && after_node.and_then(|node| node.side).is_none()
        {
            count += 1;
        }
    }
    count
}

fn count_leg_used_connector_overlaps(
    graph: &LeisureGraph,
    leg: &AStarResult,
    used_edges: &BTreeSet<usize>,
) -> usize {
    leg.edges
        .iter()
        .filter(|&&edge_index| {
            graph
                .edges
                .get(edge_index)
                .is_some_and(|edge| edge.kind == EdgeKind::Connector)
                && used_edges.contains(&edge_index)
        })
        .count()
}

fn add_used_connector_edge(
    graph: &LeisureGraph,
    used_edges: &mut BTreeSet<usize>,
    edge_index: usize,
) {
    let Some(edge) = graph.edges.get(edge_index) else {
        return;
    };
    if edge.kind != EdgeKind::Connector {
        return;
    }
    used_edges.insert(edge_index);
    if let Some(reverse) = graph
        .edge_by_key
        .get(&format!("{}->{}", edge.to, edge.from))
    {
        used_edges.insert(*reverse);
    }
}

fn compare_tours(a: &InternalTour, b: &InternalTour) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| b.scenic_sum.total_cmp(&a.scenic_sum))
        .then_with(|| a.retraced_connector_count.cmp(&b.retraced_connector_count))
        .then_with(|| a.duration_s.total_cmp(&b.duration_s))
        .then_with(|| a.signature.cmp(&b.signature))
}

fn best_of(a: InternalTour, b: InternalTour) -> InternalTour {
    if !a.feasible {
        return if b.feasible { b } else { a };
    }
    if !b.feasible {
        return a;
    }
    if compare_tours(&a, &b) != Ordering::Greater {
        a
    } else {
        b
    }
}

fn record_tour(archive: &mut BTreeMap<String, InternalTour>, tour: &InternalTour) {
    if !tour.feasible {
        return;
    }
    let replace = archive
        .get(&tour.signature)
        .map(|existing| compare_tours(tour, existing) == Ordering::Less)
        .unwrap_or(true);
    if replace {
        archive.insert(tour.signature.clone(), tour.clone());
    }
}

fn contains_all(route: &[Candidate], required_set: &BTreeSet<String>) -> bool {
    required_set
        .iter()
        .all(|id| route.iter().any(|item| &item.id == id))
}

fn insert_at(route: &[Candidate], pos: usize, candidate: Candidate) -> Vec<Candidate> {
    let pos = pos.min(route.len());
    let mut out = Vec::with_capacity(route.len() + 1);
    out.extend(route[..pos].iter().cloned());
    out.push(candidate);
    out.extend(route[pos..].iter().cloned());
    out
}

fn shuffle(items: &[Candidate], rng: &mut Mulberry32) -> Vec<Candidate> {
    let mut out = items.to_vec();
    for i in (1..out.len()).rev() {
        let j = rng.index(i + 1);
        out.swap(i, j);
    }
    out
}

fn same_route_ids(a: &[Candidate], b: &[Candidate]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(left, right)| left.id == right.id)
}

fn route_signature(route: &[Candidate]) -> String {
    route
        .iter()
        .map(|item| item.id.as_str())
        .collect::<Vec<_>>()
        .join("\u{1F}")
}

fn canonical_pair(a: &NodeId, b: &NodeId) -> String {
    if a <= b {
        format!("{a}\0{b}")
    } else {
        format!("{b}\0{a}")
    }
}

fn stable_edge_set_key(edges: &BTreeSet<usize>) -> String {
    edges
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("|")
}

fn retry_leisure_cost_limit(budget_leg: &AStarResult) -> f64 {
    if budget_leg.total_leisure_cost.is_finite() {
        (budget_leg.total_leisure_cost * USED_EDGES_PENALTY + EPS).max(0.0)
    } else {
        f64::INFINITY
    }
}

fn budget_used(budget: Budget, materialized: &MaterializedRoute) -> f64 {
    match budget.mode {
        BudgetMode::Duration => materialized.total_duration_s,
        BudgetMode::Distance => materialized.total_distance_m / 1000.0,
    }
}

fn leg_budget_metric(budget: Budget, leg: &AStarResult) -> f64 {
    match budget.mode {
        BudgetMode::Duration => leg.total_duration_s,
        BudgetMode::Distance => leg.total_distance_m / 1000.0,
    }
}

fn leg_cost_for_mode(leg: &AStarResult, mode: BudgetMode) -> f64 {
    match mode {
        BudgetMode::Duration => leg.total_duration_s,
        BudgetMode::Distance => leg.total_distance_m,
    }
}

fn base_diagnostics(
    options: &PlanOptions,
    advanced: bool,
    seeded: bool,
    time_budget_ms: f64,
    iteration_cap: usize,
) -> Map<String, Value> {
    let mut diagnostics = Map::new();
    diag_insert(
        &mut diagnostics,
        "objectiveConstants",
        json!({
            "SCENIC_WEIGHT": SCENIC_WEIGHT,
            "THEME_WEIGHT": THEME_WEIGHT,
            "LEISURE_COST_WEIGHT": LEISURE_COST_WEIGHT,
            "RETRACED_CONNECTOR_PENALTY": RETRACED_CONNECTOR_PENALTY,
            "OUT_AND_BACK_PENALTY": OUT_AND_BACK_PENALTY,
            "LOOP_EAR_BONUS": LOOP_EAR_BONUS,
            "BUDGET_FILL_WEIGHT": BUDGET_FILL_WEIGHT,
        }),
    );
    diag_insert(
        &mut diagnostics,
        "stageTimingContractMs",
        json!({
            "greedy": STAGE1_MS,
            "advancedGreedyRetry": STAGE1_ADVANCED_RETRY_MS,
            "localSearch": STAGE2_MS,
            "total": time_budget_ms,
        }),
    );
    diag_insert(
        &mut diagnostics,
        "seasonalApproximation",
        json!("summer edges allowed only in conservative 15 May..31 Oct window when seasonalCutoff is provided"),
    );
    diag_insert(&mut diagnostics, "degradedReasons", json!([]));
    diag_insert(&mut diagnostics, "advanced", json!(advanced));
    diag_insert(
        &mut diagnostics,
        "searchBound",
        if seeded {
            json!({
                "mode": "iterations",
                "greedyCap": STAGE1_MOVES,
                "lsCap": STAGE2_MOVES,
                "perturbationCap": iteration_cap,
                "maxNoImprovement": options.max_no_improvement,
            })
        } else {
            json!({
                "mode": "wall-clock",
                "wallClockBounded": true,
                "iterationCap": iteration_cap,
                "maxNoImprovement": options.max_no_improvement,
            })
        },
    );
    diagnostics
}

fn enrich_search_bound(mut value: Value, advanced: bool, pool_size: usize) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("maxAutoCandidates".to_owned(), json!(MAX_AUTO_CANDIDATES));
        object.insert("maxInsertionScan".to_owned(), json!(MAX_INSERTION_SCAN));
        let effective = if advanced {
            pool_size
        } else {
            pool_size.min(MAX_INSERTION_SCAN)
        };
        object.insert("effectivePoolSize".to_owned(), json!(effective));
        object.insert(
            "unscannedCandidateCount".to_owned(),
            json!(pool_size.saturating_sub(effective)),
        );
    }
    value
}

fn invalid_result(
    started: ClockInstant,
    mut diagnostics: Map<String, Value>,
    reason: &'static str,
    extra: Map<String, Value>,
) -> PlanResult {
    diag_insert(&mut diagnostics, "reason", json!(reason));
    for (key, value) in extra {
        diagnostics.insert(key, value);
    }
    finalize(
        PlanStatus::Infeasible,
        None,
        Vec::new(),
        0,
        started,
        diagnostics,
    )
}

fn finalize(
    status: PlanStatus,
    primary: Option<PublicTour>,
    alternatives: Vec<PublicTour>,
    iterations: usize,
    started: ClockInstant,
    diagnostics: Map<String, Value>,
) -> PlanResult {
    PlanResult {
        status,
        primary,
        alternatives,
        iterations,
        elapsed_ms: round(started.elapsed_ms(), 3),
        diagnostics: Value::Object(diagnostics),
    }
}

fn diag_insert(diagnostics: &mut Map<String, Value>, key: &str, value: Value) {
    diagnostics.insert(key.to_owned(), value);
}

fn push_degraded_reason(diagnostics: &mut Map<String, Value>, reason: &str) {
    let Some(array) = diagnostics
        .get_mut("degradedReasons")
        .and_then(Value::as_array_mut)
    else {
        diagnostics.insert("degradedReasons".to_owned(), json!([reason]));
        return;
    };
    if !array.iter().any(|value| value.as_str() == Some(reason)) {
        array.push(json!(reason));
    }
}

fn parse_end_snap_max_distance_m(value: Option<f64>) -> f64 {
    value
        .filter(|distance| distance.is_finite())
        .map(|distance| distance.max(0.0))
        .unwrap_or(END_SNAP_MAX_DISTANCE_M)
}

fn is_sentinel_stop(stop: &PublicStop) -> bool {
    stop.kind == "start" || stop.kind == "end" || stop.kind == "return" || stop.return_to_start
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn duration_from_ms(ms: f64) -> f64 {
    ms.max(1.0)
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn round(value: f64, decimals: i32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let scale = 10_f64.powi(decimals);
    (value * scale).round() / scale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_node_inbound_leg_does_not_count_out_and_back() {
        let graph = LeisureGraph::load_from_json(
            &json!({
                "version": "test",
                "generatedAt": "2026-01-01T00:00:00.000Z",
                "stats": { "nodes": 2, "edges": 0 },
                "nodes": [
                    { "id": "p", "kind": "pass", "name": "p", "lat": 46.0, "lon": 8.0 },
                    { "id": "p:A", "kind": "pass-base", "name": "p:A", "lat": 46.0, "lon": 8.001, "passId": "p", "side": "A" }
                ],
                "edges": []
            })
            .to_string(),
        )
        .expect("synthetic graph should parse");
        let route = vec![Candidate {
            id: "p".to_owned(),
            node_id: NodeId::from("p"),
            pass_id: Some("p".to_owned()),
            kind: "pass".to_owned(),
            name: "p".to_owned(),
            lat: 46.0,
            lon: 8.0,
            scenic_score: 0.0,
            themes: Vec::new(),
            ear_indices: Vec::new(),
            base_reward: 0.0,
        }];
        let legs = vec![
            AStarResult {
                path: vec![NodeId::from("p:A")],
                edges: Vec::new(),
                total_leisure_cost: 0.0,
                total_distance_m: 0.0,
                total_duration_s: 0.0,
                retraced_edge_count: 0,
                status: AStarStatus::Ok,
            },
            AStarResult {
                path: vec![NodeId::from("p"), NodeId::from("p:A")],
                edges: Vec::new(),
                total_leisure_cost: 0.0,
                total_distance_m: 0.0,
                total_duration_s: 0.0,
                retraced_edge_count: 0,
                status: AStarStatus::Ok,
            },
        ];

        assert_eq!(count_out_and_back(&graph, &route, &legs), 0);
    }
}
