use crate::graph::{haversine_m, LeisureGraph};
use crate::types::{Edge, NodeId};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};

const EPSILON: f64 = 1e-9;
const NO_NODE: usize = usize::MAX;

#[derive(Clone, Debug, PartialEq)]
pub struct AStarOptions {
    pub cost_mode: CostMode,
    /// Edge indices into `LeisureGraph::edges` to exclude from traversal.
    pub forbidden_edges: HashSet<usize>,
    pub forbidden_nodes: HashSet<NodeId>,
    /// Edge indices into `LeisureGraph::edges` that should receive the retrace penalty.
    pub used_edges: HashSet<usize>,
    pub used_edges_penalty: f64,
    pub bidirectional: bool,
    pub budget_cost: Option<f64>,
}

impl Default for AStarOptions {
    fn default() -> Self {
        Self {
            cost_mode: CostMode::Leisure,
            forbidden_edges: HashSet::new(),
            forbidden_nodes: HashSet::new(),
            used_edges: HashSet::new(),
            used_edges_penalty: 1.0,
            bidirectional: true,
            budget_cost: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CostMode {
    Leisure,
    Distance,
    Duration,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AStarResult {
    pub path: Vec<NodeId>,
    /// Edge indices into `LeisureGraph::edges`, in path order.
    pub edges: Vec<usize>,
    /// Raw, unrounded sum of leisure costs for `edges`.
    pub total_leisure_cost: f64,
    /// Raw, unrounded sum of edge distances in metres for `edges`.
    pub total_distance_m: f64,
    /// Raw, unrounded sum of edge durations in seconds for `edges`.
    pub total_duration_s: f64,
    pub retraced_edge_count: usize,
    pub status: AStarStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AStarStatus {
    Ok,
    Unreachable,
    BudgetExhausted,
}

/// Runs leisure-aware shortest path over the static directed graph.
///
/// Finds a route from `from` to `to` using the configured cost mode, optional
/// budget, forbidden nodes/edges, retrace penalty, and search direction.
/// Returns an [`AStarResult`] with status, path node ids, edge indices, raw
/// totals, and retraced-edge count. The default search is bidirectional
/// Dijkstra; set `bidirectional` to `false` for heuristic A*.
///
/// **API note**: `forbidden_edges` and `used_edges` use edge indices (into
/// `LeisureGraph::edges`). The JS reference accepts string tokens; the
/// wasm-bindgen layer translates tokens → indices at the boundary.
pub fn leisure_astar(
    graph: &LeisureGraph,
    from: &NodeId,
    to: &NodeId,
    options: &AStarOptions,
) -> AStarResult {
    let Some(&from_index) = graph.node_index.get(from) else {
        return empty_result(AStarStatus::Unreachable);
    };
    let Some(&to_index) = graph.node_index.get(to) else {
        return empty_result(AStarStatus::Unreachable);
    };

    if options.forbidden_nodes.contains(from) || options.forbidden_nodes.contains(to) {
        return empty_result(AStarStatus::Unreachable);
    }
    if from == to {
        return ok_result(graph, vec![from.clone()], Vec::new(), options);
    }

    let adjacency = IndexedAdjacency::new(graph);
    if options.bidirectional {
        bidirectional_dijkstra(graph, &adjacency, from_index, to_index, options)
    } else {
        unidirectional_astar(graph, &adjacency, from_index, to_index, options)
    }
}

#[derive(Clone, Debug)]
struct IndexedAdjacency {
    out: Vec<Vec<usize>>,
    incoming: Vec<Vec<usize>>,
}

impl IndexedAdjacency {
    fn new(graph: &LeisureGraph) -> Self {
        let mut out = vec![Vec::new(); graph.node_list.len()];
        let mut incoming = vec![Vec::new(); graph.node_list.len()];

        for (index, edge) in graph.edges.iter().enumerate() {
            let (Some(&from), Some(&to)) = (
                graph.node_index.get(&edge.from),
                graph.node_index.get(&edge.to),
            ) else {
                continue;
            };
            out[from].push(index);
            incoming[to].push(index);
        }

        Self { out, incoming }
    }
}

#[derive(Clone, Copy, Debug)]
struct HeapItem {
    priority: f64,
    node: usize,
}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.priority.total_cmp(&other.priority) == Ordering::Equal && self.node == other.node
    }
}

impl Eq for HeapItem {}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .priority
            .total_cmp(&self.priority)
            .then_with(|| other.node.cmp(&self.node))
    }
}

fn unidirectional_astar(
    graph: &LeisureGraph,
    adjacency: &IndexedAdjacency,
    from_index: usize,
    to_index: usize,
    options: &AStarOptions,
) -> AStarResult {
    let node_count = graph.node_list.len();
    let mut dist = vec![f64::INFINITY; node_count];
    let mut spent = vec![f64::INFINITY; node_count];
    let mut prev_node = vec![NO_NODE; node_count];
    let mut prev_edge = vec![NO_NODE; node_count];
    let mut heap = BinaryHeap::new();
    let mut budget_pruned = false;
    let budget = normalized_budget(options);

    dist[from_index] = 0.0;
    spent[from_index] = 0.0;
    heap.push(HeapItem {
        node: from_index,
        priority: heuristic(graph, from_index, to_index, options.cost_mode),
    });

    while let Some(item) = heap.pop() {
        let expected = dist[item.node] + heuristic(graph, item.node, to_index, options.cost_mode);
        // Lazy delete: stale heap entries are left in the BinaryHeap and ignored
        // when their priority no longer matches the best known node distance.
        if item.priority > expected + EPSILON {
            continue;
        }
        if item.node == to_index {
            let (path, edges) =
                reconstruct_forward(graph, from_index, to_index, &prev_node, &prev_edge);
            return ok_result(graph, path, edges, options);
        }

        for &edge_index in &adjacency.out[item.node] {
            let edge = &graph.edges[edge_index];
            let Some(&next_index) = graph.node_index.get(&edge.to) else {
                continue;
            };
            if is_blocked(edge_index, &edge.to, options) {
                continue;
            }

            let raw = raw_cost(edge, options.cost_mode);
            let next_spent = spent[item.node] + raw;
            if next_spent > budget + EPSILON {
                budget_pruned = true;
                continue;
            }

            let next_dist = dist[item.node] + search_cost(edge_index, edge, options);
            if next_dist + EPSILON < dist[next_index] {
                dist[next_index] = next_dist;
                spent[next_index] = next_spent;
                prev_node[next_index] = item.node;
                prev_edge[next_index] = edge_index;
                heap.push(HeapItem {
                    node: next_index,
                    priority: next_dist + heuristic(graph, next_index, to_index, options.cost_mode),
                });
            }
        }
    }

    empty_result(if budget_pruned {
        AStarStatus::BudgetExhausted
    } else {
        AStarStatus::Unreachable
    })
}

fn bidirectional_dijkstra(
    graph: &LeisureGraph,
    adjacency: &IndexedAdjacency,
    from_index: usize,
    to_index: usize,
    options: &AStarOptions,
) -> AStarResult {
    let node_count = graph.node_list.len();
    let mut dist_f = vec![f64::INFINITY; node_count];
    let mut dist_r = vec![f64::INFINITY; node_count];
    let mut spent_f = vec![f64::INFINITY; node_count];
    let mut spent_r = vec![f64::INFINITY; node_count];
    let mut prev_node_f = vec![NO_NODE; node_count];
    let mut prev_edge_f = vec![NO_NODE; node_count];
    let mut next_node_r = vec![NO_NODE; node_count];
    let mut next_edge_r = vec![NO_NODE; node_count];
    let mut heap_f = BinaryHeap::new();
    let mut heap_r = BinaryHeap::new();
    let mut best = f64::INFINITY;
    let mut meet = NO_NODE;
    let mut budget_pruned = false;
    let budget = normalized_budget(options);

    dist_f[from_index] = 0.0;
    dist_r[to_index] = 0.0;
    spent_f[from_index] = 0.0;
    spent_r[to_index] = 0.0;
    heap_f.push(HeapItem {
        node: from_index,
        priority: 0.0,
    });
    heap_r.push(HeapItem {
        node: to_index,
        priority: 0.0,
    });

    while !heap_f.is_empty() || !heap_r.is_empty() {
        if best.is_finite() && peek_priority(&heap_f) + peek_priority(&heap_r) >= best - EPSILON {
            break;
        }

        if heap_r.is_empty()
            || (!heap_f.is_empty() && peek_priority(&heap_f) <= peek_priority(&heap_r))
        {
            let Some(item) = heap_f.pop() else {
                continue;
            };
            if item.priority > dist_f[item.node] + EPSILON {
                continue;
            }

            for &edge_index in &adjacency.out[item.node] {
                let edge = &graph.edges[edge_index];
                let Some(&next_index) = graph.node_index.get(&edge.to) else {
                    continue;
                };
                if is_blocked(edge_index, &edge.to, options) {
                    continue;
                }

                let raw = raw_cost(edge, options.cost_mode);
                let next_spent = spent_f[item.node] + raw;
                if next_spent > budget + EPSILON {
                    budget_pruned = true;
                    continue;
                }

                let next_dist = dist_f[item.node] + search_cost(edge_index, edge, options);
                if next_dist + EPSILON < dist_f[next_index] {
                    dist_f[next_index] = next_dist;
                    spent_f[next_index] = next_spent;
                    prev_node_f[next_index] = item.node;
                    prev_edge_f[next_index] = edge_index;
                    heap_f.push(HeapItem {
                        node: next_index,
                        priority: next_dist,
                    });
                    consider_meet(
                        graph,
                        next_index,
                        &dist_f,
                        &dist_r,
                        &spent_f,
                        &spent_r,
                        budget,
                        &mut best,
                        &mut meet,
                        &mut budget_pruned,
                    );
                }
            }
        } else {
            let Some(item) = heap_r.pop() else {
                continue;
            };
            if item.priority > dist_r[item.node] + EPSILON {
                continue;
            }

            for &edge_index in &adjacency.incoming[item.node] {
                let edge = &graph.edges[edge_index];
                let Some(&next_index) = graph.node_index.get(&edge.from) else {
                    continue;
                };
                if is_blocked(edge_index, &edge.from, options) {
                    continue;
                }

                let raw = raw_cost(edge, options.cost_mode);
                let next_spent = spent_r[item.node] + raw;
                if next_spent > budget + EPSILON {
                    budget_pruned = true;
                    continue;
                }

                let next_dist = dist_r[item.node] + search_cost(edge_index, edge, options);
                if next_dist + EPSILON < dist_r[next_index] {
                    dist_r[next_index] = next_dist;
                    spent_r[next_index] = next_spent;
                    next_node_r[next_index] = item.node;
                    next_edge_r[next_index] = edge_index;
                    heap_r.push(HeapItem {
                        node: next_index,
                        priority: next_dist,
                    });
                    consider_meet(
                        graph,
                        next_index,
                        &dist_f,
                        &dist_r,
                        &spent_f,
                        &spent_r,
                        budget,
                        &mut best,
                        &mut meet,
                        &mut budget_pruned,
                    );
                }
            }
        }
    }

    if meet == NO_NODE {
        return empty_result(if budget_pruned {
            AStarStatus::BudgetExhausted
        } else {
            AStarStatus::Unreachable
        });
    }

    let (path, edges) = reconstruct_bidirectional(
        graph,
        from_index,
        to_index,
        meet,
        &prev_node_f,
        &prev_edge_f,
        &next_node_r,
        &next_edge_r,
    );
    ok_result(graph, path, edges, options)
}

fn consider_meet(
    graph: &LeisureGraph,
    node_index: usize,
    dist_f: &[f64],
    dist_r: &[f64],
    spent_f: &[f64],
    spent_r: &[f64],
    budget: f64,
    best: &mut f64,
    meet: &mut usize,
    budget_pruned: &mut bool,
) {
    if !dist_f[node_index].is_finite() || !dist_r[node_index].is_finite() {
        return;
    }
    if spent_f[node_index] + spent_r[node_index] > budget + EPSILON {
        *budget_pruned = true;
        return;
    }

    let total = dist_f[node_index] + dist_r[node_index];
    if total + EPSILON < *best
        || ((total - *best).abs() <= EPSILON && tie_node(graph, node_index, *meet).is_lt())
    {
        *best = total;
        *meet = node_index;
    }
}

fn reconstruct_forward(
    graph: &LeisureGraph,
    from_index: usize,
    to_index: usize,
    prev_node: &[usize],
    prev_edge: &[usize],
) -> (Vec<NodeId>, Vec<usize>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut current = to_index;

    loop {
        nodes.push(graph.node_list[current].clone());
        if current == from_index {
            break;
        }
        if prev_node[current] == NO_NODE || prev_edge[current] == NO_NODE {
            return (Vec::new(), Vec::new());
        }
        edges.push(prev_edge[current]);
        current = prev_node[current];
    }

    nodes.reverse();
    edges.reverse();
    (nodes, edges)
}

#[allow(clippy::too_many_arguments)]
fn reconstruct_bidirectional(
    graph: &LeisureGraph,
    from_index: usize,
    to_index: usize,
    meet: usize,
    prev_node_f: &[usize],
    prev_edge_f: &[usize],
    next_node_r: &[usize],
    next_edge_r: &[usize],
) -> (Vec<NodeId>, Vec<usize>) {
    let mut left_nodes = Vec::new();
    let mut current = meet;
    loop {
        left_nodes.push(graph.node_list[current].clone());
        if current == from_index {
            break;
        }
        if prev_node_f[current] == NO_NODE {
            return (Vec::new(), Vec::new());
        }
        current = prev_node_f[current];
    }
    left_nodes.reverse();

    let mut right_nodes = Vec::new();
    current = next_node_r[meet];
    while current != NO_NODE {
        right_nodes.push(graph.node_list[current].clone());
        if current == to_index {
            break;
        }
        current = next_node_r[current];
    }

    let mut left_edges = Vec::new();
    current = meet;
    while current != from_index {
        if current == NO_NODE || prev_edge_f[current] == NO_NODE {
            return (Vec::new(), Vec::new());
        }
        left_edges.push(prev_edge_f[current]);
        current = prev_node_f[current];
    }
    left_edges.reverse();

    let mut right_edges = Vec::new();
    current = meet;
    while current != to_index {
        if current == NO_NODE || next_edge_r[current] == NO_NODE {
            return (Vec::new(), Vec::new());
        }
        right_edges.push(next_edge_r[current]);
        current = next_node_r[current];
    }

    left_nodes.extend(right_nodes);
    left_edges.extend(right_edges);
    (left_nodes, left_edges)
}

fn ok_result(
    graph: &LeisureGraph,
    path: Vec<NodeId>,
    edges: Vec<usize>,
    options: &AStarOptions,
) -> AStarResult {
    let mut total_leisure_cost = 0.0;
    let mut total_distance_m = 0.0;
    let mut total_duration_s = 0.0;
    let mut retraced_edge_count = 0;
    let penalty_active = matches!(options.cost_mode, CostMode::Leisure)
        && normalized_penalty(options.used_edges_penalty) > 1.0;

    for &edge_index in &edges {
        let Some(edge) = graph.edges.get(edge_index) else {
            continue;
        };
        total_leisure_cost += number_or_zero(edge.leisure_cost);
        total_distance_m += number_or_zero(edge.distance_m);
        total_duration_s += number_or_zero(edge.duration_s);
        if penalty_active && options.used_edges.contains(&edge_index) {
            retraced_edge_count += 1;
        }
    }

    AStarResult {
        path,
        edges,
        total_leisure_cost,
        total_distance_m,
        total_duration_s,
        retraced_edge_count,
        status: AStarStatus::Ok,
    }
}

fn empty_result(status: AStarStatus) -> AStarResult {
    AStarResult {
        path: Vec::new(),
        edges: Vec::new(),
        total_leisure_cost: 0.0,
        total_distance_m: 0.0,
        total_duration_s: 0.0,
        retraced_edge_count: 0,
        status,
    }
}

fn is_blocked(edge_index: usize, node_id: &NodeId, options: &AStarOptions) -> bool {
    options.forbidden_edges.contains(&edge_index) || options.forbidden_nodes.contains(node_id)
}

fn raw_cost(edge: &Edge, mode: CostMode) -> f64 {
    match mode {
        CostMode::Leisure => number_or_zero(edge.leisure_cost),
        CostMode::Distance => number_or_zero(edge.distance_m),
        CostMode::Duration => number_or_zero(edge.duration_s),
    }
}

fn search_cost(edge_index: usize, edge: &Edge, options: &AStarOptions) -> f64 {
    let cost = raw_cost(edge, options.cost_mode);
    if !matches!(options.cost_mode, CostMode::Leisure) {
        return cost;
    }
    let penalty = normalized_penalty(options.used_edges_penalty);
    if penalty > 1.0 && options.used_edges.contains(&edge_index) {
        cost * penalty
    } else {
        cost
    }
}

fn heuristic(graph: &LeisureGraph, from_index: usize, to_index: usize, mode: CostMode) -> f64 {
    let Some(from_id) = graph.node_list.get(from_index) else {
        return 0.0;
    };
    let Some(to_id) = graph.node_list.get(to_index) else {
        return 0.0;
    };
    let (Some(from), Some(to)) = (graph.nodes.get(from_id), graph.nodes.get(to_id)) else {
        return 0.0;
    };

    let direct_m = haversine_m(from.lat, from.lon, to.lat, to.lon);
    if !direct_m.is_finite() {
        return 0.0;
    }

    let factor = match mode {
        CostMode::Leisure => graph.edge_stats.min_leisure_per_m,
        CostMode::Distance => 1.0,
        CostMode::Duration => graph.edge_stats.min_duration_per_m,
    };
    if factor.is_finite() && factor > 0.0 {
        direct_m * factor
    } else {
        0.0
    }
}

fn peek_priority(heap: &BinaryHeap<HeapItem>) -> f64 {
    heap.peek()
        .map(|item| item.priority)
        .unwrap_or(f64::INFINITY)
}

fn tie_node(graph: &LeisureGraph, candidate: usize, incumbent: usize) -> Ordering {
    if incumbent == NO_NODE {
        return Ordering::Less;
    }
    graph.node_list[candidate].cmp(&graph.node_list[incumbent])
}

fn normalized_penalty(value: f64) -> f64 {
    if value.is_finite() {
        value.max(1.0)
    } else {
        1.0
    }
}

fn normalized_budget(options: &AStarOptions) -> f64 {
    options
        .budget_cost
        .filter(|value| value.is_finite())
        .unwrap_or(f64::INFINITY)
}

fn number_or_zero(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}
