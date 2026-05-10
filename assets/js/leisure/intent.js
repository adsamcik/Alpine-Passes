const PERSONAS = Object.freeze([
  "Photographer",
  "ThrillRider",
  "Family",
  "Gourmet",
  "CultureSeeker",
  "NatureHiker",
  "Speedrunner",
  "SlowTourer",
]);

const PERSONA_TAGS = Object.freeze({
  Photographer: tagWeights({
    "panoramic-view": 1, viewpoint: 0.95, viewpoints: 0.95, photogenic: 0.95, iconic: 0.65,
    glacier: 0.55, "alpine-lake": 0.6, "scenic-railway": 0.45, "cable-car": 0.4,
    castle: 0.25, architecture: 0.35, "high-alpine": 0.4, "nature-reserve": 0.35,
    "old-town": 0.25, "special-experience": 0.35, "drivers-road": -0.05, museum: 0.05,
    "food-drink": 0.05, "hike-required": 0.15,
  }),
  ThrillRider: tagWeights({
    "drivers-road": 1, hairpin: 1, "alpine-pass": 0.95, pass: 0.55, "high-alpine": 0.8,
    iconic: 0.45, "panoramic-view": 0.3, viewpoint: 0.25, viewpoints: 0.25, glacier: 0.1,
    "alpine-lake": 0.1, "cable-car": 0.15, "special-experience": 0.25, "summer-only": 0.2,
    "car-accessible": 0.35, "food-drink": -0.15, museum: -0.45, "old-town": -0.35,
    "family-friendly": -0.35, "slow-travel": -0.5,
  }),
  Family: tagWeights({
    "family-friendly": 1, playground: 0.95, "car-accessible": 0.75, "year-round": 0.6,
    "alpine-lake": 0.45, "cable-car": 0.55, village: 0.4, "special-experience": 0.45,
    "food-drink": 0.35, castle: 0.35, "castle-fortress": 0.35, "scenic-railway": 0.5,
    "old-town": 0.3, museum: 0.25, "museum-cultural": 0.25, viewpoint: 0.2,
    "panoramic-view": 0.2, "hike-required": -0.6, "high-alpine": -0.25, "drivers-road": -0.35,
  }),
  Gourmet: tagWeights({
    "food-drink": 1, village: 0.7, "old-town": 0.65, "slow-travel": 0.55, "year-round": 0.35,
    "car-accessible": 0.3, historic: 0.25, architecture: 0.2, iconic: 0.15, photogenic: 0.15,
    "family-friendly": 0.15, "special-experience": 0.25, "alpine-hut": 0.45, "alpine-lake": 0.1,
    castle: 0.1, museum: 0.1, "panoramic-view": 0.1, "drivers-road": -0.35,
    "hike-required": -0.25, "summer-only": -0.05,
  }),
  CultureSeeker: tagWeights({
    museum: 1, "museum-cultural": 1, historic: 0.9, architecture: 0.85, unesco: 0.85,
    castle: 0.75, "castle-fortress": 0.75, "old-town": 0.75, monastery: 0.65,
    "monastery-church": 0.65, village: 0.35, "year-round": 0.45, iconic: 0.4,
    photogenic: 0.25, "scenic-railway": 0.25, "food-drink": 0.2, "car-accessible": 0.25,
    "panoramic-view": 0.05, "drivers-road": -0.45, "hike-required": -0.35, "high-alpine": -0.25,
  }),
  NatureHiker: tagWeights({
    "nature-reserve": 1, "national-park": 0.95, "hike-required": 0.9, glacier: 0.75,
    "alpine-lake": 0.8, "alpine-hut": 0.75, "high-alpine": 0.65, "panoramic-view": 0.55,
    viewpoint: 0.4, viewpoints: 0.4, photogenic: 0.35, "summer-only": 0.25, "hidden-gem": 0.45,
    "cable-car": 0.15, "car-accessible": -0.15, museum: -0.25, "food-drink": -0.15,
    "drivers-road": -0.2, "old-town": -0.25, "family-friendly": -0.05,
  }),
  Speedrunner: tagWeights({
    "car-accessible": 0.9, "year-round": 0.75, "drivers-road": 0.55, "alpine-pass": 0.35,
    iconic: 0.35, pass: 0.25, viewpoint: 0.2, "panoramic-view": 0.25, "food-drink": -0.25,
    "slow-travel": -0.9, "hike-required": -0.85, museum: -0.45, "old-town": -0.45,
    "scenic-railway": -0.35, "cable-car": -0.25, "family-friendly": -0.15, "summer-only": -0.2,
    "special-experience": -0.15, village: -0.25, "alpine-hut": -0.35,
  }),
  SlowTourer: tagWeights({
    "slow-travel": 1, village: 0.75, "old-town": 0.75, "scenic-railway": 0.75,
    "alpine-lake": 0.55, "food-drink": 0.5, "family-friendly": 0.35, historic: 0.45,
    architecture: 0.35, "panoramic-view": 0.35, viewpoint: 0.3, viewpoints: 0.3,
    "year-round": 0.25, "cable-car": 0.25, "nature-reserve": 0.35, "hidden-gem": 0.5,
    "drivers-road": -0.65, hairpin: -0.55, "high-alpine": -0.15, "hike-required": -0.1,
  }),
});

