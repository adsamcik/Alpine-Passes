const EARTH_RADIUS_M = 6_371_000;

/**
 * Loads the static leisure graph in browsers via fetch and in Node via fs.
 *
 * @param {string|URL} url
 * @returns {Promise<LeisureGraph>}
 */
export async function loadLeisureGraph(url = "assets/data/leisure-graph.v1.json") {
  if (typeof globalThis.window !== "undefined" && typeof globalThis.fetch === "function") {
    const response = await globalThis.fetch(url);
    if (!response.ok) throw new Error(`Failed to load leisure graph: ${response.status} ${response.statusText}`);
    return new LeisureGraph(await response.json());
  }

  if (isHttpUrl(url) && typeof globalThis.fetch === "function") {
    const response = await globalThis.fetch(url);
    if (!response.ok) throw new Error(`Failed to load leisure graph: ${response.status} ${response.statusText}`);
    return new LeisureGraph(await response.json());
  }

  const source = await readGraphFile(url);
  return new LeisureGraph(JSON.parse(source));
}

export class LeisureGraph {
  constructor(data) {
    this.data = data ?? {};
    this.version = this.data.version;
    this.generatedAt = this.data.generatedAt;
    this.stats = this.data.stats ?? {};
    this.rawNodes = Array.isArray(this.data.nodes) ? this.data.nodes : [];
    this.rawEdges = Array.isArray(this.data.edges) ? this.data.edges : [];

    this.nodes = new Map();
    this.nodeById = this.nodes;
    this.nodesByKind = new Map();
    this.nodeList = [];
    this.nodeIds = [];
    this.nodeIndex = new Map();
    this.indexByNodeId = this.nodeIndex;
    this._nodeKindById = new Map();

    for (const node of this.rawNodes) {
      if (!node || typeof node.id !== "string") continue;
      const index = this.nodeList.length;
      this.nodes.set(node.id, node);
      this.nodeList.push(node);
      this.nodeIds.push(node.id);
      this.nodeIndex.set(node.id, index);
      this._nodeKindById.set(node.id, node.kind);
      appendToMapArray(this.nodesByKind, node.kind, node);
    }

    this.outEdges = new Map();
    this.inEdges = new Map();
    for (const id of this.nodeIds) {
      this.outEdges.set(id, []);
      this.inEdges.set(id, []);
    }

    this.edges = [];
    this.edgeList = this.edges;
    this.edgeByKey = new Map();
    this.edgeById = new Map();

    for (const rawEdge of this.rawEdges) {
      if (!rawEdge || typeof rawEdge.from !== "string" || typeof rawEdge.to !== "string") continue;
      const key = edgeKey(rawEdge.from, rawEdge.to);
      const id = edgeIdOf(rawEdge);
      const edge = { ...rawEdge, id, key, index: this.edges.length };
      this.edges.push(edge);
      this.edgeByKey.set(key, edge);
      this.edgeById.set(id, edge);
      if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, []);
      if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, []);
      this.outEdges.get(edge.from).push(edge);
      this.inEdges.get(edge.to).push(edge);
    }

    this.passTriplets = new Map();
    this.passIdByNodeId = new Map();
    this.syntheticKindByNodeId = new Map();
    this._buildPassIndexes();

    this._spatialIndexes = buildSpatialIndexes(this.nodeList, this.nodesByKind);
    this._edgeStats = null;
    this.ensureEdgeStats();
  }

  edgeBetween(fromId, toId) {
    return this.edgeByKey.get(edgeKey(fromId, toId)) ?? null;
  }

  passSidesFor(passId) {
    const resolvedPassId = this.passIdByNodeId.get(passId) ?? passIdFromSyntheticId(passId) ?? passId;
    const triplet = this.passTriplets.get(resolvedPassId);
    if (!triplet) return null;
    return {
      pass: triplet.pass ?? null,
      A: triplet.A ?? null,
      S: triplet.S ?? null,
      B: triplet.B ?? null,
      baseA: triplet.A ?? null,
      summit: triplet.S ?? null,
      baseB: triplet.B ?? null,
    };
  }

  nodeKindOf(nodeId) {
    return this._nodeKindById.get(nodeId);
  }

  /**
   * Exact k-nearest node lookup using per-kind KD-tree indexes.
   * Returns sorted objects shaped as `{ node, distanceM }`.
   *
   * @param {number} lat
   * @param {number} lon
   * @param {string[]|string|number|null} kindsArray
   * @param {number} k
   * @returns {{ node: object, distanceM: number }[]}
   */
  nearestNodes(lat, lon, kindsArray = null, k = 8) {
    if (typeof kindsArray === "number") {
      k = kindsArray;
      kindsArray = null;
    }

    const target = { lat: Number(lat), lon: Number(lon) };
    const limit = Math.max(0, Math.trunc(Number(k) || 0));
    if (!isValidCoord(target) || limit === 0) return [];

    const kinds = normalizeKinds(kindsArray);
    const candidates = [];
    const seen = new Set();

    for (const kind of kinds) {
      const index = this._spatialIndexes.get(kind);
      if (!index) continue;
      for (const item of nearestInKdTree(index, target, limit)) {
        if (seen.has(item.node.id)) continue;
        seen.add(item.node.id);
        candidates.push(item);
      }
    }

    return candidates
      .sort(compareNearest)
      .slice(0, limit);
  }

  validate() {
    const errors = [];
    validateTopLevel(this.data, errors);
    validateNodes(this.rawNodes, errors);
    validateEdges(this.rawEdges, errors);
    validateEdgeEndpoints(this.rawEdges, new Set(this.rawNodes.map((node) => node?.id).filter(Boolean)), errors);
    validatePassTriplets(this, errors);
    validatePassEdges(this, errors);
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }

  ensureEdgeStats() {
    if (this._edgeStats) return this._edgeStats;

    let minDurationPerM = Infinity;
    let minLeisurePerM = Infinity;
    let minDistanceRatio = Infinity;

    for (const edge of this.edges) {
      const distanceM = Number(edge.distanceM);
      if (!Number.isFinite(distanceM) || distanceM <= 0) continue;

      const durationS = Number(edge.durationS);
      const leisureCost = Number(edge.leisureCost);
      if (Number.isFinite(durationS) && durationS > 0) {
        minDurationPerM = Math.min(minDurationPerM, durationS / distanceM);
      }
      if (Number.isFinite(leisureCost) && leisureCost > 0) {
        minLeisurePerM = Math.min(minLeisurePerM, leisureCost / distanceM);
      }

      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      if (from && to && edge.from !== edge.to) {
        const directM = haversineM(from, to);
        if (directM > 0) minDistanceRatio = Math.min(minDistanceRatio, distanceM / directM);
      }
    }

    this._edgeStats = {
      minDurationPerM: finiteOrZero(minDurationPerM),
      minLeisurePerM: finiteOrZero(minLeisurePerM),
      minDistanceRatio: finiteOrZero(minDistanceRatio),
    };
    return this._edgeStats;
  }

  _buildPassIndexes() {
    for (const pass of this.nodesByKind.get("pass") ?? []) {
      this.passTriplets.set(pass.id, { pass, A: null, S: null, B: null });
      this.passIdByNodeId.set(pass.id, pass.id);
    }

    for (const node of this.nodeList) {
      if (node.kind !== "pass-base" && node.kind !== "pass-summit") continue;
      const passId = node.passId ?? passIdFromSyntheticId(node.id);
      if (!passId) continue;
      if (!this.passTriplets.has(passId)) this.passTriplets.set(passId, { pass: this.nodes.get(passId) ?? null, A: null, S: null, B: null });
      const triplet = this.passTriplets.get(passId);
      if (node.kind === "pass-base" && node.side === "A") triplet.A = node;
      if (node.kind === "pass-base" && node.side === "B") triplet.B = node;
      if (node.kind === "pass-summit") triplet.S = node;
      this.passIdByNodeId.set(node.id, passId);
      this.syntheticKindByNodeId.set(node.id, node.kind);
    }
  }
}

