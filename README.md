# The Overconfidence Olympiad

A silly-but-statistically-honest web toy. Answer trivia, rate how sure you are,
and then watch four calibration methods — uncalibrated, Platt scaling, isotonic
regression, and histogram binning — try to rescue your Brier score. They can
only do so much, and the toy is upfront about exactly how much.

**Unified backend.** Humans (in the browser) and AI models (via the API or MCP)
play the same questions through one server, scored by one shared math core
(`calibration.js`), and land on one leaderboard. Run it with `node server.mjs`.

> _Add a screenshot here once deployed — a shot of the results screen (verdict
> + reliability diagram) is the money view._

## Play it

```bash
node server.mjs           # then open http://localhost:8899
```

The only runtime dependency is Node (no npm install — the server uses the
standard library). Humans play in the browser; models play the same API.

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

Questions are sourced from the [Open Trivia Database](https://opentdb.com)
(licensed **CC BY-SA 4.0**), cleaned and rebalanced, plus hand-written fills for
the thin categories and the genuinely-hard tier. The question bank in
`index.html` is therefore also distributed under **CC BY-SA 4.0**; the code is
MIT.

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

## Running it

```bash
node server.mjs            # unified server on http://localhost:8899
```

Open `http://localhost:8899` to play in the browser. Both the page and the API
are served from that one origin; every finished run (human or model) persists to
`runs.json` and feeds the leaderboard.

API (same origin, no CORS):

```
POST /api/start    {player, playerType, model, n, difficulty}  -> session + Q1
POST /api/answer   {session_id, answer, confidence}            -> next Q / complete
GET  /api/report?session_id=...                                -> report (persists)
GET  /api/career?player=...                                    -> aggregated records+metrics
GET  /api/leaderboard                                          -> best-calibrated / best-forecaster / hall-of-shame
GET  /api/runs   |   GET /api/run?id=...                       -> stored runs
```

## MCP server (let an LLM play)

`mcp-server.mjs` exposes the quiz as MCP tools (`start_quiz`, `submit_answer`,
`peek_current`, `get_report`) over stdio — zero dependencies, scored by the same
`calibration.js` as the web toy. The model answers trivia, states a probability
per answer, gets no feedback until the end, and receives a full calibration
report card (Brier, ECE, AUROC, Murphy, persona verdict).

```bash
claude mcp add calibrateme -- node /absolute/path/to/mcp-server.mjs
# or: the checked-in .mcp.json registers it automatically for sessions in this repo
```

Then ask the model to play: *"Start a 20-question quiz with the calibrateme
tools, answer honestly with your true confidence, then show me your report."*
Caveat: the public question bank is OpenTDB-derived and likely in training
data — treat accuracy as inflated; calibration is the interesting signal.

## Deploy

The leaderboard needs the Node server running, so this is no longer a static
GitHub Pages drop — it needs a host that runs `node server.mjs` (Render, Fly,
Railway, a small VPS, etc.). Bind the port from `$PORT` if your host sets one:
`node server.mjs $PORT`. Persistence is a flat `runs.json`; point it at a volume
if you want runs to survive redeploys.

## Repo layout

```
index.html              # the web app: CSS, UI, embedded question bank
calibration.js          # pure math core: fits + metrics (browser & Node)
server.mjs              # unified HTTP backend: page + /api + leaderboard + persistence
mcp-server.mjs          # MCP stdio server (agents); shares quiz logic with server.mjs
runs.json               # persisted runs (created at runtime)
test/metrics.test.mjs   # node test suite for calibration.js
tools/                  # authoring-time only
  fetch_bank.mjs        # pulls + cleans questions from OpenTDB
  build_bank.mjs        # merges/dedupes/balances and splices into index.html
```

## Rebuilding the question bank (optional)

```bash
node tools/fetch_bank.mjs /tmp/opentdb_clean.json   # ~2-3 min (rate-limited)
# add any hand-written gen_*.json fills alongside it, then:
node tools/build_bank.mjs /tmp                        # splices into index.html
```
