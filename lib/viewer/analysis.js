/* The numbers behind the chart types that are not simply "a column against time":
   window statistics, histograms, spectra, curve fits, and moving one session's samples
   onto another's axis so the two can share a chart.

   Pure functions over typed arrays, like session.js and track.js, so
   scripts/check-analysis.mjs can test them without a browser. A histogram with an
   off-by-one bin edge or a spectrum scaled by the wrong window sum still draws a
   perfectly plausible chart -- these are the places where being wrong is silent. */

/* First index with a[i] >= v, searching [lo, hi). */
export function lowerBound(a, v, lo = 0, hi = a.length){
  while (lo < hi){ const m = (lo + hi) >>> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
/* First index with a[i] > v. */
export function upperBound(a, v, lo = 0, hi = a.length){
  while (lo < hi){ const m = (lo + hi) >>> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

/* The samples whose x lies inside [x0, x1], as an inclusive index pair. An empty window
   comes back with i1 < i0, which every loop below already treats as "nothing". */
export function indexWindow(xs, n, x0, x1){
  const i0 = lowerBound(xs, x0, 0, n);
  const i1 = upperBound(xs, x1, 0, n) - 1;
  return [Math.min(i0, n - 1), Math.max(-1, Math.min(i1, n - 1))];
}

export function quantile(sorted, p){
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * p, lo = Math.floor(h), hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/* Everything a statistics table shows, over samples i0..i1. NaNs are gaps, not zeros.
   `t` turns on the time integral, trapezoidal, skipping any interval that touches a gap
   -- integrating across a dropout would invent area that was never measured. */
export function describe(col, i0, i1, t){
  const len = Math.max(0, i1 - i0 + 1);
  const vals = new Float64Array(len);
  let n = 0, sum = 0, sq = 0, mn = Infinity, mx = -Infinity, integral = 0;
  for (let i = i0; i <= i1; i++){
    const v = col[i];
    if (v !== v) continue;
    vals[n++] = v; sum += v; sq += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (t && i > i0){
      const p = col[i - 1];
      if (p === p) integral += (v + p) / 2 * (t[i] - t[i - 1]);
    }
  }
  if (!n) return { n: 0, min: NaN, max: NaN, mean: NaN, sd: NaN, rms: NaN,
    p5: NaN, p50: NaN, p95: NaN, integral: NaN };
  const sorted = vals.subarray(0, n).sort();
  const mean = sum / n;
  return {
    n, min: mn, max: mx, mean,
    sd: Math.sqrt(Math.max(0, sq / n - mean * mean)),
    rms: Math.sqrt(sq / n),
    p5: quantile(sorted, 0.05), p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95),
    integral: t ? integral : NaN,
  };
}

export function finiteRange(col, i0, i1){
  let mn = Infinity, mx = -Infinity;
  for (let i = i0; i <= i1; i++){ const v = col[i]; if (v === v){ if (v < mn) mn = v; if (v > mx) mx = v; } }
  return mn <= mx ? [mn, mx] : null;
}

/* Counts per bin over [lo, hi]. The top edge belongs to the last bin -- otherwise the
   maximum sample, which is exactly the one people look for, falls off the end. */
export function histogram(col, i0, i1, lo, hi, bins){
  const out = new Float64Array(bins);
  const span = hi - lo;
  if (!(span > 0)){
    for (let i = i0; i <= i1; i++) if (col[i] === col[i]) out[0]++;
    return out;
  }
  for (let i = i0; i <= i1; i++){
    const v = col[i];
    if (!(v >= lo && v <= hi)) continue;
    out[Math.min(bins - 1, Math.floor((v - lo) / span * bins))]++;
  }
  return out;
}

/* The typical sample interval, robust to the odd dropped sample. */
export function medianStep(t, i0, i1){
  const n = i1 - i0;
  if (n < 1) return NaN;
  const stride = Math.max(1, Math.floor(n / 2000));
  const d = [];
  for (let i = i0 + stride; i <= i1; i += stride) d.push((t[i] - t[i - stride]) / stride);
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

/* In-place iterative radix-2 FFT. n must be a power of two. */
export function fft(re, im){
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++){
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j){
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1){
    const half = len >> 1, ang = -2 * Math.PI / len;
    for (let k = 0; k < half; k++){
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (let i = 0; i < n; i += len){
        const a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/* Amplitude spectrum by Welch's method: Hann-windowed segments overlapping by half,
   power averaged across them. One FFT of a whole 30-minute window is mostly noise at any
   single frequency; averaging segments is what makes a damper's 2-3 Hz body mode stand
   out as a peak rather than a slightly taller spike among thousands.

   Scaled so a sine of amplitude A reads A at its frequency (single-sided, divided by the
   window's own sum rather than by N, which is what the Hann window's coherent gain
   requires). Each segment has its own mean removed, so a channel sitting at 80 km/h does
   not put a wall at 0 Hz that the log axis then has to accommodate. */
export function welch(col, i0, i1, dt, nfft = 1024){
  const n = i1 - i0 + 1;
  let N = 1;
  while (N * 2 <= Math.min(nfft, n)) N *= 2;
  if (N < 16 || !(dt > 0)) return null;
  const hop = N >> 1;
  const w = new Float64Array(N);
  let wsum = 0;
  for (let k = 0; k < N; k++){ w[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (N - 1)); wsum += w[k]; }
  const acc = new Float64Array(hop + 1);
  const re = new Float64Array(N), im = new Float64Array(N);
  let segs = 0;
  for (let s = i0; s + N - 1 <= i1; s += hop){
    let sum = 0, cnt = 0;
    for (let k = 0; k < N; k++){ const v = col[s + k]; if (v === v){ sum += v; cnt++; } }
    if (cnt < N / 2) continue;                          // mostly gap: skip rather than invent
    const mean = sum / cnt;
    for (let k = 0; k < N; k++){ const v = col[s + k]; re[k] = (v === v ? v - mean : 0) * w[k]; im[k] = 0; }
    fft(re, im);
    for (let k = 0; k <= hop; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  if (!segs) return null;
  const freq = new Float64Array(hop + 1), amp = new Float64Array(hop + 1);
  for (let k = 0; k <= hop; k++){
    freq[k] = k / (N * dt);
    amp[k] = (k ? 2 : 1) * Math.sqrt(acc[k] / segs) / wsum;
  }
  return { freq, amp, df: 1 / (N * dt), n: N, segments: segs };
}

/* Least-squares polynomial of degree 1-3 through points (x[k], y[k]), k < m.

   x is centred and scaled before the normal equations are built: speed in km/h squared
   and cubed next to a constant term is exactly the conditioning that makes a naive
   solve return garbage. Coefficients are expanded back to raw x for display. */
export function polyfit(x, y, m, deg){
  const D = deg + 1;
  let mu = 0, cnt = 0;
  for (let k = 0; k < m; k++) if (x[k] === x[k] && y[k] === y[k]){ mu += x[k]; cnt++; }
  if (cnt <= deg) return null;
  mu /= cnt;
  let s = 0;
  for (let k = 0; k < m; k++) if (x[k] === x[k] && y[k] === y[k]) s = Math.max(s, Math.abs(x[k] - mu));
  if (!(s > 0)) return null;

  const A = Array.from({ length: D }, () => new Float64Array(D + 1));
  const pw = new Float64Array(2 * D);
  let ym = 0;
  for (let k = 0; k < m; k++){
    const xv = x[k], yv = y[k];
    if (xv !== xv || yv !== yv) continue;
    const u = (xv - mu) / s;
    pw[0] = 1;
    for (let j = 1; j < 2 * D; j++) pw[j] = pw[j - 1] * u;
    for (let r = 0; r < D; r++){
      for (let c = 0; c < D; c++) A[r][c] += pw[r + c];
      A[r][D] += pw[r] * yv;
    }
    ym += yv;
  }
  ym /= cnt;
  for (let c = 0; c < D; c++){
    let p = c;
    for (let r = c + 1; r < D; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < D; r++){
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= D; j++) A[r][j] -= f * A[c][j];
    }
  }
  const cu = Array.from({ length: D }, (_, r) => A[r][D] / A[r][r]);
  const at = xv => { const u = (xv - mu) / s; let v = 0; for (let j = D - 1; j >= 0; j--) v = v * u + cu[j]; return v; };

  let ssr = 0, sst = 0;
  for (let k = 0; k < m; k++){
    if (x[k] !== x[k] || y[k] !== y[k]) continue;
    ssr += (y[k] - at(x[k])) ** 2;
    sst += (y[k] - ym) ** 2;
  }
  /* sum_j cu_j ((x - mu)/s)^j, expanded into powers of raw x. */
  const coef = new Array(D).fill(0);
  const binom = (a, b) => { let r = 1; for (let i = 1; i <= b; i++) r = r * (a - b + i) / i; return r; };
  for (let j = 0; j < D; j++)
    for (let i = 0; i <= j; i++) coef[i] += cu[j] / s ** j * binom(j, i) * (-mu) ** (j - i);
  return { deg, at, coef, r2: sst > 0 ? 1 - ssr / sst : 1, n: cnt };
}

/* srcY sampled at srcX, read off at dst[k] + shift, linearly interpolated. Outside the
   source's span the answer is NaN, which uPlot draws as a gap: an imported session that
   ran for less time than this one simply stops, rather than holding its last value.

   srcX needs only to be non-decreasing, not strictly increasing: distance stands still
   while the car does. dst is walked forwards and only binary-searched when it goes back,
   so the usual case is one linear pass. */
export function resampleOnto(srcX, srcY, dst, shift = 0, Out = Float32Array){
  const m = srcX.length, n = dst.length, out = new Out(n);
  if (m < 2){ out.fill(NaN); return out; }
  const x0 = srcX[0], x1 = srcX[m - 1];
  let j = 0;
  for (let k = 0; k < n; k++){
    const x = dst[k] + shift;
    if (!(x >= x0 && x <= x1)){ out[k] = NaN; continue; }
    if (srcX[j] > x) j = Math.max(0, lowerBound(srcX, x) - 1);
    while (j < m - 2 && srcX[j + 1] < x) j++;
    const xa = srcX[j], xb = srcX[j + 1];
    const f = xb > xa ? (x - xa) / (xb - xa) : 0;
    out[k] = srcY[j] + f * (srcY[j + 1] - srcY[j]);
  }
  return out;
}

/* ys at x, interpolating inside samples i0..i1 of a non-decreasing xs. */
export function valueAt(xs, ys, i0, i1, x){
  if (i1 < i0) return NaN;
  if (x <= xs[i0]) return ys[i0];
  if (x >= xs[i1]) return ys[i1];
  const j = lowerBound(xs, x, i0, i1 + 1);
  const xa = xs[j - 1], xb = xs[j];
  const f = xb > xa ? (x - xa) / (xb - xa) : 0;
  return ys[j - 1] + f * (ys[j] - ys[j - 1]);
}

/* Split a lap into equal fractions of its own distance and time each one.

   Fractions of the lap's own length rather than fixed metres: distance is integrated
   from speed, so the same lap on two days comes out a few metres different, and a
   boundary at a fixed 412 m would land in a slightly different place on the tarmac each
   time. The last sector ends at the lap's own finish, so the sectors always sum to the
   lap time exactly. */
export function sectorTimes(dist, t, lap, nSec){
  const out = [];
  const len = lap.d1 - lap.d0;
  let prev = lap.t0;
  for (let k = 1; k <= nSec; k++){
    const at = k === nSec ? lap.t1 : valueAt(dist, t, lap.i0, lap.i1, lap.d0 + len * k / nSec);
    out.push(at - prev);
    prev = at;
  }
  return out;
}
