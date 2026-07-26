#!/usr/bin/env node

import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  buildSearchDocument,
  searchEntities,
} from "../../assets/js/nature/discovery.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_NATURE_ROOT = path.join(REPO_ROOT, "assets", "data", "nature");
const DEFAULT_REPORT_PATH = path.join(
  REPO_ROOT,
  "data",
  "benchmarks",
  "nature-pipeline.v1.json",
);
const SYNTHETIC_ENTITY_COUNT = 5_000;
const DEFAULT_SEARCH_SAMPLES = 80;
const WARMUP_ROUNDS = 3;
const GZIP_OPTIONS = Object.freeze({ level: 9 });

export async function benchmarkNatureData(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const natureRoot = options.natureRoot || path.join(repoRoot, "assets", "data", "nature");
  const reportPath = options.reportPath
    || path.join(repoRoot, "data", "benchmarks", "nature-pipeline.v1.json");
  const searchSamples = options.searchSamples ?? DEFAULT_SEARCH_SAMPLES;
  if (!Number.isSafeInteger(searchSamples) || searchSamples < 20) {
    throw new TypeError("searchSamples must be a safe integer of at least 20");
  }

  const baselineMemory = memorySnapshot();
  const manifestPath = path.join(natureRoot, "manifest.v1.json");
  const manifestBuffer = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBuffer);
  if (!manifest.spatialIndex?.url || !Number.isSafeInteger(manifest.budgets?.viewportRequestBytes)) {
    throw new Error("Benchmark requires a spatial index and viewport request budget");
  }
  const spatialIndexPath = path.resolve(repoRoot, manifest.spatialIndex.url);
  const spatialIndexBuffer = await readFile(spatialIndexPath);
  if (spatialIndexBuffer.byteLength !== manifest.spatialIndex.bytes) {
    throw new Error(
      `Spatial index byte count mismatch: ${spatialIndexBuffer.byteLength} != ${manifest.spatialIndex.bytes}`,
    );
  }
  const packageMeasurements = [];
  const currentEntities = [];
  for (const entry of manifest.packages) {
    const filename = path.basename(entry.url);
    const packagePath = path.join(natureRoot, "packages", entry.regionId, filename);
    const raw = await readFile(packagePath);
    if (raw.byteLength !== entry.bytes) {
      throw new Error(
        `Manifest byte count mismatch for ${entry.regionId} shard ${entry.shardIndex}: `
        + `${raw.byteLength} != ${entry.bytes}`,
      );
    }
    const document = JSON.parse(raw);
    currentEntities.push(...document.entities);
    const gzipBytes = gzipSync(raw, GZIP_OPTIONS).byteLength;
    packageMeasurements.push({
      regionId: entry.regionId,
      shardIndex: entry.shardIndex,
      shardCount: entry.shardCount,
      file: path.posix.join(
        "assets",
        "data",
        "nature",
        "packages",
        entry.regionId,
        filename,
      ),
      entities: document.entities.length,
      rawBytes: raw.byteLength,
      gzipBytes,
      gzipToRawRatio: ratio(gzipBytes, raw.byteLength),
    });
  }
  const loadedMemory = memorySnapshot();

  const currentDocuments = currentEntities.map(buildSearchDocument);
  const currentIndexedMemory = memorySnapshot();
  const currentSearch = measureIndexedSearch({
    entities: currentEntities,
    documents: currentDocuments,
    queries: [
      "mountain",
      "waterfall",
      "hiking",
      "scenic drive",
      "御嶽山",
      "quiraing",
      "snezka",
      "no matching nature entity",
    ],
    samples: searchSamples,
  });

  const syntheticEntities = createSyntheticActiveRegion(SYNTHETIC_ENTITY_COUNT);
  const beforeSyntheticIndexMemory = memorySnapshot();
  const syntheticDocuments = syntheticEntities.map(buildSearchDocument);
  const syntheticIndexedMemory = memorySnapshot();
  const syntheticSearch = measureIndexedSearch({
    entities: syntheticEntities,
    documents: syntheticDocuments,
    queries: [
      "Synthetic Feature 1",
      "合成地点 42",
      "Gosei Chiten 42",
      "Syntetické místo 333",
      "waterfall",
      "hiking",
      "synthetic active region",
      "does not exist",
    ],
    samples: searchSamples,
  });

  const manifestGzipBytes = gzipSync(manifestBuffer, GZIP_OPTIONS).byteLength;
  const spatialIndexGzipBytes = gzipSync(spatialIndexBuffer, GZIP_OPTIONS).byteLength;
  const fixedInitialRawBytes = manifestBuffer.byteLength + spatialIndexBuffer.byteLength;
  const initialRawBytesUpperBound = fixedInitialRawBytes
    + manifest.budgets.viewportRequestBytes;
  const packageRawBytes = sum(packageMeasurements.map((item) => item.rawBytes));
  const packageGzipBytes = sum(packageMeasurements.map((item) => item.gzipBytes));
  const maxPackageRawBytes = Math.max(...packageMeasurements.map((item) => item.rawBytes));
  const deterministicBudgetChecks = [
    {
      id: "manifest_raw_bytes",
      observed: manifestBuffer.byteLength,
      limit: manifest.budgets.manifestBytes,
      unit: "bytes",
      passed: manifestBuffer.byteLength <= manifest.budgets.manifestBytes,
      enforced: true,
    },
    {
      id: "initial_nature_data_raw_upper_bound_bytes",
      observed: initialRawBytesUpperBound,
      limit: manifest.budgets.initialNatureDataBytes,
      unit: "bytes",
      passed: initialRawBytesUpperBound <= manifest.budgets.initialNatureDataBytes,
      enforced: true,
    },
    {
      id: "maximum_regional_package_raw_bytes",
      observed: maxPackageRawBytes,
      limit: manifest.budgets.regionalPackageBytes,
      unit: "bytes",
      passed: maxPackageRawBytes <= manifest.budgets.regionalPackageBytes,
      enforced: true,
    },
  ];
  const observationalChecks = [
    {
      id: "current_indexed_search_p95",
      observed: currentSearch.p95Milliseconds,
      target: manifest.budgets.searchP95Milliseconds,
      unit: "milliseconds",
      withinTarget: currentSearch.p95Milliseconds <= manifest.budgets.searchP95Milliseconds,
      observational: true,
      enforced: false,
    },
    {
      id: "synthetic_5000_indexed_search_p95",
      observed: syntheticSearch.p95Milliseconds,
      target: manifest.budgets.searchP95Milliseconds,
      unit: "milliseconds",
      withinTarget: syntheticSearch.p95Milliseconds <= manifest.budgets.searchP95Milliseconds,
      observational: true,
      enforced: false,
    },
  ];

  const report = {
    schemaVersion: "1.0.0",
    artifactType: "nature-pipeline-benchmark",
    generated: true,
    reproducibility: {
      command: "node tools/nature/benchmark.mjs",
      corpusBuildId: manifest.buildId,
      syntheticFixture: {
        generator: "createSyntheticActiveRegion",
        entityCount: SYNTHETIC_ENTITY_COUNT,
        seed: "deterministic-index-v1",
      },
      search: {
        indexedDocumentsReused: true,
        warmupRounds: WARMUP_ROUNDS,
        measuredSamplesPerCorpus: searchSamples,
        percentileMethod: "nearest-rank",
      },
      compression: "node:zlib gzip level 9",
      timestampsOmitted: true,
    },
    environment: {
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        architecture: process.arch,
      },
      hardware: {
        cpuModel: os.cpus()[0]?.model || "unknown",
        logicalCpuCount: os.cpus().length,
        totalSystemMemoryBytes: os.totalmem(),
      },
    },
    corpus: {
      buildId: manifest.buildId,
      currentEntities: currentEntities.length,
      currentPackages: packageMeasurements.length,
      syntheticActiveRegionEntities: syntheticEntities.length,
    },
    deliverySizes: {
      manifest: {
        rawBytes: manifestBuffer.byteLength,
        gzipBytes: manifestGzipBytes,
        gzipToRawRatio: ratio(manifestGzipBytes, manifestBuffer.byteLength),
      },
      spatialIndex: {
        file: manifest.spatialIndex.url,
        rawBytes: spatialIndexBuffer.byteLength,
        gzipBytes: spatialIndexGzipBytes,
        gzipToRawRatio: ratio(spatialIndexGzipBytes, spatialIndexBuffer.byteLength),
      },
      initialNatureData: {
        fixedComponents: [
          "assets/data/nature/manifest.v1.json",
          manifest.spatialIndex.url,
        ],
        variableComponent: "Spatial-cell packages intersecting the initial map viewport",
        accounting: "Deterministic raw upper bound: manifest + spatial index + the loader-enforced viewportRequestBytes limit. Actual browser bytes vary with the initial bounds and are measured separately by the Chromium smoke.",
        fixedRawBytes: fixedInitialRawBytes,
        fixedGzipBytes: manifestGzipBytes + spatialIndexGzipBytes,
        viewportCellRawBytesLimit: manifest.budgets.viewportRequestBytes,
        rawBytesUpperBound: initialRawBytesUpperBound,
        budgetBytes: manifest.budgets.initialNatureDataBytes,
      },
      regionalPackages: packageMeasurements,
      regionalPackageTotals: {
        rawBytes: packageRawBytes,
        gzipBytes: packageGzipBytes,
        gzipToRawRatio: ratio(packageGzipBytes, packageRawBytes),
        maximumRawBytes: maxPackageRawBytes,
      },
    },
    indexedSearch: {
      current: {
        entityCount: currentEntities.length,
        documentCount: currentDocuments.length,
        ...currentSearch,
      },
      syntheticActiveRegion: {
        entityCount: syntheticEntities.length,
        documentCount: syntheticDocuments.length,
        ...syntheticSearch,
      },
      interpretation: "Timing is observational and is not a build failure gate.",
    },
    processMemory: {
      unit: "bytes",
      snapshots: {
        baseline: baselineMemory,
        afterCurrentCorpusLoad: loadedMemory,
        afterCurrentSearchIndex: currentIndexedMemory,
        beforeSyntheticSearchIndex: beforeSyntheticIndexMemory,
        afterSyntheticSearchIndex: syntheticIndexedMemory,
      },
      deltas: {
        currentCorpusLoadFromBaseline: memoryDelta(loadedMemory, baselineMemory),
        currentIndexFromLoadedCorpus: memoryDelta(currentIndexedMemory, loadedMemory),
        syntheticIndex: memoryDelta(syntheticIndexedMemory, beforeSyntheticIndexMemory),
        totalFromBaseline: memoryDelta(syntheticIndexedMemory, baselineMemory),
      },
      observational: true,
      enforced: false,
    },
    budgetEvaluation: {
      authoredDeterministic: deterministicBudgetChecks,
      observational: observationalChecks,
      deterministicFailures: deterministicBudgetChecks.filter((check) => !check.passed).length,
      timingFailures: "not_applicable_observational_only",
    },
    limitations: [
      "Node microbenchmark only; it does not measure browser startup, Web Workers, IndexedDB, map rendering, interaction frames, network transfer, or routing.",
      "Measurements use warm local files and an in-process prebuilt search index.",
      "Initial nature-data accounting is an enforced raw-byte upper bound; actual viewport cell selection and compressed transfer size require browser/CDN measurement.",
      "The synthetic region stresses 5,000 multilingual searchable entities but not complex route geometry, media decoding, or vector-tile rendering.",
      "Process memory includes V8 allocator and garbage-collection noise; the benchmark does not force garbage collection.",
      "Gzip level-9 size is measured locally and does not predict CDN Brotli size or transfer latency.",
      "Timing and memory values are observational across hardware/runtime combinations and never fail the build.",
    ],
  };

  if (options.writeReport !== false) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  const failures = deterministicBudgetChecks.filter((check) => !check.passed);
  if (failures.length) {
    throw new Error(
      `Deterministic benchmark budgets failed: ${failures.map((item) => item.id).join(", ")}`,
    );
  }
  return report;
}

