import { haversineM } from "../graph.js";
import { asArray, clamp01, compareTours, normalizeTokens, nowMs, passIdFromSyntheticId, round } from "./optimizer-utils.js";

const EPS = 1e-9;

export function buildCandidates(graph, earInfo, forbiddenPassIds, themeProfile) {
  const candidates = [];
  for (const pass of graph.nodesByKind.get("pass") ?? []) {
    if (forbiddenPassIds.has(pass.id)) continue;
    const triplet = graph.passSidesFor(pass.id);
    const nodeId = triplet?.S?.id ?? (graph.nodes.has(`${pass.id}:S`) ? `${pass.id}:S` : pass.id);
    if (!graph.nodes.has(nodeId)) continue;
    candidates.push(makeCandidate(pass, "pass", nodeId, pass.id, earInfo, themeProfile));
  }
  for (const poi of graph.nodesByKind.get("poi") ?? []) {
    candidates.push(makeCandidate(poi, "poi", poi.id, null, earInfo, themeProfile));
  }
  return candidates.sort((a, b) => b.baseReward - a.baseReward || a.id.localeCompare(b.id));
}

export function rankCandidates(candidates, startNode, budget, rng) {
  return candidates
    .map((candidate) => {
      const directM = haversineM(startNode, candidate);
      const rough = budget.mode === "distance" ? (2 * directM) / 1000 : (2 * directM) / 22;
      const affordability = Number.isFinite(rough) && budget.value > 0 ? Math.max(0.1, 1 - rough / (budget.value * 1.25)) : 0.1;
      return { candidate, rank: candidate.baseReward * affordability + rng() * 1e-6 };
    })
    .sort((a, b) => b.rank - a.rank || a.candidate.id.localeCompare(b.candidate.id))
    .map((item) => item.candidate);
}

export function indexCandidates(candidates) {
  const index = new Map();
  for (const candidate of candidates) {
    index.set(candidate.id, candidate);
    index.set(candidate.nodeId, candidate);
    if (candidate.passId) {
      index.set(`${candidate.passId}:A`, candidate);
      index.set(`${candidate.passId}:S`, candidate);
      index.set(`${candidate.passId}:B`, candidate);
    }
  }
  return index;
}

export function parseBudget(options) {
  const hasSeconds = Number.isFinite(Number(options.budgetSeconds));
  const hasKm = Number.isFinite(Number(options.budgetKm));
  if (hasSeconds === hasKm) return { ok: false, reason: "provide-exactly-one-of-budgetSeconds-or-budgetKm" };
  if (hasSeconds && Number(options.budgetSeconds) <= 0) return { ok: false, reason: "budgetSeconds-must-be-positive" };
  if (hasKm && Number(options.budgetKm) <= 0) return { ok: false, reason: "budgetKm-must-be-positive" };
  return hasSeconds
    ? { ok: true, mode: "duration", value: Number(options.budgetSeconds) }
    : { ok: true, mode: "distance", value: Number(options.budgetKm) };
}

export function parseIterationCap(options, defaultSeededIterationCap) {
  if (Number.isFinite(Number(options.iterationCap))) return Math.max(0, Math.trunc(Number(options.iterationCap)));
  return options.seed === undefined ? Infinity : defaultSeededIterationCap;
}

export function resolveStart(graph, startOption, forbiddenNodes) {
  if (typeof startOption === "string") {
    const node = graph.nodes.get(startOption);
    if (!node) return { ok: false, reason: "missing-start" };
    if (forbiddenNodes.has(node.id)) return { ok: false, reason: "forbidden-start" };
    return { ok: true, node, name: node.name ?? node.id, snapped: false, snapDistanceM: 0 };
  }
  if (startOption && Number.isFinite(Number(startOption.lat)) && Number.isFinite(Number(startOption.lon))) {
    const nearest = graph.nearestNodes(Number(startOption.lat), Number(startOption.lon), ["junction"], 1)[0];
    if (!nearest?.node || forbiddenNodes.has(nearest.node.id)) return { ok: false, reason: "missing-start" };
    return { ok: true, node: nearest.node, name: startOption.name ?? nearest.node.name ?? nearest.node.id, snapped: true, snapDistanceM: nearest.distanceM };
  }
  return { ok: false, reason: "missing-start" };
}

