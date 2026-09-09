/* What a parsed session knows about itself, before any of it is drawn.

   Everything here is a pure function of the parsed columns. That matters for more than
   tidiness: the upload page needs the same answers the viewer does -- which channels are
   duplicated, which roles are ambiguous, how many laps there are -- and it has no canvas
   to hang them off. Keeping this out of the viewer is what lets a session be inspected
   once at import and the answers stored, so nobody downstream has to work them out again.

   The viewer imports these too. There is one implementation, not two. */

/* ---- per-channel statistics and disambiguated names ------------------------------ */

export function channelStats(cols, n){
  return cols.map(col => {
    let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
    for (let i = 0; i < n; i++){
      const v = col[i];
      if (v === v){ if (v < mn) mn = v; if (v > mx) mx = v; sum += v; cnt++; }
    }
    return { min: mn, max: mx, mean: cnt ? sum / cnt : NaN, flat: !(mx > mn) };
  });
}

/* A logger export can carry the same channel name twice -- an ECU speed and a GPS speed
   both exported as "GPS Speed", say, one of them dead. A plain name->index map silently
   keeps whichever came last, which is how a stuck-at-zero column ends up driving lap
   detection. Resolve the name to the channel that actually carries signal, and give the
   losers a visible #2/#3 suffix so the two are never confused in a picker. */
export function nameIndex(names, stats){
  const byName = {}, dupe = {};
  names.forEach((n, i) => {
    const prev = byName[n];
    if (prev === undefined) byName[n] = i;
    else {
      (dupe[n] = dupe[n] || [prev]).push(i);
      const span = j => (stats[j].flat ? -1 : stats[j].max - stats[j].min);
      if (span(i) > span(prev)) byName[n] = i;
    }
  });
  const label = names.map((n, i) => (dupe[n] ? `${n} #${dupe[n].indexOf(i) + 1}` : n));
  return { byName, dupe, label };
}

export function timeColumn(cols, byName, n){
  const t = cols[byName.Time];
  if (t) return t;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i * 0.05;
  return a;
}

/* ---- channel roles --------------------------------------------------------------

   A few of the views need to know which column *means* something -- which one is speed,
   which two are position, which pair makes the g-g plot. Name matching is only ever a
   first draft: loggers ship the same name twice, teams rename channels mid-season, and a
   live math channel called "GPS Speed" can sit next to a dead one. So the binding is made
   once, shown, and overridable, and every consumer reads the role rather than re-guessing
   a name at its own call site.                                                        */

export const ROLES = [
  { key: 'speed', label: 'Speed', used: 'distance, lap detection, cursor readout',
    match: [/^gps speed$/i, /^speed/i, /speed/i], reject: /accuracy|slope|heading|distance/i,
    unit: /km\/h|mph|m\/s/, moving: true },
  { key: 'lat', label: 'Latitude', used: 'track map',
    match: [/^gps latitude$/i, /latitude/i], reject: /acc/i },
  { key: 'lon', label: 'Longitude', used: 'track map',
    match: [/^gps longitude$/i, /longitude/i], reject: /acc/i },
  { key: 'dist', label: 'Distance', used: 'the distance x-axis', optional: true,
    match: [/^distance on gps speed$/i, /^distance/i, /distance/i], none: 'integrate from speed' },
  { key: 'latacc', label: 'Lateral g', used: 'the g-g plot', optional: true,
    match: [/^lateralacc$/i, /lat.*acc/i], unit: /^g$/i },
  { key: 'lonacc', label: 'Inline g', used: 'the g-g plot', optional: true,
    match: [/^inlineacc$/i, /(inline|longitudinal).*acc/i], unit: /^g$/i },
];
export const ROLE = Object.fromEntries(ROLES.map(r => [r.key, r]));

/* Candidates for a role, best first. Name match sets the order; whether the channel
   actually carries plausible data decides which of two name matches wins, so a stuck
   column never outranks a live one just for being named better. */
export function roleCandidates(key, { names, units, stats }){
  const R = ROLE[key], out = [];
  names.forEach((n, i) => {
    if (R.reject && R.reject.test(n)) return;
    const rank = R.match.findIndex(re => re.test(n));
    if (rank < 0) return;
    const st = stats[i], u = units[i] || '';
    let ok = !st.flat;
    if (ok && R.unit && u) ok = R.unit.test(u);
    if (ok && R.moving) ok = st.max > 10;
    out.push({ i, rank, ok, span: st.flat ? 0 : st.max - st.min });
  });
  out.sort((a, b) => (b.ok - a.ok) || (a.rank - b.rank) || (b.span - a.span));
  return out;
}

/* Name matching gets a role most of the way. Where it cannot finish the job, it says so
   rather than picking.

   One Michigan export carries two live channels both called `GPS Speed`, one peaking at
   79 km/h and one at 284. Any tie-break here -- widest range, first column, closest to
   the GPS track -- is the viewer quietly deciding which of the team's channels is real,
   and being wrong about that is worse than asking: every lap time, the distance axis and
   the cursor readout hang off it. So an ambiguous role resolves to nothing and asks.

   Ambiguity means two or more plausible candidates matched the name equally well. One
   clear winner, or a single candidate, still resolves on its own. */
export function resolveRoles(session){
  const role = {}, ambiguous = {};
  for (const R of ROLES){
    const c = roleCandidates(R.key, session);
    const tied = c.filter(x => x.ok && x.rank === c[0]?.rank);
    if (tied.length > 1){
      ambiguous[R.key] = tied.map(x => x.i);
      role[R.key] = -1;
      continue;
    }
    role[R.key] = c.length && (c[0].ok || !R.optional) ? c[0].i : -1;
  }
  return { role, ambiguous };
}

/* Roles travel with a stored session as channel *names*, not indices: a re-export with
   one extra column would silently shift every index by one and point the roles at the
   wrong data. Names survive that; where they do not, the role simply comes back unset
   and the viewer asks, which is the same behaviour as never having stored it. */
export function rolesToNames(role, names, dupe){
  const out = {};
  for (const R of ROLES){
    const i = role[R.key];
    if (i === undefined || i < 0) continue;
    /* A duplicated name needs the occurrence too, or it is ambiguous all over again. */
    out[R.key] = dupe && dupe[names[i]]
      ? { name: names[i], nth: dupe[names[i]].indexOf(i) }
      : { name: names[i] };
  }
  return out;
}

export function rolesFromNames(saved, names, dupe){
  const role = {};
  if (!saved) return role;
  for (const R of ROLES){
    const s = saved[R.key];
    if (!s || !s.name) continue;
    const all = dupe && dupe[s.name] ? dupe[s.name] : null;
    const i = all ? all[s.nth ?? 0] : names.indexOf(s.name);
    if (i !== undefined && i >= 0) role[R.key] = i;
  }
  return role;
}
