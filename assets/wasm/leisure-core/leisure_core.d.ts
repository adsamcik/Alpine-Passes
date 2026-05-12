/* tslint:disable */
/* eslint-disable */

export function leisure_core_version(): string;

export function wasm_decompose_ears(graph_handle: number): any;

export function wasm_find_lunch_area(graph_handle: number, tour_value: any, options_value: any): any;

/**
 * Release a previously-computed ears handle. Same semantics as `wasm_free_graph`.
 */
export function wasm_free_ears(handle: number): any;

/**
 * Release a previously-loaded graph handle. The slot is tombstoned and the
 * handle becomes invalid for subsequent calls. Returns `true` if the handle
 * was valid, `false` if it was already free / out of range, or an error if
 * the handle belongs to another handle kind.
 */
export function wasm_free_graph(handle: number): any;

export function wasm_infer_intent(entities_value: any, options_value: any): any;

export function wasm_leisure_plan_auto(graph_handle: number, ears_handle: number, options_value: any): any;

export function wasm_leisure_plan_open(graph_handle: number, ears_handle: number, start_id: string, end_id: string, options_value: any): any;

export function wasm_leisure_plan_selected(graph_handle: number, ears_handle: number, must_visit_value: any, options_value: any): any;

export function wasm_load_graph(graph_data: any): any;

export function wasm_suggest_breaks(graph_handle: number, tour_value: any, options_value: any): any;

export function wasm_suggest_corridor(graph_handle: number, tour_value: any, options_value: any): any;

export function wasm_surface_intent_pois(tour_value: any, candidates_value: any, intent_value: any, options_value: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly leisure_core_version: (a: number) => void;
    readonly wasm_decompose_ears: (a: number, b: number) => void;
    readonly wasm_find_lunch_area: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_free_ears: (a: number, b: number) => void;
    readonly wasm_free_graph: (a: number, b: number) => void;
    readonly wasm_infer_intent: (a: number, b: number, c: number) => void;
    readonly wasm_leisure_plan_auto: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_leisure_plan_open: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly wasm_leisure_plan_selected: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_load_graph: (a: number, b: number) => void;
    readonly wasm_suggest_breaks: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_suggest_corridor: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_surface_intent_pois: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
