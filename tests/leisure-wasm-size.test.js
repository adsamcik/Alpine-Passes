import { test } from "node:test";
import { statSync, readFileSync, existsSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const WASM_PATH = "assets/wasm/leisure-core/leisure_core_bg.wasm";
const BUDGET_RAW = 1_000_000;
const BUDGET_BROTLI = 300_000;

test("WASM raw size is within budget", { skip: !existsSync(WASM_PATH) }, () => {
  const size = statSync(WASM_PATH).size;
  if (size > BUDGET_RAW) {
    throw new Error(`WASM raw ${size} bytes exceeds budget ${BUDGET_RAW}. Run check:wasm-size.`);
  }
});

test("WASM brotli size is within wire budget", { skip: !existsSync(WASM_PATH) }, () => {
  const bytes = readFileSync(WASM_PATH);
  const brotli = brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  if (brotli > BUDGET_BROTLI) {
    throw new Error(`WASM brotli ${brotli} bytes exceeds wire budget ${BUDGET_BROTLI}.`);
  }
});