export function normalizeEars(input) {
  const ears = Array.isArray(input) ? input : (input?.ears ?? []);
  const earById = new Map();
  const passToEarIds = new Map();
  for (const ear of ears) {
    if (!ear?.id) continue;
    earById.set(ear.id, ear);
    for (const passId of ear.passes ?? []) {
      if (!passToEarIds.has(passId)) passToEarIds.set(passId, []);
      passToEarIds.get(passId).push(ear.id);
    }
  }
  if (input?.passToEars instanceof Map) {
    for (const [passId, passEars] of input.passToEars) {
      if (!passToEarIds.has(passId)) passToEarIds.set(passId, []);
      for (const ear of passEars ?? []) if (ear?.id && !passToEarIds.get(passId).includes(ear.id)) passToEarIds.get(passId).push(ear.id);
    }
  }
  return { ears, earById, passToEarIds };
}

export function normalizeThemeProfile(options, personaThemes) {
  const requested = new Set(normalizeTokens(options.themes));
  const personas = normalizeTokens(options.personas);
  for (const persona of personas) {
    for (const theme of personaThemes[persona] ?? []) requested.add(theme);
  }
  return { requested: [...requested].sort(), personas };
}

export function seasonalForbiddenEdges(graph, cutoff) {
  if (!cutoff) return { edges: [], diagnostics: { active: false, forbiddenSummerEdges: 0 } };
  const date = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (Number.isNaN(date.getTime())) return { edges: [], diagnostics: { active: false, invalidCutoff: String(cutoff), forbiddenSummerEdges: 0 } };
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const mmdd = month * 100 + day;
  const inSummer = mmdd >= 515 && mmdd <= 1031;
  const edges = inSummer ? [] : graph.edgeList.filter((edge) => edge.season === "summer").map((edge) => edge.id);
  return { edges, diagnostics: { active: true, cutoff: date.toISOString(), summerWindow: "05-15..10-31", inSummer, forbiddenSummerEdges: edges.length } };
}

export function resolvePassIdSet(graph, ids) {
  const out = new Set();
  for (const id of asArray(ids)) {
    const passId = resolvePassId(graph, id);
    if (passId) out.add(passId);
  }
  return out;
}

export function blockedNodesForPasses(graph, passIds) {
  const out = new Set();
  for (const passId of passIds) {
    out.add(passId);
    out.add(`${passId}:A`);
    out.add(`${passId}:S`);
    out.add(`${passId}:B`);
    const sides = graph.passSidesFor?.(passId);
    for (const node of [sides?.pass, sides?.A, sides?.S, sides?.B]) if (node?.id) out.add(node.id);
  }
  return out;
}

export function budgetFitObject(budget, used) {
  const remaining = budget.value - used;
  return {
    mode: budget.mode === "duration" ? "seconds" : "km",
    budget: round(budget.value, 3),
    used: round(used, 3),
    remaining: round(remaining, 3),
    ratio: round(budget.value > 0 ? used / budget.value : 0, 4),
    within: used <= budget.value + EPS,
  };
}

export function recordTour(archive, tour) {
  if (!tour?.feasible) return;
  const existing = archive.get(tour.signature);
  if (!existing || compareTours(tour, existing) < 0) archive.set(tour.signature, tour);
}

export function finalize(status, primary, alternatives, iterations, started, diagnostics, extraDiagnostics = {}) {
  Object.assign(diagnostics, extraDiagnostics);
  return {
    status,
    primary,
    alternatives,
    iterations,
    elapsedMs: round(nowMs() - started, 3),
    diagnostics,
  };
}

function makeCandidate(node, kind, nodeId, passId, earInfo, themeProfile) {
  const themes = normalizeTokens(node.themes);
  const scenicScore = clamp01(Number(node.scenicScore ?? node.score ?? 0.5));
  const themeHits = themes.filter((theme) => themeProfile.requested.includes(theme)).length;
  return {
    id: passId ?? node.id,
    nodeId,
    passId,
    kind,
    name: node.name ?? node.id,
    lat: node.lat,
    lon: node.lon,
    scenicScore,
    themes,
    earIds: passId ? [...(earInfo.passToEarIds.get(passId) ?? [])] : [],
    baseReward: scenicScore * 100 + themeHits * 15 + themes.length,
  };
}

export function resolvePassId(graph, id) {
  if (!id) return null;
  const value = String(id);
  for (const form of passIdForms(value)) {
    const mapped = graph.passIdByNodeId?.get(form);
    if (mapped) return mapped;
    if (graph.passTriplets?.has(form) || graph.nodes.get(form)?.kind === "pass") return form;
  }
  return null;
}

function passIdForms(value) {
  const forms = [];
  add(value);
  add(passIdFromSyntheticId(value));
  for (const form of forms.slice()) {
    if (form.startsWith("p-")) add(form.slice(2));
    else add(`p-${form}`);
  }
  return forms;

  function add(form) {
    if (form && !forms.includes(form)) forms.push(form);
  }
}
