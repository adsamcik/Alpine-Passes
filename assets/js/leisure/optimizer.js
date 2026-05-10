/**
 * Browser-first anytime orienteering optimizer for Alpine-Passes leisure tours.
 *
 * Stage timing contract:
 *   1. Greedy regret-2 construction is bounded to <= 50 ms and starts from a
 *      feasible start-only closed tour, so callers always have a valid answer.
 *      Advanced must-visit repair may use one capped <= 200 ms retry.
 *   2. Local search (2-opt, Or-opt 1/2/3, insert/remove) is bounded to <= 200 ms.
 *   3. Perturb/restart search (double-bridge, random restart, ear kick) uses the
 *      remaining `timeBudgetMs` (default 800 ms).
 *
 * Composite objective constants:
 *   scenicSum * 10000 + themeCoverage * 2000 + budgetFill * 350
 *   - leisureCost - retracedConnectorCount * 1000 - outAndBackCount * 500
 *   + loopEarCount * 150.
 *
 * Seasonal masking: the graph only marks edges as `all` or `summer`; when
 * `seasonalCutoff` falls outside a conservative 15 May..31 Oct summer window,
 * all summer edges are passed to A* as `forbiddenEdges`. Diagnostics note this
 * approximation because exact opening dates are not available in the graph.
 */
import { leisureAStar } from "./astar.js";
import { asArray, bestOf, canonicalPair, compareTours, containsAll, insertAt, makeRng, nowMs, passIdFromSyntheticId, publicStops, publicTour, recallBounded, rememberBounded, round, routeSignature, sameRouteIds, shuffle, stableSetKey } from "./lib/optimizer-utils.js";
import { blockedNodesForPasses, budgetFitObject, buildCandidates, finalize, indexCandidates, normalizeEars, normalizeThemeProfile, parseBudget, parseIterationCap, rankCandidates, recordTour, resolvePassId, resolvePassIdSet, resolveStart, seasonalForbiddenEdges } from "./lib/optimizer-planning.js";

const DEFAULT_K_ALTERNATIVES = 3;
const DEFAULT_TIME_BUDGET_MS = 800;
const DEFAULT_CACHE_ENTRIES = 5_000;
const DEFAULT_SEEDED_ITERATION_CAP = 250;
const STAGE1_MS = 50;
const STAGE1_ADVANCED_RETRY_MS = STAGE1_MS * 4;
const STAGE2_MS = 200;
const STAGE1_MOVES = 200;
const STAGE2_MOVES = 800;
const SEEDED_SAFETY_MIN_MS = 10_000;
const USED_EDGES_PENALTY = 4;
const MAX_AUTO_CANDIDATES = 110;
const MAX_INSERTION_SCAN = 70;
const END_SNAP_MAX_DISTANCE_M = 30_000;
const EPS = 1e-9;

const SCENIC_WEIGHT = 10_000;
const THEME_WEIGHT = 2_000;
const LEISURE_COST_WEIGHT = 1;
const RETRACED_CONNECTOR_PENALTY = 1_000;
const OUT_AND_BACK_PENALTY = 500;
const LOOP_EAR_BONUS = 150;
const BUDGET_FILL_WEIGHT = 350;

const OBJECTIVE_CONSTANTS = Object.freeze({
  SCENIC_WEIGHT,
  THEME_WEIGHT,
  LEISURE_COST_WEIGHT,
  RETRACED_CONNECTOR_PENALTY,
  OUT_AND_BACK_PENALTY,
  LOOP_EAR_BONUS,
  BUDGET_FILL_WEIGHT,
});

const PERSONA_THEMES = Object.freeze({
  scenic: ["panoramic-view", "viewpoints", "iconic", "high-alpine"],
  photographer: ["panoramic-view", "viewpoints", "iconic", "alpine-lake"],
  driver: ["drivers-road", "iconic", "high-alpine"],
  touring: ["drivers-road", "panoramic-view", "historic"],
  family: ["alpine-lake", "viewpoints", "cultural"],
  hiker: ["glacier", "alpine-lake", "panoramic-view", "high-alpine"],
});

/**
 * Plans a leisure tour from `options.start`, selecting pass stops opportunistically
 * under exactly one of `budgetSeconds` or `budgetKm`.
 *
 * By default, or when `options.endNode` is omitted/null or resolves to the
 * start node, the tour is a closed loop returning to the start. When
 * `options.endNode` is a different node id or `{lat, lon, name?}` point, the
 * tour is open A→B: the returned tour starts at `options.start`, visits the
 * returned `stops` in order, and ends at `tour.endNode` without an implicit
 * return leg.
 *
 * @param {import("./graph.js").LeisureGraph} graph
 * @param {object[]|{ears?: object[], passToEars?: Map<string, object[]>}} ears
 * @param {object} options Search options. `kAlternatives` is the total tour
 * count including the primary, so alternatives are capped at `kAlternatives - 1`.
 * `endNode` may be a graph node id or ad-hoc `{lat, lon, name?}` endpoint.
 * @returns {{status: "ok"|"degraded"|"infeasible", primary: object|null, alternatives: object[], iterations: number, elapsedMs: number, diagnostics: object}}
 */
export function planLeisureTour(graph, ears, options = {}) {
  return planInternal(graph, ears, [], options, false);
}

