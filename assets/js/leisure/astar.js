import { edgeIdOf, edgeKey, haversineM } from "./graph.js";

const EPSILON = 1e-9;

/**
 * Leisure-aware shortest path over the static directed graph.
 *
 * @param {import("./graph.js").LeisureGraph} graph
 * @param {string} fromId
 * @param {string} toId
 * @param {object} opts
 * @returns {{ status: "ok"|"unreachable"|"budget-exhausted", path: string[], nodes: string[], edges: string[], totalLeisureCost: number, totalDistanceM: number, totalDistanceKm: number, totalDurationS: number, retracedEdgeCount: number }}
 */
export function leisureAStar(graph, fromId, toId, opts = {}) {
  const context = buildContext(graph, opts);
  const fromIndex = graph.nodeIndex.get(fromId);
  const toIndex = graph.nodeIndex.get(toId);

  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return emptyResult("unreachable");
  if (context.forbiddenNodes.has(fromId) || context.forbiddenNodes.has(toId)) return emptyResult("unreachable");
  if (fromId === toId) return okResult(graph, [fromId], [], context);

  if (opts.bidirectional === false) {
    return unidirectionalAStar(graph, fromIndex, toIndex, context);
  }
  // The default bidirectional search is classical Dijkstra (no heuristic), so
  // the top-forward + top-reverse >= best termination condition is admissible.
  return bidirectionalDijkstra(graph, fromIndex, toIndex, context);
}

function unidirectionalAStar(graph, fromIndex, toIndex, context) {
  const nodeCount = graph.nodeList.length;
  const dist = filledFloat64(nodeCount, Infinity);
  const spent = filledFloat64(nodeCount, Infinity);
  const prevNode = filledInt32(nodeCount, -1);
  const prevEdge = filledInt32(nodeCount, -1);
  const heap = new BinaryHeap(nodeCount * 2);
  let budgetPruned = false;

  dist[fromIndex] = 0;
  spent[fromIndex] = 0;
  heap.push(fromIndex, heuristic(graph, fromIndex, toIndex, context.mode));

  while (heap.length > 0) {
    const item = heap.pop();
    if (!item) break;
    const expectedPriority = dist[item.node] + heuristic(graph, item.node, toIndex, context.mode);
    if (item.priority > expectedPriority + EPSILON) continue;
    if (item.node === toIndex) {
      return okResult(graph, reconstructForward(graph, fromIndex, toIndex, prevNode, prevEdge), edgeObjectsForward(graph, fromIndex, toIndex, prevNode, prevEdge), context);
    }

    const fromNode = graph.nodeList[item.node];
    for (const edge of graph.outEdges.get(fromNode.id) ?? []) {
      const toNodeIndex = graph.nodeIndex.get(edge.to);
      if (!Number.isInteger(toNodeIndex) || isBlocked(edge, edge.to, context)) continue;

      const raw = rawCost(edge, context.mode);
      const nextSpent = spent[item.node] + raw;
      if (nextSpent > context.budget + EPSILON) {
        budgetPruned = true;
        continue;
      }

      const nextDist = dist[item.node] + searchCost(edge, context);
      if (nextDist + EPSILON < dist[toNodeIndex]) {
        dist[toNodeIndex] = nextDist;
        spent[toNodeIndex] = nextSpent;
        prevNode[toNodeIndex] = item.node;
        prevEdge[toNodeIndex] = edge.index;
        heap.push(toNodeIndex, nextDist + heuristic(graph, toNodeIndex, toIndex, context.mode));
      }
    }
  }

  return emptyResult(budgetPruned ? "budget-exhausted" : "unreachable");
}

