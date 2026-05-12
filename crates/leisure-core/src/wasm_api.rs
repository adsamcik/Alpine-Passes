//! wasm-bindgen boundary for the leisure planner core.
//!
//! The exports intentionally accept JSON strings for complex inputs so the
//! JavaScript shim can preserve the legacy public API while keeping Rust-owned
//! graph and ear-decomposition state behind small numeric handles.

use crate::breaks::{detect_breaks, BreakOptions, BreakPoiInput};
use crate::corridor::{suggest_corridor, CorridorMode, CorridorOptions};
use crate::ears::{decompose_ears, Ear, EarDecomposition, EarKind};
use crate::graph::{edge_key, LeisureGraph};
use crate::intent::{
    infer_intent, surface_intent_pois, IntentDistribution, IntentEntity, IntentHistory,
    IntentState, SurfaceIntentOptions,
};
use crate::lunch::{find_lunch_area, LunchOptions, LunchPolicy};
use crate::optimizer::{
    leisure_plan_auto, leisure_plan_open, leisure_plan_selected, PlanOptions, PlanPoint, PublicTour,
};
use crate::types::{GraphData, GraphStats, NodeId};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use serde_wasm_bindgen::Serializer;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use wasm_bindgen::prelude::*;

fn to_js_value<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = Serializer::new().serialize_maps_as_objects(true);
    value
        .serialize(&serializer)
        .map_err(|error| JsValue::from_str(&format!("serialize: {error}")))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

const GRAPH_KIND_BIT: u32 = 0;
const EARS_KIND_BIT: u32 = 1 << 31;
const KIND_MASK: u32 = 1 << 31;
const INDEX_MASK: u32 = !KIND_MASK;

fn graph_handle(index: usize) -> u32 {
    debug_assert!(index < (1usize << 31));
    GRAPH_KIND_BIT | (index as u32)
}

fn ears_handle(index: usize) -> u32 {
    debug_assert!(index < (1usize << 31));
    EARS_KIND_BIT | (index as u32)
}

fn handle_kind(handle: u32) -> u32 {
    handle & KIND_MASK
}

fn handle_index(handle: u32) -> usize {
    (handle & INDEX_MASK) as usize
}

fn require_handle_kind(
    handle: u32,
    expected_kind: u32,
    expected_kind_name: &str,
) -> Result<(), String> {
    let kind = handle_kind(handle);
    if kind == expected_kind {
        Ok(())
    } else {
        Err(format!(
            "handle {handle} is not a {expected_kind_name} handle (got kind={kind})"
        ))
    }
}

// Storage for WASM-exported graph handles.
//
// The vector grows monotonically; freed slots are tombstoned (`None`) but
// not recycled. This is acceptable for the typical SPA pattern of loading
// one graph per page-load, but for long-lived sessions with many graph
// reloads, the spine memory will grow ~8 bytes per stale handle. Recycling
// or generation-counter handles can be added later if needed.
thread_local! {
    static GRAPHS: RefCell<Vec<Option<LeisureGraph>>> = const { RefCell::new(Vec::new()) };
}

// Storage for WASM-exported ear-decomposition handles.
//
// The vector grows monotonically; freed slots are tombstoned (`None`) but
// not recycled. This is acceptable for the typical SPA pattern of loading
// one graph per page-load, but for long-lived sessions with many graph
// reloads, the spine memory will grow ~8 bytes per stale handle. Recycling
// or generation-counter handles can be added later if needed.
thread_local! {
    static EARS: RefCell<Vec<Option<EarDecomposition>>> = const { RefCell::new(Vec::new()) };
}

#[wasm_bindgen]
pub fn wasm_load_graph(graph_data: JsValue) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        let data: GraphData = if let Some(json) = graph_data.as_string() {
            serde_json::from_str(&json)
                .map_err(|error| format!("failed to parse graph JSON: {error}"))?
        } else {
            parse_js(graph_data, "graph")?
        };
        let graph = LeisureGraph::from_data(data);
        let handle = push_graph(graph)?;
        Ok(handle)
    })
}

#[wasm_bindgen]
pub fn wasm_decompose_ears(graph_handle: u32) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph(graph_handle, |graph| {
            let decomposition = decompose_ears(graph);
            let handle = push_ears(decomposition.clone())?;
            Ok(to_wasm_ear_decomposition(handle, graph, &decomposition))
        })
    })
}