/**
 * Plans an advanced/selected tour that must include every requested pass/POI
 * id. By default, or when `options.endNode` is omitted/null or resolves to the
 * start node, the route is a closed loop; otherwise it is open A→B and ends at
 * `tour.endNode` without returning to the start. The returned primary is
 * infeasible only for invalid inputs, missing/unreachable starts, invalid
 * budgets, unreachable endpoints, or must-visits that cannot be materialized
 * within the requested budget in closed-loop mode.
 *
 * @param {import("./graph.js").LeisureGraph} graph
 * @param {object[]|{ears?: object[], passToEars?: Map<string, object[]>}} ears
 * @param {string[]} mustVisitIds
 * @param {object} options Search options. `kAlternatives` is the total tour
 * count including the primary, so alternatives are capped at `kAlternatives - 1`.
 * `endNode` may be a graph node id or ad-hoc `{lat, lon, name?}` endpoint.
 * @returns {{status: "ok"|"degraded"|"infeasible", primary: object|null, alternatives: object[], iterations: number, elapsedMs: number, diagnostics: object}}
 */
export function planLeisureTourAdvanced(graph, ears, mustVisitIds = [], options = {}) {
  return planInternal(graph, ears, mustVisitIds, options, true);
}

function planInternal(graph, earsInput, mustVisitIds, options, advanced) {
  const started = nowMs();
  const timeBudgetMs = Math.max(1, Number(options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS) || DEFAULT_TIME_BUDGET_MS);
  const endAt = started + timeBudgetMs;
  const seeded = options.seed !== undefined;
  const searchEndAt = seeded ? started + Math.max(timeBudgetMs, SEEDED_SAFETY_MIN_MS) : endAt;
  const iterationCap = parseIterationCap(options, DEFAULT_SEEDED_ITERATION_CAP);
  const cacheLimit = Math.max(100, Math.trunc(Number(options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES) || DEFAULT_CACHE_ENTRIES));
  const stageTimingsMs = { greedy: 0, localSearch: 0, perturbation: 0 };
  const diagnostics = {
    objectiveConstants: OBJECTIVE_CONSTANTS,
    stageTimingContractMs: { greedy: STAGE1_MS, advancedGreedyRetry: STAGE1_ADVANCED_RETRY_MS, localSearch: STAGE2_MS, total: timeBudgetMs },
    seasonalApproximation: "summer edges allowed only in conservative 15 May..31 Oct window when seasonalCutoff is provided",
    degradedReasons: [],
    advanced,
    searchBound: seeded
      ? {
        mode: "iterations",
        greedyCap: STAGE1_MOVES,
        lsCap: STAGE2_MOVES,
        perturbationCap: iterationCap,
      }
      : {
        mode: "wall-clock",
        wallClockBounded: true,
        iterationCap: Number.isFinite(iterationCap) ? iterationCap : null,
      },
  };

  const invalid = (reason, extra = {}) => finalize("infeasible", null, [], 0, started, diagnostics, { reason, ...extra });
  if (!graph?.nodes || !graph?.edgeList || !graph?.nodesByKind) return invalid("missing-graph");

  const budget = parseBudget(options);
  if (!budget.ok) return invalid("invalid-budget", { budgetError: budget.reason });
  const endSnapMaxDistanceM = parseEndSnapMaxDistanceM(options.endSnapMaxDistanceM);

  const earInfo = normalizeEars(earsInput);
  const themeProfile = normalizeThemeProfile(options, PERSONA_THEMES);
  const forbiddenPassIds = resolvePassIdSet(graph, options.forbiddenPassIds);
  const forbiddenNodes = blockedNodesForPasses(graph, forbiddenPassIds);
  const seasonal = seasonalForbiddenEdges(graph, options.seasonalCutoff);
  const forbiddenEdges = new Set(seasonal.edges);
  diagnostics.seasonalMask = seasonal.diagnostics;
  diagnostics.forbiddenPassIds = [...forbiddenPassIds].sort();
  diagnostics.forbiddenNodeCount = forbiddenNodes.size;
  diagnostics.forbiddenEdgeCount = forbiddenEdges.size;

  const start = resolveStart(graph, options.start, forbiddenNodes);
  if (!start.ok) return invalid(start.reason);
  diagnostics.start = { id: start.node.id, name: start.name, snapped: start.snapped, snapDistanceM: round(start.snapDistanceM ?? 0, 1) };
  const end = resolveEnd(graph, options.endNode, start, forbiddenNodes, {
    costMode: budget.mode,
    forbiddenEdges,
    endSnapMaxDistanceM,
  });
  if (!end.ok) return invalid(end.reason, end.extra);
  diagnostics.end = { id: end.node.id, name: end.name, open: end.open, requested: end.requested ?? null, snapped: end.snapped, snapDistanceM: round(end.snapDistanceM ?? 0, 1) };
  diagnostics.endNode = end.node.id;
  diagnostics.openTrip = end.open;
  diagnostics.budget = { mode: budget.mode, value: budget.value, units: budget.mode === "duration" ? "seconds" : "km" };
  diagnostics.themes = themeProfile;
  diagnostics.seed = options.seed ?? null;

  const rng = makeRng(options.seed);
  const excludeIds = new Set([start.node.id]);
  if (end.node?.id && end.node.id !== start.node.id) excludeIds.add(end.node.id);
  const expandedExclusions = expandPassSiblings(graph, excludeIds);
  const allCandidates = buildCandidates(graph, earInfo, forbiddenPassIds, themeProfile)
    .filter((candidate) => !expandedExclusions.has(candidate.nodeId) && !expandedExclusions.has(candidate.id));
  const candidateByAlias = indexCandidates(allCandidates);
  const must = [];
  const mustSeen = new Set();
  for (const id of asArray(mustVisitIds)) {
    const candidate = candidateByAlias.get(String(id)) ?? candidateByAlias.get(resolvePassId(graph, id));
    if (!candidate) return invalid("invalid-must-visit", { mustVisitId: id });
    if (!mustSeen.has(candidate.id)) {
      mustSeen.add(candidate.id);
      must.push(candidate);
    }
  }

  const env = {
    graph,
    budget,
    start,
    end,
    openEnd: end.open,
    advanced,
    earInfo,
    themeProfile,
    forbiddenNodes,
    forbiddenEdges,
    rng,
    endAt: searchEndAt,
    iterations: 0,
    legCache: new Map(),
    routeCache: new Map(),
    cacheLimit,
    materializationStats: { leisureRetries: 0, leisureAccepted: 0, degeneratePerturbations: 0 },
  };
  diagnostics.maxCacheEntries = cacheLimit;

  const endReachability = validateEndReachability(env, must);
  if (!endReachability.ok) return invalid("end-unreachable", { endNode: end.node.id, unreachableFrom: endReachability.fromId });

  let pool = advanced ? must.slice() : rankCandidates(allCandidates, start.node, budget, rng).slice(0, MAX_AUTO_CANDIDATES);
  diagnostics.candidateCount = allCandidates.length;
  diagnostics.searchCandidateCount = pool.length;
  diagnostics.searchBound.maxAutoCandidates = MAX_AUTO_CANDIDATES;
  diagnostics.searchBound.maxInsertionScan = MAX_INSERTION_SCAN;
  diagnostics.searchBound.effectivePoolSize = advanced ? pool.length : Math.min(pool.length, MAX_INSERTION_SCAN);
  diagnostics.searchBound.unscannedCandidateCount = Math.max(0, pool.length - diagnostics.searchBound.effectivePoolSize);
  diagnostics.mustVisitIds = must.map((item) => item.id);

  const requiredSet = new Set(must.map((item) => item.id));
  const archive = new Map();
  let primary = evaluateRoute(env, []);
  recordTour(archive, primary);

  const greedyStart = nowMs();
  const stage1BudgetMs = must.length > 0 ? STAGE1_ADVANCED_RETRY_MS : STAGE1_MS;
  const stage1Deadline = seeded ? searchEndAt : Math.min(Math.max(endAt, greedyStart + STAGE1_MS), greedyStart + stage1BudgetMs);
  const greedyLimiter = createSearchLimiter(stage1Deadline, seeded ? STAGE1_MOVES : Infinity);
  let route = [];
  if (must.length > 0) {
    const built = greedyConstruct(env, [], must, requiredSet, greedyLimiter, true, archive);
    if (!built.complete) {
      const retryLimiter = seeded
        ? greedyLimiter
        : createSearchLimiter(nowMs() + STAGE1_ADVANCED_RETRY_MS);
      const retry = greedyConstruct(env, built.route, must.filter((c) => !built.route.some((r) => r.id === c.id)), requiredSet, retryLimiter, true, archive);
      diagnostics.advancedGreedyRetried = true;
      if (!retry.complete) return invalid("unreachable-must-visits", { missingMustVisitIds: retry.remaining.map((item) => item.id) });
      route = retry.route;
    } else {
      route = built.route;
    }
  } else {
    route = greedyConstruct(env, [], pool, requiredSet, greedyLimiter, false, archive).route;
  }
  primary = bestOf(primary, evaluateRoute(env, route));
  if (env.openEnd && advanced && containsAll(route, requiredSet)) primary = evaluateRoute(env, route);
  recordTour(archive, primary);
  stageTimingsMs.greedy = round(nowMs() - greedyStart, 3);

  const lsStart = nowMs();
  const lsLimiter = createSearchLimiter(seeded ? searchEndAt : Math.min(endAt, lsStart + STAGE2_MS), seeded ? STAGE2_MOVES : Infinity);
  route = localSearch(env, primary.route, requiredSet, pool, lsLimiter, archive).route;
  primary = bestOf(primary, evaluateRoute(env, route));
  stageTimingsMs.localSearch = round(nowMs() - lsStart, 3);

  const perturbStart = nowMs();
  let perturbations = 0;
  const perturbSearchLimiter = seeded ? createSearchLimiter(searchEndAt, 0) : null;
  while (perturbations < iterationCap && nowMs() < searchEndAt) {
    perturbations += 1;
    env.iterations += 1;
    const seedRoute = perturbRoute(env, primary.route, requiredSet, pool);
    const searched = localSearch(
      env,
      seedRoute,
      requiredSet,
      pool,
      seeded ? perturbSearchLimiter : createSearchLimiter(Math.min(endAt, nowMs() + 45)),
      archive
    );
    const candidate = evaluateRoute(env, searched.route);
    recordTour(archive, candidate);
    primary = bestOf(primary, candidate);
  }
  stageTimingsMs.perturbation = round(nowMs() - perturbStart, 3);

  if (advanced && !containsAll(primary.route, requiredSet)) {
    return invalid("unreachable-must-visits", { missingMustVisitIds: [...requiredSet].filter((id) => !primary.route.some((item) => item.id === id)) });
  }
  if (advanced && !env.openEnd && !primary.budgetFit.within) return invalid("must-visits-exceed-budget", { budgetFit: primary.budgetFit });

  const ranked = [...archive.values()]
    .filter((tour) => tour.feasible && (!advanced || containsAll(tour.route, requiredSet)))
    .sort(compareTours);
  primary = ranked[0] ?? primary;
  const kAlternatives = Math.max(0, Math.trunc(Number(options.kAlternatives ?? DEFAULT_K_ALTERNATIVES) || 0));
  const maxAlternatives = Math.max(0, kAlternatives - 1);
  const alternatives = ranked.filter((tour) => tour.signature !== primary.signature).slice(0, maxAlternatives).map(publicTour);
  const publicPrimary = publicTour(primary);
  diagnostics.stageTimingsMs = stageTimingsMs;
  diagnostics.cache = { legs: env.legCache.size, routes: env.routeCache.size };
  diagnostics.materialization = env.materializationStats;

  let status = "ok";
  if (!publicPrimary || publicPrimary.stops.filter((stop) => !isSentinelStop(stop)).length === 0) {
    status = "degraded";
    diagnostics.degradedReasons.push("no-pass-fit-budget-or-restrictions");
  }
  if (env.openEnd && publicPrimary && !publicPrimary.budgetFit?.within) {
    status = "degraded";
    if (!diagnostics.degradedReasons.includes("budget-exceeded-by-end")) diagnostics.degradedReasons.push("budget-exceeded-by-end");
    diagnostics.reason = "budget-exceeded-by-end";
  }
  return finalize(status, publicPrimary, alternatives, env.iterations, started, diagnostics);
}