const EVIDENCE_SCALE = 0.55;
const UPDATE_ETA = 0.3;
const AMBIGUOUS_ENTROPY = 1.5;
const GENERIC_REASON_TAGS = new Set(["poi", "pass", "viewpoints"]);
const ALL_TAGS = Object.freeze([...new Set(PERSONAS.flatMap((persona) => Object.keys(PERSONA_TAGS[persona])))].sort());

export function inferIntent(state = {}) {
  const tags = [
    ...flatMapArray(state.pinnedStops, tagsFromEntity),
    ...flatMapArray(state.themeChips, (tag) => normalizeTagSet([tag])),
  ];
  const history = state.history ?? {};
  let probabilities = probabilitiesFromPrior(history.pastIntent);
  probabilities = softmax(PERSONAS.map((persona, index) => {
    let score = Math.log(Math.max(probabilities[index], 1e-12));
    for (const tag of tags) score += EVIDENCE_SCALE * (PERSONA_TAGS[persona][tag] ?? 0);
    return score;
  }));

  if (state.budgetTier === "shoestring") probabilities = multiplyPersona(probabilities, "Gourmet", 0.5);
  if (state.weather === "rainy") {
    probabilities = multiplyPersona(probabilities, "NatureHiker", 0.6);
    probabilities = multiplyPersona(probabilities, "CultureSeeker", 1.3);
  }
  if (state.groupSize >= 4) probabilities = floorPersona(probabilities, "Family", 0.2);
  if (state.withChild === true) probabilities = floorPersona(probabilities, "Family", 0.3);

  return buildIntent(probabilities, dismissedTagsFrom(history.pastIntent, history.pastDismissedTags));
}

export function updateIntent(prevIntent, observation = {}) {
  const tags = tagsFromTarget(observation.target);
  let probabilities = probabilitiesFromPrior(prevIntent);
  const direction = observation.kind === "dismiss" || observation.kind === "rejectSuggestion" ? -1 : 1;

  if (tags.length > 0) {
    probabilities = normalizeProbabilities(PERSONAS.map((persona, index) => {
      const match = dot(PERSONA_TAGS[persona], tags);
      return probabilities[index] * Math.exp(direction * UPDATE_ETA * match);
    }));
  }

  const dismissed = { ...dismissedTagsFrom(prevIntent) };
  if (observation.kind === "dismiss") {
    for (const tag of tags) dismissed[tag] = (dismissed[tag] ?? 0) + 1;
  }
  return buildIntent(probabilities, dismissed);
}

