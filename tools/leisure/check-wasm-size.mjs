#!/usr/bin/env node
// Verify the compiled WASM stays within the size budget.
// Exits with code 0 if within budget, 1 if exceeded.

import { statSync, readFileSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const WASM_PATH = "assets/wasm/leisure-core/leisure_core_bg.wasm";
const BUDGET_RAW = 1_000_000;      // 1 MB raw; ~23% above the current ~810 KB baseline.
const BUDGET_BROTLI = 300_000;     // ~293 KB wire size; ~28% above the current ~235 KB baseline.

function main() {
  let stat;
  try {
    stat = statSync(WASM_PATH);
  } catch (err) {
    console.error(`✗ WASM not found at ${WASM_PATH}. Did you run \`npm run build:wasm\`?`);
    process.exit(1);
  }

  const raw = stat.size;
  const bytes = readFileSync(WASM_PATH);
  const brotli = brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;

  const rawOk = raw <= BUDGET_RAW;
  const brotliOk = brotli <= BUDGET_BROTLI;
  const fmt = (n) => `${n.toLocaleString()} bytes (${(n / 1024).toFixed(1)} KB)`;

  console.log(`WASM raw:    ${fmt(raw)} / ${fmt(BUDGET_RAW)} ${rawOk ? "✓" : "✗"}`);
  console.log(`WASM brotli: ${fmt(brotli)} / ${fmt(BUDGET_BROTLI)} ${brotliOk ? "✓" : "✗"}`);

  if (!rawOk || !brotliOk) {
    console.error("✗ WASM size budget exceeded. Review recent changes or raise the budget if intentional.");
    process.exit(1);
  }

  console.log("✓ WASM size within budget.");
}

main();