export function edgeIdOf(edge) {
  return edge?.id ?? edgeKey(edge?.from, edge?.to);
}

export function edgeKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

export function haversineM(a, b) {
  if (!isValidCoord(a) || !isValidCoord(b)) return Infinity;
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function readGraphFile(url) {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  if (url instanceof URL && url.protocol === "file:") {
    return readFile(fileURLToPath(url), "utf8");
  }

  const value = String(url);
  if (value.startsWith("file:")) return readFile(fileURLToPath(value), "utf8");
  const filePath = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
  return readFile(filePath, "utf8");
}

function isHttpUrl(value) {
  const source = value instanceof URL ? value.href : String(value);
  return /^https?:\/\//i.test(source);
}

function buildSpatialIndexes(nodeList, nodesByKind) {
  const indexes = new Map();
  indexes.set("*", buildKdTree(nodeList.filter(isValidCoord)));
  for (const [kind, nodes] of nodesByKind) {
    indexes.set(kind, buildKdTree(nodes.filter(isValidCoord)));
  }
  return indexes;
}

function buildKdTree(nodes, depth = 0) {
  if (nodes.length === 0) return null;
  const axis = depth % 2 === 0 ? "lat" : "lon";
  const sorted = nodes
    .slice()
    .sort((a, b) => Number(a[axis]) - Number(b[axis]) || String(a.id).localeCompare(String(b.id)));
  const mid = Math.floor(sorted.length / 2);
  const left = buildKdTree(sorted.slice(0, mid), depth + 1);
  const right = buildKdTree(sorted.slice(mid + 1), depth + 1);
  return withBounds({ node: sorted[mid], axis, left, right });
}

function withBounds(tree) {
  let minLat = Number(tree.node.lat);
  let maxLat = minLat;
  let minLon = Number(tree.node.lon);
  let maxLon = minLon;

  for (const child of [tree.left, tree.right]) {
    if (!child) continue;
    minLat = Math.min(minLat, child.minLat);
    maxLat = Math.max(maxLat, child.maxLat);
    minLon = Math.min(minLon, child.minLon);
    maxLon = Math.max(maxLon, child.maxLon);
  }

  return { ...tree, minLat, maxLat, minLon, maxLon };
}

function nearestInKdTree(tree, target, k) {
  if (!tree) return [];
  const best = [];

  function visit(node) {
    if (!node) return;
    if (best.length >= k && boundsDistanceM(target, node) > best[best.length - 1].distanceM) return;

    addNearest(best, { node: node.node, distanceM: haversineM(target, node.node) }, k);

    const axis = node.axis;
    const near = Number(target[axis]) <= Number(node.node[axis]) ? node.left : node.right;
    const far = near === node.left ? node.right : node.left;
    visit(near);
    visit(far);
  }

  visit(tree);
  return best;
}

function addNearest(best, item, k) {
  best.push(item);
  best.sort(compareNearest);
  if (best.length > k) best.pop();
}

function compareNearest(a, b) {
  return a.distanceM - b.distanceM || String(a.node.id).localeCompare(String(b.node.id));
}

function boundsDistanceM(target, bounds) {
  // Approximate lower-bound pruning for compact Alpine lat/lon boxes; exact
  // haversine distances are still used when ranking returned candidates.
  const clamped = {
    lat: clamp(Number(target.lat), bounds.minLat, bounds.maxLat),
    lon: clamp(Number(target.lon), bounds.minLon, bounds.maxLon),
  };
  return haversineM(target, clamped) * 0.999999;
}

function normalizeKinds(kindsArray) {
  if (!kindsArray) return ["*"];
  const kinds = Array.isArray(kindsArray) ? kindsArray : [kindsArray];
  const clean = [...new Set(kinds.map((kind) => String(kind)).filter(Boolean))];
  return clean.length ? clean : ["*"];
}

function validateTopLevel(data, errors) {
  if (!data || typeof data !== "object") {
    errors.push("graph data must be an object");
    return;
  }
  for (const key of ["version", "generatedAt", "stats", "nodes", "edges"]) {
    if (!Object.hasOwn(data, key)) errors.push(`missing top-level ${key}`);
  }
  if (!Array.isArray(data.nodes)) errors.push("nodes must be an array");
  if (!Array.isArray(data.edges)) errors.push("edges must be an array");
}

function validateNodes(nodes, errors) {
  const seen = new Set();
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== "object") {
      errors.push(`node ${index} must be an object`);
      continue;
    }
    if (typeof node.id !== "string" || node.id.length === 0) errors.push(`node ${index} missing string id`);
    if (typeof node.kind !== "string" || node.kind.length === 0) errors.push(`node ${node.id ?? index} missing kind`);
    if (!isValidCoord(node)) errors.push(`node ${node.id ?? index} has invalid coordinates`);
    if (seen.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    seen.add(node.id);
  }
}

