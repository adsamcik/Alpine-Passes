//! F6-C1 — selected-stop ID resolution wasm export (resolves BL-F6-002
//! per ADR-F6-006).
//!
//! Exposes `crate::tour_dto::resolve_selected_stop_id` to JS so the slim
//! shim can resolve UI-selected stops without walking graph indexes in
//! JavaScript. Mirrors the JS pattern
//! `selectedStops.map(resolveSelectedStopId).filter(Boolean)`.
//!
//! The pure-Rust helper `resolve_selected_stop_ids` carries the
//! per-descriptor mapping logic so native unit tests can exercise it
//! without a wasm32 target; `wasm_resolve_selected_stop_ids` is a thin
//! JsValue parsing wrapper.

use crate::tour_dto::{resolve_selected_stop_id, SelectedStop};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use super::{parse_js_or_default, wasm_boundary, with_graph};

/// JS-side selected-stop descriptor. Accepts the loose UI shape:
/// `{ id?, passId?, nodeId?, name?, lat?, lon? }`. All fields optional;
/// missing fields default to `None`. Snake_case aliases (`pass_id`,
/// `node_id`) are accepted for callers that do not normalize.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSelectedStop {
    pub id: Option<String>,
    #[serde(alias = "pass_id")]
    pub pass_id: Option<String>,
    #[serde(alias = "node_id")]
    pub node_id: Option<String>,
    pub name: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

impl RawSelectedStop {
    /// Project a raw JS descriptor onto the `SelectedStop` enum the core
    /// resolver expects. Picks the first non-empty id-shaped field
    /// (`id` → `passId` → `nodeId`); falls back to `PoiNamed` when only
    /// `name + lat + lon` are present; otherwise yields an empty `Id("")`
    /// which `resolve_selected_stop_id` rejects (the caller filters
    /// resulting `None`s).
    pub fn to_selected_stop(&self) -> SelectedStop<'_> {
        if let Some(s) = self.id.as_deref().filter(|s| !s.is_empty()) {
            return SelectedStop::Id(s);
        }
        if let Some(s) = self.pass_id.as_deref().filter(|s| !s.is_empty()) {
            return SelectedStop::Id(s);
        }
        if let Some(s) = self.node_id.as_deref().filter(|s| !s.is_empty()) {
            return SelectedStop::Id(s);
        }
        if let (Some(name), Some(lat), Some(lon)) = (
            self.name.as_deref().filter(|s| !s.is_empty()),
            self.lat.filter(|v| v.is_finite()),
            self.lon.filter(|v| v.is_finite()),
        ) {
            return SelectedStop::PoiNamed {
                id: None,
                name,
                lat,
                lon,
            };
        }
        SelectedStop::Id("")
    }
}

/// Map each UI-selected descriptor through `resolve_selected_stop_id`,
/// dropping the `None` results. Mirrors the JS
/// `selectedStops.map(resolveSelectedStopId).filter(Boolean)` idiom.
///
/// Note: the upstream resolver returns `Some(s)` for any non-empty `Id`
/// regardless of graph membership (it only drops empty descriptors and
/// PoiNamed lookups that fail by-name); unknown ids therefore pass
/// through verbatim, matching JS behavior.
pub fn resolve_selected_stop_ids(
    graph: &crate::LeisureGraph,
    raw: &[RawSelectedStop],
) -> Vec<String> {
    raw.iter()
        .filter_map(|stop| resolve_selected_stop_id(&stop.to_selected_stop(), graph))
        .collect()
}

#[wasm_bindgen]
pub fn wasm_resolve_selected_stop_ids(
    graph_handle: u32,
    selected_stops_value: JsValue,
) -> Result<JsValue, JsValue> {
    wasm_boundary(|| {
        let raw: Vec<RawSelectedStop> =
            parse_js_or_default(selected_stops_value, "selected stops")?;
        with_graph(graph_handle, |graph| {
            Ok(resolve_selected_stop_ids(graph, &raw))
        })
    })
}
