#!/usr/bin/env node
// Authoring-time only. Pulls general-trivia MCQs from the Open Trivia Database
// (https://opentdb.com, CC BY-SA 4.0) and writes a cleaned candidate pool to
// scratchpad/opentdb_clean.json. Nothing here runs in the browser.
//
// OpenTDB enforces ~1 request / 5s per IP and hands out a session token so a
// token's questions never repeat. We fetch per category up to a cap (to fight
// OpenTDB's video-game/anime skew), decode HTML entities, drop time-drifting
// facts, dedupe, and tag each question with our 8-bucket taxonomy.

import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "/private/tmp/opentdb_clean.json";
const SLEEP_MS = 5300; // stay just over the 5s rate limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenTDB category id -> { bucket, cap }. Caps cap per-category contribution.
const CATEGORIES = [
  { id: 22, bucket: "geography", cap: 160 },
  { id: 23, bucket: "history", cap: 160 },
  { id: 17, bucket: "science", cap: 130 }, // Science & Nature
  { id: 27, bucket: "science", cap: 70 },  // Animals
  { id: 18, bucket: "science", cap: 45 },  // Computers
  { id: 19, bucket: "science", cap: 45 },  // Mathematics
  { id: 30, bucket: "science", cap: 25 },  // Gadgets
  { id: 10, bucket: "arts", cap: 70 },     // Books
  { id: 25, bucket: "arts", cap: 45 },     // Art
  { id: 20, bucket: "arts", cap: 55 },     // Mythology
  { id: 13, bucket: "arts", cap: 25 },     // Musicals & Theatre
  { id: 21, bucket: "sports", cap: 130 },
  { id: 11, bucket: "pop", cap: 90 },      // Film
  { id: 12, bucket: "pop", cap: 90 },      // Music
  { id: 14, bucket: "pop", cap: 70 },      // Television
  { id: 26, bucket: "pop", cap: 45 },      // Celebrities
  { id: 9, bucket: "general", cap: 220 },  // General Knowledge -> split later
];

// General-knowledge reclassification by keyword (best-effort).
const FOOD_RE = /\b(food|dish|cuisine|fruit|vegetable|cheese|meat|spice|drink|cocktail|wine|beer|coffee|tea|dessert|cake|bread|pasta|sauce|cook|bake|recipe|eat|edible|flavou?r|dessert)\b/i;
const WORDS_RE = /\b(word|words|language|phrase|term|latin|greek word|meaning of|means|plural|synonym|antonym|prefix|suffix|letter|alphabet|spell|spelt|abbreviation|acronym|phobia|-ology|derived from)\b/i;

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&eacute;/g, "é")
    .replace(/&aacute;/g, "á")
    .replace(/&uuml;/g, "ü")
    .replace(/&ouml;/g, "ö")
    .replace(/&auml;/g, "ä")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&rsquo;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();

// Facts that drift over time -> unfit for a "stable verifiable fact" bank.
const DRIFT_RE = /\b(currently|current|as of|right now|nowadays|latest|most recent|recently|this year|last year|to date|so far|reigning|present day|at present|today)\b/i;

const norm = (s) => decode(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function getToken() {
  const r = await fetch("https://opentdb.com/api_token.php?command=request");
  const j = await r.json();
  return j.token;
}

async function fetchBatch(catId, token) {
  const url = `https://opentdb.com/api.php?amount=50&category=${catId}&type=multiple&token=${token}`;
  const r = await fetch(url);
  return r.json();
}

function reclassify(bucket, question) {
  if (bucket !== "general") return bucket;
  if (FOOD_RE.test(question)) return "food";
  if (WORDS_RE.test(question)) return "words";
  return "general"; // leftover general knowledge; kept, labeled general
}

async function main() {
  console.error("[fetch] requesting session token...");
  const token = await getToken();
  const seen = new Set();
  const out = [];
  const perBucket = {};

  for (const { id, bucket, cap } of CATEGORIES) {
    let got = 0;
    let empties = 0;
    while (got < cap) {
      let j;
      try {
        j = await fetchBatch(id, token);
      } catch (e) {
        console.error(`[fetch] cat ${id} network error: ${e.message}; retrying`);
        await sleep(SLEEP_MS);
        continue;
      }
      if (j.response_code === 5) {
        console.error(`[fetch] rate limited, backing off`);
        await sleep(SLEEP_MS * 2);
        continue;
      }
      if (j.response_code === 3 || j.response_code === 4) {
        // token empty/not found for this category -> exhausted
        break;
      }
      if (j.response_code !== 0 || !j.results || j.results.length === 0) {
        if (++empties >= 2) break;
        await sleep(SLEEP_MS);
        continue;
      }
      for (const q of j.results) {
        const question = decode(q.question);
        const key = norm(question);
        if (seen.has(key)) continue;
        if (DRIFT_RE.test(question)) continue;
        if (question.length < 12) continue;
        const correct = decode(q.correct_answer);
        const incorrect = q.incorrect_answers.map(decode);
        if (incorrect.length !== 3) continue;
        const opts = [correct, ...incorrect];
        // reject if any option collides after normalization (dupe distractor)
        const optKeys = new Set(opts.map((o) => o.toLowerCase().trim()));
        if (optKeys.size !== 4) continue;
        seen.add(key);
        const finalBucket = reclassify(bucket, question);
        out.push({
          category: finalBucket,
          difficulty: q.difficulty, // easy|medium|hard
          question,
          correct,
          incorrect,
          src: "opentdb",
          srcCategory: id,
        });
        got++;
        perBucket[finalBucket] = (perBucket[finalBucket] || 0) + 1;
        if (got >= cap) break;
      }
      console.error(
        `[fetch] cat ${id} (${bucket}): +${j.results.length} -> kept ${got}/${cap}, total ${out.length}`
      );
      await sleep(SLEEP_MS);
    }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 0));
  console.error(`[fetch] DONE. ${out.length} questions -> ${OUT}`);
  console.error(`[fetch] per bucket:`, JSON.stringify(perBucket, null, 2));
}

main().catch((e) => {
  console.error("[fetch] FATAL", e);
  process.exit(1);
});