function resolveEnd(graph, endOption, start, forbiddenNodes, opts = {}) {
  const endSnapMaxDistanceM = opts.endSnapMaxDistanceM ?? END_SNAP_MAX_DISTANCE_M;
  if (endOption === undefined || endOption === null || endOption === "") return closedEnd(start, "unset");

  if (typeof endOption === "string") {
    const value = String(endOption);
    if (value === start.node.id) return closedEnd(start, "same-start");

    const node = graphNodeById(graph, value);
    const passId = resolvePassId(graph, value);
    if (passId && (node?.kind === "pass" || node?.kind === "pass-summit" || (!node && (/^[^:]+$/.test(value) || /:S$/.test(value))))) {
      const base = closestPassBaseEnd(graph, passId, start.node, forbiddenNodes, opts);
      if (!base) return { ok: false, reason: "end-unreachable", extra: { endNode: value } };
      if (base.id === start.node.id) return closedEnd(start, "same-start");
      return openEnd(base, base.name ?? value, value, { resolvedFromPassId: passId });
    }

    if (!node) return { ok: false, reason: "end-unreachable", extra: { endNode: value } };
    if (forbiddenNodes.has(node.id)) return { ok: false, reason: "end-unreachable", extra: { endNode: value } };
    if (node.id === start.node.id) return closedEnd(start, "same-start");
    return openEnd(node, node.name ?? node.id, value);
  }

  if (Number.isFinite(Number(endOption?.lat)) && Number.isFinite(Number(endOption?.lon ?? endOption?.lng))) {
    const nearest = graph.nearestNodes(Number(endOption.lat), Number(endOption.lon ?? endOption.lng), ["junction", "pass-base"], 32)
      .find((item) => item.distanceM <= endSnapMaxDistanceM && !forbiddenNodes.has(item.node.id));
    if (!nearest?.node) return { ok: false, reason: "end-snap-failed", extra: { endNode: endOption, snapMaxDistanceM: endSnapMaxDistanceM } };
    if (nearest.node.id === start.node.id) return closedEnd(start, "same-start");
    return openEnd(nearest.node, endOption.name ?? nearest.node.name ?? nearest.node.id, "ad-hoc", { snapped: true, snapDistanceM: nearest.distanceM });
  }

  return { ok: false, reason: "end-unreachable", extra: { endNode: endOption ?? null } };
}

