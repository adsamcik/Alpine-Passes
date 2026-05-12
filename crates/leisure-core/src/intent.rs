//! POI intent tagging and surfacing ported from `assets/js/leisure/intent.js`.
//!
//! The module exposes deterministic tag extraction, intent distribution updates,
//! and POI surfacing. `tags_from_target` is intentionally a thin adapter over
//! `tags_from_entity` so feedback targets and graph entities share one tagging
//! implementation.

use crate::graph::LeisureGraph;
use crate::optimizer::PublicTour;
use crate::types::NodeKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

pub type Tag = String;

const PERSONAS: [&str; 8] = [
    "Photographer",
    "ThrillRider",
    "Family",
    "Gourmet",
    "CultureSeeker",
    "NatureHiker",
    "Speedrunner",
    "SlowTourer",
];
const EVIDENCE_SCALE: f64 = 0.55;
const AMBIGUOUS_ENTROPY: f64 = 1.5;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentEntity {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, rename = "poiId")]
    pub poi_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub viewpoints: Vec<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentTarget {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, rename = "poiId")]
    pub poi_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub viewpoints: Vec<Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IntentState {
    pub pinned_stops: Vec<IntentEntity>,
    pub theme_chips: Vec<String>,
    pub history: IntentHistory,
    pub budget_tier: Option<String>,
    pub weather: Option<String>,
    pub group_size: Option<usize>,
    pub with_child: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IntentHistory {
    pub past_intent: Option<IntentDistribution>,
    pub past_dismissed_tags: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentDistribution {
    #[serde(flatten)]
    pub personas: BTreeMap<String, f64>,
    pub effective_tag_vector: BTreeMap<String, f64>,
    pub entropy: f64,
    pub top_persona: String,
    pub ambiguous: bool,
    pub past_dismissed_tags: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SurfaceIntentOptions {
    pub top_k: usize,
    pub serendipity_fraction: f64,
    pub corridor_pois: Vec<IntentCandidate>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentCandidate {
    pub poi_id: String,
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_poi_kind")]
    pub kind: String,
    pub name: String,
    pub score: f64,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub viewpoints: Vec<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceIntentResult {
    pub primary: Vec<SurfaceIntentItem>,
    pub serendipity: Vec<SurfaceIntentItem>,
    pub diagnostics: SurfaceIntentDiagnostics,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceIntentDiagnostics {
    pub top_persona: String,
    pub entropy: f64,
    pub top_personas: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceIntentItem {
    pub poi_id: String,
    pub name: String,
    pub score: f64,
    pub themes: Vec<String>,
    pub categories: Vec<String>,
    pub intent_match: f64,
    pub value: f64,
    pub final_score: f64,
    pub reason: String,
    #[serde(skip_serializing_if = "is_false")]
    pub off_intent: bool,
}

#[derive(Clone, Debug)]
struct ScoredCandidate {
    candidate: IntentCandidate,
    index: usize,
    tags: Vec<Tag>,
    category_tag_set: BTreeSet<Tag>,
    intent_match: f64,
    value: f64,
    final_score: f64,
    rank: usize,
}

/// Extracts deterministic intent tags from an entity.
pub fn tags_from_entity(entity: &IntentEntity) -> Vec<Tag> {
    let kind = normalize_tag(entity.kind.as_deref().unwrap_or_default());
    let mut tags = BTreeSet::new();
    for tag in normalize_tag_set(
        entity
            .themes
            .iter()
            .chain(entity.categories.iter())
            .map(String::as_str),
    ) {
        tags.insert(tag);
    }
    if !kind.is_empty() {
        tags.insert(kind.clone());
    }
    if kind == "pass" {
        tags.insert("alpine-pass".to_owned());
        tags.insert("hairpin".to_owned());
        tags.insert("viewpoint-panorama".to_owned());
    }
    if kind == "poi" {
        tags.insert("poi".to_owned());
    }
    if !entity.viewpoints.is_empty() {
        tags.insert("viewpoint".to_owned());
        tags.insert("viewpoints".to_owned());
    }
    if kind == "pass" && tags.contains("drivers-road") {
        tags.insert("hairpin".to_owned());
    }
    expand_and_sort(tags)
}

/// Extracts tags from a feedback target by adapting it to an entity.
pub fn tags_from_target(target: &IntentTarget) -> Vec<Tag> {
    tags_from_entity(&IntentEntity::from(target))
}

/// Infers a persona distribution from pins, theme chips, and context.
pub fn infer_intent(state: IntentState) -> IntentDistribution {
    let mut tags = Vec::new();
    for entity in &state.pinned_stops {
        tags.extend(tags_from_entity(entity));
    }
    for chip in &state.theme_chips {
        tags.extend(normalize_tag_set([chip.as_str()]));
    }
    let history = state.history;
    let mut probabilities = probabilities_from_prior(history.past_intent.as_ref());
    let weights = persona_tags();
    let log_scores = PERSONAS
        .iter()
        .enumerate()
        .map(|(index, persona)| {
            let mut score = probabilities[index].max(1e-12).ln();
            for tag in &tags {
                score += EVIDENCE_SCALE
                    * weights
                        .get(*persona)
                        .and_then(|map| map.get(tag))
                        .copied()
                        .unwrap_or(0.0);
            }
            score
        })
        .collect::<Vec<_>>();
    probabilities = softmax(&log_scores);

    if state.budget_tier.as_deref() == Some("shoestring") {
        probabilities = multiply_persona(probabilities, "Gourmet", 0.5);
    }
    if state.weather.as_deref() == Some("rainy") {
        probabilities = multiply_persona(probabilities, "NatureHiker", 0.6);
        probabilities = multiply_persona(probabilities, "CultureSeeker", 1.3);
    }
    if state.group_size.unwrap_or(0) >= 4 {
        probabilities = floor_persona(probabilities, "Family", 0.2);
    }
    if state.with_child == Some(true) {
        probabilities = floor_persona(probabilities, "Family", 0.3);
    }

    build_intent(
        probabilities,
        dismissed_tags_from(
            history.past_intent.as_ref(),
            Some(&history.past_dismissed_tags),
        ),
    )
}

/// Surfaces primary and serendipitous POIs for an intent distribution.
pub fn surface_intent_pois(
    graph: &LeisureGraph,
    _tour: Option<&PublicTour>,
    intent_distribution: Option<&IntentDistribution>,
    options: SurfaceIntentOptions,
) -> SurfaceIntentResult {
    let fallback;
    let intent = match intent_distribution {
        Some(intent) => intent,
        None => {
            fallback = infer_intent(IntentState::default());
            &fallback
        }
    };
    let top_k = options.top_k;
    let serendipity_count =
        ((top_k as f64) * clamp01(options.serendipity_fraction)).round() as usize;
    let serendipity_count = serendipity_count.min(top_k);
    let primary_count = top_k.saturating_sub(serendipity_count);
    let dismissed = dismissed_tags_from(Some(intent), None);
    let candidates = if options.corridor_pois.is_empty() {
        graph_pois(graph)
    } else {
        options.corridor_pois
    };
    let mut scored = dedupe_candidates(candidates)
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| {
            let entity = IntentEntity::from(&candidate);
            let tags = tags_from_entity(&entity);
            let intent_match = dot(&intent.effective_tag_vector, &tags);
            let negative_match = tags
                .iter()
                .map(|tag| dismissed.get(tag).copied().unwrap_or(0) as f64)
                .sum::<f64>();
            let value = clamp01(candidate.score / 10.0);
            let category_tag_set =
                normalize_tag_set(candidate.categories.iter().map(String::as_str))
                    .into_iter()
                    .collect::<BTreeSet<_>>();
            let final_score = intent_match * value - 0.2 * negative_match;
            ScoredCandidate {
                candidate,
                index,
                tags,
                category_tag_set,
                intent_match,
                value,
                final_score,
                rank: 0,
            }
        })
        .collect::<Vec<_>>();
    scored.sort_by(compare_base_score);
    for (rank, candidate) in scored.iter_mut().enumerate() {
        candidate.rank = rank;
    }
    let primary = select_primary(&scored, primary_count)
        .iter()
        .map(|candidate| surface_item(candidate, intent, false))
        .collect::<Vec<_>>();
    let primary_ids = primary
        .iter()
        .map(|item| item.poi_id.clone())
        .collect::<BTreeSet<_>>();
    let mut serendipity_pool = scored
        .into_iter()
        .filter(|candidate| !primary_ids.contains(&candidate.candidate.poi_id))
        .collect::<Vec<_>>();
    serendipity_pool.sort_by(compare_serendipity);
    let serendipity = serendipity_pool
        .iter()
        .take(serendipity_count)
        .map(|candidate| surface_item(candidate, intent, true))
        .collect();
    SurfaceIntentResult {
        primary,
        serendipity,
        diagnostics: SurfaceIntentDiagnostics {
            top_persona: intent.top_persona.clone(),
            entropy: intent.entropy,
            top_personas: ranked_personas(intent)
                .into_iter()
                .filter(|(_, probability)| *probability > 0.15)
                .map(|(persona, _)| persona)
                .collect(),
        },
    }
}

impl From<&IntentTarget> for IntentEntity {
    fn from(target: &IntentTarget) -> Self {
        Self {
            id: target.id.clone(),
            poi_id: target.poi_id.clone(),
            kind: target.kind.clone(),
            name: target.name.clone(),
            score: target.score,
            themes: target.themes.clone(),
            categories: target.categories.clone(),
            viewpoints: target.viewpoints.clone(),
        }
    }
}

impl From<&IntentCandidate> for IntentEntity {
    fn from(candidate: &IntentCandidate) -> Self {
        Self {
            id: Some(if candidate.id.is_empty() {
                candidate.poi_id.clone()
            } else {
                candidate.id.clone()
            }),
            poi_id: Some(candidate.poi_id.clone()),
            kind: Some(candidate.kind.clone()),
            name: Some(candidate.name.clone()),
            score: Some(candidate.score),
            themes: candidate.themes.clone(),
            categories: candidate.categories.clone(),
            viewpoints: candidate.viewpoints.clone(),
        }
    }
}

fn build_intent(
    probabilities: Vec<f64>,
    past_dismissed_tags: BTreeMap<String, usize>,
) -> IntentDistribution {
    let mut personas = BTreeMap::new();
    for (index, persona) in PERSONAS.iter().enumerate() {
        personas.insert(
            (*persona).to_owned(),
            probabilities.get(index).copied().unwrap_or(0.0),
        );
    }
    let effective_tag_vector = effective_tag_vector(&probabilities);
    let entropy = entropy(&probabilities);
    let mut result = IntentDistribution {
        personas,
        effective_tag_vector,
        entropy,
        top_persona: String::new(),
        ambiguous: entropy > AMBIGUOUS_ENTROPY,
        past_dismissed_tags: normalize_count_map(&past_dismissed_tags),
    };
    result.top_persona = ranked_personas(&result)
        .first()
        .map(|item| item.0.clone())
        .unwrap_or_else(|| "Photographer".to_owned());
    result
}

fn effective_tag_vector(probabilities: &[f64]) -> BTreeMap<String, f64> {
    let weights = persona_tags();
    let mut all_tags = BTreeSet::new();
    for map in weights.values() {
        all_tags.extend(map.keys().cloned());
    }
    let mut vector = BTreeMap::new();
    for tag in all_tags {
        let mut value = 0.0;
        for (index, persona) in PERSONAS.iter().enumerate() {
            value += probabilities.get(index).copied().unwrap_or(0.0)
                * weights
                    .get(*persona)
                    .and_then(|map| map.get(&tag))
                    .copied()
                    .unwrap_or(0.0);
        }
        if value.abs() > 1e-12 {
            vector.insert(tag, value);
        }
    }
    vector
}

fn probabilities_from_prior(intent: Option<&IntentDistribution>) -> Vec<f64> {
    let values = PERSONAS
        .iter()
        .map(|persona| {
            intent
                .and_then(|i| i.personas.get(*persona))
                .copied()
                .unwrap_or(f64::NAN)
        })
        .collect::<Vec<_>>();
    if values
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
    {
        normalize_probabilities(values)
    } else {
        normalize_probabilities(vec![1.0; PERSONAS.len()])
    }
}

fn softmax(log_scores: &[f64]) -> Vec<f64> {
    let max = log_scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    normalize_probabilities(log_scores.iter().map(|score| (score - max).exp()).collect())
}

fn normalize_probabilities(values: Vec<f64>) -> Vec<f64> {
    let clean = values
        .into_iter()
        .map(|value| {
            if value.is_finite() && value > 0.0 {
                value
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let total = clean.iter().sum::<f64>();
    if total > 0.0 {
        clean.into_iter().map(|value| value / total).collect()
    } else {
        vec![1.0 / PERSONAS.len() as f64; PERSONAS.len()]
    }
}

fn multiply_persona(mut probabilities: Vec<f64>, persona: &str, factor: f64) -> Vec<f64> {
    if let Some(index) = PERSONAS.iter().position(|item| *item == persona) {
        probabilities[index] *= factor;
    }
    normalize_probabilities(probabilities)
}

fn floor_persona(probabilities: Vec<f64>, persona: &str, floor: f64) -> Vec<f64> {
    let Some(index) = PERSONAS.iter().position(|item| *item == persona) else {
        return probabilities;
    };
    if probabilities.get(index).copied().unwrap_or(0.0) >= floor {
        return probabilities;
    }
    let current = probabilities[index];
    let remaining = 1.0 - current;
    let scale = if remaining > 0.0 {
        (1.0 - floor) / remaining
    } else {
        0.0
    };
    probabilities
        .into_iter()
        .enumerate()
        .map(|(i, value)| if i == index { floor } else { value * scale })
        .collect()
}

fn entropy(probabilities: &[f64]) -> f64 {
    probabilities
        .iter()
        .filter(|value| **value > 0.0)
        .map(|value| -value * value.ln())
        .sum()
}

fn ranked_personas(intent: &IntentDistribution) -> Vec<(String, f64)> {
    let mut ranked = PERSONAS
        .iter()
        .map(|persona| {
            (
                (*persona).to_owned(),
                intent.personas.get(*persona).copied().unwrap_or(0.0),
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.1.total_cmp(&a.1).then_with(|| {
            PERSONAS
                .iter()
                .position(|item| *item == a.0)
                .cmp(&PERSONAS.iter().position(|item| *item == b.0))
        })
    });
    ranked
}

fn dot(weights: &BTreeMap<String, f64>, tags: &[Tag]) -> f64 {
    tags.iter()
        .map(|tag| weights.get(tag).copied().unwrap_or(0.0))
        .sum()
}

fn normalize_tag_set<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<Tag> {
    let tags = values
        .into_iter()
        .map(normalize_tag)
        .filter(|tag| !tag.is_empty())
        .collect::<BTreeSet<_>>();
    expand_and_sort(tags)
}

fn normalize_tag(value: &str) -> Tag {
    value.trim().to_lowercase().replace(['_', ' '], "-")
}

fn expand_and_sort(tags: BTreeSet<Tag>) -> Vec<Tag> {
    tags.into_iter()
        .flat_map(|tag| expand_tag(&tag))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn expand_tag(tag: &str) -> Vec<Tag> {
    let mut expanded = vec![tag.to_owned()];
    match tag {
        "viewpoints" => expanded.push("viewpoint".to_owned()),
        "viewpoint" => expanded.push("viewpoints".to_owned()),
        "viewpoint-panorama" => {
            expanded.extend(
                ["viewpoint", "viewpoints", "panoramic-view"]
                    .into_iter()
                    .map(str::to_owned),
            );
        }
        "museum-cultural" => expanded.push("museum".to_owned()),
        "castle-fortress" => expanded.push("castle".to_owned()),
        "national-park" => expanded.push("nature-reserve".to_owned()),
        "monastery-church" => {
            expanded.extend(
                ["monastery", "historic", "architecture"]
                    .into_iter()
                    .map(str::to_owned),
            );
        }
        "mountain-summit" => {
            expanded.extend(
                ["viewpoint", "panoramic-view"]
                    .into_iter()
                    .map(str::to_owned),
            );
        }
        _ => {}
    }
    expanded
}

fn dismissed_tags_from(
    intent: Option<&IntentDistribution>,
    extra: Option<&BTreeMap<String, usize>>,
) -> BTreeMap<String, usize> {
    let mut map = intent
        .map(|intent| intent.past_dismissed_tags.clone())
        .unwrap_or_default();
    if let Some(extra) = extra {
        for (key, value) in extra {
            *map.entry(key.clone()).or_default() += *value;
        }
    }
    normalize_count_map(&map)
}

fn normalize_count_map(map: &BTreeMap<String, usize>) -> BTreeMap<String, usize> {
    let mut result = BTreeMap::new();
    for (key, value) in map {
        if *value == 0 {
            continue;
        }
        for tag in expand_tag(&normalize_tag(key)) {
            if !tag.is_empty() {
                *result.entry(tag).or_default() += *value;
            }
        }
    }
    result
}

fn graph_pois(graph: &LeisureGraph) -> Vec<IntentCandidate> {
    let mut ids = graph.nodes_of_kind(NodeKind::Poi).to_vec();
    ids.sort();
    ids.into_iter()
        .filter_map(|id| graph.node(&id))
        .map(|node| IntentCandidate {
            poi_id: node.id.to_string(),
            id: node.id.to_string(),
            kind: "poi".to_owned(),
            name: node.name.clone(),
            score: node.score.or(node.scenic_score).unwrap_or(0.0),
            themes: node.themes.clone(),
            categories: node.categories.clone(),
            viewpoints: node
                .viewpoints
                .iter()
                .map(|point| serde_json::json!({ "lat": point.lat, "lon": point.lon }))
                .collect(),
        })
        .collect()
}

fn dedupe_candidates(candidates: Vec<IntentCandidate>) -> Vec<IntentCandidate> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for mut candidate in candidates {
        if candidate.poi_id.is_empty() {
            candidate.poi_id = candidate.id.clone();
        }
        if candidate.id.is_empty() {
            candidate.id = candidate.poi_id.clone();
        }
        if candidate.kind.is_empty() {
            candidate.kind = "poi".to_owned();
        }
        if seen.insert(candidate.poi_id.clone()) {
            out.push(candidate);
        }
    }
    out
}

fn select_primary(scored: &[ScoredCandidate], count: usize) -> Vec<ScoredCandidate> {
    if count == 0 || scored.is_empty() {
        return Vec::new();
    }
    let mut selected = vec![scored[0].clone()];
    let mut used = BTreeSet::from([scored[0].candidate.poi_id.clone()]);
    while selected.len() < count && used.len() < scored.len() {
        let mut best: Option<ScoredCandidate> = None;
        let mut best_score = f64::NEG_INFINITY;
        for candidate in scored {
            if used.contains(&candidate.candidate.poi_id) {
                continue;
            }
            let mmr = 0.7 * candidate.final_score - 0.3 * max_similarity(candidate, &selected);
            let replace = mmr > best_score
                || ((mmr - best_score).abs() <= 1e-12
                    && best
                        .as_ref()
                        .map_or(true, |best| candidate.rank < best.rank));
            if replace {
                best = Some(candidate.clone());
                best_score = mmr;
            }
        }
        let Some(best) = best else {
            break;
        };
        used.insert(best.candidate.poi_id.clone());
        selected.push(best);
    }
    selected
}

fn max_similarity(candidate: &ScoredCandidate, selected: &[ScoredCandidate]) -> f64 {
    selected
        .iter()
        .map(|item| jaccard(&candidate.category_tag_set, &item.category_tag_set))
        .fold(0.0, f64::max)
}

fn jaccard(a: &BTreeSet<Tag>, b: &BTreeSet<Tag>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let overlap = a.intersection(b).count();
    overlap as f64 / (a.len() + b.len() - overlap) as f64
}

fn surface_item(
    candidate: &ScoredCandidate,
    intent: &IntentDistribution,
    off_intent: bool,
) -> SurfaceIntentItem {
    SurfaceIntentItem {
        poi_id: candidate.candidate.poi_id.clone(),
        name: candidate.candidate.name.clone(),
        score: candidate.candidate.score,
        themes: candidate.candidate.themes.clone(),
        categories: candidate.candidate.categories.clone(),
        intent_match: candidate.intent_match,
        value: candidate.value,
        final_score: candidate.final_score,
        reason: if off_intent {
            unexpected_reason(candidate)
        } else {
            match_reason(candidate, intent)
        },
        off_intent,
    }
}

fn match_reason(candidate: &ScoredCandidate, intent: &IntentDistribution) -> String {
    let generic = BTreeSet::from(["poi", "pass", "viewpoints"]);
    let mut matches = candidate
        .tags
        .iter()
        .filter(|tag| {
            !generic.contains(tag.as_str())
                && intent
                    .effective_tag_vector
                    .get(*tag)
                    .copied()
                    .unwrap_or(0.0)
                    > 0.0
        })
        .cloned()
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        intent
            .effective_tag_vector
            .get(b)
            .copied()
            .unwrap_or(0.0)
            .total_cmp(&intent.effective_tag_vector.get(a).copied().unwrap_or(0.0))
            .then_with(|| a.cmp(b))
    });
    matches.truncate(3);
    format!(
        "{} match: {}, ★{} {}",
        intent.top_persona,
        if matches.is_empty() {
            "balanced".to_owned()
        } else {
            matches.join(", ")
        },
        format_score(candidate.candidate.score),
        reason_kind(candidate)
    )
}

fn unexpected_reason(candidate: &ScoredCandidate) -> String {
    format!(
        "✨ Unexpected: ★{} {} (off-intent)",
        format_score(candidate.candidate.score),
        reason_kind(candidate)
    )
}

fn reason_kind(candidate: &ScoredCandidate) -> String {
    let generic = BTreeSet::from(["poi", "pass", "viewpoints"]);
    let tags = normalize_tag_set(
        candidate
            .candidate
            .categories
            .iter()
            .chain(candidate.candidate.themes.iter())
            .map(String::as_str),
    );
    let tag = tags
        .into_iter()
        .find(|tag| !generic.contains(tag.as_str()))
        .unwrap_or_else(|| "poi".to_owned());
    match tag.as_str() {
        "castle-fortress" => "castle".to_owned(),
        "museum-cultural" => "museum".to_owned(),
        _ => tag,
    }
}

fn format_score(score: f64) -> String {
    if (score.round() - score).abs() <= 1e-12 {
        format!("{}", score.round() as i64)
    } else {
        format!("{score:.1}")
    }
}

fn compare_base_score(a: &ScoredCandidate, b: &ScoredCandidate) -> Ordering {
    b.final_score
        .total_cmp(&a.final_score)
        .then_with(|| b.intent_match.total_cmp(&a.intent_match))
        .then_with(|| b.value.total_cmp(&a.value))
        .then_with(|| a.candidate.name.cmp(&b.candidate.name))
        .then_with(|| a.candidate.poi_id.cmp(&b.candidate.poi_id))
        .then_with(|| a.index.cmp(&b.index))
}

fn compare_serendipity(a: &ScoredCandidate, b: &ScoredCandidate) -> Ordering {
    a.intent_match
        .total_cmp(&b.intent_match)
        .then_with(|| b.value.total_cmp(&a.value))
        .then_with(|| b.final_score.total_cmp(&a.final_score))
        .then_with(|| a.candidate.name.cmp(&b.candidate.name))
        .then_with(|| a.candidate.poi_id.cmp(&b.candidate.poi_id))
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_poi_kind() -> String {
    "poi".to_owned()
}

fn persona_tags() -> BTreeMap<&'static str, BTreeMap<String, f64>> {
    BTreeMap::from([
        (
            "Photographer",
            tag_weights(&[
                ("panoramic-view", 1.0),
                ("viewpoint", 0.95),
                ("viewpoints", 0.95),
                ("photogenic", 0.95),
                ("iconic", 0.65),
                ("glacier", 0.55),
                ("alpine-lake", 0.6),
                ("scenic-railway", 0.45),
                ("cable-car", 0.4),
                ("castle", 0.25),
                ("architecture", 0.35),
                ("high-alpine", 0.4),
                ("nature-reserve", 0.35),
                ("old-town", 0.25),
                ("special-experience", 0.35),
                ("drivers-road", -0.05),
                ("museum", 0.05),
                ("food-drink", 0.05),
                ("hike-required", 0.15),
            ]),
        ),
        (
            "ThrillRider",
            tag_weights(&[
                ("drivers-road", 1.0),
                ("hairpin", 1.0),
                ("alpine-pass", 0.95),
                ("pass", 0.55),
                ("high-alpine", 0.8),
                ("iconic", 0.45),
                ("panoramic-view", 0.3),
                ("viewpoint", 0.25),
                ("viewpoints", 0.25),
                ("glacier", 0.1),
                ("alpine-lake", 0.1),
                ("cable-car", 0.15),
                ("special-experience", 0.25),
                ("summer-only", 0.2),
                ("car-accessible", 0.35),
                ("food-drink", -0.15),
                ("museum", -0.45),
                ("old-town", -0.35),
                ("family-friendly", -0.35),
                ("slow-travel", -0.5),
            ]),
        ),
        (
            "Family",
            tag_weights(&[
                ("family-friendly", 1.0),
                ("playground", 0.95),
                ("car-accessible", 0.75),
                ("year-round", 0.6),
                ("alpine-lake", 0.45),
                ("cable-car", 0.55),
                ("village", 0.4),
                ("special-experience", 0.45),
                ("food-drink", 0.35),
                ("castle", 0.35),
                ("castle-fortress", 0.35),
                ("scenic-railway", 0.5),
                ("old-town", 0.3),
                ("museum", 0.25),
                ("museum-cultural", 0.25),
                ("viewpoint", 0.2),
                ("panoramic-view", 0.2),
                ("hike-required", -0.6),
                ("high-alpine", -0.25),
                ("drivers-road", -0.35),
            ]),
        ),
        (
            "Gourmet",
            tag_weights(&[
                ("food-drink", 1.0),
                ("village", 0.7),
                ("old-town", 0.65),
                ("slow-travel", 0.55),
                ("year-round", 0.35),
                ("car-accessible", 0.3),
                ("historic", 0.25),
                ("architecture", 0.2),
                ("iconic", 0.15),
                ("photogenic", 0.15),
                ("family-friendly", 0.15),
                ("special-experience", 0.25),
                ("alpine-hut", 0.45),
                ("alpine-lake", 0.1),
                ("castle", 0.1),
                ("museum", 0.1),
                ("panoramic-view", 0.1),
                ("drivers-road", -0.35),
                ("hike-required", -0.25),
                ("summer-only", -0.05),
            ]),
        ),
        (
            "CultureSeeker",
            tag_weights(&[
                ("museum", 1.0),
                ("museum-cultural", 1.0),
                ("historic", 0.9),
                ("architecture", 0.85),
                ("unesco", 0.85),
                ("castle", 0.75),
                ("castle-fortress", 0.75),
                ("old-town", 0.75),
                ("monastery", 0.65),
                ("monastery-church", 0.65),
                ("village", 0.35),
                ("year-round", 0.45),
                ("iconic", 0.4),
                ("photogenic", 0.25),
                ("scenic-railway", 0.25),
                ("food-drink", 0.2),
                ("car-accessible", 0.25),
                ("panoramic-view", 0.05),
                ("drivers-road", -0.45),
                ("hike-required", -0.35),
                ("high-alpine", -0.25),
            ]),
        ),
        (
            "NatureHiker",
            tag_weights(&[
                ("nature-reserve", 1.0),
                ("national-park", 0.95),
                ("hike-required", 0.9),
                ("glacier", 0.75),
                ("alpine-lake", 0.8),
                ("alpine-hut", 0.75),
                ("high-alpine", 0.65),
                ("panoramic-view", 0.55),
                ("viewpoint", 0.4),
                ("viewpoints", 0.4),
                ("photogenic", 0.35),
                ("summer-only", 0.25),
                ("hidden-gem", 0.45),
                ("cable-car", 0.15),
                ("car-accessible", -0.15),
                ("museum", -0.25),
                ("food-drink", -0.15),
                ("drivers-road", -0.2),
                ("old-town", -0.25),
                ("family-friendly", -0.05),
            ]),
        ),
        (
            "Speedrunner",
            tag_weights(&[
                ("car-accessible", 0.9),
                ("year-round", 0.75),
                ("drivers-road", 0.55),
                ("alpine-pass", 0.35),
                ("iconic", 0.35),
                ("pass", 0.25),
                ("viewpoint", 0.2),
                ("panoramic-view", 0.25),
                ("food-drink", -0.25),
                ("slow-travel", -0.9),
                ("hike-required", -0.85),
                ("museum", -0.45),
                ("old-town", -0.45),
                ("scenic-railway", -0.35),
                ("cable-car", -0.25),
                ("family-friendly", -0.15),
                ("summer-only", -0.2),
                ("special-experience", -0.15),
                ("village", -0.25),
                ("alpine-hut", -0.35),
            ]),
        ),
        (
            "SlowTourer",
            tag_weights(&[
                ("slow-travel", 1.0),
                ("village", 0.75),
                ("old-town", 0.75),
                ("scenic-railway", 0.75),
                ("alpine-lake", 0.55),
                ("food-drink", 0.5),
                ("family-friendly", 0.35),
                ("historic", 0.45),
                ("architecture", 0.35),
                ("panoramic-view", 0.35),
                ("viewpoint", 0.3),
                ("viewpoints", 0.3),
                ("year-round", 0.25),
                ("cable-car", 0.25),
                ("nature-reserve", 0.35),
                ("hidden-gem", 0.5),
                ("drivers-road", -0.65),
                ("hairpin", -0.55),
                ("high-alpine", -0.15),
                ("hike-required", -0.1),
            ]),
        ),
    ])
}

fn tag_weights(items: &[(&str, f64)]) -> BTreeMap<String, f64> {
    items
        .iter()
        .map(|(tag, weight)| ((*tag).to_owned(), *weight))
        .collect()
}
