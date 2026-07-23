#!/usr/bin/env node
// Authoring-time only. Merges the OpenTDB pull with the hand-generated fills,
// dedupes, caps each category with a difficulty-stratified sample aimed at the
// ~30/40/30 easy/medium/hard target, shuffles answer positions (seeded, so the
// static bank isn't positionally biased even before the runtime reshuffle),
// validates, and splices the result into index.html between the BANK markers.
//
// Usage: node tools/build_bank.mjs <scratchpadDir>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = process.argv[2];
if (!SCRATCH) { console.error("need scratchpad dir arg"); process.exit(1); }
const HTML = new URL("../index.html", import.meta.url).pathname;

// deterministic RNG so rebuilds are reproducible
let seed = 20260717;
const rand = () => { seed = (1103515245 * seed + 12345) % 2147483648; return seed / 2147483648; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const load = (f) => { const p = join(SCRATCH, f); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []; };

const opentdb = load("opentdb_clean.json");
const gen = [...load("gen_food.json"), ...load("gen_words.json"), ...load("gen_hard.json")];

const VALID_CATS = new Set(["geography", "history", "science", "arts", "sports", "pop", "food", "words"]);
const CAPS = { geography: 150, history: 150, science: 150, arts: 150, sports: 130, pop: 150, food: 999, words: 999 };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---- normalize every source item to {category,difficulty,question,correct,incorrect[3],src}
function normalize(item) {
  if (!VALID_CATS.has(item.category)) return null; // drops "general" leftovers
  if (!["easy", "medium", "hard"].includes(item.difficulty)) return null;
  const q = String(item.question || "").trim();
  const correct = String(item.correct || "").trim();
  const incorrect = (item.incorrect || []).map((s) => String(s).trim()).filter(Boolean);
  if (q.length < 8 || !correct || incorrect.length !== 3) return null;
  const opts = [correct, ...incorrect];
  if (new Set(opts.map((o) => o.toLowerCase())).size !== 4) return null; // distinct options
  return { category: item.category, difficulty: item.difficulty, question: q, correct, incorrect, src: item.src || "generated" };
}

// ---- dedupe by normalized question text (generated wins ties, appended last)
const seen = new Map();
for (const item of [...opentdb, ...gen]) {
  const n = normalize(item);
  if (!n) continue;
  seen.set(norm(n.question), n); // later sources overwrite earlier on collision
}
const all = [...seen.values()];

// ---- difficulty-stratified cap per category, aiming ~30/40/30
const TARGET = { easy: 0.30, medium: 0.40, hard: 0.30 };
const byCat = {};
for (const q of all) (byCat[q.category] ||= []).push(q);

const finalItems = [];
for (const [cat, items] of Object.entries(byCat)) {
  const cap = Math.min(CAPS[cat] ?? 150, items.length);
  const buckets = { easy: [], medium: [], hard: [] };
  for (const q of items) buckets[q.difficulty].push(q);
  Object.values(buckets).forEach(shuffle);
  const chosen = [];
  // first pass: take the stratified target from each difficulty
  for (const d of ["easy", "medium", "hard"]) {
    const want = Math.round(cap * TARGET[d]);
    chosen.push(...buckets[d].splice(0, Math.min(want, buckets[d].length)));
  }
  // second pass: top up to cap from whatever remains
  const rest = shuffle([...buckets.easy, ...buckets.medium, ...buckets.hard]);
  while (chosen.length < cap && rest.length) chosen.push(rest.shift());
  finalItems.push(...chosen);
}

// ---- finalize schema: shuffle options (seeded), assign stable ids
shuffle(finalItems);
const counters = {};
const bank = finalItems.map((q) => {
  const order = shuffle([q.correct, ...q.incorrect].map((text, i) => ({ text, correct: i === 0 })));
  const options = order.map((o) => o.text);
  const answerIndex = order.findIndex((o) => o.correct);
  const c = (counters[q.category] = (counters[q.category] || 0) + 1);
  return { id: `${q.category.slice(0, 3)}-${q.difficulty[0]}-${String(c).padStart(3, "0")}`, category: q.category, difficulty: q.difficulty, question: q.question, options, answerIndex };
});

// ---- validate
let bad = 0;
for (const q of bank) {
  if (!q.options || q.options.length !== 4) bad++;
  else if (q.answerIndex < 0 || q.answerIndex > 3) bad++;
  else if (new Set(q.options.map((o) => o.toLowerCase())).size !== 4) bad++;
}
if (bad) { console.error(`VALIDATION: ${bad} malformed questions`); process.exit(1); }

// ---- report
const cnt = (arr, key) => arr.reduce((m, q) => ((m[q[key]] = (m[q[key]] || 0) + 1), m), {});
const answerDist = bank.reduce((m, q) => ((m[q.answerIndex] = (m[q.answerIndex] || 0) + 1), m), {});
console.log("TOTAL", bank.length);
console.log("by category", cnt(bank, "category"));
console.log("by difficulty", cnt(bank, "difficulty"));
const N = bank.length;
const bd = cnt(bank, "difficulty");
console.log("difficulty %", Object.fromEntries(Object.entries(bd).map(([k, v]) => [k, (100 * v / N).toFixed(1) + "%"])));
console.log("answerIndex distribution (should be ~even)", answerDist);

// ---- splice into index.html (one question per line for readability)
const html = readFileSync(HTML, "utf8");
const body = bank.map((q) => "  " + JSON.stringify(q)).join(",\n");
const replaced = html.replace(/\/\*__BANK_START__\*\/[\s\S]*?\/\*__BANK_END__\*\//,
  `/*__BANK_START__*/[\n${body}\n]/*__BANK_END__*/`);
if (replaced === html) { console.error("BANK markers not found in index.html"); process.exit(1); }
writeFileSync(HTML, replaced);
console.log("spliced", bank.length, "questions into index.html");

// also drop a standalone copy for the spot-check step
writeFileSync(join(SCRATCH, "bank_final.json"), JSON.stringify(bank, null, 0));