function parseEndSnapMaxDistanceM(value) {
  if (value === undefined || value === null || value === "") return END_SNAP_MAX_DISTANCE_M;
  const distanceM = Number(value);
  return Number.isFinite(distanceM) ? Math.max(0, distanceM) : END_SNAP_MAX_DISTANCE_M;
}

function closedEnd(start, requested) {
  return {
    ok: true,
    open: false,
    node: start.node,
    name: start.name,
    requested,
    snapped: start.snapped,
    snapDistanceM: start.snapDistanceM,
  };
}

function openEnd(node, name, requested, extra = {}) {
  return {
    ok: true,
    open: true,
    node,
    name,
    requested,
    snapped: false,
    snapDistanceM: 0,
    ...extra,
  };
}

function closestPassBaseEnd(graph, passId, referenceNode, forbiddenNodes, opts = {}) {
  const sides = graph.passSidesFor?.(passId);
  const bases = [sides?.A, sides?.B].filter((node) => node?.id && !forbiddenNodes.has(node.id));
  if (!bases.length) return null;
  return bases
    .map((node) => ({ node, leg: leisureAStar(graph, referenceNode.id, node.id, {
      costMode: opts.costMode ?? "duration",
      forbiddenNodes,
      forbiddenEdges: opts.forbiddenEdges,
    }) }))
    .filter((item) => item.leg.status === "ok")
    .sort((a, b) => legCostForMode(a.leg, opts.costMode) - legCostForMode(b.leg, opts.costMode)
      || (Number(a.leg.totalLeisureCost) || 0) - (Number(b.leg.totalLeisureCost) || 0)
      || a.node.id.localeCompare(b.node.id))[0]?.node ?? null;
}

