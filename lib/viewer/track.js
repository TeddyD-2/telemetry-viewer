/* Where the car was, and how many times it went round.

   Pure functions over the parsed columns, for the same reason as session.js: the upload
   page counts laps at import so the library card is right the moment it appears, and it
   has no viewer to do it in. */

export function colMax(c, a, b){
  let m = -Infinity;
  for (let i = a; i <= b; i++) if (c[i] > m) m = c[i];
  return m;
}

/* Local tangent-plane metres from lat/lon. Good to a few centimetres over a circuit,
   which is three orders of magnitude better than the GPS itself.

   The plane is centred on the session's own mean position unless `origin` is given. An
   imported session is projected about the open session's origin, so the two share one
   set of metres and a lap from last week can be drawn on today's map. */
export function buildXY(lat, lon, n, origin){
  if (!lat || !lon) return { x: null, y: null, origin: null };
  let lat0, lon0;
  if (origin){ ({ lat0, lon0 } = origin); }
  else {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) if (lat[i] === lat[i] && Math.abs(lat[i]) > 0.01){ s += lat[i]; c++; }
    lat0 = c ? s / c : 0;
    let s2 = 0, c2 = 0;
    for (let i = 0; i < n; i++) if (lon[i] === lon[i] && Math.abs(lon[i]) > 0.01){ s2 += lon[i]; c2++; }
    lon0 = c2 ? s2 / c2 : 0;
  }
  const mLat = 111132.0, mLon = 111320.0 * Math.cos(lat0 * Math.PI / 180);
  const x = new Float32Array(n), y = new Float32Array(n);
  for (let i = 0; i < n; i++){ x[i] = (lon[i] - lon0) * mLon; y[i] = (lat[i] - lat0) * mLat; }
  return { x, y, origin: { lat0, lon0 } };
}

export function headingAt(x, y, n, i){
  const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
  return Math.atan2(y[b] - y[a], x[b] - x[a]);
}
export const angDiff = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };

/* Distance is integrated from speed rather than summed from positions: position noise
   adds a metre or two of phantom distance every lap, and distance is the x-axis every
   lap comparison is aligned on.

   The logger's own distance channel is integrated from its own speed, so it is only the
   right answer while the speed source is the one that would have been picked anyway.
   Once the user overrides the speed role, integrate from what they chose -- otherwise
   the picker would silently fail to move the axis the comparison is drawn against. */
export function buildDistance({ n, t, speed, distChannel, x, y }){
  if (distChannel) return distChannel;
  const dist = new Float32Array(n);
  if (speed){
    let acc = 0;
    for (let i = 1; i < n; i++){
      acc += Math.max(0, speed[i]) / 3.6 * (t[i] - t[i-1]);
      dist[i] = acc;
    }
  } else if (x){
    let acc = 0;
    for (let i = 1; i < n; i++){ acc += Math.hypot(x[i]-x[i-1], y[i]-y[i-1]); dist[i] = acc; }
  }
  return dist;
}

/* Lap detection by start/finish proximity *and heading*.

   Proximity alone is not enough. On an out-and-back layout the two legs run within a few
   metres of each other, so a circle around any point on them catches the car twice a lap
   -- which on this Michigan data produced 43 "laps" alternating 14.5 s and 50 s. Requiring
   each pass to share the candidate's direction of travel (within 60 deg) discards the
   return leg, because a real start/finish line is crossed one way. The same check handles
   the crossing of a figure-eight and any other place the track touches itself.

   Candidates are then scored on the *fraction* of intervals near the median, not just how
   many: a double-crossing point still yields plenty of consistent intervals, it just
   yields an equal number of inconsistent ones. Judging by fraction also leaves room for
   the genuine outliers -- the out-lap, the in-lap, and the driver change -- without them
   poisoning the detection. */
