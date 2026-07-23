# The Overconfidence Olympiad

A silly-but-statistically-honest web toy. Answer trivia, rate how sure you are,
and then watch four calibration methods — uncalibrated, Platt scaling, isotonic
regression, and histogram binning — try to rescue your Brier score. They can
only do so much, and the toy is upfront about exactly how much.

**No data leaves your browser.** Every question, every metric, and your entire
answer history live in `localStorage`. There is no server, no analytics, no
network call at runtime — it's `index.html` plus `calibration.js` (the pure math
core, kept separate so tests and tooling can import it).

The profile screen has a **"You vs. the machines"** tab that plots your
calibration curve alongside three frozen frontier-model baselines (Opus, Fable,
Haiku) that each played a 60–75 question hard set. Those baselines are baked into
the page as `(confidence, correct)` pairs and re-scored client-side — no server
needed to compare yourself against the AIs.

> _Add a screenshot here — the results reliability diagram, or the "You vs. the
> machines" small-multiples, is the money view._

## Play it

Open `index.html` in any browser — straight from `file://`, no build step, no
dependencies, works offline.

## What it measures

After each round you get a reliability diagram (with Wilson error bars that are
honestly enormous when your sample is small), a metrics table, and a verdict.

| Metric | Plain English |
| --- | --- |
| **Brier** | Mean squared distance between your confidence and reality. 0 is perfect, 0.25 is coin-flip energy. |
| **ECE** | On average, how far your stated confidence sits from your actual accuracy. |
| **Log loss** | Punishes confident mistakes brutally. |
| **AUROC** | Can your confidence tell right answers from wrong ones *at all*? Invariant to recalibration — the punchline is that calibration can't fix discrimination; only knowing things can. |

The **overconfidence gap** (mean confidence − accuracy) drives your verdict
persona, from "Superforecaster (suspiciously so)" to "TED-talk energy."

Calibration fits use your **full career history**, accumulated across rounds, so
the statistics get more honest the more you play. Disclaimers scale down as your
`n` grows.

## Question bank

1,054 general-trivia multiple-choice questions across eight categories
(geography, history, science, arts & literature, sports, pop culture, food &
drink, words & language), roughly 30% easy / 40% medium / 30% hard. Difficulty
spread is the point: overconfidence only reveals itself on hard questions.

A majority of the questions are **derived from and modified from** the
[Open Trivia Database](https://opentdb.com), whose contributed questions are
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
— HTML-decoded, de-duplicated, filtered for time-drifting facts, rebalanced,
answer-shuffled, and reformatted (full change list in
[`LICENSE-questions.md`](LICENSE-questions.md)). The rest (~230 questions across
food, words, and the hard tier) are hand-written.

## Licensing

- **Code** (`index.html` markup/CSS/JS, `calibration.js`, `mcp-server.mjs`,
  `tools/`, tests) — [MIT](LICENSE).
- **Question bank** (the embedded `QUESTION_BANK`) — a separate work under
  [**CC BY-SA 4.0**](https://creativecommons.org/licenses/by-sa/4.0/), because it
  derives from the Open Trivia Database. Attribution and the ShareAlike
  obligation are documented in [`LICENSE-questions.md`](LICENSE-questions.md): if
  you adapt the bank, you must share the adaptation under CC BY-SA 4.0 too.

## Tests

All metric and calibration functions live in `calibration.js` — a dependency-free
module with no DOM or I/O, loaded by the page as a plain `<script>` and imported
directly by the test suite (and importable from Node for scoring anything else,
humans or LLMs alike).

```bash
node test/metrics.test.mjs
```

Covers PAV isotonic (incl. a violator fixture), AUROC with ties and degenerate
cases, Brier / ECE / log loss / Wilson against numpy-verified reference values,
Platt recovering a known sigmoid, and a 200-answer end-to-end pipeline smoke
test.

## Where the AI baselines came from

The three model baselines in the "You vs. the machines" tab weren't hand-typed —
each model actually played the quiz. `mcp-server.mjs` exposes it as an MCP tool
server (`start_quiz`, `submit_answer`, `peek_current`, `get_report`) over stdio,
scored by the same `calibration.js`; three trios of Opus / Fable / Haiku runs
were played through it, then frozen into `index.html` with
`tools/export_ai_baselines.mjs`. The MCP server is report-only (nothing is
persisted) and stays in the repo so anyone can let a model play for fun:

```bash
claude mcp add calibrateme -- node /absolute/path/to/mcp-server.mjs
# or: the checked-in .mcp.json registers it automatically for sessions in this repo
```

Then: *"Start a 25-question hard quiz with the calibrateme tools, answer only
from your own knowledge with honest confidence, then show me your report."*
Caveat baked into every report: the public OpenTDB questions are likely in
training data, so model accuracy is inflated — the calibration gap is the signal.

## Deploy to GitHub Pages

Serverless again, so it's a static drop:

1. Push this repo to GitHub with `index.html` at the root.
2. **Settings → Pages → Build and deployment → Deploy from a branch.**
3. Choose branch **`main`**, folder **`/ (root)`**, and save.
4. Live at `https://<user>.github.io/<repo>/` within a minute.

## Repo layout

```
index.html              # the whole app: CSS, UI, embedded question bank + AI baselines
calibration.js          # pure math core: fits + metrics (browser & Node)
mcp-server.mjs          # MCP stdio server so a model can play (report-only, no persistence)
.mcp.json               # registers the MCP server for Claude Code sessions in this repo
test/metrics.test.mjs   # node test suite for calibration.js
tools/                  # authoring-time only
  fetch_bank.mjs        # pulls + cleans questions from OpenTDB
  build_bank.mjs        # merges/dedupes/balances and splices the bank into index.html
  export_ai_baselines.mjs  # freezes model runs into the "You vs. the machines" baselines
```

## Rebuilding the question bank (optional)

```bash
node tools/fetch_bank.mjs /tmp/opentdb_clean.json   # ~2-3 min (rate-limited)
# add any hand-written gen_*.json fills alongside it, then:
node tools/build_bank.mjs /tmp                        # splices into index.html
```
