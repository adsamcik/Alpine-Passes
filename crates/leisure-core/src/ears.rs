use crate::graph::{edge_key, LeisureGraph};
use crate::types::{Edge, EdgeKind, NodeId, NodeKind};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_CYCLES_PER_COMPONENT: usize = 32;
const MAX_COVERAGE_CYCLES_PER_COMPONENT: usize = 256;
const MAX_CYCLE_CANDIDATES: usize = 1024;
const MAX_CYCLE_DEPTH: usize = 32;
const MAX_DFS_STEPS: usize = 50_000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarDecomposition {
    pub ears: Vec<Ear>,
    /// `.get()` returns deterministic ear indices; iteration is sorted by key.
    pub pass_to_ears: BTreeMap<String, Vec<usize>>,
    /// `.get()` returns deterministic ear indices; iteration is sorted by key.
    pub junction_to_ears: BTreeMap<String, Vec<usize>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ear {
    pub id: String,
    pub kind: EarKind,
    pub passes: Vec<String>,
    /// Edge indices into `LeisureGraph::edges`, not JavaScript edge-id tokens.
    pub edges: Vec<usize>,
    pub attachment_nodes: Vec<NodeId>,
    /// Raw, unrounded sum of leisure costs for `edges`.
    pub total_leisure_cost: f64,
    /// Raw, unrounded sum of edge distances in kilometres for `edges`.
    pub total_distance_km: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EarKind {
    Loop,
    Path,
    Spur,
    IsolatedPass,
}

/// Decomposes the contracted leisure graph into loop, path, and spur ears.
///
/// Pass triplets are contracted into pass pseudo-nodes before connector
/// topology is split into biconnected components in O(V + E). Simple-cycle
/// enumeration is bounded to the cheapest cycles per component, then extended
/// for coverage when passes would otherwise be omitted. Isolated pass ears are
/// added so every pass remains indexable.
///
/// Returns ears plus pass and junction indexes that map ids to deterministic
/// indices into the returned `ears` vector.
pub fn decompose_ears(graph: &LeisureGraph) -> EarDecomposition {
    let projection = Projection::new(graph);
    let topology = build_topology(graph, &projection);
    let (components, articulation) = biconnected_components(&topology.adjacency);
    let mut ears = Vec::new();
    let mut junctions_by_ear = Vec::new();

    for component in components.iter().filter(|component| component.len() > 1) {
        let cycles = enumerate_component_cycles(component, &topology, graph, &projection);
        for cycle in cycles {
            append_ear(
                &mut ears,
                &mut junctions_by_ear,
                make_ear(
                    EarKind::Loop,
                    &cycle.nodes,
                    true,
                    graph,
                    &topology,
                    &projection,
                    &articulation,
                ),
            );
        }
    }

    for path in compress_bridge_paths(&components, &topology, graph) {
        append_ear(
            &mut ears,
            &mut junctions_by_ear,
            make_ear(
                path.kind,
                &path.nodes,
                false,
                graph,
                &topology,
                &projection,
                &articulation,
            ),
        );
    }

    append_isolated_pass_ears(&mut ears, &mut junctions_by_ear, &projection);

    for (index, ear) in ears.iter_mut().enumerate() {
        ear.id = format!("ear-{}", index + 1);
    }

    EarDecomposition {
        pass_to_ears: index_ear_values(&ears, |ear| &ear.passes),
        junction_to_ears: index_junctions(&junctions_by_ear),
        ears,
    }
}

#[derive(Clone, Debug)]
struct Projection {
    pass_ids: BTreeSet<NodeId>,
}

impl Projection {
    fn new(graph: &LeisureGraph) -> Self {
        Self {
            pass_ids: graph
                .nodes_of_kind(NodeKind::Pass)
                .iter()
                .cloned()
                .collect(),
        }
    }

    fn pseudo_of(&self, graph: &LeisureGraph, node_id: &NodeId) -> Option<NodeId> {
        if let Some(node) = graph.nodes.get(node_id) {
            return match &node.kind {
                NodeKind::Pass => Some(node.id.clone()),
                NodeKind::PassBase | NodeKind::PassSummit => node
                    .pass_id
                    .clone()
                    .or_else(|| pass_id_from_synthetic_id(node.id.as_str())),
                _ => Some(node_id.clone()),
            };
        }

        if let Some(pass_id) = pass_id_from_synthetic_id(node_id.as_str()) {
            if self.pass_ids.contains(&pass_id) {
                return Some(pass_id);
            }
        }
        Some(node_id.clone())
    }

    fn is_pass(&self, node_id: &NodeId) -> bool {
        self.pass_ids.contains(node_id)
    }
}

#[derive(Clone, Debug)]
struct Topology {
    adjacency: BTreeMap<NodeId, Vec<NodeId>>,
    directed_best: BTreeMap<(NodeId, NodeId), ConnectorChoice>,
    undirected_best: BTreeMap<String, ConnectorChoice>,
}

#[derive(Clone, Copy, Debug)]
struct ConnectorChoice {
    edge_index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ComponentEdge {
    u: NodeId,
    v: NodeId,
    key: String,
}

#[derive(Clone, Debug)]
struct CycleCandidate {
    nodes: Vec<NodeId>,
    key: String,
    cost: f64,
}

#[derive(Clone, Debug)]
struct BridgePath {
    kind: EarKind,
    nodes: Vec<NodeId>,
}

#[derive(Clone, Debug)]
struct ExpandedWalk {
    edges: Vec<usize>,
    total_leisure_cost: f64,
    total_distance_m: f64,
}

#[derive(Clone, Debug)]
struct EarDraft {
    ear: Ear,
    junctions: Vec<String>,
}

fn build_topology(graph: &LeisureGraph, projection: &Projection) -> Topology {
    let mut adjacency_sets: BTreeMap<NodeId, BTreeSet<NodeId>> = BTreeMap::new();
    let mut directed_best = BTreeMap::new();
    let mut undirected_best = BTreeMap::new();

    for (edge_index, edge) in graph.edges.iter().enumerate() {
        if !matches!(&edge.kind, EdgeKind::Connector) {
            continue;
        }
        let (Some(from), Some(to)) = (
            projection.pseudo_of(graph, &edge.from),
            projection.pseudo_of(graph, &edge.to),
        ) else {
            continue;
        };
        if from == to {
            continue;
        }

        add_adjacency(&mut adjacency_sets, from.clone(), to.clone());
        replace_if_cheaper(
            &mut directed_best,
            (from.clone(), to.clone()),
            ConnectorChoice { edge_index },
            graph,
        );
        replace_if_cheaper(
            &mut undirected_best,
            undirected_key(&from, &to),
            ConnectorChoice { edge_index },
            graph,
        );
    }

    let adjacency = adjacency_sets
        .into_iter()
        .map(|(node, neighbours)| (node, neighbours.into_iter().collect()))
        .collect();

    Topology {
        adjacency,
        directed_best,
        undirected_best,
    }
}

#[derive(Clone, Debug)]
struct BccFrame {
    u: NodeId,
    root: NodeId,
    neighbours: Vec<NodeId>,
    next: usize,
}

fn biconnected_components(
    adjacency: &BTreeMap<NodeId, Vec<NodeId>>,
) -> (Vec<Vec<ComponentEdge>>, BTreeSet<NodeId>) {
    let mut disc: BTreeMap<NodeId, usize> = BTreeMap::new();
    let mut low: BTreeMap<NodeId, usize> = BTreeMap::new();
    let mut parent: BTreeMap<NodeId, NodeId> = BTreeMap::new();
    let mut child_count: BTreeMap<NodeId, usize> = BTreeMap::new();
    let mut edge_stack = Vec::new();
    let mut components = Vec::new();
    let mut articulation = BTreeSet::new();
    let mut time = 0;

    for root in adjacency.keys().cloned().collect::<Vec<_>>() {
        if disc.contains_key(&root) {
            continue;
        }

        let root_stack_start = edge_stack.len();
        time += 1;
        disc.insert(root.clone(), time);
        low.insert(root.clone(), time);
        child_count.insert(root.clone(), 0);

        let mut stack = vec![BccFrame {
            neighbours: adjacency.get(&root).cloned().unwrap_or_default(),
            u: root.clone(),
            root: root.clone(),
            next: 0,
        }];

        while !stack.is_empty() {
            let next_step = {
                let frame = stack.last_mut().expect("frame should exist");
                if frame.next < frame.neighbours.len() {
                    let v = frame.neighbours[frame.next].clone();
                    frame.next += 1;
                    Some((frame.u.clone(), frame.root.clone(), v))
                } else {
                    None
                }
            };

            if let Some((u, root_id, v)) = next_step {
                if !disc.contains_key(&v) {
                    *child_count.entry(u.clone()).or_insert(0) += 1;
                    parent.insert(v.clone(), u.clone());
                    edge_stack.push(ComponentEdge {
                        key: undirected_key(&u, &v),
                        u: u.clone(),
                        v: v.clone(),
                    });

                    time += 1;
                    disc.insert(v.clone(), time);
                    low.insert(v.clone(), time);
                    child_count.insert(v.clone(), 0);
                    stack.push(BccFrame {
                        neighbours: adjacency.get(&v).cloned().unwrap_or_default(),
                        u: v,
                        root: root_id,
                        next: 0,
                    });
                } else if parent.get(&u) != Some(&v)
                    && disc.get(&v).copied().unwrap_or(usize::MAX)
                        < disc.get(&u).copied().unwrap_or(usize::MAX)
                {
                    edge_stack.push(ComponentEdge {
                        key: undirected_key(&u, &v),
                        u: u.clone(),
                        v: v.clone(),
                    });
                    let low_u = low.get(&u).copied().unwrap_or(usize::MAX);
                    let disc_v = disc.get(&v).copied().unwrap_or(usize::MAX);
                    low.insert(u, low_u.min(disc_v));
                }
                continue;
            }

            let frame = stack.pop().expect("frame should pop");
            let u = frame.u;
            let root_id = frame.root;
            let Some(parent_u) = parent.get(&u).cloned() else {
                continue;
            };

            let low_u = low.get(&u).copied().unwrap_or(usize::MAX);
            let low_parent = low.get(&parent_u).copied().unwrap_or(usize::MAX);
            low.insert(parent_u.clone(), low_parent.min(low_u));

            let disc_parent = disc.get(&parent_u).copied().unwrap_or(usize::MAX);
            if low_u >= disc_parent {
                if parent_u != root_id || child_count.get(&parent_u).copied().unwrap_or(0) > 1 {
                    articulation.insert(parent_u.clone());
                }
                let component = pop_component(&mut edge_stack, &undirected_key(&parent_u, &u));
                if !component.is_empty() {
                    components.push(component);
                }
            }
        }

        if edge_stack.len() > root_stack_start {
            let component = edge_stack.split_off(root_stack_start);
            if !component.is_empty() {
                components.push(component);
            }
        }
    }

    components.retain(|component| !component.is_empty());
    (components, articulation)
}

fn pop_component(edge_stack: &mut Vec<ComponentEdge>, stop_key: &str) -> Vec<ComponentEdge> {
    let mut component = Vec::new();
    while let Some(edge) = edge_stack.pop() {
        let done = edge.key == stop_key;
        component.push(edge);
        if done {
            break;
        }
    }
    component
}

fn enumerate_component_cycles(
    component: &[ComponentEdge],
    topology: &Topology,
    graph: &LeisureGraph,
    projection: &Projection,
) -> Vec<CycleCandidate> {
    let mut adjacency_sets: BTreeMap<NodeId, BTreeSet<NodeId>> = BTreeMap::new();
    for edge in component {
        add_adjacency(&mut adjacency_sets, edge.u.clone(), edge.v.clone());
    }
    let adjacency: BTreeMap<NodeId, Vec<NodeId>> = adjacency_sets
        .into_iter()
        .map(|(node, neighbours)| (node, neighbours.into_iter().collect()))
        .collect();
    let nodes: Vec<NodeId> = adjacency.keys().cloned().collect();
    let component_pass_ids: BTreeSet<NodeId> = nodes
        .iter()
        .filter(|node| projection.is_pass(node))
        .cloned()
        .collect();
    let order: BTreeMap<NodeId, usize> = nodes
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, node)| (node, index))
        .collect();
    let mut cycles = Vec::new();
    let mut seen = BTreeSet::new();
    let mut candidate_covered_pass_ids = BTreeSet::new();
    let mut steps = 0usize;

    let mut sorted_edges = component.to_vec();
    sorted_edges.sort_by(|left, right| left.key.cmp(&right.key));
    for edge in &sorted_edges {
        if is_candidate_search_complete(&cycles, &candidate_covered_pass_ids, &component_pass_ids) {
            break;
        }
        let path = shortest_path_excluding_edge(&edge.u, &edge.v, &edge.key, &adjacency);
        if path.len() >= 3 {
            add_cycle(
                &path,
                &mut cycles,
                &mut seen,
                &mut candidate_covered_pass_ids,
                &component_pass_ids,
                graph,
                topology,
                projection,
            );
        }
    }

    for start in &nodes {
        if is_candidate_search_complete(&cycles, &candidate_covered_pass_ids, &component_pass_ids)
            || steps >= MAX_DFS_STEPS
        {
            break;
        }
        let mut visited = BTreeSet::new();
        visited.insert(start.clone());
        let mut stack = vec![CycleDfsState {
            current: start.clone(),
            path: vec![start.clone()],
            visited,
        }];
        let start_order = order.get(start).copied().unwrap_or(usize::MAX);

        while let Some(state) = stack.pop() {
            if is_candidate_search_complete(
                &cycles,
                &candidate_covered_pass_ids,
                &component_pass_ids,
            ) || steps >= MAX_DFS_STEPS
            {
                break;
            }
            steps += 1;
            if state.path.len() > MAX_CYCLE_DEPTH {
                continue;
            }

            let Some(neighbours) = adjacency.get(&state.current) else {
                continue;
            };
            for next in neighbours.iter().rev() {
                if order.get(next).copied().unwrap_or(usize::MAX) < start_order {
                    continue;
                }
                if next == start {
                    if state.path.len() >= 3 {
                        add_cycle(
                            &state.path,
                            &mut cycles,
                            &mut seen,
                            &mut candidate_covered_pass_ids,
                            &component_pass_ids,
                            graph,
                            topology,
                            projection,
                        );
                    }
                    continue;
                }
                if state.visited.contains(next) {
                    continue;
                }

                let mut next_path = state.path.clone();
                next_path.push(next.clone());
                let mut next_visited = state.visited.clone();
                next_visited.insert(next.clone());
                stack.push(CycleDfsState {
                    current: next.clone(),
                    path: next_path,
                    visited: next_visited,
                });
            }
        }
    }

    cycles.sort_by(|left, right| {
        left.cost
            .total_cmp(&right.cost)
            .then_with(|| left.key.cmp(&right.key))
    });
    select_cycles_for_coverage(cycles, &component_pass_ids)
}

#[derive(Clone, Debug)]
struct CycleDfsState {
    current: NodeId,
    path: Vec<NodeId>,
    visited: BTreeSet<NodeId>,
}

#[allow(clippy::too_many_arguments)]
fn add_cycle(
    path: &[NodeId],
    cycles: &mut Vec<CycleCandidate>,
    seen: &mut BTreeSet<String>,
    candidate_covered_pass_ids: &mut BTreeSet<NodeId>,
    component_pass_ids: &BTreeSet<NodeId>,
    graph: &LeisureGraph,
    topology: &Topology,
    projection: &Projection,
) {
    let key = canonical_cycle_key(path);
    if !seen.insert(key.clone()) {
        return;
    }

    cycles.push(CycleCandidate {
        nodes: path.to_vec(),
        key,
        cost: pseudo_walk_cost(path, true, graph, topology, projection),
    });
    for node in path {
        if component_pass_ids.contains(node) {
            candidate_covered_pass_ids.insert(node.clone());
        }
    }
}

fn is_candidate_search_complete(
    cycles: &[CycleCandidate],
    candidate_covered_pass_ids: &BTreeSet<NodeId>,
    component_pass_ids: &BTreeSet<NodeId>,
) -> bool {
    cycles.len() >= MAX_CYCLE_CANDIDATES
        && candidate_covered_pass_ids.len() >= component_pass_ids.len()
}

fn select_cycles_for_coverage(
    cycles: Vec<CycleCandidate>,
    component_pass_ids: &BTreeSet<NodeId>,
) -> Vec<CycleCandidate> {
    let mut selected = Vec::new();
    let mut covered_pass_ids = BTreeSet::new();
    let base_count = MAX_CYCLES_PER_COMPONENT.min(cycles.len());

    for cycle in cycles.iter().take(base_count) {
        add_selected_cycle(
            cycle,
            &mut selected,
            &mut covered_pass_ids,
            component_pass_ids,
        );
    }
    if covered_pass_ids.len() >= component_pass_ids.len() {
        return selected;
    }

    for cycle in cycles.iter().skip(base_count) {
        if selected.len() >= MAX_COVERAGE_CYCLES_PER_COMPONENT {
            break;
        }
        if !cycle
            .nodes
            .iter()
            .any(|node| component_pass_ids.contains(node) && !covered_pass_ids.contains(node))
        {
            continue;
        }
        add_selected_cycle(
            cycle,
            &mut selected,
            &mut covered_pass_ids,
            component_pass_ids,
        );
        if covered_pass_ids.len() >= component_pass_ids.len() {
            break;
        }
    }

    selected
}

fn add_selected_cycle(
    cycle: &CycleCandidate,
    selected: &mut Vec<CycleCandidate>,
    covered_pass_ids: &mut BTreeSet<NodeId>,
    component_pass_ids: &BTreeSet<NodeId>,
) {
    selected.push(cycle.clone());
    for node in &cycle.nodes {
        if component_pass_ids.contains(node) {
            covered_pass_ids.insert(node.clone());
        }
    }
}

fn shortest_path_excluding_edge(
    from: &NodeId,
    to: &NodeId,
    excluded_key: &str,
    adjacency: &BTreeMap<NodeId, Vec<NodeId>>,
) -> Vec<NodeId> {
    let mut queue = VecDeque::from([from.clone()]);
    let mut previous: BTreeMap<NodeId, Option<NodeId>> = BTreeMap::from([(from.clone(), None)]);

    while let Some(current) = queue.pop_front() {
        if &current == to {
            break;
        }
        let Some(neighbours) = adjacency.get(&current) else {
            continue;
        };
        for next in neighbours {
            if undirected_key(&current, next) == excluded_key || previous.contains_key(next) {
                continue;
            }
            previous.insert(next.clone(), Some(current.clone()));
            queue.push_back(next.clone());
        }
    }

    if !previous.contains_key(to) {
        return Vec::new();
    }

    let mut path = Vec::new();
    let mut current = Some(to.clone());
    while let Some(node) = current {
        path.push(node.clone());
        current = previous.get(&node).cloned().flatten();
    }
    path.reverse();
    path
}

fn compress_bridge_paths(
    components: &[Vec<ComponentEdge>],
    topology: &Topology,
    graph: &LeisureGraph,
) -> Vec<BridgePath> {
    let bridge_keys: BTreeSet<String> = components
        .iter()
        .filter(|component| component.len() == 1)
        .map(|component| component[0].key.clone())
        .collect();
    let full_degree: BTreeMap<NodeId, usize> = topology
        .adjacency
        .iter()
        .map(|(node, neighbours)| (node.clone(), neighbours.len()))
        .collect();
    let mut bridge_adjacency_sets: BTreeMap<NodeId, BTreeSet<NodeId>> = BTreeMap::new();
    let mut visited = BTreeSet::new();
    let mut paths = Vec::new();

    for key in &bridge_keys {
        let (u, v) = split_undirected_key(key);
        add_adjacency(&mut bridge_adjacency_sets, u, v);
    }
    let bridge_adjacency: BTreeMap<NodeId, Vec<NodeId>> = bridge_adjacency_sets
        .into_iter()
        .map(|(node, neighbours)| (node, neighbours.into_iter().collect()))
        .collect();

    for key in &bridge_keys {
        if visited.contains(key) {
            continue;
        }
        let (u, v) = split_undirected_key(key);
        visited.insert(key.clone());
        let mut left = walk_bridge_direction(
            u.clone(),
            v.clone(),
            &bridge_adjacency,
            &full_degree,
            graph,
            &mut visited,
        );
        let right =
            walk_bridge_direction(v, u, &bridge_adjacency, &full_degree, graph, &mut visited);
        left.reverse();
        let mut nodes = left;
        nodes.extend(right);
        if nodes.len() < 2 {
            continue;
        }

        let first_degree = full_degree.get(&nodes[0]).copied().unwrap_or(0);
        let last_degree = full_degree
            .get(nodes.last().expect("last node"))
            .copied()
            .unwrap_or(0);
        let has_endpoint_spur = first_degree <= 1 || last_degree <= 1;
        let kind = if nodes.len() > 2 || !has_endpoint_spur {
            EarKind::Path
        } else {
            EarKind::Spur
        };
        paths.push(BridgePath { kind, nodes });
    }

    paths
}

fn walk_bridge_direction(
    start: NodeId,
    mut previous: NodeId,
    bridge_adjacency: &BTreeMap<NodeId, Vec<NodeId>>,
    full_degree: &BTreeMap<NodeId, usize>,
    graph: &LeisureGraph,
    visited: &mut BTreeSet<String>,
) -> Vec<NodeId> {
    let mut nodes = vec![start.clone()];
    let mut current = start;

    while !is_bridge_anchor(&current, full_degree, graph) {
        let candidates: Vec<NodeId> = bridge_adjacency
            .get(&current)
            .into_iter()
            .flatten()
            .filter(|node| **node != previous && !visited.contains(&undirected_key(&current, node)))
            .cloned()
            .collect();
        if candidates.len() != 1 {
            break;
        }
        let candidate = candidates[0].clone();
        visited.insert(undirected_key(&current, &candidate));
        nodes.push(candidate.clone());
        previous = current;
        current = candidate;
    }

    nodes
}

fn is_bridge_anchor(
    node_id: &NodeId,
    full_degree: &BTreeMap<NodeId, usize>,
    graph: &LeisureGraph,
) -> bool {
    full_degree.get(node_id).copied().unwrap_or(0) != 2
        || graph.node_kind_of(node_id) == Some(NodeKind::Junction)
}

fn make_ear(
    kind: EarKind,
    nodes: &[NodeId],
    closed: bool,
    graph: &LeisureGraph,
    topology: &Topology,
    projection: &Projection,
    articulation: &BTreeSet<NodeId>,
) -> EarDraft {
    let expanded = expand_pseudo_walk(nodes, closed, graph, topology, projection);
    let attachments = attachment_nodes(kind, nodes, graph, articulation);
    let passes = ordered_unique_strings(
        nodes
            .iter()
            .filter(|node| projection.is_pass(node))
            .map(|node| node.to_string()),
    );
    let junctions = ordered_unique_strings(
        nodes
            .iter()
            .filter(|node| graph.node_kind_of(node) == Some(NodeKind::Junction))
            .map(|node| node.to_string()),
    );

    EarDraft {
        ear: Ear {
            id: String::new(),
            kind,
            passes,
            edges: expanded.edges,
            attachment_nodes: attachments,
            total_leisure_cost: expanded.total_leisure_cost,
            total_distance_km: expanded.total_distance_m / 1000.0,
        },
        junctions,
    }
}

fn append_ear(ears: &mut Vec<Ear>, junctions_by_ear: &mut Vec<Vec<String>>, draft: EarDraft) {
    if draft.ear.edges.is_empty() || draft.ear.passes.is_empty() {
        return;
    }
    ears.push(draft.ear);
    junctions_by_ear.push(draft.junctions);
}

fn append_isolated_pass_ears(
    ears: &mut Vec<Ear>,
    junctions_by_ear: &mut Vec<Vec<String>>,
    projection: &Projection,
) {
    let covered_pass_ids: BTreeSet<String> = ears
        .iter()
        .flat_map(|ear| ear.passes.iter().cloned())
        .collect();

    for pass_id in &projection.pass_ids {
        if covered_pass_ids.contains(pass_id.as_str()) {
            continue;
        }
        ears.push(Ear {
            id: String::new(),
            kind: EarKind::IsolatedPass,
            passes: vec![pass_id.to_string()],
            edges: Vec::new(),
            attachment_nodes: vec![pass_id.clone()],
            total_leisure_cost: 0.0,
            total_distance_km: 0.0,
        });
        junctions_by_ear.push(Vec::new());
    }
}

fn expand_pseudo_walk(
    nodes: &[NodeId],
    closed: bool,
    graph: &LeisureGraph,
    topology: &Topology,
    projection: &Projection,
) -> ExpandedWalk {
    let mut edges = Vec::new();
    let mut total_leisure_cost = 0.0;
    let mut total_distance_m = 0.0;
    if nodes.is_empty() {
        return ExpandedWalk {
            edges,
            total_leisure_cost,
            total_distance_m,
        };
    }

    let pair_count = if closed {
        nodes.len()
    } else {
        nodes.len().saturating_sub(1)
    };
    let connectors: Vec<Option<usize>> = (0..pair_count)
        .map(|index| best_connector(topology, &nodes[index], &nodes[(index + 1) % nodes.len()]))
        .collect();

    for (index, connector) in connectors.iter().enumerate() {
        let Some(edge_index) = connector else {
            continue;
        };
        add_expanded_edge(
            *edge_index,
            graph,
            &mut edges,
            &mut total_leisure_cost,
            &mut total_distance_m,
        );

        let target_index = (index + 1) % nodes.len();
        let target_pseudo = &nodes[target_index];
        let has_outgoing = closed || target_index < nodes.len() - 1;
        if !has_outgoing || !projection.is_pass(target_pseudo) {
            continue;
        }
        let Some(Some(next_connector)) = connectors.get((index + 1) % connectors.len()) else {
            continue;
        };
        let connector_edge = &graph.edges[*edge_index];
        let next_connector_edge = &graph.edges[*next_connector];
        for pass_edge_index in pass_traversal_edges(
            graph,
            target_pseudo,
            connector_stop_for(connector_edge, target_pseudo, graph, projection),
            connector_stop_for(next_connector_edge, target_pseudo, graph, projection),
        ) {
            add_expanded_edge(
                pass_edge_index,
                graph,
                &mut edges,
                &mut total_leisure_cost,
                &mut total_distance_m,
            );
        }
    }

    ExpandedWalk {
        edges,
        total_leisure_cost,
        total_distance_m,
    }
}

fn add_expanded_edge(
    edge_index: usize,
    graph: &LeisureGraph,
    edges: &mut Vec<usize>,
    total_leisure_cost: &mut f64,
    total_distance_m: &mut f64,
) {
    let Some(edge) = graph.edges.get(edge_index) else {
        return;
    };
    edges.push(edge_index);
    *total_leisure_cost += number_or_zero(edge.leisure_cost);
    *total_distance_m += number_or_zero(edge.distance_m);
}

fn pass_traversal_edges(
    graph: &LeisureGraph,
    pass_id: &NodeId,
    from_stop: Option<NodeId>,
    to_stop: Option<NodeId>,
) -> Vec<usize> {
    let (Some(from_stop), Some(to_stop)) = (from_stop, to_stop) else {
        return Vec::new();
    };
    if from_stop == to_stop {
        return Vec::new();
    }
    if pass_id_from_synthetic_id(from_stop.as_str()).as_ref() != Some(pass_id)
        || pass_id_from_synthetic_id(to_stop.as_str()).as_ref() != Some(pass_id)
    {
        return Vec::new();
    }

    let summit = NodeId::new(format!("{pass_id}:S"));
    let mut edges = Vec::new();
    if from_stop != summit {
        if let Some(edge_index) = pass_climb_edge_index(graph, &from_stop, &summit) {
            edges.push(edge_index);
        }
    }
    if to_stop != summit {
        if let Some(edge_index) = pass_climb_edge_index(graph, &summit, &to_stop) {
            edges.push(edge_index);
        }
    }
    edges
}

fn pass_climb_edge_index(graph: &LeisureGraph, from: &NodeId, to: &NodeId) -> Option<usize> {
    let index = *graph.edge_by_key.get(&edge_key(from, to))?;
    matches!(&graph.edges.get(index)?.kind, EdgeKind::PassClimb).then_some(index)
}

fn connector_stop_for(
    edge: &Edge,
    pass_id: &NodeId,
    graph: &LeisureGraph,
    projection: &Projection,
) -> Option<NodeId> {
    if projection.pseudo_of(graph, &edge.from).as_ref() == Some(pass_id) {
        return Some(edge.from.clone());
    }
    if projection.pseudo_of(graph, &edge.to).as_ref() == Some(pass_id) {
        return Some(edge.to.clone());
    }
    None
}

fn attachment_nodes(
    kind: EarKind,
    nodes: &[NodeId],
    graph: &LeisureGraph,
    articulation: &BTreeSet<NodeId>,
) -> Vec<NodeId> {
    let mut attachments = Vec::new();
    if kind == EarKind::Loop {
        for node in nodes {
            if articulation.contains(node) || graph.node_kind_of(node) == Some(NodeKind::Junction) {
                attachments.push(node.clone());
            }
        }
        if attachments.is_empty() {
            if let Some(first) = nodes.first() {
                attachments.push(first.clone());
            }
        }
    } else if !nodes.is_empty() {
        attachments.push(nodes[0].clone());
        attachments.push(nodes[nodes.len() - 1].clone());
        for node in nodes.iter().skip(1).take(nodes.len().saturating_sub(2)) {
            if articulation.contains(node) || graph.node_kind_of(node) == Some(NodeKind::Junction) {
                attachments.push(node.clone());
            }
        }
    }
    ordered_unique_nodes(attachments)
}

fn index_ear_values<F>(ears: &[Ear], values_for_ear: F) -> BTreeMap<String, Vec<usize>>
where
    F: Fn(&Ear) -> &[String],
{
    let mut index = BTreeMap::new();
    for (ear_index, ear) in ears.iter().enumerate() {
        for value in values_for_ear(ear) {
            index
                .entry(value.clone())
                .or_insert_with(Vec::new)
                .push(ear_index);
        }
    }
    index
}

fn index_junctions(junctions_by_ear: &[Vec<String>]) -> BTreeMap<String, Vec<usize>> {
    let mut index = BTreeMap::new();
    for (ear_index, junctions) in junctions_by_ear.iter().enumerate() {
        for junction in junctions {
            index
                .entry(junction.clone())
                .or_insert_with(Vec::new)
                .push(ear_index);
        }
    }
    index
}

fn best_connector(topology: &Topology, from: &NodeId, to: &NodeId) -> Option<usize> {
    topology
        .directed_best
        .get(&(from.clone(), to.clone()))
        .or_else(|| topology.directed_best.get(&(to.clone(), from.clone())))
        .or_else(|| topology.undirected_best.get(&undirected_key(from, to)))
        .map(|choice| choice.edge_index)
}

fn pseudo_walk_cost(
    nodes: &[NodeId],
    closed: bool,
    graph: &LeisureGraph,
    topology: &Topology,
    projection: &Projection,
) -> f64 {
    if nodes.is_empty() {
        return 0.0;
    }
    let pair_count = if closed {
        nodes.len()
    } else {
        nodes.len().saturating_sub(1)
    };
    let connectors: Vec<Option<usize>> = (0..pair_count)
        .map(|index| best_connector(topology, &nodes[index], &nodes[(index + 1) % nodes.len()]))
        .collect();
    let mut cost = 0.0;

    for (index, connector) in connectors.iter().enumerate() {
        if let Some(edge_index) = connector {
            cost += number_or_zero(graph.edges[*edge_index].leisure_cost);
        }

        let target_index = (index + 1) % nodes.len();
        let target_pseudo = &nodes[target_index];
        let has_outgoing = closed || target_index < nodes.len() - 1;
        if connector.is_none() || !has_outgoing || !projection.is_pass(target_pseudo) {
            continue;
        }
        let Some(Some(next_connector)) = connectors.get((index + 1) % connectors.len()) else {
            continue;
        };
        let connector_edge = &graph.edges[connector.expect("connector exists")];
        let next_connector_edge = &graph.edges[*next_connector];
        for pass_edge_index in pass_traversal_edges(
            graph,
            target_pseudo,
            connector_stop_for(connector_edge, target_pseudo, graph, projection),
            connector_stop_for(next_connector_edge, target_pseudo, graph, projection),
        ) {
            cost += number_or_zero(graph.edges[pass_edge_index].leisure_cost);
        }
    }

    cost
}

fn add_adjacency(adjacency: &mut BTreeMap<NodeId, BTreeSet<NodeId>>, from: NodeId, to: NodeId) {
    adjacency
        .entry(from.clone())
        .or_default()
        .insert(to.clone());
    adjacency.entry(to).or_default().insert(from);
}

fn replace_if_cheaper<K: Ord>(
    map: &mut BTreeMap<K, ConnectorChoice>,
    key: K,
    value: ConnectorChoice,
    graph: &LeisureGraph,
) {
    let should_replace = map.get(&key).map_or(true, |existing| {
        compare_edge_indices(graph, value.edge_index, existing.edge_index).is_lt()
    });
    if should_replace {
        map.insert(key, value);
    }
}

fn compare_edge_indices(graph: &LeisureGraph, left: usize, right: usize) -> Ordering {
    let left = &graph.edges[left];
    let right = &graph.edges[right];
    number_or_zero(left.leisure_cost)
        .total_cmp(&number_or_zero(right.leisure_cost))
        .then_with(|| number_or_zero(left.distance_m).total_cmp(&number_or_zero(right.distance_m)))
        .then_with(|| left.canonical_id().cmp(&right.canonical_id()))
}

fn canonical_cycle_key(nodes: &[NodeId]) -> String {
    let mut rotations = cycle_rotations(nodes);
    let mut reversed = nodes.to_vec();
    reversed.reverse();
    rotations.extend(cycle_rotations(&reversed));
    rotations.sort();
    rotations.into_iter().next().unwrap_or_default()
}

fn cycle_rotations(nodes: &[NodeId]) -> Vec<String> {
    let mut out = Vec::new();
    for index in 0..nodes.len() {
        let rotated: Vec<&str> = nodes[index..]
            .iter()
            .chain(nodes[..index].iter())
            .map(NodeId::as_str)
            .collect();
        out.push(rotated.join("\0"));
    }
    out
}

fn undirected_key(a: &NodeId, b: &NodeId) -> String {
    let (u, v) = sorted_pair(a, b);
    format!("{u}\0{v}")
}

fn split_undirected_key(key: &str) -> (NodeId, NodeId) {
    let mut parts = key.splitn(2, '\0');
    (
        NodeId::from(parts.next().unwrap_or_default()),
        NodeId::from(parts.next().unwrap_or_default()),
    )
}

fn sorted_pair(a: &NodeId, b: &NodeId) -> (NodeId, NodeId) {
    if a <= b {
        (a.clone(), b.clone())
    } else {
        (b.clone(), a.clone())
    }
}

fn ordered_unique_nodes(values: Vec<NodeId>) -> Vec<NodeId> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn ordered_unique_strings<I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn pass_id_from_synthetic_id(node_id: &str) -> Option<NodeId> {
    let (pass_id, suffix) = node_id.rsplit_once(':')?;
    (!pass_id.is_empty() && matches!(suffix, "A" | "S" | "B")).then(|| NodeId::from(pass_id))
}

#[cfg(test)]
mod tests {
    use super::pass_id_from_synthetic_id;

    #[test]
    fn synthetic_pass_ids_require_non_empty_prefix() {
        assert_eq!(pass_id_from_synthetic_id(":A"), None);
        assert_eq!(
            pass_id_from_synthetic_id("furka:A").as_deref(),
            Some("furka")
        );
    }
}

fn number_or_zero(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}