function bidirectionalDijkstra(graph, fromIndex, toIndex, context) {
  const nodeCount = graph.nodeList.length;
  const distF = filledFloat64(nodeCount, Infinity);
  const distR = filledFloat64(nodeCount, Infinity);
  const spentF = filledFloat64(nodeCount, Infinity);
  const spentR = filledFloat64(nodeCount, Infinity);
  const prevNodeF = filledInt32(nodeCount, -1);
  const prevEdgeF = filledInt32(nodeCount, -1);
  const nextNodeR = filledInt32(nodeCount, -1);
  const nextEdgeR = filledInt32(nodeCount, -1);
  const heapF = new BinaryHeap(nodeCount * 2);
  const heapR = new BinaryHeap(nodeCount * 2);
  let best = Infinity;
  let meet = -1;
  let budgetPruned = false;

  distF[fromIndex] = 0;
  distR[toIndex] = 0;
  spentF[fromIndex] = 0;
  spentR[toIndex] = 0;
  heapF.push(fromIndex, 0);
  heapR.push(toIndex, 0);

  function consider(nodeIndex) {
    if (!Number.isFinite(distF[nodeIndex]) || !Number.isFinite(distR[nodeIndex])) return;
    const totalSpent = spentF[nodeIndex] + spentR[nodeIndex];
    if (totalSpent > context.budget + EPSILON) {
      budgetPruned = true;
      return;
    }
    const total = distF[nodeIndex] + distR[nodeIndex];
    if (total + EPSILON < best || (Math.abs(total - best) <= EPSILON && tieNode(graph, nodeIndex, meet) < 0)) {
      best = total;
      meet = nodeIndex;
    }
  }

  while (heapF.length > 0 || heapR.length > 0) {
    if (Number.isFinite(best) && heapF.peekPriority() + heapR.peekPriority() >= best - EPSILON) break;

    if (heapR.length === 0 || heapF.peekPriority() <= heapR.peekPriority()) {
      const item = heapF.pop();
      if (!item || item.priority > distF[item.node] + EPSILON) continue;
      const node = graph.nodeList[item.node];

      for (const edge of graph.outEdges.get(node.id) ?? []) {
        const nextIndex = graph.nodeIndex.get(edge.to);
        if (!Number.isInteger(nextIndex) || isBlocked(edge, edge.to, context)) continue;

        const raw = rawCost(edge, context.mode);
        const nextSpent = spentF[item.node] + raw;
        if (nextSpent > context.budget + EPSILON) {
          budgetPruned = true;
          continue;
        }

        const nextDist = distF[item.node] + searchCost(edge, context);
        if (nextDist + EPSILON < distF[nextIndex]) {
          distF[nextIndex] = nextDist;
          spentF[nextIndex] = nextSpent;
          prevNodeF[nextIndex] = item.node;
          prevEdgeF[nextIndex] = edge.index;
          heapF.push(nextIndex, nextDist);
          consider(nextIndex);
        }
      }
    } else {
      const item = heapR.pop();
      if (!item || item.priority > distR[item.node] + EPSILON) continue;
      const node = graph.nodeList[item.node];

      for (const edge of graph.inEdges.get(node.id) ?? []) {
        const nextIndex = graph.nodeIndex.get(edge.from);
        if (!Number.isInteger(nextIndex) || isBlocked(edge, edge.from, context)) continue;

        const raw = rawCost(edge, context.mode);
        const nextSpent = spentR[item.node] + raw;
        if (nextSpent > context.budget + EPSILON) {
          budgetPruned = true;
          continue;
        }

        const nextDist = distR[item.node] + searchCost(edge, context);
        if (nextDist + EPSILON < distR[nextIndex]) {
          distR[nextIndex] = nextDist;
          spentR[nextIndex] = nextSpent;
          nextNodeR[nextIndex] = item.node;
          nextEdgeR[nextIndex] = edge.index;
          heapR.push(nextIndex, nextDist);
          consider(nextIndex);
        }
      }
    }
  }

  if (meet === -1) return emptyResult(budgetPruned ? "budget-exhausted" : "unreachable");
  return okResult(graph, reconstructBidirectionalNodes(graph, fromIndex, toIndex, meet, prevNodeF, nextNodeR), reconstructBidirectionalEdges(graph, fromIndex, toIndex, meet, prevNodeF, prevEdgeF, nextNodeR, nextEdgeR), context);
}

function buildContext(graph, opts) {
  return {
    mode: normalizeMode(opts.costMode ?? opts.mode ?? "leisure"),
    budget: budgetForMode(opts.costMode ?? opts.mode ?? "leisure", opts),
    forbiddenNodes: normalizeStringSet(opts.forbiddenNodes),
    forbiddenEdges: normalizeEdgeSet(opts.forbiddenEdges),
    usedEdges: normalizeEdgeSet(opts.usedEdges),
    // usedEdgesPenalty is a multiplier; clamp documentation and behavior agree
    // that values below 1 must not reward retracing an already-used edge.
    usedEdgesPenalty: Math.max(1, Number(opts.usedEdgesPenalty ?? opts.usedEdgePenalty ?? 1) || 1),
    stats: graph.ensureEdgeStats(),
  };
}

function normalizeMode(mode) {
  if (mode === "distance" || mode === "duration") return mode;
  return "leisure";
}

