//! Placeholder for wasm-callable wrappers around `crate::heuristics::*`.
//!
//! At F1 time this module is intentionally empty: the 8 heuristics
//! (optimizer_options, is_seasonally_closed_pass, ...) are consumed
//! by F2/F4/F5 from Rust, and post-F6 the JS shim no longer calls
//! them directly. See ADR-F1-005.
//!
//! Future features may add `#[wasm_bindgen]`-annotated `wasm_*` wrappers
//! here without owning the parent mod.rs.
