/* Lap detection against the real session, and against synthetic runs that look nothing
   like it.

   The detector was written against one 30-minute Michigan endurance file, and a detector
   tuned to one track is a detector that quietly stops working on the next one. These
   cases vary the things that actually differ between events: lap length from an autocross
   loop to a long circuit, lap count from two to fifty, sample rate, and how much crawling
   around the paddock brackets the running.

   The Michigan case is the regression guard -- 22 timed laps, best 1:03.15 -- and the
   synthetic ones are the generality guard.

     node scripts/check-laps.mjs                                                        */

import { readFileSync, existsSync } from 'node:fs';
import { WORKER_SRC } from '../lib/viewer/parse.js';
import { channelStats, nameIndex, timeColumn, resolveRoles } from '../lib/viewer/session.js';
import { buildXY, buildDistance, detectLaps, timedLaps } from '../lib/viewer/track.js';

let failures = 0;
function check(ok, what){
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
  return ok;
}

/* ---- synthetic: a car going round a loop at a steady speed ---------------------- */
function lapRun({ radius, laps, hz = 20, speed = 15, warmup = 0, cooldown = 0 }){
  const lapLen = 2 * Math.PI * radius;
  const lapT = lapLen / speed;
  const n = Math.round((laps * lapT + warmup + cooldown) * hz);
  const lat0 = 42.45, lon0 = -76.47;
  const mLat = 111132, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const t = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n);
  const sp = new Float32Array(n);
  let ang = 0;
  for (let i = 0; i < n; i++){
    const time = i / hz;
    t[i] = time;
    /* Crawl in and out of the paddock: on the loop but far too slow to be a lap. */
    const inRun = time >= warmup && time <= warmup + laps * lapT;
    const v = inRun ? speed : 1.2;
    ang += (v / radius) / hz;
    lat[i] = lat0 + (radius * Math.cos(ang)) / mLat;
    lon[i] = lon0 + (radius * Math.sin(ang)) / mLon;
    sp[i] = v * 3.6;
  }
  const { x, y } = buildXY(lat, lon, n);
  const dist = buildDistance({ n, t, speed: sp, x, y, distChannel: null });
  return { n, t, x, y, dist, speed: sp, lapT };
}

console.log('synthetic loops');
const cases = [
  { name: 'autocross-sized loop, 8 laps',    radius: 22,  laps: 8,  speed: 12 },
  { name: 'club circuit, 5 laps',            radius: 180, laps: 5,  speed: 25 },
  { name: 'long circuit, 3 laps',            radius: 500, laps: 3,  speed: 35 },
  { name: 'endurance, 40 laps',              radius: 120, laps: 40, speed: 20 },
  { name: 'only 2 laps',                     radius: 120, laps: 2,  speed: 20 },
  { name: '50 Hz logger',                    radius: 120, laps: 6,  speed: 20, hz: 50 },
  { name: 'with an out-lap and an in-lap',   radius: 120, laps: 6,  speed: 20, warmup: 40, cooldown: 40 },
  /* FSAE skidpad: a 15 m circle, laps under five seconds. This found nothing at all
     until the detection radius stopped being fixed at 12 m -- a circle that size
     swallows the whole loop, so the car never registers as having left it. */
  { name: 'skidpad, 4.3 s laps',             radius: 7.6, laps: 12, speed: 11 },
  { name: 'tight autocross, 8.6 s laps',     radius: 15,  laps: 8,  speed: 11 },
  { name: '5 Hz GPS',                        radius: 180, laps: 6,  speed: 25, hz: 5 },
];
for (const c of cases){
  const run = lapRun(c);
  const { laps } = detectLaps({ ...run, sfIdx: null });
  const timed = timedLaps(laps);
  /* A detector sees the crossings between laps, so N laps on the ground is N-1 to N
     complete intervals depending on where the run starts and stops. */
  const okCount = timed >= c.laps - 2 && timed <= c.laps;
  const times = laps.filter(l => !l.partial).map(l => l.time);
  const spread = times.length
    ? (Math.max(...times) - Math.min(...times)) / (times.reduce((a, b) => a + b, 0) / times.length)
    : 1;
  check(okCount && spread < 0.05,
    `${c.name}: ${timed} timed (expected ~${c.laps}), ` +
    `${times.length ? times[0].toFixed(2) + ' s' : 'none'}, spread ${(spread * 100).toFixed(1)}%`);
}

/* ---- a course that touches itself: the figure-eight the heading check exists for -- */
{
  const hz = 20, n = 20 * 60 * hz, R = 90, speed = 18;
  const lat0 = 42.45, lon0 = -76.47, mLat = 111132, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const t = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n);
  const sp = new Float32Array(n);
  const lapLen = 4 * Math.PI * R, lapT = lapLen / speed;
  for (let i = 0; i < n; i++){
    t[i] = i / hz;
    const u = ((i / hz) % lapT) / lapT * 2 * Math.PI;
    /* Lemniscate: crosses its own centre once a lap, in opposite directions. */
    const d = 1 + Math.sin(u) ** 2;
    lat[i] = lat0 + (R * Math.cos(u) / d) / mLat;
    lon[i] = lon0 + (R * Math.sin(u) * Math.cos(u) / d) / mLon;
    sp[i] = speed * 3.6;
  }
  const { x, y } = buildXY(lat, lon, n);
  const dist = buildDistance({ n, t, speed: sp, x, y, distChannel: null });
  const { laps } = detectLaps({ n, t, x, y, dist, speed: sp, sfIdx: null });
  const expect = Math.floor((n / hz) / lapT);
  check(Math.abs(timedLaps(laps) - expect) <= 2,
    `figure-eight crossing itself: ${timedLaps(laps)} timed (expected ~${expect})`);
}

/* ---- the real thing ------------------------------------------------------------- */
const file = process.argv[2] || 'data/endurance.csv';
if (!existsSync(file)){
  console.log(`\n(skipping the real session: ${file} not found)`);
} else {
  console.log(`\n${file}`);
  const bytes = readFileSync(file);
  const body = WORKER_SRC.replace(/onmessage[\s\S]*$/, '') + '\nreturn parseAll(BUF);';
  // eslint-disable-next-line no-new-func
  const m = new Function('BUF', 'postMessage', body)(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), () => {});

  const stats = channelStats(m.cols, m.n);
  const { byName, dupe } = nameIndex(m.names, stats);
  const t = timeColumn(m.cols, byName, m.n);
  const { role } = resolveRoles({ names: m.names, units: m.units, stats });
  const col = k => (role[k] >= 0 ? m.cols[role[k]] : null);
  const { x, y } = buildXY(col('lat'), col('lon'), m.n);
  const dist = buildDistance({
    n: m.n, t, speed: col('speed'), x, y,
    distChannel: role.dist >= 0 ? m.cols[role.dist] : null,
  });
  const { laps } = detectLaps({ n: m.n, t, x, y, dist, speed: col('speed'), sfIdx: null });
  const valid = laps.filter(l => !l.partial);
  const best = valid.length ? Math.min(...valid.map(l => l.time)) : NaN;

  check(timedLaps(laps) === 22, `22 timed laps (got ${timedLaps(laps)})`);
  check(Math.abs(best - 63.15) < 0.02, `best lap 1:03.15 (got ${best.toFixed(2)} s)`);
  check(laps.some(l => l.partial), 'the driver change is flagged as a partial, not a lap');
  void dupe;
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