export function createSyntheticActiveRegion(count = SYNTHETIC_ENTITY_COUNT) {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError("count must be a positive safe integer");
  }
  const categories = ["mountain", "waterfall", "lake", "forest", "viewpoint", "wetland"];
  const entities = [];
  for (let index = 0; index < count; index += 1) {
    const ordinal = index + 1;
    const languageKind = index % 4;
    let names;
    if (languageKind === 0) {
      names = [
        { language: "ja", script: "Jpan", value: `合成地点 ${ordinal}`, kind: "primary" },
        {
          language: "ja-Latn",
          script: "Latn",
          value: `Gosei Chiten ${ordinal}`,
          kind: "romanized",
        },
        {
          language: "en",
          value: `Synthetic Feature ${ordinal}`,
          kind: "translated",
        },
      ];
    } else if (languageKind === 1) {
      names = [
        { language: "cs", value: `Syntetické místo ${ordinal}`, kind: "primary" },
        { language: "en", value: `Synthetic Feature ${ordinal}`, kind: "translated" },
      ];
    } else if (languageKind === 2) {
      names = [
        { language: "gd", value: `Àite sintéiseach ${ordinal}`, kind: "primary" },
        { language: "en", value: `Synthetic Feature ${ordinal}`, kind: "translated" },
      ];
    } else {
      names = [
        { language: "fr", value: `Site synthétique ${ordinal}`, kind: "primary" },
        { language: "en", value: `Synthetic Feature ${ordinal}`, kind: "translated" },
      ];
    }
    entities.push({
      id: `synthetic:active-region:${String(ordinal).padStart(5, "0")}`,
      names,
      geometry: {
        type: "Point",
        coordinates: [
          -10 + (index % 200) * 0.1,
          35 + (Math.floor(index / 200) % 100) * 0.1,
        ],
      },
      classifications: [{
        system: "itinera-synthetic",
        original: categories[index % categories.length],
        normalized: categories[index % categories.length],
      }],
      activities: index % 3 === 0 ? ["hiking"] : ["walking"],
      themes: ["synthetic", "active region", `bucket ${index % 25}`],
      jurisdictionIds: ["SYNTHETIC"],
      summary: `Deterministic synthetic active-region search fixture ${ordinal}.`,
    });
  }
  return entities;
}

