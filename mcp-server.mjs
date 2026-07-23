#!/usr/bin/env node
// mcp-server.mjs — Overconfidence Olympiad as an MCP server (stdio transport).
//
// Lets an LLM play the calibration quiz: it answers trivia, states a subjective
// probability per answer, and gets a full calibration report card scored by the
// same calibration.js the web toy uses. No feedback mid-quiz (same rule as the
// toy: no peeking, so confidence stays honest).
//
// Zero dependencies: speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Question bank is parsed from index.html's __BANK__ markers — one source of truth.
//
// Register with Claude Code:
//   claude mcp add calibrateme -- node /absolute/path/to/mcp-server.mjs
// or use the .mcp.json checked into this repo.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import readline from "node:readline";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Calib = require(join(__dirname, "calibration.js"));

// ---- question bank (single source of truth: index.html) -------------------
const html = readFileSync(join(__dirname, "index.html"), "utf8");
const bankMatch = html.match(/\/\*__BANK_START__\*\/([\s\S]*?)\/\*__BANK_END__\*\//);
if (!bankMatch) { process.stderr.write("FATAL: bank markers not found in index.html\n"); process.exit(1); }
const BANK = JSON.parse(bankMatch[1]);

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- sessions --------------------------------------------------------------
const sessions = new Map(); // id -> { questions, i, records }

function startSession(n, difficulty) {
  let pool = difficulty && difficulty !== "mixed" ? BANK.filter((q) => q.difficulty === difficulty) : BANK.slice();
  pool = shuffle(pool.slice()).slice(0, n);
  const id = crypto.randomBytes(6).toString("hex");
  sessions.set(id, { questions: pool, i: 0, records: [] });
  return id;
}

function questionPayload(s) {
  const q = s.questions[s.i];
  return {
    number: s.i + 1,
    total: s.questions.length,
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    options: q.options.map((o, i) => `${"ABCD"[i]}. ${o}`),
  };
}

// ---- report ----------------------------------------------------------------
function persona(gap, resolution) {
  const discriminating = resolution > 0.03;
  if (Math.abs(gap) <= 0.05 && discriminating) return "Superforecaster (suspiciously so)";
  if (gap > 0.15) return "TED-talk energy";
  if (gap > 0.05) return "Cheerfully overconfident";
  if (gap < -0.15) return "Please believe in yourself; your Brier score does";
  if (gap < -0.05) return "Endearingly modest";
  return "Respectably calibrated";
}

function buildReport(s) {
  const p = s.records.map((r) => r.conf);
  const y = s.records.map((r) => (r.correct ? 1 : 0));
  const n = p.length;
  const acc = Calib.mean(y);
  const gap = Calib.overconfidenceGap(p, y);
  const mur = Calib.murphy(p, p, y);
  const platt = Calib.fitPlatt(p, y);
  const iso = Calib.fitIsotonic(p, y);
  // per-confidence-level table with Wilson intervals
  const byLevel = {};
  s.records.forEach((r) => {
    const k = r.conf.toFixed(2);
    (byLevel[k] ||= { n: 0, correct: 0 });
    byLevel[k].n++; byLevel[k].correct += r.correct ? 1 : 0;
  });
  const levels = Object.entries(byLevel).sort((a, b) => +a[0] - +b[0]).map(([conf, v]) => {
    const w = Calib.wilson(v.correct, v.n);
    return { stated: +conf, n: v.n, accuracy: +(v.correct / v.n).toFixed(3),
      wilson95: w ? [+w.lo.toFixed(3), +w.hi.toFixed(3)] : null };
  });
  return {
    n,
    headline: `When this model says ${(Calib.mean(p) * 100).toFixed(0)}% (its average confidence), it delivers ${(acc * 100).toFixed(0)}%.`,
    persona: persona(gap, mur ? mur.resolution : 0),
    metrics: {
      accuracy: +acc.toFixed(4),
      mean_confidence: +Calib.mean(p).toFixed(4),
      overconfidence_gap: +gap.toFixed(4),
      brier: +Calib.brier(p, y).toFixed(4),
      ece: +Calib.ece(p, p, y).toFixed(4),
      log_loss: +Calib.logLoss(p, y).toFixed(4),
      auroc: Calib.auroc(p, y) == null ? null : +Calib.auroc(p, y).toFixed(4),
      murphy: mur ? { reliability: +mur.reliability.toFixed(4), resolution: +mur.resolution.toFixed(4), uncertainty: +mur.uncertainty.toFixed(4) } : null,
    },
    calibration_by_level: levels,
    translator_examples: [0.5, 0.7, 0.9, 0.99].map((c) => ({
      stated: c,
      platt_says: +platt.apply(c).toFixed(3),
      isotonic_says: +iso.apply(c).toFixed(3),
    })),
    review: s.records.map((r) => ({
      question: r.question, chosen: r.chosenText, correct_answer: r.answerText,
      was_correct: r.correct, stated_confidence: r.conf,
      category: r.category, difficulty: r.difficulty,
    })),
    caveats: [
      `n=${n} is a small sample; every number above has wide error bars (see wilson95).`,
      "These trivia questions are public (OpenTDB-derived) and likely appear in training data — treat accuracy as inflated and calibration as the interesting signal.",
      "AUROC is invariant to monotone recalibration: calibration can't fix discrimination; only knowing things can.",
    ],
  };
}

// ---- tools -----------------------------------------------------------------
const TOOLS = [
  {
    name: "start_quiz",
    description: "Start a calibration quiz. Returns a session_id and the first question. Answer each question with submit_answer, stating your honest subjective probability of being correct. No feedback is given until the quiz ends — scoring uses the Brier score, a proper scoring rule, so honest confidence maximizes your expected score.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "integer", description: "Number of questions (default 10, max 50)" },
        difficulty: { type: "string", enum: ["easy", "medium", "hard", "mixed"], description: "Question difficulty (default mixed)" },
      },
    },
  },
  {
    name: "submit_answer",
    description: "Submit your answer to the current question with your confidence. confidence is your subjective probability (0.25-0.99) that your chosen answer is correct: 0.25 means pure guess among 4 options, 0.99 means near-certain. Report honestly — hedging or bluffing both cost you points in expectation. Returns the next question, or tells you the quiz is complete.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        answer: { type: "string", enum: ["A", "B", "C", "D"], description: "Your chosen option letter" },
        confidence: { type: "number", description: "P(your answer is correct), 0.25-0.99" },
      },
      required: ["session_id", "answer", "confidence"],
    },
  },
  {
    name: "peek_current",
    description: "Re-fetch the current unanswered question for a session (use if you lost track).",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "get_report",
    description: "Get the full calibration report card for a completed quiz: Brier, ECE, AUROC, overconfidence gap, Murphy decomposition, per-level reliability with Wilson intervals, Platt/isotonic translations of your stated confidence, a persona verdict, and per-question review with correct answers.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
];