export function surfaceIntentPois(graph, tour, intentDistribution, options = {}) {
  void tour;
  const intent = intentDistribution ?? inferIntent();
  const topK = Math.max(0, Math.trunc(Number(options.topK ?? 12) || 0));
  const serendipityCount = Math.min(topK, Math.max(0, Math.round(topK * clamp01(Number(options.serendipityFraction ?? (2 / 12))))));
  const primaryCount = Math.max(0, topK - serendipityCount);
  const dismissed = dismissedTagsFrom(intent);
  const effectiveTagVector = intent.effectiveTagVector ?? {};
  const candidates = dedupeCandidates((Array.isArray(options.corridorPois) ? options.corridorPois : graphPois(graph)).map(normalizeCandidate).filter(Boolean));

  const scored = candidates.map((candidate, index) => {
    const tags = tagsFromEntity(candidate);
    const intentMatch = dot(effectiveTagVector, tags);
    const negativeMatch = tags.reduce((sum, tag) => sum + (dismissed[tag] ?? 0), 0);
    const value = clamp01(Number(candidate.score) / 10); // Cap malformed scores so quality stays in the expected 0..1 range.
    return {
      ...candidate,
      index,
      tags,
      categoryTagSet: new Set(normalizeTagSet(candidate.categories)),
      intentMatch,
      negativeMatch,
      value,
      finalScore: intentMatch * value - 0.2 * negativeMatch,
    };
  }).sort(compareBaseScore);
  scored.forEach((candidate, rank) => { candidate.rank = rank; });

  const primary = selectPrimary(scored, primaryCount).map((candidate) => surfaceItem(candidate, intent, false));
  const primaryIds = new Set(primary.map((item) => item.poiId));
  const serendipity = scored
    .filter((candidate) => !primaryIds.has(candidate.poiId))
    .sort(compareSerendipity)
    .slice(0, serendipityCount)
    .map((candidate) => surfaceItem(candidate, intent, true));

  return {
    primary,
    serendipity,
    diagnostics: {
      topPersona: intent.topPersona,
      entropy: intent.entropy,
      topPersonas: rankedPersonas(intent).filter((item) => item.probability > 0.15).map((item) => item.persona),
    },
  };
}

function tagWeights(weights) {
  return Object.freeze({ ...weights });
}

function buildIntent(probabilities, pastDismissedTags = {}) {
  const result = {};
  for (let i = 0; i < PERSONAS.length; i += 1) result[PERSONAS[i]] = probabilities[i];
  result.effectiveTagVector = effectiveTagVector(probabilities);
  result.entropy = entropy(probabilities);
  result.topPersona = rankedPersonas(result)[0].persona;
  result.ambiguous = result.entropy > AMBIGUOUS_ENTROPY;
  result.pastDismissedTags = normalizeCountMap(pastDismissedTags);
  return result;
}

function effectiveTagVector(probabilities) {
  const vector = {};
  for (const tag of ALL_TAGS) {
    let value = 0;
    for (let i = 0; i < PERSONAS.length; i += 1) value += probabilities[i] * (PERSONA_TAGS[PERSONAS[i]][tag] ?? 0);
    if (Math.abs(value) > 1e-12) vector[tag] = value;
  }
  return vector;
}

function probabilitiesFromPrior(intent) {
  const values = PERSONAS.map((persona) => Number(intent?.[persona]));
  return normalizeProbabilities(values.every((value) => Number.isFinite(value) && value >= 0) ? values : PERSONAS.map(() => 1));
}

function softmax(logScores) {
  const max = Math.max(...logScores);
  return normalizeProbabilities(logScores.map((score) => Math.exp(score - max)));
}

function normalizeProbabilities(values) {
  const clean = values.map((value) => Number.isFinite(value) && value > 0 ? value : 0);
  const total = clean.reduce((sum, value) => sum + value, 0);
  return total > 0 ? clean.map((value) => value / total) : PERSONAS.map(() => 1 / PERSONAS.length);
}

