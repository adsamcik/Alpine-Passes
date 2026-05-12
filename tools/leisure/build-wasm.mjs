import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(repoRoot, "assets", "wasm", "leisure-core");
const wasmPath = path.join(outDir, "leisure_core_bg.wasm");
const wasmOptBin = path.join(repoRoot, "node_modules", "binaryen", "bin", "wasm-opt");
const wasmOptFlags = [
  "-Oz",
  "--converge",
  "--enable-bulk-memory",
  "--enable-bulk-memory-opt",
  "--enable-nontrapping-float-to-int",
  "--strip-debug",
  "--strip-dwarf",
];

if (!fs.existsSync(wasmOptBin)) {
  throw new Error("wasm-opt not found. Install it with: npm install --no-save binaryen");
}

const rustflags = [
  process.env.RUSTFLAGS,
  `--remap-path-prefix=${repoRoot}=.`,
  `--remap-path-prefix=${path.join(os.homedir(), ".cargo")}=.cargo`,
  process.env.CARGO_HOME ? `--remap-path-prefix=${process.env.CARGO_HOME}=.cargo` : null,
]
  .filter(Boolean)
  .join(" ");

execFileSync(
  "wasm-pack",
  [
    "build",
    "crates/leisure-core",
    "--target",
    "web",
    "--release",
    "--out-dir",
    "../../assets/wasm/leisure-core",
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, RUSTFLAGS: rustflags },
    stdio: "inherit",
  },
);

runWasmOpt([...wasmOptFlags, "-o", wasmPath, wasmPath], "inherit");

writeAllowlist();
ensureWasmOptProducer();
stampWasmContentHash();

function writeAllowlist() {
  fs.writeFileSync(
    path.join(outDir, ".gitignore"),
    [
      "# Ignore everything by default",
      "*",
      "",
      "# Allowlist the wasm-pack outputs that ship as static assets",
      "!.gitignore",
      "!README.md",
      "!leisure_core.js",
      "!leisure_core_bg.js",
      "!leisure_core.d.ts",
      "!leisure_core_bg.wasm",
      "!leisure_core_bg.wasm.d.ts",
      "!package.json",
      "",
    ].join("\n"),
  );
}

function ensureWasmOptProducer() {
  const bytes = fs.readFileSync(wasmPath);
  if (bytes.includes(Buffer.from("wasm-opt"))) return;

  fs.appendFileSync(wasmPath, producerSection("wasm-opt", wasmOptVersion()));
}

function stampWasmContentHash() {
  const wasmBytes = fs.readFileSync(wasmPath);
  const hash = createHash("sha256").update(wasmBytes).digest("hex").slice(0, 12);
  const shimPath = path.join(repoRoot, "assets", "js", "leisure", "wasm-shim.js");
  const shim = fs.readFileSync(shimPath, "utf8");
  const updated = shim.replace(
    /const WASM_CONTENT_HASH = "[^"]*";/,
    `const WASM_CONTENT_HASH = "${hash}";`,
  );
  if (shim === updated) {
    console.warn("WASM_CONTENT_HASH placeholder not found in wasm-shim.js — skipping content-hash injection");
    return;
  }
  fs.writeFileSync(shimPath, updated);
  console.log(`Stamped WASM content hash: ${hash}`);
}

function wasmOptVersion() {
  return runWasmOpt(["--version"], "pipe")
    .trim()
    .replace(/^wasm-opt version\s*/u, "");
}

function runWasmOpt(args, stdio) {
  return execFileSync(process.execPath, [wasmOptBin, ...args], {
    cwd: repoRoot,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    stdio,
  });
}

function producerSection(name, version) {
  const payload = Buffer.concat([
    encodeString("producers"),
    encodeU32(1),
    encodeString("processed-by"),
    encodeU32(1),
    encodeString(name),
    encodeString(version),
  ]);
  return Buffer.concat([Buffer.from([0]), encodeU32(payload.length), payload]);
}

function encodeString(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeU32(bytes.length), bytes]);
}

function encodeU32(value) {
  const out = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return Buffer.from(out);
}