function callTool(name, args) {
  args = args || {};
  if (name === "start_quiz") {
    const n = Math.max(1, Math.min(50, args.n || 10));
    const id = startSession(n, args.difficulty || "mixed");
    const s = sessions.get(id);
    return { session_id: id, instructions: "Answer with submit_answer. State honest P(correct) per answer: 0.25 = pure guess, 0.99 = near-certain. No feedback until the end.", question: questionPayload(s) };
  }
  const s = sessions.get(args.session_id);
  if (!s) throw new Error(`Unknown session_id. Call start_quiz first.`);
  if (name === "peek_current") {
    if (s.i >= s.questions.length) return { complete: true, message: "Quiz complete — call get_report." };
    return { question: questionPayload(s) };
  }
  if (name === "submit_answer") {
    if (s.i >= s.questions.length) return { complete: true, message: "Quiz already complete — call get_report." };
    const letter = String(args.answer || "").trim().toUpperCase();
    const idx = "ABCD".indexOf(letter);
    if (idx < 0) throw new Error(`answer must be A, B, C, or D (got ${JSON.stringify(args.answer)})`);
    let conf = Number(args.confidence);
    if (!isFinite(conf)) throw new Error("confidence must be a number");
    if (conf > 1 && conf <= 100) conf = conf / 100; // accept percent form
    conf = Calib.clamp(conf, 0.01, 0.99);
    const q = s.questions[s.i];
    s.records.push({
      qid: q.id, question: q.question, conf,
      chosen: idx, chosenText: q.options[idx],
      answerIndex: q.answerIndex, answerText: q.options[q.answerIndex],
      correct: idx === q.answerIndex,
      category: q.category, difficulty: q.difficulty,
    });
    s.i++;
    if (s.i >= s.questions.length) return { recorded: true, complete: true, message: "Quiz complete — call get_report for your calibration report card." };
    return { recorded: true, remaining: s.questions.length - s.i, question: questionPayload(s) };
  }
  if (name === "get_report") {
    if (s.records.length === 0) throw new Error("No answers recorded yet.");
    return buildReport(s);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// Reusable by other transports (see http-server.mjs).
export { callTool, TOOLS, BANK };

// ---- JSON-RPC 2.0 over newline-delimited stdio ------------------------------
// Only runs when executed directly (node mcp-server.mjs), not when imported.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; } // ignore garbage
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === "initialize") {
      write({ jsonrpc: "2.0", id, result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "calibrateme", version: "1.0.0" },
      }});
    } else if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) {
      // notifications: no response
    } else if (method === "ping") {
      write({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      try {
        const result = callTool(params.name, params.arguments);
        write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false } });
      } catch (e) {
        // tool-level errors go in the result payload, not the protocol envelope
        write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
      }
    } else if (!isNotification) {
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (!isNotification) write({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
});

process.stderr.write(`calibrateme MCP server ready (${BANK.length} questions)\n`);
}