function multiplyPersona(probabilities, persona, factor) {
  const next = probabilities.slice();
  next[PERSONAS.indexOf(persona)] *= factor;
  return normalizeProbabilities(next);
}

function floorPersona(probabilities, persona, floor) {
  const index = PERSONAS.indexOf(persona);
  if (probabilities[index] >= floor) return probabilities;
  const remaining = 1 - probabilities[index];
  const scale = remaining > 0 ? (1 - floor) / remaining : 0;
  return probabilities.map((value, i) => i === index ? floor : value * scale);
}

function entropy(probabilities) {
  return probabilities.reduce((sum, value) => value > 0 ? sum - value * Math.log(value) : sum, 0);
}

function rankedPersonas(intent) {
  return PERSONAS.map((persona) => ({ persona, probability: Number(intent?.[persona]) || 0 }))
    .sort((a, b) => b.probability - a.probability || PERSONAS.indexOf(a.persona) - PERSONAS.indexOf(b.persona));
}

function dot(weights, tags) {
  let sum = 0;
  for (const tag of tags) sum += weights[tag] ?? 0;
  return sum;
}

function tagsFromTarget(target = {}) {
  return tagsFromEntity(target);
}

function tagsFromEntity(entity = {}) {
  const kind = normalizeTag(entity.kind);
  const tags = new Set(normalizeTagSet([...(entity.themes ?? []), ...(entity.categories ?? []), kind]));
  if (kind === "pass") {
    tags.add("alpine-pass");
    tags.add("hairpin");
    tags.add("viewpoint-panorama");
  }
  if (kind === "poi") tags.add("poi");
  if (Array.isArray(entity.viewpoints) && entity.viewpoints.length > 0) {
    tags.add("viewpoint");
    tags.add("viewpoints");
  }
  if (kind === "pass" && tags.has("drivers-road")) tags.add("hairpin");
  return [...new Set([...tags].flatMap(expandTag))];
}

function normalizeTagSet(values) {
  return [...new Set((values ?? []).map(normalizeTag).filter(Boolean).flatMap(expandTag))];
}

function normalizeTag(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function expandTag(tag) {
  const expanded = [tag];
  if (tag === "viewpoints") expanded.push("viewpoint");
  if (tag === "viewpoint") expanded.push("viewpoints");
  if (tag === "viewpoint-panorama") expanded.push("viewpoint", "viewpoints", "panoramic-view");
  if (tag === "museum-cultural") expanded.push("museum");
  if (tag === "castle-fortress") expanded.push("castle");
  if (tag === "national-park") expanded.push("nature-reserve");
  if (tag === "monastery-church") expanded.push("monastery", "historic", "architecture");
  if (tag === "mountain-summit") expanded.push("viewpoint", "panoramic-view");
  return expanded;
}

function dismissedTagsFrom(intent, extra = null) {
  return normalizeCountMap({ ...(intent?.pastDismissedTags ?? {}), ...(extra ?? {}) });
}

function normalizeCountMap(map = {}) {
  const result = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    for (const tag of expandTag(normalizeTag(key))) {
      const count = Number(value);
      if (tag && Number.isFinite(count) && count > 0) result[tag] = (result[tag] ?? 0) + count;
    }
  }
  return result;
}

function graphPois(graph) {
  if (!graph) return [];
  if (graph.nodesByKind?.get) return graph.nodesByKind.get("poi") ?? [];
  const nodes = graph.nodes instanceof Map ? [...graph.nodes.values()] : graph.nodeById instanceof Map ? [...graph.nodeById.values()] : graph.nodeList ?? graph.rawNodes ?? graph.data?.nodes ?? [];
  return nodes.filter((node) => node?.kind === "poi");
}