function graphNodeById(graph, id) {
  const value = String(id);
  return graph.nodes.get(value) ?? (value.startsWith("p-") ? graph.nodes.get(value.slice(2)) : null);
}

function expandPassSiblings(graph, ids) {
  const expanded = new Set();
  for (const id of ids) {
    if (!id) continue;
    expanded.add(id);
    const passId = resolvePassId(graph, id);
    if (!passId) continue;
    expanded.add(passId);
    expanded.add(`${passId}:A`);
    expanded.add(`${passId}:S`);
    expanded.add(`${passId}:B`);
    const sides = graph.passSidesFor?.(passId);
    for (const node of [sides?.pass, sides?.A, sides?.S, sides?.B]) if (node?.id) expanded.add(node.id);
  }
  return expanded;
}

function isSentinelStop(stop) {
  return stop?.kind === "start" || stop?.kind === "end" || stop?.kind === "return" || stop?.returnToStart;
}

function legCostForMode(leg, costMode) {
  if (costMode === "distance") return finiteMetric(leg.totalDistanceM);
  if (costMode === "duration") return finiteMetric(leg.totalDurationS);
  return finiteMetric(leg.totalLeisureCost);
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Infinity;
}

function validateEndReachability(env, must) {
  if (!env.openEnd) return { ok: true };
  const sources = must.length ? must.map((item) => item.nodeId) : [env.start.node.id];
  for (const fromId of sources) {
    if (fromId === env.end.node.id) continue;
    const result = leisureAStar(env.graph, fromId, env.end.node.id, {
      costMode: env.budget.mode,
      forbiddenNodes: env.forbiddenNodes,
      forbiddenEdges: env.forbiddenEdges,
    });
    if (result.status !== "ok") return { ok: false, fromId };
  }
  return { ok: true };
}

function createSearchLimiter(deadline, moveCap = Infinity) {
  return { deadline, moveCap, moves: 0 };
}

function hasSearchBudget(limiter) {
  return limiter.moves < limiter.moveCap && nowMs() < limiter.deadline;
}

function countSearchMove(limiter) {
  limiter.moves += 1;
}

function greedyConstruct(env, seedRoute, candidates, requiredSet, limiter, requireAll, archive) {
  let route = seedRoute.slice();
  const placed = new Set(route.map((item) => item.id));
  let current = evaluateRoute(env, route);
  recordTour(archive, current);
  const remaining = candidates.filter((item) => !placed.has(item.id));

  while (remaining.length && hasSearchBudget(limiter)) {
    let bestMove = null;
    const scan = remaining.slice(0, requireAll ? remaining.length : MAX_INSERTION_SCAN);
    for (const candidate of scan) {
      if (!hasSearchBudget(limiter)) break;
      const options = [];
      for (let pos = 0; pos <= route.length && hasSearchBudget(limiter); pos += 1) {
        const nextRoute = insertAt(route, pos, candidate);
        const tour = evaluateRoute(env, nextRoute);
        countSearchMove(limiter);
        env.iterations += 1;
        if (!tour.feasible) continue;
        recordTour(archive, tour);
        options.push({ route: nextRoute, tour, delta: tour.score - current.score });
      }
      if (!options.length) continue;
      options.sort((a, b) => b.delta - a.delta || compareTours(a.tour, b.tour));
      const secondDelta = options[1]?.delta ?? (requireAll ? -10_000 : 0);
      const priority = options[0].delta + 0.25 * (options[0].delta - secondDelta);
      if (!bestMove || priority > bestMove.priority + EPS || (Math.abs(priority - bestMove.priority) <= EPS && options[0].tour.score > bestMove.tour.score)) {
        bestMove = { ...options[0], candidate, priority };
      }
    }
    if (!bestMove || (!requireAll && bestMove.delta <= EPS)) break;
    route = bestMove.route;
    current = bestMove.tour;
    placed.add(bestMove.candidate.id);
    remaining.splice(remaining.findIndex((item) => item.id === bestMove.candidate.id), 1);
  }

  return { route, complete: remaining.length === 0, remaining };
}

function localSearch(env, seedRoute, requiredSet, pool, limiter, archive) {
  let route = seedRoute.slice();
  let best = evaluateRoute(env, route);
  recordTour(archive, best);
  let improved = true;

  while (improved && hasSearchBudget(limiter)) {
    improved = false;
    const accepted = tryMoveGenerators([
      () => twoOptMoves(route),
      () => orOptMoves(route),
      () => removalMoves(route, requiredSet),
      () => insertionMoves(route, pool),
    ]);
    if (accepted) {
      route = accepted.route;
      best = accepted.tour;
      improved = true;
    }
  }
  return { route, tour: best };

  function tryMoveGenerators(generators) {
    for (const makeMoves of generators) {
      for (const nextRoute of makeMoves()) {
        if (!hasSearchBudget(limiter)) return null;
        const tour = evaluateRoute(env, nextRoute);
        countSearchMove(limiter);
        env.iterations += 1;
        if (tour.feasible) recordTour(archive, tour);
        if (tour.feasible && tour.score > best.score + EPS && containsAll(nextRoute, requiredSet)) return { route: nextRoute, tour };
      }
    }
    return null;
  }
}

function* twoOptMoves(route) {
  for (let i = 0; i < route.length - 1; i += 1) {
    for (let j = i + 1; j < route.length; j += 1) {
      yield route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
    }
  }
}

