//! F1-C2 parity test: verifies that the wasm_api/ directory layout preserves
//! every wasm-bindgen export that existed in the pre-refactor wasm_api.rs.
//!
//! `#[wasm_bindgen]` exports cannot be invoked from a host (non-wasm32) test
//! target via JsValue plumbing, so parity is asserted at the SOURCE level via
//! two complementary checks:
//!
//!   (a) Compile-time presence — each export is referenced by a typed
//!       function-pointer cast. If a signature drifts or an export is
//!       removed, this file fails to compile.
//!   (b) String-level signature snapshot — the source of `wasm_api/mod.rs`
//!       is parsed for `pub fn wasm_*` lines and the set is compared against
//!       the canonical roster.
//!
//! `leisure_core_version` is the 13th export but lives in `lib.rs`, so it is
//! checked separately (compile-time reference only).

use leisure_core::wasm_api;
use wasm_bindgen::JsValue;

// ----------------------------------------------------------------------------
// (a) Compile-time presence — typed function-pointer assertions.
//     Signatures are taken verbatim from the pre-refactor wasm_api.rs.
// ----------------------------------------------------------------------------

#[test]
fn wasm_exports_have_expected_signatures() {
    let _f01: fn(JsValue) -> Result<JsValue, JsValue> = wasm_api::wasm_load_graph;
    let _f02: fn(u32) -> Result<JsValue, JsValue> = wasm_api::wasm_decompose_ears;
    let _f03: fn(u32) -> Result<JsValue, JsValue> = wasm_api::wasm_free_graph;
    let _f04: fn(u32) -> Result<JsValue, JsValue> = wasm_api::wasm_free_ears;
    let _f05: fn(u32, u32, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_leisure_plan_auto;
    let _f06: fn(u32, u32, JsValue, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_leisure_plan_selected;
    let _f07: fn(u32, u32, &str, &str, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_leisure_plan_open;
    let _f08: fn(u32, JsValue, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_suggest_corridor;
    let _f09: fn(u32, JsValue, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_find_lunch_area;
    let _f10: fn(u32, JsValue, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_suggest_breaks;
    let _f11: fn(JsValue, JsValue) -> Result<JsValue, JsValue> = wasm_api::wasm_infer_intent;
    let _f12: fn(JsValue, JsValue, JsValue, JsValue) -> Result<JsValue, JsValue> =
        wasm_api::wasm_surface_intent_pois;

    // 13th export lives in lib.rs, not in wasm_api/.
    let _v: fn() -> String = leisure_core::leisure_core_version;
}

// ----------------------------------------------------------------------------
// (b) Source-level snapshot — set-equality of `pub fn wasm_*` declarations
//     in wasm_api/mod.rs.
// ----------------------------------------------------------------------------

const MOD_RS: &str = include_str!("../src/wasm_api/mod.rs");

const EXPECTED_WASM_EXPORTS_IN_MOD: &[&str] = &[
    "wasm_load_graph",
    "wasm_decompose_ears",
    "wasm_free_graph",
    "wasm_free_ears",
    "wasm_leisure_plan_auto",
    "wasm_leisure_plan_selected",
    "wasm_leisure_plan_open",
    "wasm_suggest_corridor",
    "wasm_find_lunch_area",
    "wasm_suggest_breaks",
    "wasm_infer_intent",
    "wasm_surface_intent_pois",
];

fn extract_wasm_pub_fn_names(src: &str) -> Vec<String> {
    let mut names = Vec::new();
    for raw_line in src.lines() {
        let line = raw_line.trim_start();
        // Match `pub fn wasm_<ident>(...` — covers both single-line signatures
        // and multi-line signatures (where `pub fn wasm_foo(` is on its own line).
        if let Some(rest) = line.strip_prefix("pub fn ") {
            if rest.starts_with("wasm_") {
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(rest.len());
                names.push(rest[..end].to_string());
            }
        }
    }
    names
}

#[test]
fn wasm_api_mod_rs_exports_exact_set() {
    let mut found = extract_wasm_pub_fn_names(MOD_RS);
    found.sort();
    found.dedup();

    let mut expected: Vec<String> =
        EXPECTED_WASM_EXPORTS_IN_MOD.iter().map(|s| s.to_string()).collect();
    expected.sort();

    assert_eq!(
        found, expected,
        "wasm_api/mod.rs `pub fn wasm_*` set drifted from the F1 roster.\n\
         Found:    {:?}\n\
         Expected: {:?}",
        found, expected
    );

    assert_eq!(
        found.len(),
        12,
        "Expected exactly 12 wasm_* exports in wasm_api/mod.rs (the 13th, \
         leisure_core_version, lives in lib.rs)."
    );
}

#[test]
fn wasm_api_mod_rs_has_doc_header_and_heuristics_decl() {
    assert!(
        MOD_RS.contains("wasm_api/ — WASM boundary for the leisure planner core."),
        "wasm_api/mod.rs missing the F1 directory-convention doc-header."
    );
    assert!(
        MOD_RS.contains("pub mod heuristics;"),
        "wasm_api/mod.rs missing `pub mod heuristics;` registration."
    );
}