function normalizeCandidate(item) {
  const source = item?.poi ?? item?.node ?? item;
  if (!source || typeof source !== "object") return null;
  const poiId = item.poiId ?? source.poiId ?? source.id ?? item.id;
  if (!poiId) return null;
  return {
    poiId: String(poiId),
    id: String(poiId),
    kind: source.kind ?? item.kind ?? "poi",
    name: source.name ?? item.name ?? String(poiId),
    score: Number(source.score ?? item.score ?? 0),
    themes: Array.isArray(source.themes) ? source.themes.slice() : Array.isArray(item.themes) ? item.themes.slice() : [],
    categories: Array.isArray(source.categories) ? source.categories.slice() : Array.isArray(item.categories) ? item.categories.slice() : [],
    viewpoints: source.viewpoints ?? item.viewpoints,
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.poiId)) return false;
    seen.add(candidate.poiId);
    return true;
  });
}

function selectPrimary(scored, count) {
  if (count <= 0 || scored.length === 0) return [];
  const selected = [scored[0]];
  const used = new Set([scored[0].poiId]);
  while (selected.length < count && used.size < scored.length) {
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of scored) {
      if (used.has(candidate.poiId)) continue;
      const mmr = 0.7 * candidate.finalScore - 0.3 * maxSimilarity(candidate, selected);
      if (mmr > bestScore || (mmr === bestScore && (!best || candidate.rank < best.rank))) {
        best = candidate;
        bestScore = mmr;
      }
    }
    if (!best) break;
    used.add(best.poiId);
    selected.push(best);
  }
  return selected;
}

function maxSimilarity(candidate, selected) {
  let max = 0;
  for (const item of selected) max = Math.max(max, jaccard(candidate.categoryTagSet, item.categoryTagSet));
  return max;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function surfaceItem(candidate, intent, offIntent) {
  return {
    poiId: candidate.poiId,
    name: candidate.name,
    score: candidate.score,
    themes: candidate.themes,
    categories: candidate.categories,
    intentMatch: candidate.intentMatch,
    value: candidate.value,
    finalScore: candidate.finalScore,
    reason: offIntent ? unexpectedReason(candidate) : matchReason(candidate, intent),
    ...(offIntent ? { offIntent: true } : {}),
  };
}

function matchReason(candidate, intent) {
  const matches = candidate.tags
    .filter((tag) => !GENERIC_REASON_TAGS.has(tag) && (intent.effectiveTagVector?.[tag] ?? 0) > 0)
    .sort((a, b) => (intent.effectiveTagVector[b] ?? 0) - (intent.effectiveTagVector[a] ?? 0) || a.localeCompare(b))
    .slice(0, 3);
  return `${intent.topPersona} match: ${matches.join(", ") || "balanced"}, ★${formatScore(candidate.score)} ${reasonKind(candidate)}`;
}

function unexpectedReason(candidate) {
  return `✨ Unexpected: ★${formatScore(candidate.score)} ${reasonKind(candidate)} (off-intent)`;
}

function reasonKind(candidate) {
  const tags = normalizeTagSet(candidate.categories).concat(normalizeTagSet(candidate.themes));
  const tag = tags.find((item) => !GENERIC_REASON_TAGS.has(item)) ?? "poi";
  if (tag === "castle-fortress") return "castle";
  if (tag === "museum-cultural") return "museum";
  return tag;
}

function formatScore(score) {
  return Number.isInteger(score) ? String(score) : Number(score || 0).toFixed(1);
}

function compareBaseScore(a, b) {
  if (!b) return -1;
  return b.finalScore - a.finalScore
    || b.intentMatch - a.intentMatch
    || b.value - a.value
    || stringOrder(a.name, b.name)
    || stringOrder(a.poiId, b.poiId)
    || a.index - b.index;
}

function compareSerendipity(a, b) {
  return a.intentMatch - b.intentMatch
    || b.value - a.value
    || b.finalScore - a.finalScore
    || stringOrder(a.name, b.name)
    || stringOrder(a.poiId, b.poiId);
}

function stringOrder(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function flatMapArray(values, mapper) {
  return Array.isArray(values) ? values.flatMap(mapper) : [];
}

function clamp01(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
