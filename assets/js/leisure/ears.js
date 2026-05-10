const MAX_CYCLES_PER_COMPONENT = 32;
const MAX_COVERAGE_CYCLES_PER_COMPONENT = 256;
const MAX_CYCLE_CANDIDATES = 1024;
const MAX_CYCLE_DEPTH = 32;
const MAX_DFS_STEPS = 50_000;

/**
 * Decomposes the contracted leisure graph into loop/path/spur ears.
 *
 * Pass triplets are contracted to pass pseudo-nodes, connector topology is split
 * with Hopcroft-Tarjan biconnected components in O(V + E), and simple-cycle
 * enumeration is bounded to the 32 cheapest cycles per component, with a
 * coverage extension for passes that would otherwise be omitted.
 *
 * @param {import("./graph.js").LeisureGraph} graph
 * @returns {{ ears: object[], passToEars: Map<string, object[]>, junctionToEars: Map<string, object[]> }}
 */
export function decomposeEars(graph) {
  const projection = buildProjection(graph);
  const topology = buildTopology(graph, projection);
  const { components, articulation } = biconnectedComponents(topology.adjacency);
  const ears = [];

  for (const component of components.filter((item) => item.length > 1)) {
    const cycles = enumerateComponentCycles(component, topology, graph, projection);
    for (const cycle of cycles) {
      appendEar(ears, makeEar("loop", cycle.nodes, true, graph, topology, projection, articulation));
    }
  }

  for (const path of compressBridgePaths(components, topology, graph)) {
    appendEar(ears, makeEar(path.kind, path.nodes, false, graph, topology, projection, articulation));
  }

  appendIsolatedPassEars(ears, projection);

  ears.forEach((ear, index) => {
    ear.id = `ear-${index + 1}`;
  });

  const passToEars = indexEars(ears, (ear) => ear.passes);
  const junctionToEars = indexEars(ears, (ear) => ear._junctions);
  for (const ear of ears) delete ear._junctions;

  return {
    ears,
    passToEars,
    junctionToEars,
  };
}

function buildProjection(graph) {
  const passIds = new Set((graph.nodesByKind.get("pass") ?? []).map((node) => node.id));

  function pseudoOf(nodeId) {
    const node = graph.nodes.get(nodeId);
    if (node?.kind === "pass") return node.id;
    if (node?.kind === "pass-base" || node?.kind === "pass-summit") return node.passId ?? passIdFromSyntheticId(node.id);
    const syntheticPassId = passIdFromSyntheticId(nodeId);
    if (syntheticPassId && passIds.has(syntheticPassId)) return syntheticPassId;
    return nodeId;
  }

  return { pseudoOf, passIds };
}

function buildTopology(graph, projection) {
  const adjacency = new Map();
  const directedBest = new Map();
  const undirectedBest = new Map();

  for (const edge of graph.edgeList) {
    if (edge.kind !== "connector") continue;
    const from = projection.pseudoOf(edge.from);
    const to = projection.pseudoOf(edge.to);
    if (!from || !to || from === to) continue;

    addAdjacency(adjacency, from, to);
    replaceIfCheaper(directedBest, `${from}->${to}`, { from, to, edge });

    const key = undirectedKey(from, to);
    const [u, v] = sortedPair(from, to);
    replaceIfCheaper(undirectedBest, key, { u, v, key, edge });
  }

  for (const [node, neighbours] of adjacency) {
    adjacency.set(node, [...neighbours].sort());
  }

  return { adjacency, directedBest, undirectedBest };
}

