// calibration.js — the pure math core of the Overconfidence Olympiad.
// No DOM, no localStorage, no I/O: just calibration fits and metrics over
// parallel arrays p[] (stated probabilities) and y[] (0/1 outcomes).
//
// Consumers:
//   browser  : <script src="calibration.js"></script>  -> window.Calib
//   node CJS : const Calib = require("./calibration.js")
//   node ESM : import Calib from "./calibration.js"    (CJS default interop)
//
// Keep this file dependency-free and side-effect-free (beyond the exports);
// it is shared by the web toy, the test suite, and any future scoring
// service or MCP server.

const Calib = (function () {
  "use strict";

  // The six confidence levels the UI offers, mapped to probabilities.
  // 4 options => chance = 0.25 is the floor; 0.99 is the ceiling ("Certain").
  const LIKERT = [0.25, 0.40, 0.55, 0.70, 0.85, 0.99];
  const LIKERT_LABELS = ["Total guess", "Hunch", "Leaning", "Fairly sure", "Confident", "Certain"];

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const logit = (p) => Math.log(p / (1 - p));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

  // ---- input hygiene ---------------------------------------------------
  // Everything downstream assumes p[] (predictions in (0,1)) and y[] (0/1),
  // equal length. NaN-free by construction: guards return null, never NaN.

  // ---- calibration: uncalibrated (identity) ----------------------------
  function fitIdentity() {
    return { method: "uncalibrated", apply: (p) => p };
  }

  // ---- calibration: Platt scaling --------------------------------------
  // Fit sigma(a * logit(p) + b) by Newton's method. p is clamped to
  // [0.01, 0.99] before the logit so 0.25/0.99 stay finite. A tiny ridge
  // keeps the 2x2 Hessian invertible when data is perfectly separable
  // (e.g. a fresh player who got everything right).
  function fitPlatt(p, y, opts) {
    const iters = (opts && opts.iters) || 25;
    const ridge = (opts && opts.ridge != null) ? opts.ridge : 1e-6;
    const n = p.length;
    if (n === 0) return { method: "platt", a: 1, b: 0, apply: (x) => x, degenerate: true };
    const z = p.map((v) => logit(clamp(v, 0.01, 0.99)));
    // negative log-likelihood, the convex objective we're minimizing
    const nll = (a, b) => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const q = clamp(sigmoid(a * z[i] + b), 1e-12, 1 - 1e-12);
        s -= y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q);
      }
      return s;
    };
    // Start at the identity (a=1,b=0). Damped Newton with a backtracking line
    // search only ever accepts a step that lowers the NLL, so the fit is
    // guaranteed no worse than uncalibrated — pure Newton can overshoot and
    // diverge here because the objective, while convex, isn't quadratic.
    let a = 1, b = 0, cur = nll(a, b);
    for (let it = 0; it < iters; it++) {
      let g0 = 0, g1 = 0;          // gradient
      let h00 = 0, h01 = 0, h11 = 0; // Hessian (symmetric)
      for (let i = 0; i < n; i++) {
        const q = sigmoid(a * z[i] + b);
        const d = q - y[i];
        g0 += d * z[i];
        g1 += d;
        const w = q * (1 - q);
        h00 += w * z[i] * z[i];
        h01 += w * z[i];
        h11 += w;
      }
      h00 += ridge; h11 += ridge;
      const det = h00 * h11 - h01 * h01;
      if (!isFinite(det) || Math.abs(det) < 1e-12) break;
      const da = (h11 * g0 - h01 * g1) / det;
      const db = (h00 * g1 - h01 * g0) / det;
      let step = 1, na = a, nb = b, nn = cur;
      for (let ls = 0; ls < 25; ls++) {
        na = a - step * da; nb = b - step * db; nn = nll(na, nb);
        if (isFinite(nn) && nn <= cur + 1e-12) break;
        step *= 0.5;
      }
      if (!(nn < cur - 1e-10)) break; // converged (no further improvement)
      a = na; b = nb; cur = nn;
    }
    const apply = (x) => sigmoid(a * logit(clamp(x, 0.01, 0.99)) + b);
    return { method: "platt", a, b, apply };
  }

  // ---- calibration: isotonic regression (PAV) --------------------------
  // Pool Adjacent Violators on (confidence, correct) sorted by confidence.
  // Returns a weakly-increasing step function. Points sharing an x are
  // aggregated first so the fit is a clean step over the distinct levels.
  function fitIsotonic(p, y) {
    const n = p.length;
    if (n === 0) return { method: "isotonic", knots: [], apply: (x) => x, degenerate: true };
    // aggregate by unique x
    const byX = new Map();
    for (let i = 0; i < n; i++) {
      const key = p[i];
      const cur = byX.get(key) || { x: key, sum: 0, w: 0 };
      cur.sum += y[i]; cur.w += 1;
      byX.set(key, cur);
    }
    // blocks sorted by x ascending
    let blocks = [...byX.values()]
      .sort((u, v) => u.x - v.x)
      .map((b) => ({ x: b.x, xHi: b.x, value: b.sum / b.w, w: b.w }));
    // PAV: merge while a block's value is below its left neighbour's
    let i = 0;
    while (i < blocks.length - 1) {
      if (blocks[i].value > blocks[i + 1].value + 1e-12) {
        const A = blocks[i], B = blocks[i + 1];
        const merged = {
          x: A.x, xHi: B.xHi,
          value: (A.value * A.w + B.value * B.w) / (A.w + B.w),
          w: A.w + B.w,
        };
        blocks.splice(i, 2, merged);
        if (i > 0) i--; // step back to re-check the new left violation
      } else {
        i++;
      }
    }
    // knots: for lookup we need each block's x-span and value
    const knots = blocks.map((b) => ({ x: b.x, xHi: b.xHi, y: b.value, w: b.w }));
    const apply = (x) => {
      if (knots.length === 0) return x;
      if (x <= knots[0].x) return knots[0].y;
      if (x >= knots[knots.length - 1].xHi) return knots[knots.length - 1].y;
      // last block whose starting x is <= x (step function, left value wins)
      let best = knots[0];
      for (const k of knots) { if (k.x <= x + 1e-12) best = k; else break; }
      return best.y;
    };
    return { method: "isotonic", knots, apply };
  }

  // ---- calibration: histogram binning ----------------------------------
  // Bin by the 6 Likert levels; replace each with Laplace-smoothed accuracy
  // (correct+1)/(count+2). Levels never used fall back to identity so we
  // don't invent a 0.5 for a bin we have no evidence about.
  function fitBinning(p, y, levels) {
    const L = levels || LIKERT;
    const stat = L.map((lv) => ({ p: lv, n: 0, correct: 0 }));
    const idx = (v) => {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < L.length; i++) { const d = Math.abs(L[i] - v); if (d < bd) { bd = d; bi = i; } }
      return bi;
    };
    for (let i = 0; i < p.length; i++) {
      const b = stat[idx(p[i])];
      b.n += 1; b.correct += y[i];
    }
    const levelsOut = stat.map((b) => ({
      p: b.p, n: b.n, correct: b.correct,
      acc: b.n > 0 ? (b.correct + 1) / (b.n + 2) : null, // Laplace; null = unseen
    }));
    const apply = (x) => {
      const b = levelsOut[idx(x)];
      return b.acc == null ? x : b.acc; // unseen level -> identity
    };
    return { method: "binning", levels: levelsOut, apply };
  }

  // ---- calibration: linear regression ----------------------------------
  // Ordinary least squares of correctness on stated confidence:
  // f(p) = m*p + c, the straight-line best fit through your reliability dots.
  // The baseline every engineer already knows. Unlike Platt it can predict
  // below 0 or above 1, so the output is clamped; if every answer used the
  // same confidence (zero variance) it degrades to the constant base rate.
  function fitLinear(p, y) {
    const n = p.length;
    if (n === 0) return { method: "linear", m: 1, c: 0, apply: (x) => x, degenerate: true };
    const mx = mean(p), my = mean(y);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (p[i] - mx) ** 2; sxy += (p[i] - mx) * (y[i] - my); }
    const m = sxx < 1e-12 ? 0 : sxy / sxx;
    const c = my - m * mx;
    return { method: "linear", m, c, apply: (x) => clamp(m * x + c, 0, 1) };
  }

  // ---- grouping by stated Likert level (for ECE / Murphy / reliability) -
  function groupByLevel(pStated, preds, y, levels) {
    const L = levels || LIKERT;
    const idx = (v) => {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < L.length; i++) { const d = Math.abs(L[i] - v); if (d < bd) { bd = d; bi = i; } }
      return bi;
    };
    const bins = L.map((lv) => ({ level: lv, n: 0, sumPred: 0, sumY: 0 }));
    for (let i = 0; i < pStated.length; i++) {
      const b = bins[idx(pStated[i])];
      b.n += 1; b.sumPred += preds[i]; b.sumY += y[i];
    }
    return bins
      .filter((b) => b.n > 0)
      .map((b) => ({ level: b.level, n: b.n, meanPred: b.sumPred / b.n, acc: b.sumY / b.n }));
  }

  // ---- metrics ---------------------------------------------------------
  function brier(preds, y) {
    if (preds.length === 0) return null;
    let s = 0;
    for (let i = 0; i < preds.length; i++) s += (preds[i] - y[i]) ** 2;
    return s / preds.length;
  }

  const LOGLOSS_EPS = 1e-3; // clamp so isotonic pools at exactly 0/1 don't blow up
  function logLoss(preds, y) {
    if (preds.length === 0) return null;
    let s = 0;
    for (let i = 0; i < preds.length; i++) {
      const p = clamp(preds[i], LOGLOSS_EPS, 1 - LOGLOSS_EPS);
      s += y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p);
    }
    return -s / preds.length;
  }

  // ECE over the stated Likert bins: sum_k (n_k/N) |meanPred_k - acc_k|.
  function ece(pStated, preds, y, levels) {
    if (pStated.length === 0) return null;
    const g = groupByLevel(pStated, preds, y, levels);
    const N = pStated.length;
    let e = 0;
    for (const b of g) e += (b.n / N) * Math.abs(b.meanPred - b.acc);
    return e;
  }

  // Murphy decomposition: Brier = reliability - resolution + uncertainty.
  // Binned by stated Likert level; forecast per bin = mean(preds in bin).
  function murphy(pStated, preds, y, levels) {
    if (pStated.length === 0) return null;
    const g = groupByLevel(pStated, preds, y, levels);
    const N = pStated.length;
    const base = mean(y);
    let reliability = 0, resolution = 0;
    for (const b of g) {
      reliability += b.n * (b.meanPred - b.acc) ** 2;
      resolution += b.n * (b.acc - base) ** 2;
    }
    reliability /= N; resolution /= N;
    const uncertainty = base * (1 - base);
    return { reliability, resolution, uncertainty, brier: reliability - resolution + uncertainty, base };
  }

  // AUROC via rank statistic (Mann-Whitney U), ties counted as 0.5.
  // Returns null (never NaN) when one class is empty -> UI shows "—".
  function auroc(preds, y) {
    const n = preds.length;
    let nPos = 0, nNeg = 0;
    for (let i = 0; i < n; i++) { if (y[i] === 1) nPos++; else nNeg++; }
    if (nPos === 0 || nNeg === 0) return null;
    // average ranks (1-based), ties share the mean rank
    const order = [...Array(n).keys()].sort((i, j) => preds[i] - preds[j]);
    const rank = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && preds[order[j + 1]] === preds[order[i]]) j++;
      const r = (i + j) / 2 + 1; // mean of 1-based ranks i+1..j+1
      for (let k = i; k <= j; k++) rank[order[k]] = r;
      i = j + 1;
    }
    let rankSumPos = 0;
    for (let k = 0; k < n; k++) if (y[k] === 1) rankSumPos += rank[k];
    const U = rankSumPos - (nPos * (nPos + 1)) / 2;
    return U / (nPos * nNeg);
  }

  // Overconfidence gap: mean stated confidence - accuracy. Drives the verdict.
  function overconfidenceGap(pStated, y) {
    if (pStated.length === 0) return null;
    return mean(pStated) - mean(y);
  }

  // Wilson score interval for k/n at z (default 95%). n=0 -> null.
  function wilson(k, n, z) {
    if (n === 0) return null;
    z = z || 1.96;
    const phat = k / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (phat + z2 / (2 * n)) / denom;
    const half = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
    return { center, lo: clamp(center - half, 0, 1), hi: clamp(center + half, 0, 1), phat };
  }

  return {
    LIKERT, LIKERT_LABELS,
    clamp, sigmoid, logit, mean,
    fitIdentity, fitPlatt, fitIsotonic, fitBinning, fitLinear,
    groupByLevel,
    brier, logLoss, ece, murphy, auroc, overconfidenceGap, wilson,
    LOGLOSS_EPS,
  };
})();
if (typeof globalThis !== "undefined") globalThis.Calib = Calib;
if (typeof module !== "undefined" && module.exports) module.exports = Calib;