/// Release a previously-loaded graph handle. The slot is tombstoned and the
/// handle becomes invalid for subsequent calls. Returns `true` if the handle
/// was valid, `false` if it was already free / out of range, or an error if
/// the handle belongs to another handle kind.
#[wasm_bindgen]
pub fn wasm_free_graph(handle: u32) -> Result<JsValue, JsValue> {
    free_graph_handle(handle)
        .map(JsValue::from_bool)
        .map_err(|message| JsValue::from_str(&message))
}

/// Release a previously-computed ears handle. Same semantics as `wasm_free_graph`.
#[wasm_bindgen]
pub fn wasm_free_ears(handle: u32) -> Result<JsValue, JsValue> {
    free_ears_handle(handle)
        .map(JsValue::from_bool)
        .map_err(|message| JsValue::from_str(&message))
}

#[wasm_bindgen]
pub fn wasm_leisure_plan_auto(
    graph_handle: u32,
    ears_handle: u32,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph_and_ears(graph_handle, ears_handle, |graph, ears| {
            let options = parse_plan_options(graph, options_value)?;
            Ok(leisure_plan_auto(graph, ears, options))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_leisure_plan_selected(
    graph_handle: u32,
    ears_handle: u32,
    must_visit_value: JsValue,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph_and_ears(graph_handle, ears_handle, |graph, ears| {
            let must_visit_ids = parse_string_list(must_visit_value, "mustVisit")?;
            let options = parse_plan_options(graph, options_value)?;
            Ok(leisure_plan_selected(graph, ears, &must_visit_ids, options))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_leisure_plan_open(
    graph_handle: u32,
    ears_handle: u32,
    start_id: &str,
    end_id: &str,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph_and_ears(graph_handle, ears_handle, |graph, ears| {
            let options = parse_plan_options(graph, options_value)?;
            Ok(leisure_plan_open(
                graph,
                ears,
                PlanPoint::Node(NodeId::from(start_id)),
                PlanPoint::Node(NodeId::from(end_id)),
                options,
            ))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_suggest_corridor(
    graph_handle: u32,
    tour_value: JsValue,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph(graph_handle, |graph| {
            let tour: PublicTour = parse_js(tour_value, "tour")?;
            let options = parse_corridor_options(options_value)?;
            Ok(suggest_corridor(graph, &tour, options))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_find_lunch_area(
    graph_handle: u32,
    tour_value: JsValue,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph(graph_handle, |graph| {
            let tour: PublicTour = parse_js(tour_value, "tour")?;
            let options = parse_lunch_options(options_value)?;
            Ok(find_lunch_area(graph, &tour, options))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_suggest_breaks(
    graph_handle: u32,
    tour_value: JsValue,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        with_graph(graph_handle, |graph| {
            let tour: PublicTour = parse_js(tour_value, "tour")?;
            let options = parse_break_options(options_value)?;
            Ok(detect_breaks(graph, &tour, options))
        })
    })
}

#[wasm_bindgen]
pub fn wasm_infer_intent(
    entities_value: JsValue,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        let entities: Vec<IntentEntity> = parse_js(entities_value, "entities")?;
        let options = parse_value_or_default(options_value, "intent options")?;
        let state = parse_intent_state(entities, &options)?;
        Ok(infer_intent(state))
    })
}

#[wasm_bindgen]
pub fn wasm_surface_intent_pois(
    tour_value: JsValue,
    candidates_value: JsValue,
    intent_value: JsValue,
    options_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        let tour = parse_optional_js::<PublicTour>(tour_value, "tour")?;
        let candidates = parse_candidates(candidates_value)?;
        let intent = parse_optional_js::<IntentDistribution>(intent_value, "intent")?;
        let options_value = parse_value_or_default(options_value, "surface intent options")?;
        let options = parse_surface_intent_options(candidates, &options_value);
        // R4 passes explicit candidates only; R5 can add a graph-handle based API if surface scoring needs graph lookups.
        let empty_graph = empty_graph();
        Ok(surface_intent_pois(
            &empty_graph,
            tour.as_ref(),
            intent.as_ref(),
            options,
        ))
    })
}

fn wasm_boundary<T, F>(body: F) -> Result<JsValue, JsValue>
where
    T: Serialize,
    F: FnOnce() -> Result<T, String>,
{
    install_panic_hook();
    let value = body().map_err(|message| JsValue::from_str(&message))?;
    to_js_value(&value)
}

#[cfg(target_arch = "wasm32")]
fn install_panic_hook() {
    use std::sync::Once;

    static SET_HOOK: Once = Once::new();
    SET_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            console_error(&format!("leisure-core panic: {info}"));
        }));
    });
}

#[cfg(not(target_arch = "wasm32"))]
fn install_panic_hook() {}

fn push_graph(graph: LeisureGraph) -> Result<u32, String> {
    GRAPHS.with(|graphs| {
        let mut graphs = graphs.borrow_mut();
        if graphs.len() >= (1usize << 31) {
            return Err("too many graph handles".to_owned());
        }
        let handle = graph_handle(graphs.len());
        graphs.push(Some(graph));
        Ok(handle)
    })
}

fn push_ears(decomposition: EarDecomposition) -> Result<u32, String> {
    EARS.with(|ears| {
        let mut ears = ears.borrow_mut();
        if ears.len() >= (1usize << 31) {
            return Err("too many ear-decomposition handles".to_owned());
        }
        let handle = ears_handle(ears.len());
        ears.push(Some(decomposition));
        Ok(handle)
    })
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __wasm_handle_test_load_graph(data: GraphData) -> Result<u32, String> {
    push_graph(LeisureGraph::from_data(data))
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __wasm_handle_test_decompose_ears(graph_handle: u32) -> Result<u32, String> {
    with_graph(graph_handle, |graph| push_ears(decompose_ears(graph)))
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __wasm_handle_test_free_graph(graph_handle: u32) -> Result<bool, String> {
    free_graph_handle(graph_handle)
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __wasm_handle_test_free_ears(ears_handle: u32) -> Result<bool, String> {
    free_ears_handle(ears_handle)
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __wasm_handle_test_require_graph(graph_handle: u32) -> Result<(), String> {
    with_graph(graph_handle, |_| Ok(()))
}

#[doc(hidden)]
#[cfg(not(target_arch = "wasm32"))]
pub fn __wasm_handle_test_require_graph_and_ears(
    graph_handle: u32,
    ears_handle: u32,
) -> Result<(), String> {
    with_graph_and_ears(graph_handle, ears_handle, |_, _| Ok(()))
}

fn free_graph_handle(graph_handle: u32) -> Result<bool, String> {
    require_handle_kind(graph_handle, GRAPH_KIND_BIT, "graph")?;
    let index = handle_index(graph_handle);
    GRAPHS.with(|graphs| {
        let mut graphs = graphs.borrow_mut();
        Ok(graphs.get_mut(index).and_then(Option::take).is_some())
    })
}

fn free_ears_handle(ears_handle: u32) -> Result<bool, String> {
    require_handle_kind(ears_handle, EARS_KIND_BIT, "ears")?;
    let index = handle_index(ears_handle);
    EARS.with(|ears| {
        let mut ears = ears.borrow_mut();
        Ok(ears.get_mut(index).and_then(Option::take).is_some())
    })
}

fn with_graph<T, F>(graph_handle: u32, body: F) -> Result<T, String>
where
    F: FnOnce(&LeisureGraph) -> Result<T, String>,
{
    require_handle_kind(graph_handle, GRAPH_KIND_BIT, "graph")?;
    let index = handle_index(graph_handle);
    GRAPHS.with(|graphs| {
        let graphs = graphs.borrow();
        let graph = match graphs.get(index) {
            None => {
                return Err(format!(
                    "graph handle {graph_handle} out of range (max {})",
                    graphs.len().saturating_sub(1)
                ));
            }
            Some(None) => return Err(format!("graph handle {graph_handle} was freed")),
            Some(Some(graph)) => graph,
        };
        body(graph)
    })
}

fn with_graph_and_ears<T, F>(graph_handle: u32, ears_handle: u32, body: F) -> Result<T, String>
where
    F: FnOnce(&LeisureGraph, &EarDecomposition) -> Result<T, String>,
{
    require_handle_kind(graph_handle, GRAPH_KIND_BIT, "graph")?;
    require_handle_kind(ears_handle, EARS_KIND_BIT, "ears")?;
    let graph_index = handle_index(graph_handle);
    let ears_index = handle_index(ears_handle);
    GRAPHS.with(|graphs| {
        EARS.with(|ears| {
            let graphs = graphs.borrow();
            let ears = ears.borrow();
            let graph = match graphs.get(graph_index) {
                None => {
                    return Err(format!(
                        "graph handle {graph_handle} out of range (max {})",
                        graphs.len().saturating_sub(1)
                    ));
                }
                Some(None) => return Err(format!("graph handle {graph_handle} was freed")),
                Some(Some(graph)) => graph,
            };
            let ears = match ears.get(ears_index) {
                None => {
                    return Err(format!(
                        "ears handle {ears_handle} out of range (max {})",
                        ears.len().saturating_sub(1)
                    ));
                }
                Some(None) => return Err(format!("ears handle {ears_handle} was freed")),
                Some(Some(ears)) => ears,
            };
            body(graph, ears)
        })
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmEarDecomposition {
    handle: u32,
    ears: Vec<WasmEar>,
    pass_to_ears: BTreeMap<String, Vec<WasmEar>>,
    junction_to_ears: BTreeMap<String, Vec<WasmEar>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmEar {
    id: String,
    kind: String,
    passes: Vec<String>,
    edges: Vec<String>,
    attachment_nodes: Vec<String>,
    total_leisure_cost: f64,
    total_distance_km: f64,
}

fn to_wasm_ear_decomposition(
    handle: u32,
    graph: &LeisureGraph,
    decomposition: &EarDecomposition,
) -> WasmEarDecomposition {
    let ears = decomposition
        .ears
        .iter()
        .map(|ear| to_wasm_ear(graph, ear))
        .collect::<Vec<_>>();
    let pass_to_ears = decomposition
        .pass_to_ears
        .iter()
        .map(|(id, indices)| (id.clone(), ears_for_indices(&ears, indices)))
        .collect();
    let junction_to_ears = decomposition
        .junction_to_ears
        .iter()
        .map(|(id, indices)| (id.clone(), ears_for_indices(&ears, indices)))
        .collect();
    WasmEarDecomposition {
        handle,
        ears,
        pass_to_ears,
        junction_to_ears,
    }
}

fn ears_for_indices(ears: &[WasmEar], indices: &[usize]) -> Vec<WasmEar> {
    indices
        .iter()
        .filter_map(|index| ears.get(*index).cloned())
        .collect()
}

fn to_wasm_ear(graph: &LeisureGraph, ear: &Ear) -> WasmEar {
    WasmEar {
        id: ear.id.clone(),
        kind: match ear.kind {
            EarKind::Loop => "loop",
            EarKind::Path => "path",
            EarKind::Spur => "spur",
            EarKind::IsolatedPass => "isolated-pass",
        }
        .to_owned(),
        passes: ear.passes.clone(),
        edges: ear
            .edges
            .iter()
            .filter_map(|index| graph.edges.get(*index))
            .map(|edge| edge.canonical_id())
            .collect(),
        attachment_nodes: ear
            .attachment_nodes
            .iter()
            .map(ToString::to_string)
            .collect(),
        total_leisure_cost: round(ear.total_leisure_cost, 3),
        total_distance_km: round(ear.total_distance_km, 3),
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanOptionsInput {
    start: Option<PlanPointInput>,
    end_node: Option<PlanPointInput>,
    budget_seconds: Option<f64>,
    budget_km: Option<f64>,
    themes: Option<Value>,
    personas: Option<Value>,
    forbidden_pass_ids: Option<Value>,
    forbidden_edges: Option<Value>,
    forbidden_nodes: Option<Value>,
    seasonal_cutoff: Option<Value>,
    k_alternatives: Option<usize>,
    time_budget_ms: Option<f64>,
    seed: Option<Value>,
    iteration_cap: Option<usize>,
    max_cache_entries: Option<usize>,
    end_snap_max_distance_m: Option<f64>,
    max_no_improvement: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum PlanPointInput {
    Node(String),
    Coordinates {
        lat: f64,
        #[serde(default)]
        lon: Option<f64>,
        #[serde(default)]
        lng: Option<f64>,
        #[serde(default)]
        name: Option<String>,
    },
}

fn parse_plan_options(graph: &LeisureGraph, value: JsValue) -> Result<PlanOptions, String> {
    let input: PlanOptionsInput = parse_js_or_default(value, "plan options")?;
    let mut options = PlanOptions::default();
    if let Some(start) = input.start {
        options.start = start.into_plan_point()?;
    }
    options.end_node = input
        .end_node
        .map(PlanPointInput::into_plan_point)
        .transpose()?;
    options.budget_seconds = input.budget_seconds.filter(|value| value.is_finite());
    options.budget_km = input.budget_km.filter(|value| value.is_finite());
    options.themes = strings_from_optional_value(input.themes.as_ref());
    options.personas = strings_from_optional_value(input.personas.as_ref());
    options.forbidden_pass_ids = strings_from_optional_value(input.forbidden_pass_ids.as_ref());
    options.forbidden_edges =
        edge_indices_from_optional_value(graph, input.forbidden_edges.as_ref());
    options.forbidden_nodes = strings_from_optional_value(input.forbidden_nodes.as_ref())
        .into_iter()
        .map(NodeId::from)
        .collect();
    options.seasonal_cutoff = input.seasonal_cutoff.as_ref().and_then(string_from_value);
    if let Some(value) = input.k_alternatives {
        options.k_alternatives = value;
    }
    if let Some(value) = input.time_budget_ms.filter(|value| value.is_finite()) {
        options.time_budget_ms = value;
    }
    options.seed = input.seed.as_ref().and_then(seed_from_value);
    options.iteration_cap = input.iteration_cap;
    if let Some(value) = input.max_cache_entries {
        options.max_cache_entries = value;
    }
    options.end_snap_max_distance_m = input.end_snap_max_distance_m;
    if let Some(value) = input.max_no_improvement {
        options.max_no_improvement = value;
    }
    Ok(options)
}

impl PlanPointInput {
    fn into_plan_point(self) -> Result<PlanPoint, String> {
        match self {
            Self::Node(id) => Ok(PlanPoint::Node(NodeId::from(id))),
            Self::Coordinates {
                lat,
                lon,
                lng,
                name,
            } => {
                let lon = lon
                    .or(lng)
                    .ok_or_else(|| "coordinate point missing lon".to_owned())?;
                Ok(PlanPoint::Coordinates { lat, lon, name })
            }
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorridorOptionsInput {
    buffer_km: Option<f64>,
    auto_include_max_detour_min: Option<f64>,
    auto_include_min_score: Option<f64>,
    suggest_max_detour_min: Option<f64>,
    suggest_min_score: Option<f64>,
    themes: Option<Value>,
    personas: Option<Value>,
    max_auto_include_per_hour: Option<usize>,
    max_suggestions_total: Option<usize>,
    exclude_ids: Option<Value>,
    detour_budget_min: Option<f64>,
    mode: Option<String>,
}

fn parse_corridor_options(value: JsValue) -> Result<CorridorOptions, String> {
    let input: CorridorOptionsInput = parse_js_or_default(value, "corridor options")?;
    let mut options = CorridorOptions::default();
    assign_finite(&mut options.buffer_km, input.buffer_km);
    assign_finite(
        &mut options.auto_include_max_detour_min,
        input.auto_include_max_detour_min,
    );
    assign_finite(
        &mut options.auto_include_min_score,
        input.auto_include_min_score,
    );
    assign_finite(
        &mut options.suggest_max_detour_min,
        input.suggest_max_detour_min,
    );
    assign_finite(&mut options.suggest_min_score, input.suggest_min_score);
    options.themes = strings_from_optional_value(input.themes.as_ref());
    options.personas = strings_from_optional_value(input.personas.as_ref());
    if let Some(value) = input.max_auto_include_per_hour {
        options.max_auto_include_per_hour = value;
    }
    if let Some(value) = input.max_suggestions_total {
        options.max_suggestions_total = value;
    }
    options.exclude_ids = strings_from_optional_value(input.exclude_ids.as_ref())
        .into_iter()
        .collect();
    options.detour_budget_min = input.detour_budget_min.filter(|value| value.is_finite());
    if input.mode.as_deref() == Some("hidden-gem") {
        options.mode = CorridorMode::HiddenGem;
    }
    Ok(options)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LunchOptionsInput {
    start_time: Option<String>,
    tz_offset_minutes: Option<i32>,
    persona: Option<String>,
    lunch_policy: Option<Value>,
    narrative_mode: Option<bool>,
    weather: Option<String>,
}

fn parse_lunch_options(value: JsValue) -> Result<LunchOptions, String> {
    let input: LunchOptionsInput = parse_js_or_default(value, "lunch options")?;
    let mut options = LunchOptions::default();
    if let Some(value) = input.start_time.filter(|value| !value.trim().is_empty()) {
        options.start_time = value;
    }
    if let Some(value) = input.tz_offset_minutes {
        options.tz_offset_minutes = value;
    }
    if let Some(value) = input.persona.filter(|value| !value.trim().is_empty()) {
        options.persona = value;
    }
    if let Some(policy) = input.lunch_policy.as_ref() {
        options.lunch_policy = parse_lunch_policy(policy);
    }
    if let Some(value) = input.narrative_mode {
        options.narrative_mode = value;
    }
    options.weather = input.weather;
    Ok(options)
}

fn parse_lunch_policy(value: &Value) -> LunchPolicy {
    if let Some(text) = value.as_str() {
        return match text {
            "skip" | "none" | "0" => LunchPolicy::Skip,
            "auto" => LunchPolicy::Auto,
            _ => text
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(LunchPolicy::WindowMinutes)
                .unwrap_or(LunchPolicy::Auto),
        };
    }
    number_from_value(value)
        .filter(|number| *number > 0.0)
        .map(LunchPolicy::WindowMinutes)
        .unwrap_or(LunchPolicy::Auto)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BreakOptionsInput {
    start_time: Option<String>,
    tz_offset_minutes: Option<i32>,
    persona: Option<String>,
    weather: Option<String>,
    tour_packed: Option<bool>,
    corridor_pois: Option<Vec<BreakPoiInput>>,
    max_breaks_total: Option<usize>,
    stop_dwell_sec: Option<BTreeMap<String, f64>>,
}

fn parse_break_options(value: JsValue) -> Result<BreakOptions, String> {
    let input: BreakOptionsInput = parse_js_or_default(value, "break options")?;
    let mut options = BreakOptions::default();
    if let Some(value) = input.start_time.filter(|value| !value.trim().is_empty()) {
        options.start_time = value;
    }
    if let Some(value) = input.tz_offset_minutes {
        options.tz_offset_minutes = value;
    }
    if let Some(value) = input.persona.filter(|value| !value.trim().is_empty()) {
        options.persona = value;
    }
    options.weather = input.weather;
    if let Some(value) = input.tour_packed {
        options.tour_packed = value;
    }
    if let Some(value) = input.corridor_pois {
        options.corridor_pois = value;
    }
    if let Some(value) = input.max_breaks_total {
        options.max_breaks_total = value;
    }
    if let Some(value) = input.stop_dwell_sec {
        options.stop_dwell_sec = value;
    }
    Ok(options)
}

fn parse_intent_state(entities: Vec<IntentEntity>, options: &Value) -> Result<IntentState, String> {
    let object = options.as_object();
    let theme_chips = object
        .and_then(|item| item.get("themeChips").or_else(|| item.get("themes")))
        .map(strings_from_value)
        .unwrap_or_default();
    let budget_tier = object
        .and_then(|item| item.get("budgetTier"))
        .and_then(string_from_value);
    let weather = object
        .and_then(|item| item.get("weather"))
        .and_then(string_from_value);
    let group_size = object
        .and_then(|item| item.get("groupSize"))
        .and_then(number_from_value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.trunc() as usize);
    let with_child = object
        .and_then(|item| item.get("withChild"))
        .and_then(Value::as_bool);
    let history = object
        .and_then(|item| item.get("history"))
        .map(parse_intent_history)
        .transpose()?
        .unwrap_or_default();
    Ok(IntentState {
        pinned_stops: entities,
        theme_chips,
        history,
        budget_tier,
        weather,
        group_size,
        with_child,
    })
}

fn parse_intent_history(value: &Value) -> Result<IntentHistory, String> {
    let Some(object) = value.as_object() else {
        return Ok(IntentHistory::default());
    };
    let past_intent = object
        .get("pastIntent")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("failed to parse history.pastIntent: {error}"))?;
    let past_dismissed_tags = object
        .get("pastDismissedTags")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("failed to parse history.pastDismissedTags: {error}"))?
        .unwrap_or_default();
    Ok(IntentHistory {
        past_intent,
        past_dismissed_tags,
    })
}

fn parse_candidates(value: JsValue) -> Result<Vec<crate::intent::IntentCandidate>, String> {
    parse_js_or_default(value, "intent candidates")
}

fn parse_surface_intent_options(
    candidates: Vec<crate::intent::IntentCandidate>,
    options: &Value,
) -> SurfaceIntentOptions {
    let mut out = SurfaceIntentOptions {
        top_k: 12,
        serendipity_fraction: 2.0 / 12.0,
        corridor_pois: candidates,
    };
    if let Some(object) = options.as_object() {
        if let Some(value) = object
            .get("topK")
            .and_then(number_from_value)
            .filter(|value| *value >= 0.0)
        {
            out.top_k = value.trunc() as usize;
        }
        if let Some(value) = object
            .get("serendipityFraction")
            .and_then(number_from_value)
            .filter(|value| value.is_finite())
        {
            out.serendipity_fraction = value;
        }
        if out.corridor_pois.is_empty() {
            if let Some(value) = object.get("corridorPois") {
                out.corridor_pois =
                    serde_json::from_value(value.clone()).unwrap_or_else(|_| Vec::new());
            }
        }
    }
    out
}

fn parse_string_list(value: JsValue, label: &str) -> Result<Vec<String>, String> {
    let value = parse_value_or_default(value, label)?;
    Ok(strings_from_value(&value))
}

fn parse_js<T>(value: JsValue, label: &str) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| format!("failed to parse {label}: {error}"))
}

fn parse_js_or_default<T>(value: JsValue, label: &str) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    if value.is_null() || value.is_undefined() {
        return Ok(T::default());
    }
    parse_js(value, label)
}

fn parse_optional_js<T>(value: JsValue, label: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
{
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    parse_js(value, label).map(Some)
}

fn parse_value_or_default(value: JsValue, label: &str) -> Result<Value, String> {
    if value.is_null() || value.is_undefined() {
        return Ok(Value::Null);
    }
    parse_js(value, label)
}

fn strings_from_optional_value(value: Option<&Value>) -> Vec<String> {
    value.map(strings_from_value).unwrap_or_default()
}

fn strings_from_value(value: &Value) -> Vec<String> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().filter_map(string_from_value).collect(),
        Value::String(text) => vec![text.clone()],
        Value::Number(_) | Value::Bool(_) => string_from_value(value).into_iter().collect(),
        Value::Object(object) => object
            .get("values")
            .or_else(|| object.get("items"))
            .map(strings_from_value)
            .unwrap_or_default(),
    }
}

fn string_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) => text.parse::<f64>().ok().filter(|value| value.is_finite()),
        _ => None,
    }
}

fn seed_from_value(value: &Value) -> Option<u64> {
    if value.is_null() {
        return None;
    }
    if let Some(number) = number_from_value(value) {
        return Some((number as u32) as u64);
    }
    let text = seed_text_from_value(value);
    let mut hash = 2_166_136_261_u32;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    Some(u64::from(hash))
}

fn seed_text_from_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => format!("array:{}", items.len()),
        Value::Object(object) => format!("object:{}", object.len()),
    }
}

fn edge_indices_from_optional_value(graph: &LeisureGraph, value: Option<&Value>) -> HashSet<usize> {
    value
        .map(|value| {
            strings_from_value(value)
                .into_iter()
                .filter_map(|token| edge_index_for_token(graph, &token))
                .collect()
        })
        .unwrap_or_default()
}

fn edge_index_for_token(graph: &LeisureGraph, token: &str) -> Option<usize> {
    if let Ok(index) = token.parse::<usize>() {
        if index < graph.edges.len() {
            return Some(index);
        }
    }
    graph
        .edge_by_id
        .get(token)
        .or_else(|| graph.edge_by_key.get(token))
        .copied()
        .or_else(|| {
            let (from, to) = token.split_once("->")?;
            graph
                .edge_by_key
                .get(&edge_key(&NodeId::from(from), &NodeId::from(to)))
                .copied()
        })
}

fn assign_finite(target: &mut f64, value: Option<f64>) {
    if let Some(value) = value.filter(|value| value.is_finite()) {
        *target = value;
    }
}

fn round(value: f64, decimals: i32) -> f64 {
    let scale = 10_f64.powi(decimals);
    (value * scale).round() / scale
}

fn empty_graph() -> LeisureGraph {
    LeisureGraph::from_data(GraphData {
        version: "wasm-empty".to_owned(),
        generated_at: String::new(),
        stats: GraphStats::default(),
        nodes: Vec::new(),
        edges: Vec::new(),
    })
}