function biconnectedComponents(adjacency) {
  const nodes = [...adjacency.keys()].sort();
  const disc = new Map();
  const low = new Map();
  const parent = new Map();
  const edgeStack = [];
  const components = [];
  const articulation = new Set();
  let time = 0;

  // TODO: convert to iterative if BCC > 5000 nodes.
  function dfs(u, root) {
    disc.set(u, ++time);
    low.set(u, disc.get(u));
    let children = 0;

    for (const v of adjacency.get(u) ?? []) {
      const key = undirectedKey(u, v);
      if (!disc.has(v)) {
        parent.set(v, u);
        children += 1;
        edgeStack.push({ u, v, key });
        dfs(v, root);
        low.set(u, Math.min(low.get(u), low.get(v)));

        if (low.get(v) >= disc.get(u)) {
          if (u !== root || children > 1) articulation.add(u);
          components.push(popComponent(edgeStack, key));
        }
      } else if (v !== parent.get(u) && disc.get(v) < disc.get(u)) {
        edgeStack.push({ u, v, key });
        low.set(u, Math.min(low.get(u), disc.get(v)));
      }
    }
  }

  for (const node of nodes) {
    if (disc.has(node)) continue;
    dfs(node, node);
    if (edgeStack.length) components.push(edgeStack.splice(0));
  }

  return { components: components.filter((component) => component.length > 0), articulation };
}

function popComponent(edgeStack, stopKey) {
  const component = [];
  while (edgeStack.length) {
    const edge = edgeStack.pop();
    component.push(edge);
    if (edge.key === stopKey) break;
  }
  return component;
}

function enumerateComponentCycles(component, topology, graph, projection) {
  const adjacency = new Map();
  for (const edge of component) addAdjacency(adjacency, edge.u, edge.v);
  for (const [node, neighbours] of adjacency) adjacency.set(node, [...neighbours].sort());

  const nodes = [...adjacency.keys()].sort();
  const componentPassIds = new Set(nodes.filter((node) => projection.passIds.has(node)));
  const order = new Map(nodes.map((node, index) => [node, index]));
  const cycles = [];
  const seen = new Set();
  const candidateCoveredPassIds = new Set();
  let steps = 0;

  for (const edge of component.slice().sort((a, b) => a.key.localeCompare(b.key))) {
    if (cycles.length >= MAX_CYCLE_CANDIDATES && candidateCoveredPassIds.size >= componentPassIds.size) break;
    const path = shortestPathExcludingEdge(edge.u, edge.v, edge.key, adjacency);
    if (path.length >= 3) addCycle(path);
  }

  for (const start of nodes) {
    if (isCandidateSearchComplete() || steps >= MAX_DFS_STEPS) break;
    const visited = new Set([start]);
    dfsCycle(start, start, [start], visited);
  }

  return selectCyclesForCoverage(
    cycles.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key)),
    componentPassIds
  );

  function dfsCycle(start, current, path, visited) {
    if (isCandidateSearchComplete() || steps >= MAX_DFS_STEPS) return;
    steps += 1;
    if (path.length > MAX_CYCLE_DEPTH) return;

    for (const next of adjacency.get(current) ?? []) {
      if (order.get(next) < order.get(start)) continue;
      if (next === start) {
        if (path.length >= 3) addCycle(path);
        continue;
      }
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      dfsCycle(start, next, path, visited);
      path.pop();
      visited.delete(next);
    }
  }

  function addCycle(path) {
    const key = canonicalCycleKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    cycles.push({ nodes: path.slice(), key, cost: pseudoWalkCost(path, true, graph, topology, projection) });
    for (const node of path) {
      if (componentPassIds.has(node)) candidateCoveredPassIds.add(node);
    }
  }

  function isCandidateSearchComplete() {
    return cycles.length >= MAX_CYCLE_CANDIDATES && candidateCoveredPassIds.size >= componentPassIds.size;
  }
}