function budgetForMode(modeInput, opts) {
  const mode = normalizeMode(modeInput);
  if (Number.isFinite(Number(opts.budget))) return Number(opts.budget);
  if (opts.budget && typeof opts.budget === "object") {
    if (mode === "distance" && Number.isFinite(Number(opts.budget.distanceM))) return Number(opts.budget.distanceM);
    if (mode === "distance" && Number.isFinite(Number(opts.budget.distanceKm))) return Number(opts.budget.distanceKm) * 1000;
    if (mode === "duration" && Number.isFinite(Number(opts.budget.durationS))) return Number(opts.budget.durationS);
    if (mode === "leisure" && Number.isFinite(Number(opts.budget.leisureCost))) return Number(opts.budget.leisureCost);
  }
  if (mode === "distance") {
    if (Number.isFinite(Number(opts.maxDistanceM))) return Number(opts.maxDistanceM);
    if (Number.isFinite(Number(opts.maxDistanceKm))) return Number(opts.maxDistanceKm) * 1000;
  }
  if (mode === "duration" && Number.isFinite(Number(opts.maxDurationS))) return Number(opts.maxDurationS);
  if (mode === "leisure" && Number.isFinite(Number(opts.maxLeisureCost))) return Number(opts.maxLeisureCost);
  return Infinity;
}

function rawCost(edge, mode) {
  if (mode === "distance") return Number(edge.distanceM) || 0;
  if (mode === "duration") return Number(edge.durationS) || 0;
  return Number(edge.leisureCost) || 0;
}

function searchCost(edge, context) {
  const cost = rawCost(edge, context.mode);
  if (context.mode !== "leisure" || context.usedEdgesPenalty <= 1 || !isUsedEdge(edge, context.usedEdges)) return cost;
  return cost * context.usedEdgesPenalty;
}

function heuristic(graph, fromIndex, toIndex, mode) {
  const from = graph.nodeList[fromIndex];
  const to = graph.nodeList[toIndex];
  const directM = haversineM(from, to);
  if (!Number.isFinite(directM)) return 0;
  if (mode === "distance") return directM;
  const stats = graph.ensureEdgeStats();
  if (mode === "duration") return directM * stats.minDurationPerM;
  return directM * stats.minLeisurePerM;
}

function isBlocked(edge, nodeId, context) {
  return context.forbiddenNodes.has(nodeId) || hasEdgeToken(edge, context.forbiddenEdges);
}

function isUsedEdge(edge, usedEdges) {
  return hasEdgeToken(edge, usedEdges);
}

function hasEdgeToken(edge, set) {
  if (!set || set.size === 0) return false;
  const key = edgeKey(edge.from, edge.to);
  return set.has(edgeIdOf(edge))
    || set.has(key)
    || (edge.roadClass ? set.has(`${edge.roadClass}:${key}`) : false);
}

function normalizeStringSet(value) {
  if (!value) return new Set();
  const iterable = value instanceof Set || Array.isArray(value) ? value : [value];
  return new Set([...iterable].map((item) => String(item)));
}

function normalizeEdgeSet(value) {
  if (!value) return new Set();
  const iterable = value instanceof Set || Array.isArray(value) ? value : [value];
  const out = new Set();
  for (const item of iterable) {
    if (!item) continue;
    if (typeof item === "string") {
      out.add(item);
    } else if (typeof item === "object") {
      const key = edgeKey(item.from, item.to);
      out.add(edgeIdOf(item));
      out.add(key);
      if (item.roadClass) out.add(`${item.roadClass}:${key}`);
    }
  }
  return out;
}

function reconstructForward(graph, fromIndex, toIndex, prevNode, prevEdge) {
  const ids = [];
  for (let node = toIndex; node !== -1; node = prevNode[node]) {
    ids.push(graph.nodeList[node].id);
    if (node === fromIndex) break;
    if (prevEdge[node] === -1) return [];
  }
  return ids.reverse();
}

function edgeObjectsForward(graph, fromIndex, toIndex, prevNode, prevEdge) {
  const edges = [];
  for (let node = toIndex; node !== fromIndex; node = prevNode[node]) {
    if (node === -1 || prevEdge[node] === -1) return [];
    edges.push(graph.edgeList[prevEdge[node]]);
  }
  return edges.reverse();
}

function reconstructBidirectionalNodes(graph, fromIndex, toIndex, meet, prevNodeF, nextNodeR) {
  const left = [];
  for (let node = meet; node !== -1; node = prevNodeF[node]) {
    left.push(graph.nodeList[node].id);
    if (node === fromIndex) break;
  }
  left.reverse();

  const right = [];
  for (let node = nextNodeR[meet]; node !== -1; node = nextNodeR[node]) {
    right.push(graph.nodeList[node].id);
    if (node === toIndex) break;
  }

  return left.concat(right);
}

