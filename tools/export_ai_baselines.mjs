#!/usr/bin/env node
// Authoring-time only. Reads runs.json, extracts the frontier-model trios, and
// emits a compact baseline blob to embed in index.html between the AI markers.
// Only (confidence, correct) pairs are kept — the app recomputes every metric
// client-side with calibration.js, so there are no precomputed numbers to drift.
//
//   node tools/export_ai_baselines.mjs   # prints the blob to stdout

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runs = JSON.parse(readFileSync(join(__dirname, "..", "runs.json"), "utf8"));

// player id -> display label. Trios only (the real comparison set).
const MODELS = [
  { player: "opus-trio", key: "opus", label: "Opus" },
  { player: "fable-trio", key: "fable", label: "Fable" },
  { player: "haiku-trio", key: "haiku", label: "Haiku" },
];

const out = {};
for (const m of MODELS) {
  const rs = runs.filter((r) => r.player === m.player);
  const pairs = rs.flatMap((r) => r.review.map((x) => [x.stated_confidence, x.was_correct ? 1 : 0]));
  out[m.key] = { label: m.label, runs: rs.length, difficulty: "hard", pairs };
}

// compact one-model-per-line JSON for readability in the diff
const body = Object.entries(out)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  .join(",\n");
process.stdout.write(`{\n${body}\n}\n`);
process.stderr.write(
  "counts: " + Object.entries(out).map(([k, v]) => `${k}=${v.pairs.length}`).join(" ") + "\n"
);