export function detectLaps({ n, t, x, y, dist, speed, sfIdx, gate }){
  if (!x) return { laps: [], sf: null };
  const dt = t[1] - t[0] || 0.05;
  const moving = i => !speed || speed[i] > 8;
  const GAP = Math.max(20, Math.round(0.8 / dt));
  const HEAD_TOL = Math.PI / 3;

  /* Two numbers used to be fixed at values that suited one 30-minute circuit run, and
     both of them are wrong somewhere the team actually competes.

     The detection radius has to be small enough that the circle does not swallow a
     meaningful part of the course. On a skidpad -- 7.6 m radius, the whole loop 15 m
     across -- a 12 m circle contains nearly the entire lap, so there is never a moment
     the car has "left" and the detector finds nothing at all. Rather than derive a
     radius from geometry and hope, try a few and keep the first that produces a
     consistent set of laps: the circuit case still matches on 12 and costs nothing.

     The minimum interval that counts as a lap was a flat 5 seconds, which is longer than
     a skidpad lap. It is now tied to how long the car must be clear of the circle before
     a second pass can be counted at all, which is the real physical floor. */
  const RADII = [12, 6, 20, 3, 30];
  const minLap = Math.max(1.2, GAP * dt * 1.5);

  const headingAt = i => {
    const a = Math.max(0, i-3), b = Math.min(n-1, i+3);
    return Math.atan2(y[b] - y[a], x[b] - x[a]);
  };
  const angDiff = (a, b) => { const d = Math.abs(a-b) % (2*Math.PI); return d > Math.PI ? 2*Math.PI - d : d; };

  const passes = (ci, R) => {
    const px = x[ci], py = y[ci], h0 = headingAt(ci), out = [];
    let run = null;
    const close = () => { if (run && angDiff(headingAt(run.best), h0) < HEAD_TOL) out.push(run.best); run = null; };
    for (let i = 0; i < n; i++){
      const d = Math.hypot(x[i] - px, y[i] - py);
      if (d < R){ if (!run) run = { best: i, bd: d }; else if (d < run.bd){ run.bd = d; run.best = i; } run.e = i; }
      else if (run && i - run.e > GAP) close();
    }
    close();
    return out;
  };
  const score = cr => {
    if (cr.length < 3) return null;
    const it = []; for (let i = 1; i < cr.length; i++) it.push(t[cr[i]] - t[cr[i-1]]);
    const ok = it.filter(v => v > minLap);
    if (ok.length < 2) return null;
    const med = ok.slice().sort((a, b) => a - b)[ok.length >> 1];
    const good = it.filter(v => v > med * 0.75 && v < med * 1.25);
    const frac = good.length / it.length;
    if (good.length < 2 || frac < 0.6) return null;
    const mean = good.reduce((a, b) => a + b, 0) / good.length;
    const sd = Math.sqrt(good.reduce((a, b) => a + (b - mean) ** 2, 0) / good.length);
    return { n: good.length, frac, sd, cr };
  };

  let best = null;
  for (const R of RADII){
    if (sfIdx != null){ best = score(passes(sfIdx, R)); if (best) best.ci = sfIdx; }
    if (!best){
      const step = Math.max(1, Math.floor(n / 180));
      for (let ci = 0; ci < n; ci += step){
        if (!moving(ci)) continue;
        const s = score(passes(ci, R));
        const better = s && (!best || s.n > best.n
          || (s.n === best.n && s.frac > best.frac + 1e-9)
          || (s.n === best.n && Math.abs(s.frac - best.frac) < 1e-9 && s.sd < best.sd));
        if (better){ s.ci = ci; best = s; }
      }
    }
    if (best) break;   // the first radius that works is the one the course wants
  }
  if (!best) return { laps: [], sf: null };

  /* Where each pass actually crossed the line, between samples.

     A pass is found as the sample nearest the start/finish point, which at 20 Hz can be
     a metre and a half either side of it. Within one session that washes out -- every
     lap is off by a similar amount -- but a lap from another session starts from a
     different sample, and a 1.5 m disagreement about where the lap begins is a quarter
     of a second of delta-t through a slow corner that is not really there.

     The line is a gate across the track at the start/finish point, square to the
     direction of travel there; each crossing is interpolated to where the car's path
     goes through it. An imported session is given the open session's gate, so both are
     timed from the same line on the tarmac rather than from each one's nearest sample. */
  const gx = gate ? gate.x : x[best.ci], gy = gate ? gate.y : y[best.ci];
  const gh = gate ? gate.h : headingAt(best.ci);
  const gc = Math.cos(gh), gs = Math.sin(gh);
  const along = i => (x[i] - gx) * gc + (y[i] - gy) * gs;
  const crossing = i => {
    for (let k = 0; k <= 6; k++){
      for (const j of k ? [i - k, i + k - 1] : [i - 1, i]){
        if (j < 0 || j + 1 >= n) continue;
        const a = along(j), b = along(j + 1);
        if (a <= 0 && b > 0){
          const f = -a / (b - a);
          return { t: t[j] + f * (t[j+1] - t[j]), d: dist[j] + f * (dist[j+1] - dist[j]) };
        }
      }
    }
    return { t: t[i], d: dist[i] };
  };

  const cr = best.cr, laps = [];
  const at = cr.map(crossing);
  for (let i = 1; i < cr.length; i++){
    laps.push({ i0: cr[i-1], i1: cr[i], t0: at[i-1].t, t1: at[i].t,
      time: at[i].t - at[i-1].t, d0: at[i-1].d, d1: at[i].d });
  }
  /* A lap far off the median is an in/out lap or a stop, not a representative lap;
     excluded from "best lap" so one 282 s driver change cannot be mistaken for one. */
  const ts = laps.map(l => l.time).sort((a, b) => a - b);
  const med = ts[ts.length >> 1] || 0;
  laps.forEach((l, k) => {
    l.n = k + 1;
    l.partial = l.time < med * 0.75 || l.time > med * 1.25;
    l.maxSpeed = speed ? colMax(speed, l.i0, l.i1) : NaN;
  });
  const valid = laps.filter(l => !l.partial);
  const bt = valid.length ? Math.min(...valid.map(l => l.time)) : Infinity;
  laps.forEach(l => { l.best = (!l.partial && l.time === bt); });
  return { laps, sf: best.ci };
}

export const timedLaps = laps => laps.filter(l => !l.partial).length;