function validateEdges(edges, errors) {
  const seenKeys = new Set();
  const seenIds = new Set();
  for (const [index, edge] of edges.entries()) {
    if (!edge || typeof edge !== "object") {
      errors.push(`edge ${index} must be an object`);
      continue;
    }
    if (typeof edge.from !== "string" || typeof edge.to !== "string") errors.push(`edge ${index} missing endpoints`);
    if (typeof edge.kind !== "string" || edge.kind.length === 0) errors.push(`edge ${index} missing kind`);
    if (!isPositiveFinite(edge.distanceM)) errors.push(`edge ${index} ${edgeKey(edge.from, edge.to)} invalid distanceM`);
    if (!isPositiveFinite(edge.durationS)) errors.push(`edge ${index} ${edgeKey(edge.from, edge.to)} invalid durationS`);
    if (!isNonNegativeFinite(edge.leisureCost)) errors.push(`edge ${index} ${edgeKey(edge.from, edge.to)} invalid leisureCost`);

    const key = edgeKey(edge.from, edge.to);
    if (seenKeys.has(key)) errors.push(`duplicate edge key ${key}`);
    seenKeys.add(key);
    if (Object.hasOwn(edge, "id")) {
      const id = edgeIdOf(edge);
      if (seenIds.has(id)) errors.push(`duplicate edge id ${id}`);
      seenIds.add(id);
    }
  }
}

