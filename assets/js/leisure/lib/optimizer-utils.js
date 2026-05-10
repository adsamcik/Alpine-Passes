export function insertAt(route, pos, candidate) {
  return route.slice(0, pos).concat([candidate], route.slice(pos));
}

export function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function makeRng(seed) {
  let state = seed === undefined ? (Date.now() >>> 0) : hashSeed(seed);
  return function rng() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canonicalPair(a, b) {
  return String(a) <= String(b) ? `${a}\0${b}` : `${b}\0${a}`;
}

export function passIdFromSyntheticId(nodeId) {
  const match = String(nodeId).match(/^(.+):[ABS]$/);
  return match ? match[1] : null;
}

export function normalizeTokens(value) {
  return asArray(value).flatMap((item) => String(item).split(",")).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) || value instanceof Set ? [...value] : [value];
}

export function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function round(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round((Number(value) || 0) * scale) / scale;
}

export function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function stableSetKey(set) {
  return set?.size ? [...set].sort().join("|") : "";
}

export function rememberBounded(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= maxEntries) map.delete(map.keys().next().value);
  map.set(key, value);
}

export function recallBounded(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

export function routeSignature(route) {
  return route.map((item) => item.id).join("\u001F");
}

export function sameRouteIds(a, b) {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item.id === b[index]?.id);
}

export function publicStops(start, route, end = null) {
  const startStop = { id: start.node.id, nodeId: start.node.id, kind: "start", name: start.name, lat: start.node.lat, lon: start.node.lon, order: 0 };
  const stops = [startStop].concat(route.map((item, index) => ({
    id: item.id,
    nodeId: item.nodeId,
    passId: item.passId,
    kind: item.kind,
    name: item.name,
    lat: item.lat,
    lon: item.lon,
    themes: item.themes,
    scenicScore: item.scenicScore,
    order: index + 1,
  })));
  if (end?.node?.id && end.node.id !== start.node.id) {
    return stops.concat([{
      id: end.node.id,
      nodeId: end.node.id,
      kind: "end",
      name: end.name,
      lat: end.node.lat,
      lon: end.node.lon,
      order: route.length + 1,
    }]);
  }
  if (route.length === 0) return stops;
  // Closed tours repeat the start as a terminal marker for UI route rendering.
  return stops.concat([{ ...startStop, kind: "return", returnToStart: true, order: route.length + 1 }]);
}

export function publicTour(tour) {
  if (!tour) return null;
  const { feasible, route, signature, _durationS, ...rest } = tour;
  return rest;
}

export function compareTours(a, b) {
  return compareNumeric(numeric(b?.score, -Infinity), numeric(a?.score, -Infinity))
    || compareNumeric(numeric(b?.scenicSum), numeric(a?.scenicSum))
    || compareNumeric(numeric(a?.retracedConnectorCount, Infinity), numeric(b?.retracedConnectorCount, Infinity))
    || compareNumeric(numeric(a?._durationS, Infinity), numeric(b?._durationS, Infinity))
    || String(a?.signature ?? "").localeCompare(String(b?.signature ?? ""));
}

export function bestOf(a, b) {
  if (!a?.feasible) return b?.feasible ? b : a;
  if (!b?.feasible) return a;
  return compareTours(a, b) <= 0 ? a : b;
}

export function containsAll(routeOrTour, requiredSet) {
  const route = Array.isArray(routeOrTour) ? routeOrTour : routeOrTour?.route;
  if (!requiredSet.size) return true;
  const present = new Set((route ?? []).map((item) => item.id));
  for (const id of requiredSet) if (!present.has(id)) return false;
  return true;
}

function hashSeed(seed) {
  if (Number.isFinite(Number(seed))) return Number(seed) >>> 0;
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isNaN(number) ? fallback : number;
}

function compareNumeric(a, b) {
  if (a === b) return 0;
  if (a === Infinity || b === -Infinity) return 1;
  if (a === -Infinity || b === Infinity) return -1;
  return a - b;
}