function* orOptMoves(route) {
  for (let len = 1; len <= 3; len += 1) {
    if (route.length <= len) continue;
    for (let i = 0; i <= route.length - len; i += 1) {
      const segment = route.slice(i, i + len);
      const rest = route.slice(0, i).concat(route.slice(i + len));
      for (let pos = 0; pos <= rest.length; pos += 1) {
        if (pos === i) continue;
        yield rest.slice(0, pos).concat(segment, rest.slice(pos));
      }
    }
  }
}

function* removalMoves(route, requiredSet) {
  for (let i = 0; i < route.length; i += 1) {
    if (requiredSet.has(route[i].id)) continue;
    yield route.slice(0, i).concat(route.slice(i + 1));
  }
}

function* insertionMoves(route, pool) {
  const present = new Set(route.map((item) => item.id));
  for (const candidate of pool.slice(0, MAX_INSERTION_SCAN)) {
    if (present.has(candidate.id)) continue;
    for (let pos = 0; pos <= route.length; pos += 1) yield insertAt(route, pos, candidate);
  }
}

function perturbRoute(env, route, requiredSet, pool) {
  if (route.length >= 8 && env.rng() < 0.3) return doubleBridge(route, env.rng);
  if (env.rng() < 0.3) return randomRestart(env, requiredSet, pool);
  if (env.rng() < 0.5) return kickByEar(env, route, requiredSet, pool);
  return randomKick(env, route, requiredSet, pool);
}

function doubleBridge(route, rng) {
  const n = route.length;
  const cuts = [...new Set(Array.from({ length: 4 }, () => 1 + Math.floor(rng() * (n - 1))))].sort((a, b) => a - b);
  if (cuts.length < 4) return route.slice().reverse();
  const [a, b, c, d] = cuts;
  return route.slice(0, a).concat(route.slice(c, d), route.slice(b, c), route.slice(a, b), route.slice(d));
}

function randomRestart(env, requiredSet, pool) {
  let route = shuffle(pool.filter((item) => requiredSet.has(item.id)), env.rng);
  for (const candidate of shuffle(pool.filter((item) => !requiredSet.has(item.id)), env.rng).slice(0, 12)) {
    const next = insertAt(route, Math.floor(env.rng() * (route.length + 1)), candidate);
    if (evaluateRoute(env, next).feasible) route = next;
  }
  return route;
}

function kickByEar(env, route, requiredSet, pool) {
  const earIds = route.flatMap((item) => item.earIds);
  const earId = earIds.length ? earIds[Math.floor(env.rng() * earIds.length)] : null;
  if (!earId) return randomKick(env, route, requiredSet, pool);
  let next = route.filter((item) => requiredSet.has(item.id) || !item.earIds.includes(earId));
  const additions = pool.filter((item) => !next.some((r) => r.id === item.id) && item.earIds.includes(earId));
  for (const candidate of shuffle(additions, env.rng).slice(0, 3)) next = insertAt(next, Math.floor(env.rng() * (next.length + 1)), candidate);
  if (!sameRouteIds(next, route)) return next;
  env.materializationStats.degeneratePerturbations += 1;
  return randomKick(env, route, requiredSet, pool);
}

function randomKick(env, route, requiredSet, pool) {
  let next = route.filter((item) => requiredSet.has(item.id) || env.rng() > 0.35);
  const present = new Set(next.map((item) => item.id));
  for (const candidate of shuffle(pool.filter((item) => !present.has(item.id)), env.rng).slice(0, 2)) {
    next = insertAt(next, Math.floor(env.rng() * (next.length + 1)), candidate);
    present.add(candidate.id);
  }
  if (sameRouteIds(next, route) && route.length > 1) next = route.slice().reverse();
  if (sameRouteIds(next, route)) env.materializationStats.degeneratePerturbations += 1;
  return next;
}

function evaluateRoute(env, route) {
  const signature = routeSignature(route);
  const cached = recallBounded(env.routeCache, signature);
  if (cached !== undefined) return cached;

  const nodes = [env.start.node.id, ...route.map((item) => item.nodeId), env.end.node.id];
  const baseline = materializeRoute(env, nodes, false, 0);
  if (!baseline.ok) {
    const failed = failedTour(env, route, signature, baseline.leg, baseline.fromId, baseline.toId);
    rememberBounded(env.routeCache, signature, failed, env.cacheLimit);
    return failed;
  }

  const baselineEdges = baseline.edgeIds.map((id) => env.graph.edgeById.get(id)).filter(Boolean);
  const baselineUsed = budgetUsed(env.budget, baseline);
  const baselineFit = budgetFitObject(env.budget, baselineUsed);
  let materialized = baseline;
  if (baselineFit.within && countRetracedConnectors(baselineEdges) > 0) {
    const retry = materializeRoute(env, nodes, true, Math.max(0, env.budget.value - baselineUsed));
    if (retry.ok) materialized = retry;
  }

  const edgeIds = materialized.edgeIds;
  const legs = materialized.legs;
  const totalLeisureCost = materialized.totalLeisureCost;
  const totalDistanceM = materialized.totalDistanceM;
  const totalDurationS = materialized.totalDurationS;
  const edgeObjects = edgeIds.map((id) => env.graph.edgeById.get(id)).filter(Boolean);
  const retracedConnectorCount = countRetracedConnectors(edgeObjects);
  const outAndBackCount = countOutAndBack(env.graph, route, legs);
  const scenicSum = route.reduce((sum, item) => sum + item.scenicScore, 0);
  const themeCoverage = computeThemeCoverage(route, env.themeProfile);
  const earsTraversed = earsForRoute(env.earInfo, route, edgeObjects);
  const loopEarCount = earsTraversed.filter((id) => env.earInfo.earById.get(id)?.kind === "loop").length;
  const used = env.budget.mode === "duration" ? totalDurationS : totalDistanceM / 1000;
  const budgetFit = budgetFitObject(env.budget, used);
  const score = scoreTour({ scenicSum, themeCoverage, totalLeisureCost, retracedConnectorCount, outAndBackCount, loopEarCount, budgetFit });
  const tour = {
    feasible: budgetFit.within || (env.openEnd && (env.advanced || route.length === 0)),
    route: route.slice(),
    signature,
    endNode: env.end.node.id,
    stops: publicStops(env.start, route, env.end),
    edges: edgeIds,
    totalLeisureCost: round(totalLeisureCost, 3),
    totalDistanceKm: round(totalDistanceM / 1000, 3),
    totalDurationH: round(totalDurationS / 3600, 4),
    scenicSum: round(scenicSum, 4),
    retracedConnectorCount,
    outAndBackCount,
    earsTraversed,
    themeCoverage,
    budgetFit,
    path: materialized.pathNodes,
    score: round(score, 3),
    _durationS: round(totalDurationS, 3),
  };
  rememberBounded(env.routeCache, signature, tour, env.cacheLimit);
  return tour;
}