function selectCyclesForCoverage(cycles, componentPassIds) {
  const selected = [];
  const coveredPassIds = new Set();
  const baseCount = Math.min(MAX_CYCLES_PER_COMPONENT, cycles.length);

  for (let i = 0; i < baseCount; i += 1) addSelected(cycles[i]);
  if (coveredPassIds.size >= componentPassIds.size) return selected;

  // FIX: Keep the cheap-cycle ranking, then extend only with cycles that cover
  // passes absent from the base cap so large BCCs do not strand pass nodes.
  for (let i = baseCount; i < cycles.length && selected.length < MAX_COVERAGE_CYCLES_PER_COMPONENT; i += 1) {
    const cycle = cycles[i];
    if (!cycle.nodes.some((node) => componentPassIds.has(node) && !coveredPassIds.has(node))) continue;
    addSelected(cycle);
    if (coveredPassIds.size >= componentPassIds.size) break;
  }

  return selected;

  function addSelected(cycle) {
    selected.push(cycle);
    for (const node of cycle.nodes) {
      if (componentPassIds.has(node)) coveredPassIds.add(node);
    }
  }
}

function shortestPathExcludingEdge(from, to, excludedKey, adjacency) {
  const queue = [from];
  const previous = new Map([[from, null]]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === to) break;
    for (const next of adjacency.get(current) ?? []) {
      if (undirectedKey(current, next) === excludedKey || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }

  if (!previous.has(to)) return [];
  const path = [];
  for (let node = to; node !== null; node = previous.get(node)) path.push(node);
  return path.reverse();
}

function compressBridgePaths(components, topology, graph) {
  const bridgeKeys = new Set(components.filter((component) => component.length === 1).map((component) => component[0].key));
  const bridgeAdjacency = new Map();
  const fullDegree = new Map();
  const visited = new Set();
  const paths = [];

  for (const [node, neighbours] of topology.adjacency) fullDegree.set(node, neighbours.length);

  for (const key of bridgeKeys) {
    const [u, v] = splitUndirectedKey(key);
    addAdjacency(bridgeAdjacency, u, v);
  }
  for (const [node, neighbours] of bridgeAdjacency) bridgeAdjacency.set(node, [...neighbours].sort());

  for (const key of [...bridgeKeys].sort()) {
    if (visited.has(key)) continue;
    const [u, v] = splitUndirectedKey(key);
    visited.add(key);
    const left = walkBridgeDirection(u, v, bridgeAdjacency, fullDegree, graph, visited);
    const right = walkBridgeDirection(v, u, bridgeAdjacency, fullDegree, graph, visited);
    const nodes = left.reverse().concat(right);
    if (nodes.length < 2) continue;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const hasEndpointSpur = (fullDegree.get(first) ?? 0) <= 1 || (fullDegree.get(last) ?? 0) <= 1;
    // FIX: A compressed multi-edge bridge chain is a path ear even when it
    // starts or ends at a degree-1 anchor; only single-edge dead-ends are spurs.
    const kind = nodes.length > 2 || !hasEndpointSpur ? "path" : "spur";
    paths.push({ kind, nodes });
  }

  return paths;
}

function walkBridgeDirection(start, previous, bridgeAdjacency, fullDegree, graph, visited) {
  const nodes = [start];
  let current = start;

  while (!isBridgeAnchor(current, fullDegree, graph)) {
    const candidates = (bridgeAdjacency.get(current) ?? []).filter((node) => node !== previous && !visited.has(undirectedKey(current, node)));
    if (candidates.length !== 1) break;
    const candidate = candidates[0];
    visited.add(undirectedKey(current, candidate));
    nodes.push(candidate);
    previous = current;
    current = candidate;
  }

  return nodes;
}

function isBridgeAnchor(nodeId, fullDegree, graph) {
  const degree = fullDegree.get(nodeId) ?? 0;
  // FIX: Degree-2 tree nodes are articulation points too; only true endpoints
  // and named junctions should stop bridge-chain compression.
  return degree !== 2 || graph.nodeKindOf(nodeId) === "junction";
}

function makeEar(kind, nodes, closed, graph, topology, projection, articulation) {
  const expanded = expandPseudoWalk(nodes, closed, graph, topology, projection);
  const attachments = attachmentNodes(kind, nodes, graph, articulation);
  const passes = orderedUnique(nodes.filter((node) => projection.passIds.has(node)));
  const junctions = orderedUnique(nodes.filter((node) => graph.nodeKindOf(node) === "junction"));

  return {
    id: "",
    kind,
    passes,
    edges: expanded.edges,
    attachmentNodes: attachments,
    totalLeisureCost: roundNumber(expanded.totalLeisureCost, 3),
    totalDistanceKm: roundNumber(expanded.totalDistanceM / 1000, 3),
    _junctions: junctions,
  };
}

function appendEar(ears, ear) {
  if (!ear || ear.edges.length === 0 || ear.passes.length === 0) return;
  ears.push(ear);
}

function appendIsolatedPassEars(ears, projection) {
  const coveredPassIds = new Set();
  for (const ear of ears) {
    for (const passId of ear.passes) coveredPassIds.add(passId);
  }

  // FIX: Bounded cycle enumeration can still miss disconnected or otherwise
  // uncovered passes; stubs make passToEars total over every pass node.
  for (const passId of [...projection.passIds].sort()) {
    if (coveredPassIds.has(passId)) continue;
    ears.push({
      id: "",
      kind: "isolated-pass",
      passes: [passId],
      edges: [],
      attachmentNodes: [passId],
      totalLeisureCost: 0,
      totalDistanceKm: 0,
      _junctions: [],
    });
  }
}

function expandPseudoWalk(nodes, closed, graph, topology, projection) {
  const edgeIds = [];
  let totalLeisureCost = 0;
  let totalDistanceM = 0;
  const pairCount = closed ? nodes.length : nodes.length - 1;
  const connectors = [];

  for (let i = 0; i < pairCount; i += 1) {
    connectors.push(bestConnector(topology, nodes[i], nodes[(i + 1) % nodes.length]));
  }

  for (let i = 0; i < pairCount; i += 1) {
    const connector = connectors[i];
    if (!connector) continue;
    addEdge(connector.edge);

    const targetIndex = (i + 1) % nodes.length;
    const targetPseudo = nodes[targetIndex];
    const hasOutgoing = closed || targetIndex < nodes.length - 1;
    if (!hasOutgoing || !projection.passIds.has(targetPseudo)) continue;

    const nextConnector = connectors[(i + 1) % connectors.length];
    if (!nextConnector) continue;
    for (const passEdge of passTraversalEdges(graph, targetPseudo, connectorStopFor(connector.edge, targetPseudo, projection), connectorStopFor(nextConnector.edge, targetPseudo, projection))) {
      addEdge(passEdge);
    }
  }

  return { edges: edgeIds, totalLeisureCost, totalDistanceM };

  function addEdge(edge) {
    if (!edge) return;
    edgeIds.push(edge.id);
    totalLeisureCost += Number(edge.leisureCost) || 0;
    totalDistanceM += Number(edge.distanceM) || 0;
  }
}

function passTraversalEdges(graph, passId, fromStop, toStop) {
  if (!fromStop || !toStop || fromStop === toStop) return [];
  if (passIdFromSyntheticId(fromStop) !== passId || passIdFromSyntheticId(toStop) !== passId) return [];

  const summit = `${passId}:S`;
  const edges = [];
  if (fromStop !== summit) edges.push(graph.edgeBetween(fromStop, summit));
  if (toStop !== summit) edges.push(graph.edgeBetween(summit, toStop));
  return edges.filter((edge) => edge?.kind === "pass-climb");
}

function connectorStopFor(edge, passId, projection) {
  if (projection.pseudoOf(edge.from) === passId) return edge.from;
  if (projection.pseudoOf(edge.to) === passId) return edge.to;
  return null;
}

function attachmentNodes(kind, nodes, graph, articulation) {
  const attachments = [];
  if (kind === "loop") {
    for (const node of nodes) {
      if (articulation.has(node) || graph.nodeKindOf(node) === "junction") attachments.push(node);
    }
    if (attachments.length === 0 && nodes.length) attachments.push(nodes[0]);
  } else {
    attachments.push(nodes[0]);
    attachments.push(nodes[nodes.length - 1]);
    for (const node of nodes.slice(1, -1)) {
      if (articulation.has(node) || graph.nodeKindOf(node) === "junction") attachments.push(node);
    }
  }
  return orderedUnique(attachments);
}

function indexEars(ears, valuesForEar) {
  const index = new Map();
  for (const ear of ears) {
    const values = valuesForEar(ear) ?? [];
    for (const value of values) {
      if (!index.has(value)) index.set(value, []);
      index.get(value).push(ear);
    }
  }
  return index;
}

function bestConnector(topology, from, to) {
  return topology.directedBest.get(`${from}->${to}`)
    ?? topology.directedBest.get(`${to}->${from}`)
    ?? topology.undirectedBest.get(undirectedKey(from, to))
    ?? null;
}

function pseudoWalkCost(nodes, closed, graph, topology, projection) {
  let cost = 0;
  const pairCount = closed ? nodes.length : nodes.length - 1;
  const connectors = [];
  for (let i = 0; i < pairCount; i += 1) {
    connectors.push(bestConnector(topology, nodes[i], nodes[(i + 1) % nodes.length]));
  }

  for (let i = 0; i < pairCount; i += 1) {
    const connector = connectors[i];
    cost += Number(connector?.edge?.leisureCost) || 0;

    const targetIndex = (i + 1) % nodes.length;
    const targetPseudo = nodes[targetIndex];
    const hasOutgoing = closed || targetIndex < nodes.length - 1;
    if (!connector || !hasOutgoing || !projection.passIds.has(targetPseudo)) continue;

    const nextConnector = connectors[(i + 1) % connectors.length];
    if (!nextConnector) continue;
    // FIX: Rank cycles by the same pass-traversal cost that expanded ears emit.
    for (const passEdge of passTraversalEdges(graph, targetPseudo, connectorStopFor(connector.edge, targetPseudo, projection), connectorStopFor(nextConnector.edge, targetPseudo, projection))) {
      cost += Number(passEdge.leisureCost) || 0;
    }
  }
  return cost;
}

function addAdjacency(adjacency, from, to) {
  if (!adjacency.has(from)) adjacency.set(from, new Set());
  if (!adjacency.has(to)) adjacency.set(to, new Set());
  adjacency.get(from).add(to);
  adjacency.get(to).add(from);
}

function replaceIfCheaper(map, key, value) {
  const existing = map.get(key);
  if (!existing || compareEdges(value.edge, existing.edge) < 0) map.set(key, value);
}

function compareEdges(a, b) {
  return (Number(a.leisureCost) || 0) - (Number(b.leisureCost) || 0)
    || (Number(a.distanceM) || 0) - (Number(b.distanceM) || 0)
    || String(a.id).localeCompare(String(b.id));
}

function canonicalCycleKey(nodes) {
  const forward = rotations(nodes);
  const reverse = rotations(nodes.slice().reverse());
  return forward.concat(reverse).sort()[0];
}

function rotations(nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i += 1) {
    out.push(nodes.slice(i).concat(nodes.slice(0, i)).join("\0"));
  }
  return out;
}

function undirectedKey(a, b) {
  const [u, v] = sortedPair(a, b);
  return `${u}\0${v}`;
}

function splitUndirectedKey(key) {
  return key.split("\0");
}

function sortedPair(a, b) {
  return String(a) <= String(b) ? [a, b] : [b, a];
}

function orderedUnique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function passIdFromSyntheticId(nodeId) {
  const match = String(nodeId).match(/^(.+):[ABS]$/);
  return match ? match[1] : null;
}

function roundNumber(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}
