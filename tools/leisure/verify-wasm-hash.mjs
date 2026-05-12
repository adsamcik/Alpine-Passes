#!/usr/bin/env node
// Verifies the WASM_CONTENT_HASH constant in wasm-shim.js matches the
// SHA-256[:12] of the current leisure_core_bg.wasm. If the .wasm was
// changed without re-running `npm run build:wasm`, this fails the test
// suite so the stale-cache-key cannot ship.
//
// To regenerate the hash, run: npm run build:wasm

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const WASM_PATH = "assets/wasm/leisure-core/leisure_core_bg.wasm";
const SHIM_PATH = "assets/js/leisure/wasm-shim.js";

function main() {
  if (!existsSync(WASM_PATH)) {
    console.error(`✗ WASM artifact missing: ${WASM_PATH}`);
    console.error(`  Run \`npm run build:wasm\` to generate it.`);
    process.exit(1);
  }
  if (!existsSync(SHIM_PATH)) {
    console.error(`✗ Shim missing: ${SHIM_PATH}`);
    process.exit(1);
  }

  const wasmBytes = readFileSync(WASM_PATH);
  const expected = createHash("sha256").update(wasmBytes).digest("hex").slice(0, 12);

  const shimSource = readFileSync(SHIM_PATH, "utf8");
  const match = shimSource.match(/const WASM_CONTENT_HASH = "([^"]*)";/);
  if (!match) {
    console.error(`✗ WASM_CONTENT_HASH constant not found in ${SHIM_PATH}`);
    console.error(`  The placeholder regex may have drifted. Check the shim file.`);
    process.exit(1);
  }
  const actual = match[1];

  if (actual !== expected) {
    console.error(`✗ WASM_CONTENT_HASH is stale.`);
    console.error(`  Expected (sha256[:12] of WASM): ${expected}`);
    console.error(`  Actual (in wasm-shim.js):       ${actual}`);
    console.error(`  Run \`npm run build:wasm\` to regenerate the hash and bundle.`);
    process.exit(1);
  }

  console.log(`✓ WASM_CONTENT_HASH matches binary: ${actual}`);
}

main();