function materializeRoute(env, nodes, allowLeisure, budgetSlack) {
  const edgeIds = [];
  const pathNodes = [];
  const legs = [];
  const usedConnectorEdges = new Set();
  let totalLeisureCost = 0;
  let totalDistanceM = 0;
  let totalDurationS = 0;

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const options = legBetween(env, nodes[i], nodes[i + 1], usedConnectorEdges, allowLeisure);
    if (options.budget.status !== "ok") return { ok: false, leg: options.budget, fromId: nodes[i], toId: nodes[i + 1] };
    let leg = options.budget;
    if (allowLeisure && options.leisure) {
      const extraBudget = legBudgetMetric(env.budget, options.leisure) - legBudgetMetric(env.budget, options.budget);
      if (extraBudget <= budgetSlack + EPS) {
        leg = options.leisure;
        budgetSlack -= Math.max(0, extraBudget);
        env.materializationStats.leisureAccepted += 1;
      }
    }
    legs.push(leg);
    edgeIds.push(...leg.edges);
    pathNodes.push(...(pathNodes.length ? leg.nodes.slice(1) : leg.nodes));
    totalLeisureCost += leg.totalLeisureCost;
    totalDistanceM += leg.totalDistanceM;
    totalDurationS += leg.totalDurationS;
    for (const edgeId of leg.edges) addUsedConnectorEdge(env, usedConnectorEdges, edgeId);
  }
  return { ok: true, legs, edgeIds, pathNodes, totalLeisureCost, totalDistanceM, totalDurationS };
}

function failedTour(env, route, signature, leg, fromId, toId) {
  return {
    feasible: false,
    route: route.slice(),
    signature,
    endNode: env.end.node.id,
    status: leg?.status ?? "unreachable",
    reason: `unreachable-leg:${fromId}->${toId}`,
    stops: publicStops(env.start, route, env.end),
    edges: [],
    totalLeisureCost: 0,
    totalDistanceKm: 0,
    totalDurationH: 0,
    scenicSum: 0,
    retracedConnectorCount: 0,
    outAndBackCount: 0,
    earsTraversed: [],
    themeCoverage: computeThemeCoverage([], env.themeProfile),
    budgetFit: { ...budgetFitObject(env.budget, 0), within: false },
    path: [],
    score: -Infinity,
    _durationS: 0,
  };
}

function legBetween(env, fromId, toId, usedEdges, allowLeisure) {
  const usedKey = stableSetKey(usedEdges);
  const key = `options\u001F${allowLeisure ? 1 : 0}\u001F${env.budget.mode}\u001F${fromId}\u001F${toId}\u001F${usedKey}`;
  const cached = recallBounded(env.legCache, key);
  if (cached !== undefined) return cached;
  const budget = budgetLegBetween(env, fromId, toId);
  const result = { budget, leisure: null };
  if (allowLeisure && budget.status === "ok" && usedEdges?.size) {
    const leisure = leisureLegBetween(env, fromId, toId, usedEdges, usedKey, retryLeisureCostLimit(budget));
    if (leisure.status === "ok" && countLegUsedConnectorOverlaps(env, leisure, usedEdges) < countLegUsedConnectorOverlaps(env, budget, usedEdges)) {
      result.leisure = leisure;
    }
  }
  rememberBounded(env.legCache, key, result, env.cacheLimit);
  return result;
}

function budgetLegBetween(env, fromId, toId) {
  const key = `budget\u001F${env.budget.mode}\u001F${fromId}\u001F${toId}`;
  const cached = recallBounded(env.legCache, key);
  if (cached !== undefined) return cached;
  const opts = {
    costMode: env.budget.mode,
    forbiddenNodes: env.forbiddenNodes,
    forbiddenEdges: env.forbiddenEdges,
  };
  if (!env.openEnd && env.budget.mode === "duration") opts.maxDurationS = env.budget.value;
  if (!env.openEnd && env.budget.mode === "distance") opts.maxDistanceKm = env.budget.value;
  const result = leisureAStar(env.graph, fromId, toId, opts);
  rememberBounded(env.legCache, key, result, env.cacheLimit);
  return result;
}

