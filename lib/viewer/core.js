/* The telemetry viewer.

   This is the original single-file viewer, unchanged in substance: canvas rendering
   driven by one mutable `D` state object and direct DOM writes. React owns the markup
   (see components/Viewer.jsx) and nothing else -- the charts are redrawn thousands of
   times while dragging a cursor, which is exactly the workload a virtual DOM is worst
   at, and the imperative code here is already the fast path.

   `createViewer` scopes every lookup to the mounted root and hands back a small handle,
   so the page can drop a session in and React can tear the whole thing down cleanly. */

import { parseCsvFile } from './parse.js';

export function createViewer(root, opts = {}){
  const $ = s => root.querySelector(s);
    /* Listeners on window/document outlive the element they were wired for, so every
       one is tracked and removed when React unmounts the viewer. */
    const off = [];
    const on = (target, ev, fn, opts) => {
      target.addEventListener(ev, fn, opts);
      off.push(() => target.removeEventListener(ev, fn, opts));
    };
  const SLOT = ['--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8']
    .map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const CSS = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

  /* ============================ state ============================ */
  const D = {
    loaded:false, meta:{}, names:[], units:[], cols:[], n:0,
    byName:{}, stats:[], dead:[], label:[], dupe:{},
    role:{}, roleAuto:{},                        // which channel plays speed / lat / lon / ...
    t:null, x:null, y:null, dist:null,           // derived: time, local metres, cumulative distance
    laps:[], sf:null,                            // laps + start/finish index
    sel:[],                                      // selected channel indices (traces)
    mode:'traces', xMode:'time',
    view:[0,1],                                  // x-domain window
    cursor:0, selLap:-1, overlay:new Set(), refLap:-1, lapColor:new Map(),
    mapChan:-1, cmpChan:-1, histChan:-1, cmpHover:null, histHover:null,
  };
  /* Colour follows the lap, not its position in the current selection.
     Indexing SLOT by "which of the ticked laps is this" means unticking one repaints every
     lap after it -- you learned lap 9 was orange, then it turns green because lap 8 went away.
     A slot is claimed when a lap enters the overlay and released only when it leaves, so the
     survivors of a change keep the hue they had. Capped at 8: past the fixed order there is no
     9th hue that stays distinguishable under colour-vision deficiency. */
  const MAX_OVERLAY = 8;
  function claimLapColor(k){
    if (D.lapColor.has(k)) return true;
    if (D.lapColor.size >= MAX_OVERLAY) return false;
    const used = new Set(D.lapColor.values());
    for (let i = 0; i < SLOT.length; i++)
      if (!used.has(i)){ D.lapColor.set(k, i); return true; }
    return false;
  }
  const lapHue = k => SLOT[D.lapColor.get(k) ?? 0];

  const fmtT = s => { if(!isFinite(s)) return '\u2014'; const m = Math.floor(s/60), r = s-60*m;
    return m ? `${m}:${r.toFixed(2).padStart(5,'0')}` : r.toFixed(2); };
  const fmtD = (v,p=2) => !isFinite(v) ? '\u2014' : Math.abs(v)>=1e5||(Math.abs(v)<1e-3&&v!==0)
    ? v.toExponential(2) : v.toFixed(p);

  /* ============================ load ============================ */
  /* Progress / error chrome, shared by the local-file and stored-session paths. */
  function busy(msg, pct){
    const empty = $('#empty');
    if (!empty) return;
    empty.style.display = 'flex';
    $('#prog').style.display = pct === null ? 'none' : 'block';
    if (pct >= 0) $('#prog i').style.width = pct + '%';
    $('#status').textContent = msg;
  }
  function failed(msg){
    const empty = $('#empty');
    if (!empty) return;
    empty.style.display = 'flex';
    $('#prog').style.display = 'none';
    $('#status').innerHTML = `<b style="color:var(--brand)">${msg}</b>`;
  }

  async function loadFile(f){
    busy(`reading ${f.name} (${(f.size/1048576).toFixed(1)} MB)\u2026`, 0);
    try {
      const m = await parseCsvFile(f, p => busy('parsing\u2026', p));
      ingest(m, f.name);
      return m;
    } catch (err){ failed(String(err && err.message || err)); throw err; }
  }

  /* Open a session that was already parsed -- from the cache file a stored dataset
     carries, or handed straight over by the upload page so it never parses twice. */
  function loadParsed(m, name){ ingest(m, name); }

  function ingest(m, fname){
    D.loaded = true; D.meta = m.meta; D.names = m.names; D.units = m.units; D.cols = m.cols; D.n = m.n;

    D.stats = D.cols.map(col => {
      let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
      for (let i = 0; i < D.n; i++){ const v = col[i]; if (v === v){ if (v<mn) mn=v; if (v>mx) mx=v; sum+=v; cnt++; } }
      return {min:mn, max:mx, mean:cnt?sum/cnt:NaN, flat:!(mx>mn)};
    });

    /* A logger export can carry the same channel name twice -- an ECU speed and a GPS speed
       both exported as "GPS Speed", say, one of them dead. A plain name->index map silently
       keeps whichever came last, which is how a stuck-at-zero column ends up driving lap
       detection. Resolve the name to the channel that actually carries signal, and give the
       losers a visible #2/#3 suffix so the two are never confused in a picker. */
    D.byName = {}; D.dupe = {};
    D.names.forEach((n,i) => {
      const prev = D.byName[n];
      if (prev === undefined) D.byName[n] = i;
      else {
        (D.dupe[n] = D.dupe[n] || [prev]).push(i);
        const span = j => D.stats[j].flat ? -1 : D.stats[j].max - D.stats[j].min;
        if (span(i) > span(prev)) D.byName[n] = i;
      }
    });
    D.label = D.names.map((n,i) => D.dupe[n] ? `${n} #${D.dupe[n].indexOf(i)+1}` : n);

    D.t = D.cols[D.byName['Time']] || (() => { const a = new Float32Array(D.n);
      for (let i=0;i<D.n;i++) a[i]=i*0.05; return a; })();

    resolveRoles();
    buildGeometry();
    detectLaps();

    const g = n => D.byName[n];
    D.mapChan  = roleIdx('speed') >= 0 ? roleIdx('speed') : 1;
    D.cmpChan  = D.mapChan;
    D.histChan = D.mapChan;
    D.sel = [roleIdx('speed'), roleIdx('latacc'), roleIdx('lonacc'),
             ...['F Brake Pressure','Pack CCV'].map(g)]
      .filter(i => i !== undefined && i >= 0).slice(0,5);
    if (!D.sel.length) D.sel = [1,2,3].filter(i => i < D.names.length);

    D.view = [D.t[0], D.t[D.n-1]];
    D.cursor = 0;

    $('#sessname').textContent = opts.title || `${D.meta.Session || fname} \u2014 ${D.meta.Vehicle || ''}`;
    $('#sessmeta').textContent = [D.meta.Date, D.meta.Time, D.meta.Racer && 'driver ' + D.meta.Racer,
      `${D.n.toLocaleString()} samples`, `${D.names.length} channels`,
      `${D.meta['Sample Rate']||''} Hz`].filter(Boolean).join('  \u00b7  ');
    $('#bar').style.display = 'flex';
    $('#empty').remove();
    renderRoles(); renderChannels(); renderLaps(); render();
  }

  /* ---- channel roles -------------------------------------------------------------

     A few of the views need to know which column *means* something -- which one is speed,
     which two are position, which pair makes the g-g plot. Guessing that from the channel
     name is only ever a first draft: loggers ship the same name twice, teams rename channels
     mid-season, and a live math channel called "GPS Speed" can sit next to a dead one. So
     the guess is made once, shown, and overridable, and every consumer reads the role rather
     than re-guessing a name at its own call site. When a role is unset the view that needs it
     says so and offers the picker, instead of drawing something quietly wrong.             */

  const ROLES = [
    {key:'speed',  label:'Speed',     used:'distance, lap detection, cursor readout',
     match:[/^gps speed$/i, /^speed/i, /speed/i], reject:/accuracy|slope|heading|distance/i,
     unit:/km\/h|mph|m\/s/, moving:true},
    {key:'lat',    label:'Latitude',  used:'track map',
     match:[/^gps latitude$/i, /latitude/i], reject:/acc/i},
    {key:'lon',    label:'Longitude', used:'track map',
     match:[/^gps longitude$/i, /longitude/i], reject:/acc/i},
    {key:'dist',   label:'Distance',  used:'the distance x-axis', optional:true,
     match:[/^distance on gps speed$/i, /^distance/i, /distance/i], none:'integrate from speed'},
    {key:'latacc', label:'Lateral g', used:'the g-g plot', optional:true,
     match:[/^lateralacc$/i, /lat.*acc/i], unit:/^g$/i},
    {key:'lonacc', label:'Inline g',  used:'the g-g plot', optional:true,
     match:[/^inlineacc$/i, /(inline|longitudinal).*acc/i], unit:/^g$/i},
  ];
  const ROLE = Object.fromEntries(ROLES.map(r => [r.key, r]));

  /* Candidates for a role, best first. Name match sets the order; whether the channel
     actually carries plausible data decides which of two name matches wins, so a stuck
     column never outranks a live one just for being named better. */
  function roleCandidates(key){
    const R = ROLE[key], out = [];
    D.names.forEach((n,i) => {
      if (R.reject && R.reject.test(n)) return;
      const rank = R.match.findIndex(re => re.test(n));
      if (rank < 0) return;
      const st = D.stats[i], u = D.units[i] || '';
      let ok = !st.flat;
      if (ok && R.unit && u) ok = R.unit.test(u);
      if (ok && R.moving) ok = st.max > 10;
      out.push({i, rank, ok, span: st.flat ? 0 : st.max - st.min});
    });
    out.sort((a,b) => (b.ok - a.ok) || (a.rank - b.rank) || (b.span - a.span));
    return out;
  }
  function resolveRoles(){
    D.role = {}; D.roleAuto = {};
    for (const R of ROLES){
      const c = roleCandidates(R.key);
      const pick = c.length && (c[0].ok || !R.optional) ? c[0].i : -1;
      D.role[R.key] = D.roleAuto[R.key] = pick;
    }
  }
  const roleIdx = k => (D.role && D.role[k] !== undefined) ? D.role[k] : -1;
  const roleCol = k => { const i = roleIdx(k); return i >= 0 ? D.cols[i] : null; };
  const speedCol = () => roleCol('speed');

  const fmtRange = i => { const st = D.stats[i];
    return st.flat ? (st.min === st.min ? `flat ${fmtD(st.min)}` : 'no data')
                   : `${fmtD(st.min)}\u2013${fmtD(st.max)}`; };

  /* name - unit - range: enough to tell apart two channels that share a name. */
  function chanOptLabel(i){
    return `${D.label[i]}${D.units[i] ? '  \u2014 ' + D.units[i] : ''}  \u00b7 ${fmtRange(i)}`;
  }
  /* Fill a <select> with every channel, flat ones last and marked rather than hidden:
     a channel reading zero is often exactly what the user came to check. */
  function fillChanSelect(sel, cur){
    sel.innerHTML = '';
    const live = [], flat = [];
    D.names.forEach((_,i) => (D.stats[i].flat ? flat : live).push(i));
    for (const [gname, list] of [['channels', live], ['flat / no signal', flat]]){
      if (!list.length) continue;
      const grp = document.createElement('optgroup'); grp.label = gname;
      for (const i of list){
        const o = document.createElement('option');
        o.value = i; o.textContent = chanOptLabel(i);
        if (i === cur) o.selected = true;
        grp.appendChild(o);
      }
      sel.appendChild(grp);
    }
    if (cur >= 0) sel.value = String(cur);
  }

  /* A role picker: likely channels first, then every other channel, then "not set". Every
     column in the file is reachable from here, so an unusual export is a couple of clicks
     rather than a dead end. */
  function fillRoleSelect(sel, key){
    const R = ROLE[key], cur = roleIdx(key);
    sel.innerHTML = '';
    const cands = roleCandidates(key).map(c => c.i);
    const rest = D.names.map((_,i) => i).filter(i => !cands.includes(i));
    const add = (grp, i) => { const o = document.createElement('option');
      o.value = i; o.textContent = chanOptLabel(i); grp.appendChild(o); };
    if (cands.length){ const g1 = document.createElement('optgroup'); g1.label = 'likely';
      cands.forEach(i => add(g1, i)); sel.appendChild(g1); }
    const g2 = document.createElement('optgroup'); g2.label = 'all channels';
    rest.forEach(i => add(g2, i)); sel.appendChild(g2);
    const none = document.createElement('option');
    none.value = -1; none.textContent = R.none ? `\u2014 ${R.none} \u2014` : '\u2014 not set \u2014';
    sel.appendChild(none);
    sel.value = String(cur);
  }
  /* Changing a role re-derives everything downstream of it and redraws. */
  function setRole(key, i){
    D.role[key] = i;
    if (key === 'speed' || key === 'lat' || key === 'lon' || key === 'dist'){
      buildGeometry(); detectLaps();
      const xs = xArr(); D.view = [xs[0], xs[D.n-1]]; D.selLap = -1;
    }
    renderRoles(); renderLaps(); renderChannels(); render();
  }
  function renderRoles(){
    const wrap = $('#rolewrap');
    if (!wrap || !D.loaded) return;
    wrap.innerHTML = ROLES.map(R => {
      const unset = roleIdx(R.key) < 0 && !R.optional;
      return `<div class="role"><label title="used for ${R.used}">${R.label}${
        unset ? ' <span class="warn" title="not found \u2014 pick one">!</span>' : ''
      }</label><select data-role="${R.key}"></select></div>`;
    }).join('');
    bindRoleSelects(wrap);
    const changed = ROLES.filter(R => D.role[R.key] !== D.roleAuto[R.key]).length;
    $('#rolen').textContent = changed ? `${changed} overridden` : 'auto';
    const spd = $('#spdsel');
    if (spd){ fillRoleSelect(spd, 'speed'); spd.onchange = () => setRole('speed', +spd.value); }
  }
  function bindRoleSelects(root){
    for (const sel of root.querySelectorAll('select[data-role]')){
      fillRoleSelect(sel, sel.dataset.role);
      sel.onchange = () => setRole(sel.dataset.role, +sel.value);
    }
  }
  /* Shown in place of a chart whose role is unset: says what is missing, and fixes it here
     rather than sending the user off to find a settings panel. */
  function roleMissing(keys, what){
    const list = keys.map(k => `<div class="role"><label>${ROLE[k].label}</label>
      <select data-role="${k}"></select></div>`).join('');
    return `<div class="rolefix"><b>${what}</b>
      <div class="hint">Name matching did not find ${keys.length > 1 ? 'these channels' : 'this channel'}
        in this file. Pick ${keys.length > 1 ? 'them' : 'it'} here.</div>${list}</div>`;
  }

  /* Local tangent-plane metres from lat/lon, plus a cumulative distance channel.
     Distance is integrated from GPS speed where available rather than summed from
     positions: position noise adds a metre or two of phantom distance every lap, and
     distance is the x-axis every lap comparison is aligned on. */
  function buildGeometry(){
    const la = roleCol('lat'), lo = roleCol('lon');
    if (la && lo){
      let s = 0, c = 0;
      for (let i = 0; i < D.n; i++) if (la[i] === la[i] && Math.abs(la[i]) > 0.01){ s += la[i]; c++; }
      const lat0 = c ? s/c : 0;
      let s2 = 0, c2 = 0;
      for (let i = 0; i < D.n; i++) if (lo[i] === lo[i] && Math.abs(lo[i]) > 0.01){ s2 += lo[i]; c2++; }
      const lon0 = c2 ? s2/c2 : 0;
      const mLat = 111132.0, mLon = 111320.0*Math.cos(lat0*Math.PI/180);
      D.x = new Float32Array(D.n); D.y = new Float32Array(D.n);
      for (let i = 0; i < D.n; i++){ D.x[i] = (lo[i]-lon0)*mLon; D.y[i] = (la[i]-lat0)*mLat; }
    } else { D.x = D.y = null; }

    /* The logger's own distance channel is integrated from its own speed, so it is only
       the right answer while the speed source is the one we would have picked anyway. Once
       the user overrides the speed role, integrate from what they chose -- otherwise the
       picker would silently fail to move the x-axis lap comparison is drawn against. */
    const dch = roleIdx('dist');
    if (dch >= 0 && !D.stats[dch].flat && roleIdx('speed') === D.roleAuto.speed){
      D.dist = D.cols[dch]; return; }
    const sp = speedCol();
    D.dist = new Float32Array(D.n);
    if (sp){ let acc = 0;
      for (let i = 1; i < D.n; i++){ const dt = D.t[i]-D.t[i-1];
        acc += Math.max(0, sp[i])/3.6*dt; D.dist[i] = acc; }
    } else if (D.x){ let acc = 0;
      for (let i = 1; i < D.n; i++){ acc += Math.hypot(D.x[i]-D.x[i-1], D.y[i]-D.y[i-1]); D.dist[i] = acc; }
    }
  }

  /* Lap detection by start/finish proximity *and heading*.

     Proximity alone is not enough. On an out-and-back layout the two legs run within a few
     metres of each other, so a circle around any point on them catches the car twice a lap \u2014
     which on this Michigan data produced 43 "laps" alternating 14.5 s and 50 s. Requiring each
     pass to share the candidate's direction of travel (within 60 deg) discards the return leg,
     because a real start/finish line is crossed one way. The same check handles the crossing of
     a figure-eight and any other place the track touches itself.

     Candidates are then scored on the *fraction* of intervals near the median, not just how
     many: a double-crossing point still yields plenty of consistent intervals, it just yields
     an equal number of inconsistent ones. Judging by fraction also leaves room for the genuine
     outliers \u2014 the out-lap, the in-lap, and the driver change \u2014 without them poisoning
     the detection. */
  function detectLaps(sfIdx){
    D.laps = [];
    if (!D.x) return;
    const sp = speedCol();
    const moving = i => !sp || sp[i] > 8;
    const R = 12, GAP = Math.max(20, Math.round(0.8/(D.t[1]-D.t[0] || 0.05)));
    const HEAD_TOL = Math.PI/3;

    const headingAt = i => {
      const a = Math.max(0,i-3), b = Math.min(D.n-1,i+3);
      return Math.atan2(D.y[b]-D.y[a], D.x[b]-D.x[a]);
    };
    const angDiff = (a,b) => { let d = Math.abs(a-b) % (2*Math.PI);
      return d > Math.PI ? 2*Math.PI-d : d; };

    const passes = ci => {
      const px = D.x[ci], py = D.y[ci], h0 = headingAt(ci), out = [];
      let run = null;
      const close = () => { if (run && angDiff(headingAt(run.best), h0) < HEAD_TOL) out.push(run.best); run = null; };
      for (let i = 0; i < D.n; i++){
        const d = Math.hypot(D.x[i]-px, D.y[i]-py);
        if (d < R){ if (!run) run = {best:i, bd:d}; else if (d < run.bd){ run.bd = d; run.best = i; } run.e = i; }
        else if (run && i - run.e > GAP) close();
      }
      close();
      return out;
    };
    const score = cr => {
      if (cr.length < 3) return null;
      const it = []; for (let i = 1; i < cr.length; i++) it.push(D.t[cr[i]] - D.t[cr[i-1]]);
      const ok = it.filter(v => v > 5);
      if (ok.length < 2) return null;
      const med = ok.slice().sort((a,b)=>a-b)[ok.length>>1];
      const good = it.filter(v => v > med*0.75 && v < med*1.25);
      const frac = good.length/it.length;
      if (good.length < 2 || frac < 0.6) return null;
      const mean = good.reduce((a,b)=>a+b,0)/good.length;
      const sd = Math.sqrt(good.reduce((a,b)=>a+(b-mean)**2,0)/good.length);
      return {n:good.length, frac, sd, cr};
    };

    let best = null;
    if (sfIdx != null){ best = score(passes(sfIdx)); if (best) best.ci = sfIdx; }
    if (!best){
      const step = Math.max(1, Math.floor(D.n/180));
      for (let ci = 0; ci < D.n; ci += step){
        if (!moving(ci)) continue;
        const s = score(passes(ci));
        const better = s && (!best || s.n > best.n
          || (s.n === best.n && s.frac > best.frac + 1e-9)
          || (s.n === best.n && Math.abs(s.frac-best.frac) < 1e-9 && s.sd < best.sd));
        if (better){ s.ci = ci; best = s; }
      }
    }
    if (!best) return;
    D.sf = best.ci;
    const cr = best.cr;
    for (let i = 1; i < cr.length; i++){
      D.laps.push({ i0:cr[i-1], i1:cr[i], t0:D.t[cr[i-1]], t1:D.t[cr[i]],
        time:D.t[cr[i]]-D.t[cr[i-1]], d0:D.dist[cr[i-1]], d1:D.dist[cr[i]] });
    }
    // A lap far off the median is an in/out lap or a stop, not a representative lap; excluded
    // from "best lap" so one 282 s driver change can't be mistaken for a timed lap.
    const ts = D.laps.map(l => l.time).sort((a,b)=>a-b);
    const med = ts[ts.length>>1] || 0;
    D.laps.forEach((l,k) => {
      l.n = k+1;
      l.partial = l.time < med*0.75 || l.time > med*1.25;
      l.maxSpeed = sp ? colMax(sp, l.i0, l.i1) : NaN;
    });
    const valid = D.laps.filter(l => !l.partial);
    const bt = valid.length ? Math.min(...valid.map(l=>l.time)) : Infinity;
    D.laps.forEach(l => l.best = (!l.partial && l.time === bt));
    D.refLap = D.laps.findIndex(l => l.best);
    D.overlay = new Set(valid.slice(0,3).map(l => D.laps.indexOf(l)));
    D.lapColor = new Map();
    [...D.overlay].sort((a,b)=>a-b).forEach(claimLapColor);
  }
  function colMax(c,a,b){ let m=-Infinity; for(let i=a;i<=b;i++) if(c[i]>m) m=c[i]; return m; }

  /* ============================ chart engine ============================ */
  const PAD = {l:56, r:12, t:22, b:20};

  /* Min/max decimation: one vertical span per pixel column. Drawing 36 000 points into a
     900 px chart otherwise both wastes time and *hides* data \u2014 plain stride sampling walks
     straight past the single-sample spikes (brake pressure, current draw) you are looking
     for. Keeping the min and max of each column preserves them exactly. */
  function decimate(col, i0, i1, xs, x0, x1, w){
    const pts = [];
    const span = x1 - x0;
    if (span <= 0) return pts;
    const cols = Math.max(1, Math.floor(w));
    let k = i0;
    for (let px = 0; px < cols; px++){
      const xe = x0 + span*(px+1)/cols;
      let mn = Infinity, mx = -Infinity, mnI = -1, mxI = -1;
      while (k <= i1 && xs[k] <= xe){
        const v = col[k];
        if (v === v){ if (v < mn){ mn = v; mnI = k; } if (v > mx){ mx = v; mxI = k; } }
        k++;
      }
      if (mnI >= 0){
        if (mnI <= mxI){ pts.push([xs[mnI],mn],[xs[mxI],mx]); }
        else { pts.push([xs[mxI],mx],[xs[mnI],mn]); }
      }
    }
    return pts;
  }
  function idxRange(xs, x0, x1){
    const lo = bs(xs, x0), hi = bs(xs, x1);
    return [Math.max(0, lo-1), Math.min(D.n-1, hi+1)];
  }
  function bs(a, v){ let lo = 0, hi = a.length-1;
    while (lo < hi){ const m = (lo+hi)>>1; if (a[m] < v) lo = m+1; else hi = m; } return lo; }

  function ticks(a, b, want){
    const span = b-a; if (!(span > 0)) return [a];
    const raw = span/want, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw/mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10)*mag;
    const out = []; for (let v = Math.ceil(a/step)*step; v <= b+step*1e-6; v += step) out.push(v);
    return out;
  }
  function setupCanvas(cv, h){
    const dpr = devicePixelRatio || 1, w = cv.clientWidth;
    cv.height = Math.round(h*dpr); cv.width = Math.round(w*dpr); cv.style.height = h+'px';
    const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
    return {g, w, h};
  }
  function axes(g, w, h, x0, x1, y0, y1, xfmt, yfmt){
    g.fillStyle = CSS('--surface'); g.fillRect(0,0,w,h);
    const iw = w-PAD.l-PAD.r, ih = h-PAD.t-PAD.b;
    g.strokeStyle = '#2a2a27'; g.lineWidth = 1;
    g.fillStyle = CSS('--ink-3'); g.font = '10px ui-monospace,Consolas,monospace';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of ticks(y0,y1,4)){
      const py = Math.round(PAD.t + ih*(1-(v-y0)/(y1-y0)))+0.5;
      if (py < PAD.t-1 || py > PAD.t+ih+1) continue;
      g.beginPath(); g.moveTo(PAD.l,py); g.lineTo(w-PAD.r,py); g.stroke();
      g.fillText(yfmt ? yfmt(v) : fmtD(v, Math.abs(y1-y0) < 5 ? 2 : Math.abs(y1-y0) < 50 ? 1 : 0), PAD.l-6, py);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of ticks(x0,x1,7)){
      const px = Math.round(PAD.l + iw*(v-x0)/(x1-x0))+0.5;
      if (px < PAD.l-1 || px > w-PAD.r+1) continue;
      g.beginPath(); g.moveTo(px,PAD.t); g.lineTo(px,PAD.t+ih); g.stroke();
      g.fillText(xfmt ? xfmt(v) : fmtD(v,0), px, PAD.t+ih+4);
    }
    return {iw, ih, X: v => PAD.l+iw*(v-x0)/(x1-x0), Y: v => PAD.t+ih*(1-(v-y0)/(y1-y0))};
  }
  function drawPts(g, pts, A, color, width){
    if (!pts.length) return;
    g.strokeStyle = color; g.lineWidth = width||1.4; g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (const [px,py] of pts){
      if (py !== py){ pen = false; continue; }
      const X = A.X(px), Y = A.Y(py);
      if (!pen){ g.moveTo(X,Y); pen = true; } else g.lineTo(X,Y);
    }
    g.stroke();
  }
  const xArr = () => D.xMode === 'time' ? D.t : D.dist;
  const xLabel = () => D.xMode === 'time' ? 's' : 'm';
  const xFmt = v => D.xMode === 'time' ? (v>=60 ? fmtT(v) : v.toFixed(1)) : (v/1000).toFixed(2)+'k';

  /* ============================ views ============================ */
  function render(){
    if (!D.loaded) return;
    const v = $('#view');
    $('#rangelbl').textContent = D.xMode === 'time'
      ? `${fmtT(D.view[0])} \u2013 ${fmtT(D.view[1])}`
      : `${(D.view[0]/1000).toFixed(2)} \u2013 ${(D.view[1]/1000).toFixed(2)} km`;
    if (D.mode === 'traces') renderTraces(v);
    else if (D.mode === 'compare') renderCompare(v);
    else if (D.mode === 'track') renderTrack(v);
    else renderAnalysis(v);
    drawStrip();
    updateCursorOut();
  }

  /* ---- traces: one lane per channel, shared x, shared crosshair ---- */
  function renderTraces(root){
    if (!D.sel.length){
      root.innerHTML = `<div class="hint" style="padding:24px">Pick channels on the left to plot them.
        <br><br>Drag on a chart to zoom \u00b7 <kbd>wheel</kbd> zoom \u00b7 <kbd>shift</kbd>+drag pan \u00b7 double-click reset.</div>`;
      return;
    }
    const need = D.sel.map(c => 'tr'+c);
    if (root.dataset.k !== need.join(',')){
      root.dataset.k = need.join(',');
      root.innerHTML = '';
      D.sel.forEach((ci,k) => {
        const d = document.createElement('div'); d.className = 'chart'; d.dataset.ci = ci;
        d.innerHTML = `<canvas></canvas>
          <div class="hd"><span class="sw" style="background:${SLOT[k%8]}"></span>
            <span>${D.label[ci]}</span><span class="u">${D.units[ci]||''}</span></div>
          <div class="val"></div><button class="x" title="remove">\u00d7</button>`;
        d.querySelector('.x').onclick = e => { e.stopPropagation();
          D.sel = D.sel.filter(x => x !== ci); renderChannels(); render(); };
        attachInteract(d.querySelector('canvas'));
        root.appendChild(d);
      });
    }
    const H = Math.max(110, Math.min(230, (root.clientHeight - 8*D.sel.length)/D.sel.length));
    [...root.children].forEach((d,k) => {
      const ci = +d.dataset.ci, cv = d.querySelector('canvas');
      const {g,w,h} = setupCanvas(cv, H);
      const xs = xArr(), [i0,i1] = idxRange(xs, D.view[0], D.view[1]);
      let mn = Infinity, mx = -Infinity;
      for (let i = i0; i <= i1; i++){ const v = D.cols[ci][i]; if (v===v){ if(v<mn)mn=v; if(v>mx)mx=v; } }
      if (!(mx > mn)){ mx = (mn||0)+1; mn = (mn||0)-1; }
      const pad = (mx-mn)*0.08; mn -= pad; mx += pad;
      const A = axes(g,w,h,D.view[0],D.view[1],mn,mx,xFmt);
      drawPts(g, decimate(D.cols[ci], i0, i1, xs, D.view[0], D.view[1], A.iw), A, SLOT[k%8]);
      lapMarks(g, A, h);
      crosshair(g, A, h, w);
      d.querySelector('.val').textContent = fmtD(D.cols[ci][D.cursor], 2);
      d.querySelector('.val').style.color = SLOT[k%8];
    });
  }
  function lapMarks(g, A, h){
    if (D.xMode !== 'time') return;
    g.strokeStyle = 'rgba(200,16,46,.35)'; g.lineWidth = 1;
    for (const l of D.laps){
      const px = Math.round(A.X(l.t0))+0.5;
      if (px < PAD.l || px > A.X(D.view[1])) continue;
      g.beginPath(); g.moveTo(px, PAD.t); g.lineTo(px, h-PAD.b); g.stroke();
    }
  }
  function crosshair(g, A, h, w){
    const xs = xArr(), cx = xs[D.cursor];
    if (cx < D.view[0] || cx > D.view[1]) return;
    const px = Math.round(A.X(cx))+0.5;
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
    g.setLineDash([3,3]); g.beginPath(); g.moveTo(px,PAD.t); g.lineTo(px,h-PAD.b); g.stroke();
    g.setLineDash([]);
  }

  /* ---- compare: same channel, several laps, aligned on distance into lap ---- */
  function lapSeries(lap, ci){
    const out = {d:[], v:[], t:[]};
    for (let i = lap.i0; i <= lap.i1; i++){
      out.d.push(D.dist[i]-lap.d0); out.v.push(D.cols[ci][i]); out.t.push(D.t[i]-lap.t0);
    }
    return out;
  }
  /* Crosshair + readout for the distance-domain charts. Enhances, never gates: the legend
     still names every series and the CSV export still carries the numbers, so nothing is
     reachable *only* by hovering. Hit area is the whole plot width rather than the 2 px line,
     because landing on a stroke is not a reasonable ask. */
  function attachHover(cv, key, x0, x1){
    cv.style.cursor = 'crosshair';
    cv.onmousemove = e => {
      const r = cv.getBoundingClientRect();
      const f = (e.clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r);
      D[key] = (f < 0 || f > 1) ? null : x0 + f * (x1 - x0);
      render();
    };
    cv.onmouseleave = () => { D[key] = null; render(); };
  }
  function crosshairAt(g, A, w, h, xVal, rows){
    if (xVal == null) return;
    const px = Math.round(A.X(xVal)) + 0.5;
    if (px < PAD.l || px > w - PAD.r) return;
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, PAD.t); g.lineTo(px, h - PAD.b); g.stroke();
    g.font = '11px ui-monospace,Consolas,monospace'; g.textBaseline = 'top';
    const lh = 13, bw = 108, bh = rows.length * lh + 6;
    const bx = px + 8 + bw > w - PAD.r ? px - bw - 8 : px + 8;
    g.fillStyle = 'rgba(18,18,17,.92)'; g.fillRect(bx, PAD.t + 4, bw, bh);
    g.strokeStyle = '#33332f'; g.strokeRect(bx + .5, PAD.t + 4.5, bw - 1, bh - 1);
    rows.forEach((row, i) => {
      const y = PAD.t + 7 + i * lh;
      g.fillStyle = row.color; g.fillRect(bx + 6, y + 3, 7, 7);
      g.fillStyle = CSS('--ink-2'); g.textAlign = 'left'; g.fillText(row.label, bx + 18, y);
      g.fillStyle = CSS('--ink'); g.textAlign = 'right'; g.fillText(row.value, bx + bw - 6, y);
    });
    g.textAlign = 'left';
  }


  function renderCompare(root){
    const laps = [...D.overlay].sort((a,b)=>a-b).filter(k => D.laps[k]);
    if (!D.laps.length){ root.innerHTML = `<div class="hint" style="padding:24px">No laps detected.
      Open the Track view and click a point on the trace to place the start/finish line.</div>`; return; }
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <span class="lbl">channel</span><select id="cmpsel" style="width:auto;max-width:260px"></select>
        <span class="lbl">reference</span><select id="refsel" style="width:auto"></select>
        <span class="hint">tick laps in the sidebar to overlay them</span>
      </div>
      <div class="chart"><canvas id="cmpc"></canvas>
        <div class="hd"><span>${D.label[D.cmpChan]}</span>
        <span class="u">${D.units[D.cmpChan]||''} \u00b7 vs distance into lap</span></div></div>
      <div class="chart"><canvas id="dtc"></canvas>
        <div class="hd"><span>Delta-t vs lap ${D.laps[D.refLap]?.n ?? '\u2014'}</span>
        <span class="u">s \u00b7 below zero = ahead of reference</span></div></div>`;
    const cs = $('#cmpsel');
    fillChanSelect(cs, D.cmpChan);
    cs.onchange = () => { D.cmpChan = +cs.value; render(); };
    const rs = $('#refsel');
    D.laps.forEach((l,k) => { const o = document.createElement('option'); o.value = k;
      o.textContent = `Lap ${l.n} \u2014 ${fmtT(l.time)}`; if (k === D.refLap) o.selected = true; rs.appendChild(o); });
    rs.onchange = () => { D.refLap = +rs.value; render(); };

    const series = laps.map(k => ({k, lap:D.laps[k], s:lapSeries(D.laps[k], D.cmpChan)}));
    const maxD = Math.max(1, ...series.map(s => s.s.d[s.s.d.length-1] || 0));

    { const {g,w,h} = setupCanvas($('#cmpc'), Math.max(200, root.clientHeight*0.44));
      let mn = Infinity, mx = -Infinity;
      series.forEach(s => s.s.v.forEach(v => { if (v===v){ if(v<mn)mn=v; if(v>mx)mx=v; } }));
      if (!(mx>mn)){ mx=(mn||0)+1; mn=(mn||0)-1; }
      const pad = (mx-mn)*0.08;
      const A = axes(g,w,h,0,maxD,mn-pad,mx+pad, v => (v/1000).toFixed(2)+'k');
      series.forEach(s => drawPts(g, s.s.d.map((d,j)=>[d, s.s.v[j]]), A, lapHue(s.k), 1.4));
      legend(g, w, series.map(s => [`Lap ${s.lap.n}`, lapHue(s.k)]));
      crosshairAt(g, A, w, h, D.cmpHover, series.map(s => ({
        label:`L${s.lap.n}`, color:lapHue(s.k), value:fmtD(interp(s.s.d, s.s.v, D.cmpHover), 2)})));
      attachHover($('#cmpc'), 'cmpHover', 0, maxD);
    }
    { const {g,w,h} = setupCanvas($('#dtc'), Math.max(150, root.clientHeight*0.34));
      const ref = D.laps[D.refLap] ? lapSeries(D.laps[D.refLap], D.cmpChan) : null;
      const dts = series.map(s => ({s, pts: ref ? s.s.d.map((d,j) => [d, s.s.t[j]-interp(ref.d, ref.t, d)]) : []}));
      let mn = -0.5, mx = 0.5;
      dts.forEach(o => o.pts.forEach(([,v]) => { if (v===v){ if(v<mn)mn=v; if(v>mx)mx=v; } }));
      const A = axes(g,w,h,0,maxD,mn*1.1,mx*1.1, v => (v/1000).toFixed(2)+'k');
      g.strokeStyle = '#55554e'; g.beginPath();
      g.moveTo(PAD.l, A.Y(0)); g.lineTo(w-PAD.r, A.Y(0)); g.stroke();
      dts.forEach(o => drawPts(g, o.pts, A, lapHue(o.s.k), 1.4));
      // >= 2 series always carries a legend; the delta chart had none and reused
      // the compare chart's colours without ever naming them.
      legend(g, w, series.map(s => [`Lap ${s.lap.n}`, lapHue(s.k)]));
      crosshairAt(g, A, w, h, D.cmpHover, dts.map(o => ({
        label:`L${o.s.lap.n}`, color:lapHue(o.s.k),
        value:(v => v>=0?'+'+v.toFixed(2):v.toFixed(2))(interp(o.pts.map(q=>q[0]), o.pts.map(q=>q[1]), D.cmpHover))})));
      attachHover($('#dtc'), 'cmpHover', 0, maxD);
    }
  }
  function interp(xs, ys, x){
    if (!xs.length) return NaN;
    let lo = 0, hi = xs.length-1;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[hi]) return ys[hi];
    while (lo < hi-1){ const m = (lo+hi)>>1; if (xs[m] <= x) lo = m; else hi = m; }
    const f = (x-xs[lo])/((xs[hi]-xs[lo])||1);
    return ys[lo] + f*(ys[hi]-ys[lo]);
  }
  function legend(g, w, items){
    g.font = '11px system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
    let x = w - PAD.r - 8;
    for (let i = items.length-1; i >= 0; i--){
      const [t,c] = items[i], tw = g.measureText(t).width;
      x -= tw + 8;
      g.fillStyle = c; g.fillRect(x-11, PAD.t-7, 8, 8);
      g.fillStyle = CSS('--ink-2'); g.fillText(t, x, PAD.t-3);
      x -= 14;
    }
  }

  /* ---- track map ---- */
  /* One hue, lightness stepping 0.53 -> 0.91, anchored dark-to-light because the surface is
     dark. Not the turbo/rainbow ramp motorsport tools habitually use for track maps: a rainbow
     has no perceptual order (readers cannot say which of green and orange is "more") and it
     collapses under red-green colour blindness. A single-hue ramp orders itself. The darkest
     step is held at 3.2:1 against the surface, because these are 2 px lines rather than filled
     areas, and a line you cannot see reads as missing data rather than as a low value. */
  const MAPRAMP = ['#256abf','#2a78d6','#3987e5','#5598e7','#6da7ec','#86b6ef','#9ec5f4','#b7d3f6','#cde2fb'];
  function rampCol(f){ const i = Math.max(0, Math.min(MAPRAMP.length-1,
    Math.floor(f*MAPRAMP.length))); return MAPRAMP[i]; }
  function renderTrack(root){
    if (!D.x){
      root.innerHTML = roleMissing(['lat','lon'], 'The track map needs a latitude and a longitude channel.');
      bindRoleSelects(root); return; }
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <span class="lbl">colour by</span><select id="mapsel" style="width:auto;max-width:260px"></select>
        <span class="hint">click the trace to move the start/finish line and re-time the laps</span>
      </div>
      <div class="chart"><canvas id="mapc"></canvas>
        <div class="hd"><span>${D.label[D.mapChan]}</span><span class="u">${D.units[D.mapChan]||''}</span></div></div>`;
    const ms = $('#mapsel');
    fillChanSelect(ms, D.mapChan);
    ms.onchange = () => { D.mapChan = +ms.value; render(); };

    const cv = $('#mapc');
    const {g,w,h} = setupCanvas(cv, Math.max(320, root.clientHeight-60));
    g.fillStyle = CSS('--surface'); g.fillRect(0,0,w,h);
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
    for (let i=0;i<D.n;i++){ const a=D.x[i],b=D.y[i]; if(a===a){ if(a<x0)x0=a; if(a>x1)x1=a; if(b<y0)y0=b; if(b>y1)y1=b; } }
    const m = 26, sc = Math.min((w-2*m)/(x1-x0||1), (h-2*m)/(y1-y0||1));
    const PX = v => w/2 + (v-(x0+x1)/2)*sc, PY = v => h/2 - (v-(y0+y1)/2)*sc;
    const col = D.cols[D.mapChan];
    const lap = D.laps[D.selLap];
    const a0 = lap ? lap.i0 : 0, a1 = lap ? lap.i1 : D.n-1;
    // Scale the ramp to what is actually drawn, not to the whole session. Over a full run the
    // range includes the pit stop, so one lap lands entirely in the top half of the ramp and
    // reads as flat -- exactly the corner-by-corner variation you opened the map to see.
    let lo = Infinity, hi = -Infinity;
    for (let i = a0; i <= a1; i++){ const v = col[i]; if (v === v){ if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!(hi > lo)){ lo = (lo||0)-1; hi = (hi||0)+1; }
    // Two passes, context first. The car covers the same tarmac 22 times, so drawing the
    // selected lap inline with everything else means the *later* laps' grey paints straight
    // over it and the selection vanishes.
    g.lineWidth = 2.4; g.lineCap = 'round';
    if (lap){
      g.strokeStyle = '#2c2c29';
      g.beginPath();
      for (let i = 1; i < D.n; i++){
        if (D.x[i] !== D.x[i]) continue;
        g.moveTo(PX(D.x[i-1]),PY(D.y[i-1])); g.lineTo(PX(D.x[i]),PY(D.y[i]));
      }
      g.stroke();
    }
    for (let i = Math.max(1,a0); i <= a1; i++){
      if (D.x[i] !== D.x[i]) continue;
      g.strokeStyle = rampCol((col[i]-lo)/(hi-lo));
      g.beginPath(); g.moveTo(PX(D.x[i-1]),PY(D.y[i-1])); g.lineTo(PX(D.x[i]),PY(D.y[i])); g.stroke();
    }
    if (D.sf != null){
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(PX(D.x[D.sf]),PY(D.y[D.sf]),8,0,7); g.stroke();
      g.fillStyle = '#fff'; g.font='10px system-ui'; g.textAlign='center';
      g.fillText('S/F', PX(D.x[D.sf]), PY(D.y[D.sf])-12);
    }
    const c = D.cursor;
    g.fillStyle = CSS('--brand'); g.strokeStyle='#fff'; g.lineWidth=1.5;
    g.beginPath(); g.arc(PX(D.x[c]),PY(D.y[c]),5.5,0,7); g.fill(); g.stroke();
    // ramp key
    const kw = 150, kx = w-PAD.r-kw, ky = h-30;
    for (let i = 0; i < MAPRAMP.length; i++){ g.fillStyle = MAPRAMP[i];
      g.fillRect(kx+i*kw/MAPRAMP.length, ky, kw/MAPRAMP.length+1, 8); }
    g.fillStyle = CSS('--ink-3'); g.font='10px ui-monospace,Consolas,monospace';
    g.textAlign='left'; g.fillText(fmtD(lo,1), kx, ky+18);
    g.textAlign='right'; g.fillText(fmtD(hi,1), kx+kw, ky+18);

    cv.onclick = e => {
      const r = cv.getBoundingClientRect(), mx = e.clientX-r.left, my = e.clientY-r.top;
      let bi = -1, bd = 1e9;
      for (let i = 0; i < D.n; i++){ const d = Math.hypot(PX(D.x[i])-mx, PY(D.y[i])-my);
        if (d < bd){ bd = d; bi = i; } }
      if (bi >= 0 && bd < 20){ detectLaps(bi); renderLaps(); render(); }
    };
    cv.onmousemove = e => {
      const r = cv.getBoundingClientRect(), mx = e.clientX-r.left, my = e.clientY-r.top;
      let bi = -1, bd = 1e9;
      for (let i = 0; i < D.n; i += 3){ const d = Math.hypot(PX(D.x[i])-mx, PY(D.y[i])-my);
        if (d < bd){ bd = d; bi = i; } }
      if (bi >= 0 && bd < 14){ D.cursor = bi; updateCursorOut(); render(); }
    };
  }

  /* ---- analysis: g-g, histogram, stats over the visible window ---- */
  function renderAnalysis(root){
    root.innerHTML = `<div class="grid2">
        <div class="chart"><canvas id="ggc"></canvas>
          <div class="hd"><span>g\u2013g diagram</span><span class="u">lateral vs longitudinal, g</span></div></div>
        <div class="chart"><canvas id="hic"></canvas>
          <div class="hd"><span>Histogram</span><span class="u" id="hiu"></span></div></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin:6px 0 8px">
        <span class="lbl">histogram of</span><select id="hisel" style="width:auto;max-width:260px"></select>
      </div>
      <div class="chart" style="padding:8px 2px"><table class="stats" id="stab"></table></div>`;
    const hs = $('#hisel');
    fillChanSelect(hs, D.histChan);
    hs.onchange = () => { D.histChan = +hs.value; render(); };
    $('#hiu').textContent = D.units[D.histChan]||'';

    const xs = xArr(), [i0,i1] = idxRange(xs, D.view[0], D.view[1]);

    { const {g,w,h} = setupCanvas($('#ggc'), 300);
      const lat = roleCol('latacc'), lon = roleCol('lonacc');
      if (!lat || !lon){ g.fillStyle=CSS('--surface'); g.fillRect(0,0,w,h);
        g.fillStyle=CSS('--ink-3'); g.font='12px system-ui'; g.textAlign='center';
        g.fillText('set the lateral / inline g channels in the sidebar', w/2, h/2); }
      else {
        let lim = 0.5;
        for (let i=i0;i<=i1;i++){ lim = Math.max(lim, Math.abs(lat[i])||0, Math.abs(lon[i])||0); }
        lim = Math.min(lim, 3);
        const A = axes(g,w,h,-lim,lim,-lim,lim,v=>v.toFixed(1),v=>v.toFixed(1));
        g.strokeStyle='#3a3a35';
        for (const r of [0.5,1,1.5,2,2.5]){ if (r>lim) break; g.beginPath();
          g.arc(A.X(0),A.Y(0),(A.X(r)-A.X(0)),0,7); g.stroke(); }
        g.fillStyle = 'rgba(57,135,229,.5)';
        const stride = Math.max(1, Math.floor((i1-i0)/9000));
        for (let i=i0;i<=i1;i+=stride){ const a=lat[i], b=lon[i];
          if (a===a&&b===b) g.fillRect(A.X(a)-1, A.Y(b)-1, 2, 2); }
      }
    }
    { const {g,w,h} = setupCanvas($('#hic'), 300);
      const c = D.cols[D.histChan]; const st = D.stats[D.histChan];
      let mn=Infinity,mx=-Infinity;
      for (let i=i0;i<=i1;i++){ const v=c[i]; if(v===v){ if(v<mn)mn=v; if(v>mx)mx=v; } }
      if (!(mx>mn)){ mx=(mn||0)+1; mn=(mn||0)-1; }
      const NB = 48, bins = new Float64Array(NB);
      for (let i=i0;i<=i1;i++){ const v=c[i]; if(v===v){
        bins[Math.min(NB-1, Math.floor((v-mn)/(mx-mn)*NB))]++; } }
      const top = Math.max(...bins) || 1;
      const A = axes(g,w,h,mn,mx,0,top*1.05, v=>fmtD(v,1), v=>v>=1000?(v/1000).toFixed(0)+'k':v.toFixed(0));
      const hb = D.histHover==null ? -1 : Math.floor((D.histHover-mn)/(mx-mn)*NB);
      for (let i=0;i<NB;i++){
        // 2 px surface gap between bars rather than a stroked border
        const x = A.X(mn+(mx-mn)*i/NB), x2 = A.X(mn+(mx-mn)*(i+1)/NB);
        g.fillStyle = i===hb ? CSS('--ink-2') : CSS('--s3');
        g.fillRect(x+1, A.Y(bins[i]), Math.max(1,x2-x-2), A.Y(0)-A.Y(bins[i]));
      }
      if (hb>=0 && hb<NB){
        const lo = mn+(mx-mn)*hb/NB, hi2 = mn+(mx-mn)*(hb+1)/NB;
        crosshairAt(g, A, w, h, D.histHover, [
          {label:'range', color:CSS('--s3'), value:`${fmtD(lo,1)}-${fmtD(hi2,1)}`},
          {label:'samples', color:CSS('--s3'), value:String(bins[hb])},
          {label:'of total', color:CSS('--s3'),
           value:(100*bins[hb]/Math.max(1,i1-i0+1)).toFixed(1)+'%'}]);
      }
      attachHover($('#hic'), 'histHover', mn, mx);
    }
    const rows = (D.sel.length ? D.sel : [D.histChan]).map(ci => {
      const c = D.cols[ci]; let mn=Infinity,mx=-Infinity,s=0,n=0;
      for (let i=i0;i<=i1;i++){ const v=c[i]; if(v===v){ if(v<mn)mn=v; if(v>mx)mx=v; s+=v; n++; } }
      const mean = n?s/n:NaN; let sd=0;
      for (let i=i0;i<=i1;i++){ const v=c[i]; if(v===v) sd+=(v-mean)**2; }
      sd = n?Math.sqrt(sd/n):NaN;
      return `<tr><td>${D.label[ci]}</td><td>${D.units[ci]||''}</td><td>${fmtD(mn)}</td>
        <td>${fmtD(mx)}</td><td>${fmtD(mean)}</td><td>${fmtD(sd)}</td></tr>`;
    }).join('');
    $('#stab').innerHTML = `<tr><th>Channel</th><th>Unit</th><th>Min</th><th>Max</th><th>Mean</th><th>SD</th></tr>${rows}`;
  }

  /* ---- session strip: whole run, with the zoom window brushed ---- */
  function drawStrip(){
    const cv = $('#strip');
    const {g,w,h} = setupCanvas(cv, 64);
    g.fillStyle = CSS('--surface'); g.fillRect(0,0,w,h);
    const spi = roleIdx('speed') >= 0 ? roleIdx('speed') : 1;
    const sp = D.cols[spi];
    if (!sp) return;
    const xs = xArr(), x0 = xs[0], x1 = xs[D.n-1];
    const A = {X: v => 4 + (w-8)*(v-x0)/((x1-x0)||1), Y: v => h-4 - (h-12)*(v-D.stats[1].min)/
      ((D.stats[1].max-D.stats[1].min)||1)};
    const st = D.stats[spi];
    A.Y = v => h-4 - (h-12)*(v-st.min)/((st.max-st.min)||1);
    drawPts(g, decimate(sp, 0, D.n-1, xs, x0, x1, w-8), A, '#4a4a44', 1);
    // laps
    g.strokeStyle = 'rgba(200,16,46,.3)';
    for (const l of D.laps){ const px = Math.round(A.X(D.xMode==='time'?l.t0:l.d0))+0.5;
      g.beginPath(); g.moveTo(px,2); g.lineTo(px,h-2); g.stroke(); }
    // window
    const wx0 = A.X(D.view[0]), wx1 = A.X(D.view[1]);
    g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(wx0, 2, Math.max(2,wx1-wx0), h-4);
    g.strokeStyle = CSS('--brand'); g.lineWidth = 1.5;
    g.strokeRect(wx0+0.5, 2.5, Math.max(2,wx1-wx0)-1, h-5);
    const cx = A.X(xs[D.cursor]);
    g.strokeStyle = '#fff'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx+0.5,2); g.lineTo(cx+0.5,h-2); g.stroke();
    cv.onmousedown = e => {
      const r = cv.getBoundingClientRect();
      const toX = px => x0 + (px-4)/(w-8)*(x1-x0);
      const a = toX(e.clientX-r.left);
      let moved = false;
      const mv = ev => { moved = true; const b = toX(ev.clientX-r.left);
        D.view = [Math.min(a,b), Math.max(a,b)]; clampView(); render(); };
      const up = ev => { document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up);
        if (!moved){ D.cursor = bs(xs, a); const span = D.view[1]-D.view[0];
          D.view = [a-span/2, a+span/2]; clampView(); render(); } };
      document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    };
  }
  function clampView(){
    const xs = xArr(), lo = xs[0], hi = xs[D.n-1];
    let [a,b] = D.view;
    if (!(b > a)) b = a + (hi-lo)*1e-3;
    const span = Math.min(b-a, hi-lo);
    a = Math.max(lo, Math.min(a, hi-span)); b = a+span;
    D.view = [a,b];
  }

  /* ============================ interaction ============================ */
  function attachInteract(cv){
    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', e => {
      const r = cv.getBoundingClientRect(), w = r.width;
      const f = (e.clientX-r.left-PAD.l)/(w-PAD.l-PAD.r);
      if (f < 0 || f > 1) return;
      D.cursor = bs(xArr(), D.view[0]+f*(D.view[1]-D.view[0]));
      render();
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect(), w = r.width;
      const f = Math.max(0, Math.min(1, (e.clientX-r.left-PAD.l)/(w-PAD.l-PAD.r)));
      const at = D.view[0]+f*(D.view[1]-D.view[0]);
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      D.view = [at-(at-D.view[0])*k, at+(D.view[1]-at)*k];
      clampView(); render();
    }, {passive:false});
    cv.addEventListener('mousedown', e => {
      const r = cv.getBoundingClientRect(), w = r.width;
      const toX = px => D.view[0] + Math.max(0,Math.min(1,(px-PAD.l)/(w-PAD.l-PAD.r)))*(D.view[1]-D.view[0]);
      const a = toX(e.clientX-r.left), pan = e.shiftKey, v0 = D.view.slice();
      let moved = false;
      const mv = ev => {
        moved = true;
        const b = toX(ev.clientX-r.left);
        if (pan){ const d = a-b; D.view = [v0[0]+d, v0[1]+d]; }
        else { cv.parentElement.dataset.sel = `${Math.min(a,b)},${Math.max(a,b)}`; }
        clampView(); render();
        if (!pan) drawSelOverlay(cv, a, b);
      };
      const up = ev => {
        document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up);
        if (!moved || pan) return;
        const b = toX(ev.clientX-r.left);
        if (Math.abs(b-a) > (D.view[1]-D.view[0])*0.004){ D.view = [Math.min(a,b),Math.max(a,b)]; clampView(); }
        render();
      };
      document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    });
    cv.addEventListener('dblclick', () => { const xs = xArr();
      D.view = [xs[0], xs[D.n-1]]; render(); });
  }
  function drawSelOverlay(cv, a, b){
    const g = cv.getContext('2d'), w = cv.clientWidth, h = cv.clientHeight;
    const X = v => PAD.l + (w-PAD.l-PAD.r)*(v-D.view[0])/(D.view[1]-D.view[0]);
    g.fillStyle = 'rgba(200,16,46,.18)';
    g.fillRect(X(Math.min(a,b)), PAD.t, X(Math.max(a,b))-X(Math.min(a,b)), h-PAD.t-PAD.b);
  }
  function updateCursorOut(){
    const i = D.cursor, sp = speedCol();
    const lap = D.laps.find(l => i >= l.i0 && i <= l.i1);
    $('#cursorout').innerHTML = [
      `t ${fmtT(D.t[i])}`,
      D.dist ? `${(D.dist[i]/1000).toFixed(3)} km` : '',
      lap ? `lap ${lap.n}` : '',
      sp ? `${sp[i].toFixed(1)} ${D.units[roleIdx('speed')]||'km/h'}` : ''
    ].filter(Boolean).join(' &nbsp;\u00b7&nbsp; ');
  }

  /* ============================ sidebar ============================ */
  function renderChannels(){
    const q = ($('#chsearch').value||'').toLowerCase();
    const hide = $('#hidedead').checked;
    const groups = new Map();
    D.names.forEach((n,i) => {
      if (hide && D.stats[i].flat && !D.sel.includes(i)) return;
      if (q && !n.toLowerCase().includes(q)) return;
      const gname = n.split(' ')[0];
      if (!groups.has(gname)) groups.set(gname, []);
      groups.get(gname).push(i);
    });
    const nShown = [...groups.values()].reduce((a,b)=>a+b.length,0);
    $('#chann').textContent = `${nShown} / ${D.names.length}` +
      (D.dead.length ? '' : ` \u00b7 ${D.stats.filter(s=>s.flat).length} flat`);
    const out = [];
    for (const [gn, list] of [...groups].sort((a,b)=>b[1].length-a[1].length || a[0].localeCompare(b[0]))){
      if (list.length > 1) out.push(`<div class="grp">${gn} \u00b7 ${list.length}</div>`);
      for (const i of list){
        const k = D.sel.indexOf(i);
        out.push(`<div class="ch ${k>=0?'on':''} ${D.stats[i].flat?'dead':''}" data-i="${i}">
          <span class="sw" style="${k>=0?`background:${SLOT[k%8]}`:''}"></span>
          <span class="nm" title="${D.label[i]} · ${D.units[i]||'no unit'} · ${fmtRange(i)} · col ${i+1}">${D.label[i]}</span>
          <span class="u">${D.units[i]||''}</span></div>`);
      }
    }
    const wrap = $('#chanwrap');
    wrap.innerHTML = out.join('') || '<div class="hint" style="padding:10px 12px">no matches</div>';
    wrap.onclick = e => {
      const el = e.target.closest('.ch'); if (!el) return;
      const i = +el.dataset.i, k = D.sel.indexOf(i);
      if (k >= 0) D.sel.splice(k,1); else { if (D.sel.length >= 8) D.sel.shift(); D.sel.push(i); }
      renderChannels(); render();
    };
  }
  function renderLaps(){
    const w = $('#lapwrap');
    if (!D.laps.length){ w.innerHTML = '<div class="hint" style="padding:8px 12px">no laps detected</div>';
      $('#lapn').textContent = ''; return; }
    const valid = D.laps.filter(l=>!l.partial);
    const bt = valid.length ? Math.min(...valid.map(l=>l.time)) : NaN;
    $('#lapn').textContent = `${valid.length} timed \u00b7 best ${fmtT(bt)}`;
    const rows = D.laps.map((l,k) => {
      const ov = D.overlay.has(k);
      return `<tr data-k="${k}" class="${k===D.selLap?'sel':''} ${l.best?'best':''} ${l.partial?'partial':''}">
        <td><span class="sw" style="background:${ov?lapHue(k):'#3a3a36'}"></span>${l.n}</td>
        <td>${fmtT(l.time)}</td>
        <td>${l.partial||!isFinite(bt)?'\u2014':(l.time-bt>=0?'+':'')+(l.time-bt).toFixed(2)}</td>
        <td>${isFinite(l.maxSpeed)?l.maxSpeed.toFixed(0):'\u2014'}</td></tr>`;
    }).join('');
    w.innerHTML = `<table class="laps"><tr><th>Lap</th><th>Time</th><th>\u0394 best</th><th>Max</th></tr>${rows}</table>`;
    w.onclick = e => {
      const tr = e.target.closest('tr[data-k]'); if (!tr) return;
      const k = +tr.dataset.k;
      if (e.target.closest('td')?.cellIndex === 0){
        if (D.overlay.has(k)){ D.overlay.delete(k); D.lapColor.delete(k); }
        else if (claimLapColor(k)) D.overlay.add(k);
      } else {
        D.selLap = k;
        const l = D.laps[k];
        D.view = D.xMode === 'time' ? [l.t0, l.t1] : [l.d0, l.d1];
        D.cursor = l.i0;
      }
      renderLaps(); render();
    };
  }

  /* ============================ chrome ============================ */
  $('#loadbtn').onclick = () => $('#file').click();
  $('#file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]).catch(() => {});
  on(document, 'dragover', e => { e.preventDefault(); $('#drop')?.classList.add('hot'); });
  on(document, 'dragleave', () => $('#drop')?.classList.remove('hot'));
  on(document, 'drop', e => { e.preventDefault();
    $('#drop')?.classList.remove('hot');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f).catch(() => {}); });
  $('#modes').onclick = e => { const b = e.target.closest('button'); if (!b) return;
    D.mode = b.dataset.mode; [...$('#modes').children].forEach(x => x.classList.toggle('on', x===b));
    $('#view').dataset.k = ''; render(); };
  $('#xmodes').onclick = e => { const b = e.target.closest('button'); if (!b) return;
    const xs0 = xArr(), c = D.cursor;
    D.xMode = b.dataset.x; [...$('#xmodes').children].forEach(x => x.classList.toggle('on', x===b));
    const xs = xArr();
    const l = D.laps[D.selLap];
    D.view = l ? (D.xMode==='time'?[l.t0,l.t1]:[l.d0,l.d1]) : [xs[0], xs[D.n-1]];
    render(); };
  $('#reset').onclick = () => { const xs = xArr(); D.selLap = -1;
    D.view = [xs[0], xs[D.n-1]]; renderLaps(); render(); };
  $('#zoomlap').onclick = () => { const lap = D.laps.find(l => D.cursor >= l.i0 && D.cursor <= l.i1);
    if (!lap) return; D.selLap = D.laps.indexOf(lap);
    D.view = D.xMode==='time' ? [lap.t0,lap.t1] : [lap.d0,lap.d1]; renderLaps(); render(); };
  $('#chsearch').oninput = () => renderChannels();
  $('#hidedead').onchange = () => renderChannels();
  $('#clearsel').onclick = () => { D.sel = []; renderChannels(); render(); };
  $('#exportpng').onclick = () => {
    const cvs = [...root.querySelectorAll('#view canvas')];
    if (!cvs.length) return;
    const W = Math.max(...cvs.map(c=>c.width)), H = cvs.reduce((a,c)=>a+c.height,0);
    const o = document.createElement('canvas'); o.width = W; o.height = H;
    const g = o.getContext('2d'); g.fillStyle = CSS('--bg'); g.fillRect(0,0,W,H);
    let y = 0; for (const c of cvs){ g.drawImage(c, 0, y); y += c.height; }
    o.toBlob(b => dl(b, `${(D.meta.Session||'session')}-${D.mode}.png`));
  };
  $('#exportcsv').onclick = () => {
    const xs = xArr(), [i0,i1] = idxRange(xs, D.view[0], D.view[1]);
    const cols = D.sel.length ? D.sel : [0];
    const head = ['Time', ...cols.map(c=>D.names[c])].join(',');
    const lines = [head];
    for (let i = i0; i <= i1; i++)
      lines.push([D.t[i].toFixed(3), ...cols.map(c=>D.cols[c][i])].join(','));
    dl(new Blob([lines.join('\n')], {type:'text/csv'}),
       `${(D.meta.Session||'session')}-${fmtT(D.view[0]).replace(':','m')}.csv`);
  };
  function dl(blob, name){ const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 5000); }
  on(window, 'keydown', e => {
    if (!D.loaded || /input|select|textarea/i.test(e.target.tagName)) return;
    const step = e.shiftKey ? 40 : 4;
    if (e.key === 'ArrowRight'){ D.cursor = Math.min(D.n-1, D.cursor+step); render(); e.preventDefault(); }
    if (e.key === 'ArrowLeft'){ D.cursor = Math.max(0, D.cursor-step); render(); e.preventDefault(); }
    if (e.key === 'f'){ const xs = xArr(); D.view = [xs[0], xs[D.n-1]]; render(); }
    if (e.key === 'l'){ $('#zoomlap').click(); }
  });
  let rt;
  on(window, 'resize', () => { clearTimeout(rt);
    rt = setTimeout(() => { $('#view').dataset.k = ''; render(); }, 120); });
  if (opts.onReady) opts.onReady();

  return {
    loadFile,
    loadParsed,
    /* The session as the upload page needs it, once the user has opened one locally. */
    parsed: () => (D.loaded ? { meta: D.meta, names: D.names, units: D.units, cols: D.cols, n: D.n } : null),
    summary: () => (D.loaded ? {
      samples: D.n,
      channels: D.names.length,
      laps: D.laps.filter(l => !l.partial).length,
      durationS: D.n ? D.t[D.n-1] - D.t[0] : 0,
      session: D.meta.Session || '',
      vehicle: D.meta.Vehicle || '',
      racer: D.meta.Racer || '',
      recordedAt: [D.meta.Date, D.meta.Time].filter(Boolean).join(' '),
    } : null),
    busy,
    failed,
    destroy(){ off.forEach(f => f()); off.length = 0; clearTimeout(rt); },
  };
}