function validateEdgeEndpoints(edges, nodeIds, errors) {
  for (const edge of edges) {
    if (!edge) continue;
    if (!nodeIds.has(edge.from)) errors.push(`edge ${edgeKey(edge.from, edge.to)} references unknown from ${edge.from}`);
    if (!nodeIds.has(edge.to)) errors.push(`edge ${edgeKey(edge.from, edge.to)} references unknown to ${edge.to}`);
  }
}

function validatePassTriplets(graph, errors) {
  for (const pass of graph.nodesByKind.get("pass") ?? []) {
    const triplet = graph.passTriplets.get(pass.id);
    if (!triplet?.A) errors.push(`pass ${pass.id} missing base A node`);
    if (!triplet?.S) errors.push(`pass ${pass.id} missing summit node`);
    if (!triplet?.B) errors.push(`pass ${pass.id} missing base B node`);
  }
}

function validatePassEdges(graph, errors) {
  for (const pass of graph.nodesByKind.get("pass") ?? []) {
    const a = `${pass.id}:A`;
    const s = `${pass.id}:S`;
    const b = `${pass.id}:B`;
    for (const [from, to] of [[a, s], [s, a], [s, b], [b, s]]) {
      const edge = graph.edgeBetween(from, to);
      if (!edge || edge.kind !== "pass-climb" || edge.passId !== pass.id) {
        errors.push(`pass ${pass.id} missing pass-climb ${edgeKey(from, to)}`);
      }
    }

    const aOut = graph.edgeBetween(a, a);
    const bOut = graph.edgeBetween(b, b);
    if (!aOut || aOut.kind !== "pass-out-and-back") errors.push(`pass ${pass.id} missing out-and-back ${edgeKey(a, a)}`);
    if (!bOut || bOut.kind !== "pass-out-and-back") errors.push(`pass ${pass.id} missing out-and-back ${edgeKey(b, b)}`);

    const aTraverse = (graph.edgeBetween(a, s)?.leisureCost ?? NaN) + (graph.edgeBetween(s, b)?.leisureCost ?? NaN);
    const bTraverse = (graph.edgeBetween(b, s)?.leisureCost ?? NaN) + (graph.edgeBetween(s, a)?.leisureCost ?? NaN);
    if (aOut && Number.isFinite(aTraverse) && !(aOut.leisureCost > aTraverse)) {
      errors.push(`pass ${pass.id} A out-and-back is not costlier than traverse`);
    }
    if (bOut && Number.isFinite(bTraverse) && !(bOut.leisureCost > bTraverse)) {
      errors.push(`pass ${pass.id} B out-and-back is not costlier than traverse`);
    }
  }
}

function appendToMapArray(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function passIdFromSyntheticId(nodeId) {
  const match = String(nodeId).match(/^(.+):[ABS]$/);
  return match ? match[1] : null;
}

function isValidCoord(point) {
  return point
    && Number.isFinite(Number(point.lat))
    && Number.isFinite(Number(point.lon))
    && Math.abs(Number(point.lat)) <= 90
    && Math.abs(Number(point.lon)) <= 180;
}

function isPositiveFinite(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function isNonNegativeFinite(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toRad(value) {
  return value * Math.PI / 180;
}
