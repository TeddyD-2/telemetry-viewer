/* A second session, opened next to the first so the two can be compared.

   The open session is the reference frame: its channel names, its map projection, its
   start/finish line. An imported session is derived the same way the viewer derives its
   own -- statistics, roles, distance, laps, all from session.js and track.js -- and then
   bent into that frame, because every comparison depends on the two agreeing about
   something:

   - Roles. A file from the same car usually has the same logger configuration, so where
     name matching cannot settle a role on its own (two live "GPS Speed" channels), the
     open session's answer is tried by name before giving up. Roles stored with a library
     session win over both, as they do everywhere else.
   - Position. It is projected about the open session's origin, so its laps can be drawn
     on the same map.
   - The start/finish line. Laps are compared on distance into the lap, so two sessions
     that start their laps at different points on the circuit produce an overlay that is
     wrong everywhere while looking entirely plausible. The imported session's laps are
     timed from the sample nearest the open session's line, travelling the same way. Only
     if nothing passes within 25 m -- a different track -- does it find its own.

   Pure, so scripts/check-analysis.mjs runs it against the real file. */

import { channelStats, nameIndex, timeColumn, resolveRoles, rolesFromNames } from './session.js';
import { buildXY, buildDistance, detectLaps, headingAt, angDiff } from './track.js';

export function deriveSession(m, { roles, like, frame } = {}){
  const stats = channelStats(m.cols, m.n);
  const { byName, dupe, label } = nameIndex(m.names, stats);
  const S = {
    meta: m.meta || {}, names: m.names, units: m.units, cols: m.cols, n: m.n,
    stats, byName, dupe, label,
  };
  S.t = timeColumn(m.cols, byName, m.n);

  const { role, ambiguous } = resolveRoles(S);
  const fallback = rolesFromNames(like, m.names, dupe);
  for (const k of Object.keys(fallback)) if (!(role[k] >= 0)) role[k] = fallback[k];
  Object.assign(role, rolesFromNames(roles, m.names, dupe));
  S.role = role;
  S.roleAmbig = ambiguous;

  const col = k => (S.role[k] >= 0 ? S.cols[S.role[k]] : null);
  project(S, frame && frame.origin);
  const dch = S.role.dist;
  S.dist = buildDistance({
    n: S.n, t: S.t, speed: col('speed'), x: S.x, y: S.y,
    distChannel: dch >= 0 && !S.stats[dch].flat ? S.cols[dch] : null,
  });
  timeLaps(S, frame);
  return S;
}

export function project(S, origin){
  const col = k => (S.role[k] >= 0 ? S.cols[S.role[k]] : null);
  const { x, y } = buildXY(col('lat'), col('lon'), S.n, origin);
  S.x = x; S.y = y;
}

/* frame: { x, y, n, sf } of the open session. */
export function timeLaps(S, frame){
  const speed = S.role.speed >= 0 ? S.cols[S.role.speed] : null;
  const sfIdx = matchLine(S, frame, speed);
  const gate = sfIdx != null
    ? { x: frame.x[frame.sf], y: frame.y[frame.sf], h: headingAt(frame.x, frame.y, frame.n, frame.sf) }
    : undefined;
  const { laps, sf } = detectLaps({ n: S.n, t: S.t, x: S.x, y: S.y, dist: S.dist, speed, sfIdx, gate });
  S.laps = laps; S.sf = sf; S.sfMatched = sfIdx != null && sf === sfIdx;
}

const SF_REACH = 25;   // metres; past this it is not the same line

function matchLine(S, P, speed){
  if (!S.x || !P || !P.x || P.sf == null) return null;
  const px = P.x[P.sf], py = P.y[P.sf], ph = headingAt(P.x, P.y, P.n, P.sf);
  let best = -1, bd = SF_REACH;
  for (let i = 0; i < S.n; i++){
    if (speed && !(speed[i] > 8)) continue;
    const d = Math.hypot(S.x[i] - px, S.y[i] - py);
    if (d >= bd) continue;
    if (angDiff(headingAt(S.x, S.y, S.n, i), ph) > Math.PI / 3) continue;
    bd = d; best = i;
  }
  return best >= 0 ? best : null;
}

/* The column in S that plays the part of `name` in the open session: the same label
   (so "GPS Speed #2" finds the second one when S duplicates it too), then the same raw
   name (which resolves a duplicate to the live one), then a case-insensitive match. */
export function matchChannel(S, label, name){
  let j = S.label.indexOf(label);
  if (j < 0 && S.byName[name] !== undefined) j = S.byName[name];
  if (j < 0){
    const lo = label.toLowerCase();
    j = S.label.findIndex(l => l.toLowerCase() === lo);
  }
  return j;
}
