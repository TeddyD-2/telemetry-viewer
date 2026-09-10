/* The numbers behind the chart types, and importing a second session to compare against.

   Every one of these draws a plausible chart when it is wrong: a histogram whose top
   bin drops the maximum, a spectrum scaled by the wrong window sum, a fit solved in
   badly conditioned raw units, an imported session whose laps start somewhere else on
   the track. So each is checked against an answer known in advance.

     node scripts/check-analysis.mjs                                                    */

import { readFileSync, existsSync } from 'node:fs';
import { WORKER_SRC } from '../lib/viewer/parse.js';
import {
  describe, histogram, welch, polyfit, resampleOnto, valueAt, sectorTimes,
  indexWindow, lowerBound, upperBound, quantile,
} from '../lib/viewer/analysis.js';
import { deriveSession } from '../lib/viewer/compare.js';
import { timedLaps } from '../lib/viewer/track.js';

let failures = 0;
function check(ok, what){
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
  return ok;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('window statistics');
{
  const col = Float64Array.from({ length: 100 }, (_, i) => i + 1);
  const t = Float64Array.from({ length: 100 }, (_, i) => i * 0.1);
  const s = describe(col, 0, 99, t);
  check(s.n === 100 && s.min === 1 && s.max === 100, `min/max over 1..100 (${s.min}, ${s.max})`);
  check(near(s.mean, 50.5, 1e-9) && near(s.p50, 50.5, 1e-9), `mean and median 50.5 (${s.mean}, ${s.p50})`);
  check(near(s.sd, Math.sqrt((100 * 100 - 1) / 12), 1e-9), `population SD (${s.sd.toFixed(4)})`);
  check(near(s.p5, 5.95, 1e-9) && near(s.p95, 95.05, 1e-9), `5th/95th percentile interpolate (${s.p5}, ${s.p95})`);
  /* trapezoid of y = x+1 sampled every 0.1 s over 9.9 s */
  check(near(s.integral, (1 + 100) / 2 * 9.9, 1e-9), `time integral (${s.integral})`);
  col[50] = NaN;
  const g = describe(col, 0, 99, t);
  check(g.n === 99 && near(g.integral, (1 + 100) / 2 * 9.9 - (50 + 51) / 2 * 0.1 - (51 + 52) / 2 * 0.1, 1e-9),
    'a gap is skipped, not integrated across');
  check(describe(col, 10, 5).n === 0, 'empty window gives n = 0');
  check(quantile(new Float64Array([4]), 0.95) === 4, 'quantile of one value');
}

console.log('windows and searches');
{
  const xs = new Float64Array([0, 1, 1, 1, 2, 3]);
  check(lowerBound(xs, 1) === 1 && upperBound(xs, 1) === 4, 'bounds across a plateau');
  const [i0, i1] = indexWindow(xs, xs.length, 0.5, 2);
  check(i0 === 1 && i1 === 4, `window [0.5, 2] is samples 1..4 (got ${i0}..${i1})`);
  const [e0, e1] = indexWindow(xs, xs.length, 3.5, 9);
  check(e1 < e0 || e0 === e1, 'window past the end is empty or one sample at most');
}

console.log('histogram');
{
  const col = new Float64Array([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, NaN]);
  const h = histogram(col, 0, col.length - 1, 0, 4, 4);
  check([...h].join(',') === '2,2,2,3', `bins [0,1) [1,2) [2,3) [3,4] (got ${[...h]})`);
  check(h.reduce((a, b) => a + b, 0) === 9, 'every finite sample counted once, the maximum included');
  const flat = histogram(new Float64Array([5, 5, 5]), 0, 2, 5, 5, 10);
  check(flat[0] === 3, 'a flat channel lands in one bin rather than dividing by zero');
}

console.log('spectrum');
{
  const hz = 100, n = 8192, dt = 1 / hz;
  const f1 = 3.125, a1 = 2, f2 = 12.5, a2 = 0.5;          // both on bin centres for nfft 1024
  const col = Float64Array.from({ length: n }, (_, i) =>
    40 + a1 * Math.sin(2 * Math.PI * f1 * i * dt) + a2 * Math.sin(2 * Math.PI * f2 * i * dt));
  const s = welch(col, 0, n - 1, dt, 1024);
  const peakNear = f => {
    let k = Math.round(f / s.df);
    return { f: s.freq[k], a: s.amp[k] };
  };
  const p1 = peakNear(f1), p2 = peakNear(f2);
  check(s && s.n === 1024 && near(s.df, hz / 1024, 1e-12), `1024-sample segments at ${s.df.toFixed(4)} Hz resolution`);
  check(near(p1.a, a1, 0.02), `amplitude 2 at ${f1} Hz reads ${p1.a.toFixed(3)}`);
  check(near(p2.a, a2, 0.02), `amplitude 0.5 at ${f2} Hz reads ${p2.a.toFixed(3)}`);
  let kmax = 1;
  for (let k = 1; k < s.amp.length; k++) if (s.amp[k] > s.amp[kmax]) kmax = k;
  check(near(s.freq[kmax], f1, s.df / 2), `largest peak is the 3.125 Hz tone (${s.freq[kmax].toFixed(3)} Hz)`);
  check(s.amp[0] < 0.05, `the 40-unit offset is removed, not a wall at 0 Hz (${s.amp[0].toFixed(4)})`);
  check(welch(col, 0, 8, dt, 1024) === null, 'too few samples gives no spectrum rather than a bogus one');
}

console.log('curve fits');
{
  /* Speed-sized x: raw powers of 80 next to a constant are what break a naive solve. */
  const m = 400, x = new Float64Array(m), y = new Float64Array(m);
  for (let k = 0; k < m; k++){ x[k] = 20 + k * 0.2; y[k] = 0.002 * x[k] ** 2 - 0.1 * x[k] + 3; }
  const q = polyfit(x, y, m, 2);
  check(q && near(q.coef[2], 0.002, 1e-9) && near(q.coef[1], -0.1, 1e-7) && near(q.coef[0], 3, 1e-5),
    `quadratic recovered in raw units (${q && q.coef.map(c => c.toPrecision(4)).join(', ')})`);
  check(q && near(q.r2, 1, 1e-9), `R² of an exact fit is 1 (${q && q.r2})`);
  const l = polyfit(new Float64Array([0, 1, 2, NaN]), new Float64Array([1, 3, 5, 7]), 4, 1);
  check(l && near(l.coef[1], 2, 1e-12) && near(l.coef[0], 1, 1e-12) && l.n === 3, 'a line, skipping a NaN');
  check(polyfit(new Float64Array([1, 1, 1]), new Float64Array([1, 2, 3]), 3, 1) === null,
    'x with no spread gives no fit rather than a vertical line');
}

console.log('resampling');
{
  const sx = new Float64Array([0, 1, 2, 2, 3]);           // distance standing still at 2
  const sy = new Float64Array([0, 10, 20, 20, 30]);
  const out = resampleOnto(sx, sy, new Float64Array([-1, 0, 0.5, 2, 2.5, 3, 4]), 0);
  check(Number.isNaN(out[0]) && Number.isNaN(out[6]), 'outside the source is a gap');
  check(near(out[1], 0, 1e-6) && near(out[2], 5, 1e-6) && near(out[3], 20, 1e-6) && near(out[4], 25, 1e-6) && near(out[5], 30, 1e-6),
    `linear inside, across a plateau (${[...out].map(v => +v.toFixed(2))})`);
  const shifted = resampleOnto(sx, sy, new Float64Array([10, 11]), -9.5);
  check(near(shifted[0], 5, 1e-6) && near(shifted[1], 15, 1e-6), 'shift moves the read point');
  const back = resampleOnto(sx, sy, new Float64Array([2.5, 0.5]), 0);
  check(near(back[0], 25, 1e-6) && near(back[1], 5, 1e-6), 'a destination that goes backwards');
  check(near(valueAt(sx, sy, 1, 4, 2.5), 25, 1e-9), 'valueAt inside a sub-range');
}

console.log('sectors');
{
  const n = 1001, dist = new Float64Array(n), t = new Float64Array(n);
  for (let i = 0; i < n; i++){ t[i] = i * 0.1; dist[i] = 5 * t[i] + 0.4 * t[i] ** 2; }
  const lap = { i0: 100, i1: 900, t0: t[100], t1: t[900], d0: dist[100], d1: dist[900] };
  const s = sectorTimes(dist, t, lap, 3);
  check(near(s.reduce((a, b) => a + b, 0), lap.t1 - lap.t0, 1e-9), 'sectors sum to the lap time');
  check(s[0] > s[1] && s[1] > s[2], `an accelerating car takes less time per sector (${s.map(v => v.toFixed(2))})`);
}

/* ---- importing a second session against the real one ---------------------------- */
const file = process.argv[2] || 'data/endurance.csv';
if (!existsSync(file)){
  console.log(`\n(skipping the real session: ${file} not found)`);
} else {
  console.log(`\n${file}, imported against itself`);
  const bytes = readFileSync(file);
  const body = WORKER_SRC.replace(/onmessage[\s\S]*$/, '') + '\nreturn parseAll(BUF);';
  // eslint-disable-next-line no-new-func
  const m = new Function('BUF', 'postMessage', body)(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), () => {});

  const P = deriveSession(m);
  const P_frame = { x: P.x, y: P.y, n: P.n, sf: P.sf, origin: null };
  check(timedLaps(P.laps) === 22, `the open session: 22 timed laps (got ${timedLaps(P.laps)})`);

  /* The same run with its first 9 minutes cut off: a different logger start, so a
     different time base and a different set of lap boundaries if left to itself. */
  const cut = 20 * 60 * 9;
  const trimmed = {
    meta: m.meta, names: m.names, units: m.units, n: m.n - cut,
    cols: m.cols.map(c => c.slice(cut)),
  };
  const origin = (() => {
    let s = 0, c = 0, s2 = 0;
    const lat = m.cols[P.role.lat], lon = m.cols[P.role.lon];
    for (let i = 0; i < m.n; i++) if (Math.abs(lat[i]) > 0.01){ s += lat[i]; s2 += lon[i]; c++; }
    return { lat0: s / c, lon0: s2 / c };
  })();
  P_frame.origin = origin;
  const S = deriveSession(trimmed, { frame: P_frame });
  check(S.sfMatched, 'the imported session is timed from the open session\'s line');
  const sfGap = Math.hypot(S.x[S.sf] - P.x[P.sf], S.y[S.sf] - P.y[P.sf]);
  check(sfGap < 3, `its line is ${sfGap.toFixed(2)} m from the open session's`);

  const bestOf = X => X.laps.filter(l => !l.partial).reduce((a, l) => (l.time < a.time ? l : a), { time: Infinity });
  const pb = bestOf(P), sb = bestOf(S);
  check(near(pb.time, sb.time, 0.1), `same best lap either way (${pb.time.toFixed(2)} vs ${sb.time.toFixed(2)} s)`);

  /* Delta-t of that lap against itself, on the distance grid the lap view uses. */
  const grid = Float64Array.from({ length: 1500 }, (_, k) => k * Math.min(pb.d1 - pb.d0, sb.d1 - sb.d0) / 1499);
  /* A margin either side: an interpolated boundary can fall a few samples outside the
     sample nearest the line. The lap view reads laps the same way. */
  const tIn = (X, l) => {
    const a = Math.max(0, l.i0 - 8), b = Math.min(X.n, l.i1 + 9);
    return resampleOnto(X.dist.subarray(a, b), X.t.subarray(a, b), grid, l.d0, Float64Array);
  };
  const ta = tIn(P, pb), tb = tIn(S, sb);
  let worst = 0, gaps = 0;
  for (let k = 0; k < grid.length; k++){
    const d = Math.abs((tb[k] - sb.t0) - (ta[k] - pb.t0));
    if (d === d) worst = Math.max(worst, d); else gaps++;
  }
  check(gaps === 0, `no gaps on the grid (${gaps})`);
  check(near(pb.time, sb.time, 0.02), `lap times agree once both are timed from one line (${pb.time.toFixed(3)} vs ${sb.time.toFixed(3)} s)`);
  check(worst < 0.03, `delta-t of the best lap against its imported copy stays within ${worst.toFixed(3)} s`);

  const sp = P.role.speed;
  check(S.role.speed >= 0 && S.names[S.role.speed] === P.names[sp], 'the imported session finds the same speed channel');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