function leisureLegBetween(env, fromId, toId, usedEdges, usedKey, maxLeisureCost) {
  const key = `leisure\u001F${env.budget.mode}\u001F${fromId}\u001F${toId}\u001F${usedKey}`;
  const cached = recallBounded(env.legCache, key);
  if (cached !== undefined) return cached;
  env.materializationStats.leisureRetries += 1;
  const opts = {
    costMode: "leisure",
    forbiddenNodes: env.forbiddenNodes,
    forbiddenEdges: env.forbiddenEdges,
    usedEdges,
    usedEdgesPenalty: USED_EDGES_PENALTY,
  };
  if (Number.isFinite(maxLeisureCost)) opts.maxLeisureCost = maxLeisureCost;
  const result = leisureAStar(env.graph, fromId, toId, opts);
  rememberBounded(env.legCache, key, result, env.cacheLimit);
  return result;
}

function retryLeisureCostLimit(budgetLeg) {
  const baselineCost = Number(budgetLeg.totalLeisureCost);
  return Number.isFinite(baselineCost) ? Math.max(0, baselineCost * USED_EDGES_PENALTY + EPS) : Infinity;
}

function budgetUsed(budget, materialized) {
  return budget.mode === "duration" ? materialized.totalDurationS : materialized.totalDistanceM / 1000;
}

function legBudgetMetric(budget, leg) {
  return budget.mode === "duration" ? Number(leg.totalDurationS) || 0 : (Number(leg.totalDistanceM) || 0) / 1000;
}

function countLegUsedConnectorOverlaps(env, leg, usedEdges) {
  let count = 0;
  for (const edgeId of leg.edges) {
    const edge = env.graph.edgeById.get(edgeId);
    if (edge?.kind === "connector" && usedEdgesHasConnector(usedEdges, edge)) count += 1;
  }
  return count;
}

function usedEdgesHasConnector(usedEdges, edge) {
  const key = edge.key ?? `${edge.from}->${edge.to}`;
  const reverseKey = `${edge.to}->${edge.from}`;
  return usedEdges.has(edge.id)
    || usedEdges.has(key)
    || usedEdges.has(reverseKey)
    || (edge.roadClass ? usedEdges.has(`${edge.roadClass}:${key}`) || usedEdges.has(`${edge.roadClass}:${reverseKey}`) : false);
}

function addUsedConnectorEdge(env, usedEdges, edgeId) {
  const edge = env.graph.edgeById.get(edgeId);
  if (edge?.kind !== "connector") return;
  const key = edge.key ?? `${edge.from}->${edge.to}`;
  const reverseKey = `${edge.to}->${edge.from}`;
  usedEdges.add(edge.id);
  usedEdges.add(key);
  usedEdges.add(reverseKey);
  if (edge.roadClass) {
    usedEdges.add(`${edge.roadClass}:${key}`);
    usedEdges.add(`${edge.roadClass}:${reverseKey}`);
  }
}

function scoreTour(tour) {
  const themeScore = tour.themeCoverage.score ?? 0;
  const budgetFill = Math.max(0, Math.min(1, tour.budgetFit.ratio || 0));
  return tour.scenicSum * SCENIC_WEIGHT
    + themeScore * THEME_WEIGHT
    + budgetFill * BUDGET_FILL_WEIGHT
    - tour.totalLeisureCost * LEISURE_COST_WEIGHT
    - tour.retracedConnectorCount * RETRACED_CONNECTOR_PENALTY
    - tour.outAndBackCount * OUT_AND_BACK_PENALTY
    + tour.loopEarCount * LOOP_EAR_BONUS;
}

function countRetracedConnectors(edges) {
  const seen = new Set();
  let retraced = 0;
  for (const edge of edges) {
    if (edge.kind !== "connector") continue;
    const key = canonicalPair(edge.from, edge.to);
    if (seen.has(key)) retraced += 1;
    else seen.add(key);
  }
  return retraced;
}

function countOutAndBack(graph, route, legs) {
  let count = 0;
  for (let i = 0; i < route.length; i += 1) {
    const passId = route[i].passId;
    if (!passId) continue;
    const inbound = legs[i]?.nodes ?? [];
    const outbound = legs[i + 1]?.nodes ?? [];
    const before = inbound[inbound.length - 2];
    const after = outbound[1];
    const beforeNode = graph.nodes.get(before);
    const afterNode = graph.nodes.get(after);
    if (beforeNode?.passId === passId && afterNode?.passId === passId && beforeNode.side && beforeNode.side === afterNode.side) {
      count += 1;
    } else if (before && before === after && !beforeNode?.side && !afterNode?.side) {
      count += 1;
    }
  }
  return count;
}

function computeThemeCoverage(route, profile) {
  const covered = new Set();
  for (const item of route) for (const theme of item.themes) covered.add(theme);
  const requested = profile.requested;
  const coveredRequested = requested.filter((theme) => covered.has(theme));
  const ratio = requested.length ? coveredRequested.length / requested.length : Math.min(1, covered.size / 5);
  return {
    requested,
    coveredThemes: [...covered].sort(),
    coveredRequested,
    ratio: round(ratio, 4),
    score: round(ratio, 4),
  };
}

function earsForRoute(earInfo, route, edges) {
  const ids = new Set();
  for (const item of route) for (const id of item.earIds) ids.add(id);
  for (const edge of edges) {
    const passId = edge.passId;
    if (!passId) continue;
    for (const id of earInfo.passToEarIds.get(passId) ?? []) ids.add(id);
  }
  return [...ids].sort();
}