function reconstructBidirectionalEdges(graph, fromIndex, toIndex, meet, prevNodeF, prevEdgeF, nextNodeR, nextEdgeR) {
  const left = [];
  for (let node = meet; node !== fromIndex; node = prevNodeF[node]) {
    if (node === -1 || prevEdgeF[node] === -1) return [];
    left.push(graph.edgeList[prevEdgeF[node]]);
  }
  left.reverse();

  const right = [];
  for (let node = meet; node !== toIndex; node = nextNodeR[node]) {
    if (node === -1 || nextEdgeR[node] === -1) return [];
    right.push(graph.edgeList[nextEdgeR[node]]);
  }

  return left.concat(right);
}

function okResult(graph, nodes, edgeObjects, context) {
  const totals = totalMetrics(edgeObjects, context);
  const path = [...nodes];
  return {
    status: "ok",
    path,
    nodes: path,
    edges: edgeObjects.map((edge) => edge.id),
    totalLeisureCost: roundNumber(totals.totalLeisureCost, 3),
    totalDistanceM: roundNumber(totals.totalDistanceM, 3),
    totalDistanceKm: roundNumber(totals.totalDistanceM / 1000, 3),
    totalDurationS: roundNumber(totals.totalDurationS, 3),
    retracedEdgeCount: totals.retracedEdgeCount,
  };
}

function emptyResult(status) {
  return {
    status,
    path: [],
    nodes: [],
    edges: [],
    totalLeisureCost: 0,
    totalDistanceM: 0,
    totalDistanceKm: 0,
    totalDurationS: 0,
    retracedEdgeCount: 0,
  };
}

function totalMetrics(edges, context) {
  let totalLeisureCost = 0;
  let totalDistanceM = 0;
  let totalDurationS = 0;
  let retracedEdgeCount = 0;
  for (const edge of edges) {
    totalLeisureCost += Number(edge.leisureCost) || 0;
    totalDistanceM += Number(edge.distanceM) || 0;
    totalDurationS += Number(edge.durationS) || 0;
    if (context.mode === "leisure" && context.usedEdgesPenalty > 1 && isUsedEdge(edge, context.usedEdges)) {
      retracedEdgeCount += 1;
    }
  }
  return { totalLeisureCost, totalDistanceM, totalDurationS, retracedEdgeCount };
}

function tieNode(graph, candidate, incumbent) {
  if (incumbent === -1) return -1;
  return graph.nodeList[candidate].id.localeCompare(graph.nodeList[incumbent].id);
}

function filledFloat64(length, value) {
  const array = new Float64Array(length);
  array.fill(value);
  return array;
}

function filledInt32(length, value) {
  const array = new Int32Array(length);
  array.fill(value);
  return array;
}

function roundNumber(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

class BinaryHeap {
  constructor(capacity = 64) {
    const initial = Math.max(4, capacity);
    this.nodes = new Int32Array(initial);
    this.priorities = new Float64Array(initial);
    this.length = 0;
  }

  push(node, priority) {
    if (this.length >= this.nodes.length) this.grow();
    let index = this.length;
    this.length += 1;

    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent] <= priority) break;
      this.nodes[index] = this.nodes[parent];
      this.priorities[index] = this.priorities[parent];
      index = parent;
    }

    this.nodes[index] = node;
    this.priorities[index] = priority;
  }

  pop() {
    if (this.length === 0) return null;
    const node = this.nodes[0];
    const priority = this.priorities[0];
    this.length -= 1;

    if (this.length > 0) {
      const lastNode = this.nodes[this.length];
      const lastPriority = this.priorities[this.length];
      let index = 0;

      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.length) break;
        const child = right < this.length && this.priorities[right] < this.priorities[left] ? right : left;
        if (this.priorities[child] >= lastPriority) break;
        this.nodes[index] = this.nodes[child];
        this.priorities[index] = this.priorities[child];
        index = child;
      }

      this.nodes[index] = lastNode;
      this.priorities[index] = lastPriority;
    }

    return { node, priority };
  }

  peekPriority() {
    return this.length > 0 ? this.priorities[0] : Infinity;
  }

  grow() {
    const nodes = new Int32Array(this.nodes.length * 2);
    const priorities = new Float64Array(this.priorities.length * 2);
    nodes.set(this.nodes);
    priorities.set(this.priorities);
    this.nodes = nodes;
    this.priorities = priorities;
  }
}
