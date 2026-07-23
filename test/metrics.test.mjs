// Tests for calibration.js — the pure math core shared by the web toy, this
// suite, and any future scoring service.
//
// Run:  node test/metrics.test.mjs
//
// Reference numbers for brier/logLoss/ece/murphy/wilson were cross-checked
// against numpy (sklearn was unavailable in the build env, so the equivalent
// closed-form expressions were used; the numpy call is noted at each fixture).
// PAV and AUROC fixtures are hand-computed and shown in the comments.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Calib = require(join(__dirname, "..", "calibration.js"));
assert.ok(Calib && typeof Calib.brier === "function", "Calib loaded from calibration.js");

// The page must actually load the same module we just tested — guard against
// the script tag being dropped or renamed during an index.html refactor.
const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
assert.ok(/<script src="calibration\.js"><\/script>/.test(html),
  'index.html references <script src="calibration.js">');

// ---- test harness ----------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
}
const approx = (a, b, tol = 1e-9, msg = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a} (tol ${tol})`);

// ======================================================================
// PAV / isotonic regression
// ======================================================================
test("PAV: already-monotone data is unchanged", () => {
  // p distinct, means [0,1,1] already non-decreasing -> no pooling
  const iso = Calib.fitIsotonic([0.25, 0.55, 0.85], [0, 1, 1]);
  approx(iso.apply(0.25), 0, 1e-12, "level .25");
  approx(iso.apply(0.55), 1, 1e-12, "level .55");
  approx(iso.apply(0.85), 1, 1e-12, "level .85");
});

test("PAV: single violator gets pooled (hand-computed)", () => {
  // values [0,1,0,1] at x [.25,.40,.55,.70]; the middle 1,0 violate ->
  // pool to 0.5 -> result [0, 0.5, 0.5, 1]
  const iso = Calib.fitIsotonic([0.25, 0.40, 0.55, 0.70], [0, 1, 0, 1]);
  approx(iso.apply(0.25), 0, 1e-12);
  approx(iso.apply(0.40), 0.5, 1e-12);
  approx(iso.apply(0.55), 0.5, 1e-12);
  approx(iso.apply(0.70), 1, 1e-12);
});

test("PAV: cascading merge with weights pools everything to 0.6", () => {
  // level .25: 5 pts, 4 correct (mean .8); .55: 5 pts, 3 correct (.6);
  // .85: 5 pts, 2 correct (.4). Decreasing => all pool: (4+3+2)/15 = 0.6
  const p = [], y = [];
  const push = (lv, k, n) => { for (let i = 0; i < n; i++) { p.push(lv); y.push(i < k ? 1 : 0); } };
  push(0.25, 4, 5); push(0.55, 3, 5); push(0.85, 2, 5);
  const iso = Calib.fitIsotonic(p, y);
  approx(iso.apply(0.25), 0.6, 1e-12);
  approx(iso.apply(0.55), 0.6, 1e-12);
  approx(iso.apply(0.85), 0.6, 1e-12);
  assert.equal(iso.knots.length, 1, "all levels pooled into one block");
});

// ======================================================================
// AUROC (Mann-Whitney U, ties = 0.5)
// ======================================================================
test("AUROC: perfect separation = 1", () => {
  approx(Calib.auroc([0.2, 0.4, 0.6, 0.8], [0, 0, 1, 1]), 1, 1e-12);
});
test("AUROC: all tied = 0.5", () => {
  approx(Calib.auroc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5, 1e-12);
});
test("AUROC: mixed with one tie = 0.875 (hand-computed)", () => {
  // pairs: (.6>.3)=1, (.6=.6)=.5, (.9>.3)=1, (.9>.6)=1 => 3.5/4
  approx(Calib.auroc([0.3, 0.6, 0.6, 0.9], [0, 0, 1, 1]), 0.875, 1e-12);
});
test("AUROC: all-correct is null, not NaN", () => {
  assert.equal(Calib.auroc([0.3, 0.6, 0.9], [1, 1, 1]), null);
});
test("AUROC: all-wrong is null, not NaN", () => {
  assert.equal(Calib.auroc([0.3, 0.6, 0.9], [0, 0, 0]), null);
});
test("AUROC: invariant under strictly-monotone recalibration (Platt)", () => {
  const p = [0.25, 0.4, 0.55, 0.7, 0.85, 0.99, 0.25, 0.7, 0.4, 0.85];
  const y = [0, 0, 1, 1, 1, 1, 0, 0, 1, 1];
  const raw = Calib.auroc(p, y);
  const platt = Calib.fitPlatt(p, y);
  const pp = p.map(platt.apply);
  approx(Calib.auroc(pp, y), raw, 1e-9, "Platt preserves ranking");
});

// ======================================================================
// Brier / log loss / ECE / Murphy (numpy-verified)
// ======================================================================
test("Brier matches numpy (0.2475)", () => {
  // np.mean((np.array([.9,.8,.3,.5])-np.array([1,0,0,1]))**2) -> 0.2475
  approx(Calib.brier([0.9, 0.8, 0.3, 0.5], [1, 0, 0, 1]), 0.2475, 1e-12);
});
test("Log loss matches numpy (0.69115513814...) with eps=1e-3", () => {
  // -np.mean(y*log(clip(p,1e-3,1-1e-3))+(1-y)*log(1-clip)) -> 0.6911551381476512
  approx(Calib.logLoss([0.9, 0.8, 0.3, 0.5], [1, 0, 0, 1]), 0.6911551381476512, 1e-12);
});
test("Log loss clamps isotonic 0/1 pools instead of returning Infinity", () => {
  // isotonic can output exactly 0 or 1; clamp keeps log loss finite
  const v = Calib.logLoss([0, 1], [1, 0]); // maximally wrong but clamped
  assert.ok(isFinite(v) && v > 0, "finite, positive");
});
test("ECE matches hand/numpy value (0.2)", () => {
  approx(Calib.ece([0.25, 0.25, 0.85, 0.85], [0.25, 0.25, 0.85, 0.85], [0, 1, 1, 1]), 0.2, 1e-12);
});
test("Murphy: reliability-resolution+uncertainty reconstructs Brier", () => {
  const stated = [0.25, 0.25, 0.85, 0.85], y = [0, 1, 1, 1];
  const d = Calib.murphy(stated, stated, y);
  approx(d.reliability, 0.0425, 1e-12, "reliability");
  approx(d.resolution, 0.0625, 1e-12, "resolution");
  approx(d.uncertainty, 0.1875, 1e-12, "uncertainty");
  const recon = d.reliability - d.resolution + d.uncertainty;
  approx(recon, Calib.brier(stated, y), 1e-12, "reconstruction == brier");
  approx(recon, 0.1675, 1e-12);
});

// ======================================================================
// Wilson interval (numpy-verified)
// ======================================================================
test("Wilson 8/10 at 95% matches numpy [0.4902, 0.9433]", () => {
  const w = Calib.wilson(8, 10, 1.96);
  approx(w.center, 0.716737949370015, 1e-12, "center");
  approx(w.lo, 0.49015684672072335, 1e-12, "lo");
  approx(w.hi, 0.9433190520193067, 1e-12, "hi");
});
test("Wilson n=0 is null", () => { assert.equal(Calib.wilson(0, 0), null); });

// ======================================================================
// Platt: recover a known sigmoid
// ======================================================================
test("Platt recovers known (a,b) from synthetic data", () => {
  // Deterministic LCG so the test is reproducible.
  let s = 123456789;
  const rand = () => { s = (1103515245 * s + 12345) % 2147483648; return s / 2147483648; };
  const A = 2.0, B = -0.5;
  const p = [], y = [];
  for (let i = 0; i < 8000; i++) {
    const pr = 0.02 + 0.96 * rand();          // stated confidence in (0.02,0.98)
    const z = Math.log(pr / (1 - pr));
    const prob = 1 / (1 + Math.exp(-(A * z + B)));
    p.push(pr); y.push(rand() < prob ? 1 : 0);
  }
  const fit = Calib.fitPlatt(p, y);
  approx(fit.a, A, 0.15, "slope a");
  approx(fit.b, B, 0.15, "intercept b");
});

test("Platt never scores worse than uncalibrated on log loss (identity is in-family)", () => {
  // Regression: undamped Newton diverged on discrete overconfident data,
  // producing log loss far above the identity's. The identity (a=1,b=0) is a
  // feasible point, so the fit must be <= uncalibrated on the objective.
  let s = 7;
  const rand = () => { s = (1103515245 * s + 12345) % 2147483648; return s / 2147483648; };
  const L = Calib.LIKERT;
  const p = [], y = [];
  for (let i = 0; i < 210; i++) {
    const c = L[Math.floor(rand() * 6)];
    p.push(c); y.push(rand() < Math.max(0.05, c - 0.22) ? 1 : 0);
  }
  const rawLL = Calib.logLoss(p, y);
  const fit = Calib.fitPlatt(p, y);
  const plattLL = Calib.logLoss(p.map(fit.apply), y);
  assert.ok(plattLL <= rawLL + 1e-9, `platt logloss ${plattLL} <= raw ${rawLL}`);
  // and AUROC is preserved (monotone map, same tie structure on 6 levels)
  approx(Calib.auroc(p.map(fit.apply), y), Calib.auroc(p, y), 1e-9, "AUROC preserved");
});

test("Platt is stable on perfectly-separable data (all correct)", () => {
  const p = [0.25, 0.4, 0.55, 0.7, 0.85, 0.99];
  const fit = Calib.fitPlatt(p, [1, 1, 1, 1, 1, 1]);
  assert.ok(isFinite(fit.a) && isFinite(fit.b), "no NaN/Inf");
  const out = p.map(fit.apply);
  assert.ok(out.every((v) => v >= 0 && v <= 1 && isFinite(v)), "outputs in [0,1]");
});

// ======================================================================
// Binning
// ======================================================================
test("Binning: Laplace smoothing (correct+1)/(n+2), unseen -> identity", () => {
  // level .25 used 4x with 1 correct -> (1+1)/(4+2)=1/3; other levels unseen
  const p = [0.25, 0.25, 0.25, 0.25], y = [1, 0, 0, 0];
  const fit = Calib.fitBinning(p, y);
  approx(fit.apply(0.25), 1 / 3, 1e-12, "seen level smoothed");
  approx(fit.apply(0.85), 0.85, 1e-12, "unseen level falls back to identity");
});

// ======================================================================
// Linear regression baseline
// ======================================================================
test("Linear: recovers a known line y = 0.8x + 0.05", () => {
  // build points exactly on the line so OLS must return the same slope/intercept
  const p = [0.25, 0.40, 0.55, 0.70, 0.85, 0.99];
  const y = p.map((x) => 0.8 * x + 0.05);
  const fit = Calib.fitLinear(p, y);
  approx(fit.m, 0.8, 1e-9, "slope");
  approx(fit.c, 0.05, 1e-9, "intercept");
  approx(fit.apply(0.5), 0.45, 1e-9, "apply mid-range");
});
test("Linear: output is clamped to [0,1]", () => {
  // a steep line through {0.25->0, 0.99->1} extrapolates outside [0,1]; clamp holds
  const fit = Calib.fitLinear([0.25, 0.99], [0, 1]);
  const v0 = fit.apply(0.1), v1 = fit.apply(1.0);
  assert.ok(v0 >= 0 && v1 <= 1, `clamped: ${v0}, ${v1}`);
});
test("Linear: zero-variance input degrades to the base rate, no divide-by-zero", () => {
  // everyone answered at 0.85; slope is undefined -> constant mean(y)
  const fit = Calib.fitLinear([0.85, 0.85, 0.85, 0.85], [1, 0, 1, 1]);
  assert.equal(fit.m, 0);
  approx(fit.apply(0.85), 0.75, 1e-12, "= base rate 3/4");
  approx(fit.apply(0.25), 0.75, 1e-12, "constant everywhere");
});

// ======================================================================
// Full-pipeline smoke test: simulated 200-answer overconfident history
// ======================================================================
test("Pipeline: 200-answer overconfident history, no NaNs, calibration helps", () => {
  let s = 42;
  const rand = () => { s = (1103515245 * s + 12345) % 2147483648; return s / 2147483648; };
  const L = Calib.LIKERT;
  const p = [], y = [];
  for (let i = 0; i < 200; i++) {
    const lvl = L[Math.floor(rand() * L.length)];
    p.push(lvl);
    // overconfident: true accuracy well below stated confidence
    const trueAcc = Math.max(0.05, lvl - 0.22);
    y.push(rand() < trueAcc ? 1 : 0);
  }
  const methods = {
    uncalibrated: Calib.fitIdentity(),
    linear: Calib.fitLinear(p, y),
    platt: Calib.fitPlatt(p, y),
    isotonic: Calib.fitIsotonic(p, y),
    binning: Calib.fitBinning(p, y),
  };
  const rawBrier = Calib.brier(p, y);
  assert.ok(isFinite(rawBrier), "raw brier finite");
  for (const [name, mdl] of Object.entries(methods)) {
    const preds = p.map(mdl.apply);
    const b = Calib.brier(preds, y);
    const ll = Calib.logLoss(preds, y);
    const e = Calib.ece(p, preds, y);
    const au = Calib.auroc(preds, y);
    assert.ok(isFinite(b) && isFinite(ll) && isFinite(e), `${name}: metrics finite`);
    assert.ok(au === null || (au >= 0 && au <= 1), `${name}: auroc valid`);
    assert.ok(preds.every((v) => v >= 0 && v <= 1 && isFinite(v)), `${name}: preds in [0,1]`);
    if (name !== "uncalibrated") {
      // on the fitting data, recalibration should not worsen Brier
      assert.ok(b <= rawBrier + 1e-9, `${name}: brier ${b} <= raw ${rawBrier}`);
    }
  }
  // AUROC invariance: Platt == uncalibrated (strictly monotone)
  const auRaw = Calib.auroc(p, y);
  const auPlatt = Calib.auroc(p.map(methods.platt.apply), y);
  approx(auPlatt, auRaw, 1e-9, "Platt AUROC == raw AUROC");
});

// ======================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