function measureIndexedSearch({
  entities,
  documents,
  queries,
  samples,
}) {
  let resultChecksum = 0;
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    for (const query of queries) {
      resultChecksum += searchEntities(entities, query, { documents }).length;
    }
  }
  const durations = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const query = queries[sample % queries.length];
    const start = process.hrtime.bigint();
    const results = searchEntities(entities, query, { documents });
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    durations.push(duration);
    resultChecksum = (resultChecksum + results.length + (results[0]?.entity.id.length || 0))
      % 1_000_000_007;
  }
  return {
    queryCount: queries.length,
    measuredSamples: samples,
    p50Milliseconds: round(percentile(durations, 0.50)),
    p95Milliseconds: round(percentile(durations, 0.95)),
    maximumMilliseconds: round(Math.max(...durations)),
    minimumMilliseconds: round(Math.min(...durations)),
    resultChecksum,
  };
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function memoryDelta(after, before) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]]),
  );
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      options.reportPath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--output=")) {
      options.reportPath = path.resolve(argument.slice("--output=".length));
    } else if (argument === "--samples") {
      options.searchSamples = Number(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--samples=")) {
      options.searchSamples = Number(argument.slice("--samples=".length));
    } else {
      throw new Error(`Unknown benchmark option: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const report = await benchmarkNatureData(options);
  console.log(
    `Nature benchmark: ${report.corpus.currentEntities} current / `
    + `${report.corpus.syntheticActiveRegionEntities} synthetic entities; `
    + `${report.deliverySizes.regionalPackageTotals.rawBytes} raw / `
    + `${report.deliverySizes.regionalPackageTotals.gzipBytes} gzip bytes; `
    + `search p95 ${report.indexedSearch.current.p95Milliseconds} ms current / `
    + `${report.indexedSearch.syntheticActiveRegion.p95Milliseconds} ms synthetic; `
    + `report ${options.reportPath || DEFAULT_REPORT_PATH}`,
  );
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_NATURE_ROOT,
  DEFAULT_REPORT_PATH,
  DEFAULT_SEARCH_SAMPLES,
  REPO_ROOT,
  SYNTHETIC_ENTITY_COUNT,
};
