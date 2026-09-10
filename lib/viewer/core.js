/* The telemetry viewer.

   Canvas rendering driven by one mutable `D` state object and direct DOM writes. React
   owns the markup (see components/Viewer.jsx) and nothing else -- the charts are redrawn
   thousands of times while dragging a cursor, which is exactly the workload a virtual
   DOM is worst at, and the imperative code here is already the fast path.

   Two views:
     Charts        the chart workspace (charts.js): line charts, scatter, histogram,
                   spectrum and statistics, all sharing the cursor and the zoom window.
     Lap analysis  the track map beside the lap comparison, sector table below
                   (lapview.js).

   Either can include sessions imported alongside this one (compare.js) -- another day,
   another driver -- which is the comparison people were mailing CSVs around to make.

   `createViewer` scopes every lookup to the mounted root and hands back a small handle,
   so the page can drop a session in and React can tear the whole thing down cleanly. */

import { parseCsvFile } from './parse.js';
import { fetchParsed } from './binary.js';
import {
  ROLES, ROLE, channelStats, nameIndex, timeColumn,
  roleCandidates as candidatesFor, resolveRoles as resolveRolesFor,
  rolesFromNames, rolesToNames,
} from './session.js';
import { buildXY, buildDistance, detectLaps as detectLapsIn } from './track.js';
import { createCharts, newChart } from './charts.js';
import { createLapView } from './lapview.js';
import { deriveSession, project, timeLaps, matchChannel } from './compare.js';
import { indexWindow, lowerBound, resampleOnto } from './analysis.js';
import { SESSION_DASH, tint } from './palette.js';
import { openImporter } from './importer.js';
import { parse, evaluate, refs, renameRef, MathError, CONSTS, BUILTINS } from './math.js';
import { openMathEditor } from './mathEditor.js';

export function createViewer(root, opts = {}){
  const $ = s => root.querySelector(s);
  /* Listeners on window/document outlive the element they were wired for, so every one
     is tracked and removed when React unmounts the viewer. */
  const off = [];
  const on = (target, ev, fn, o) => {
    target.addEventListener(ev, fn, o);
    off.push(() => target.removeEventListener(ev, fn, o));
  };
  /* 24 colour slots: the eight validated categorical hues, then the same eight lighter,
     then lighter again. Past eight, two series can share a hue family, but never the
     same colour -- and the lap and channel caps are no longer set by running out. */
  const BASE = ['--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8']
    .map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const SLOT = [...BASE, ...BASE.map(c => tint(c, .42)), ...BASE.map(c => tint(c, .68))];
  const CSS = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

  /* ============================ state ============================ */
  const D = {
    loaded:false, meta:{}, names:[], units:[], cols:[], n:0,
    byName:{}, stats:[], label:[], dupe:{},
    role:{}, roleAuto:{}, roleAmbig:{},          // which channel plays speed / lat / lon / ...
    chQuery:'', hideFlat:true, rolesOpen:false,  // sidebar controls, kept across rebuilds
    panelOpen:new Map(),                         // which sidebar panels are open, per view
    traceH:230, traceCols:2, lineW:1.5,          // chart layout defaults
    charts:[],                                   // the chart workspace, see charts.js
    nRaw:0, math:[], gone:new Set(), colVer:[],  // math channels: appended after the logged ones
    t:null, x:null, y:null, dist:null, origin:null,
    laps:[], sf:null,
    mode:'charts', xMode:'time',
    view:[0,1],                                  // x-domain window, in xMode units
    cursor:0, marker:-1, selLap:-1,
    overlay:new Set(), refLap:'', lapColor:new Map(),   // lap keys: "p:3", or "<session key>:3"
    mapChan:-1, cmpChans:[], lapHover:null, lapZoom:null, sectors:3,
    sessions:[], sessVer:0,                      // imported sessions, see compare.js
  };

  /* Colour follows the lap, not its position in the current selection. A slot is
     claimed when a lap enters the overlay and released only when it leaves, so the
     survivors of a change keep the colour they had. The first eight ticked laps get the
     eight distinct hues; past that, lighter versions of them. */
  const MAX_OVERLAY = 24;
  const MAX_PLOTTED = 24;
  const MAX_SESSIONS = 4;

  const flatSel = () => [...new Set(D.charts.flatMap(c => c.chans))];
  /* Colour follows the channel's place in the whole workspace, so it stays put when a
     chart above it is removed or merged. */
  const chanColor = ci => SLOT[Math.max(0, flatSel().indexOf(ci)) % SLOT.length];

  function claimLapColor(k){
    if (D.lapColor.has(k)) return true;
    if (D.lapColor.size >= MAX_OVERLAY) return false;
    const used = new Set(D.lapColor.values());
    for (let i = 0; i < SLOT.length; i++)
      if (!used.has(i)){ D.lapColor.set(k, i); return true; }
    return false;
  }
  const lapHue = k => SLOT[D.lapColor.get(k) ?? 0];

  const fmtT = s => { if(!isFinite(s)) return '—'; const m = Math.floor(s/60), r = s-60*m;
    return m ? `${m}:${r.toFixed(2).padStart(5,'0')}` : r.toFixed(2); };
  const fmtD = (v,p=2) => !isFinite(v) ? '—' : Math.abs(v)>=1e5||(Math.abs(v)<1e-3&&v!==0)
    ? v.toExponential(2) : v.toFixed(p);
  /* Channel names come from the file, and math channel names from whoever typed them. */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

  let noteTimer = 0;
  function note(msg){
    let el = $('#toast');
    if (!el){
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      $('#content').appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => el.classList.remove('on'), 3800);
  }

  /* ============================ load ============================ */
  function busy(msg, pct){
    const empty = $('#empty');
    if (!empty) return;
    empty.style.display = 'flex';
    $('#prog').style.display = pct === null ? 'none' : 'block';
    if (pct >= 0) $('#prog i').style.width = pct + '%';
    $('#status').textContent = msg;
  }
  /* Errors have to land somewhere the user can see. The drop target is removed once a
     session opens, so anything that goes wrong after that used to fail to a blank panel
     and no message at all. */
  function failed(msg){
    const empty = $('#empty');
    if (empty){
      empty.style.display = 'flex';
      $('#prog').style.display = 'none';
      $('#status').innerHTML = `<b style="color:var(--brand)">${esc(msg)}</b>`;
      return;
    }
    const v = $('#view');
    if (v) v.innerHTML = `<div class="rolefix"><b style="color:var(--brand)">Something went wrong</b>
      <div class="hint">${esc(msg)}</div></div>`;
  }

  async function loadFile(f){
    busy(`reading ${f.name} (${(f.size/1048576).toFixed(1)} MB)…`, 0);
    try {
      const m = await parseCsvFile(f, p => busy('parsing…', p));
      ingest(m, f.name);
      return m;
    } catch (err){ failed(String(err && err.message || err)); throw err; }
  }

  function loadParsed(m, name){ ingest(m, name); }

  function ingest(m, fname){
    /* Copies of the arrays rather than the parsed session's own: math channels are
       appended to these, and the parsed session is also what the upload page stores. */
    D.loaded = true; D.meta = m.meta; D.names = m.names.slice(); D.units = m.units.slice();
    D.cols = m.cols.slice(); D.n = m.n; D.nRaw = m.names.length;

    D.stats = channelStats(D.cols, D.n);
    Object.assign(D, nameIndex(D.names, D.stats));
    D.t = timeColumn(D.cols, D.byName, D.n);

    charts.destroy(); lapview.destroy();
    for (const S of D.sessions) S.cache.clear();
    resolveRoles();
    buildGeometry();
    detectLaps();
    applyMathLibrary();

    const sp = roleIdx('speed');
    D.mapChan = sp >= 0 ? sp : 1;
    D.cmpChans = sp >= 0 ? [sp] : [];
    /* No channels chosen up front. A 250-channel export has no five channels that are
       right for everyone, and picking some meant every session opened onto plots nobody
       asked for, which had to be cleared before the real ones could be added. */
    D.charts = [];
    D.marker = -1; D.lapHover = null; D.lapZoom = null; D.selLap = -1;

    D.view = [D.t[0], D.t[D.n-1]];
    D.cursor = 0;

    $('#sessname').textContent = opts.title || `${D.meta.Session || fname} — ${D.meta.Vehicle || ''}`;
    $('#sessmeta').textContent = [D.meta.Date, D.meta.Time, D.meta.Racer && 'driver ' + D.meta.Racer,
      `${D.n.toLocaleString()} samples`, `${D.nRaw} channels`,
      `${D.meta['Sample Rate']||''} Hz`].filter(Boolean).join('  ·  ');
    $('#bar').style.display = 'flex';
    $('#empty')?.remove();
    syncChrome();
    renderSidebar(true); render();
  }

  /* ============================ roles ============================ */
  function roleCandidates(key){ return candidatesFor(key, D); }

  function resolveRoles(){
    const { role, ambiguous } = resolveRolesFor(D);
    D.role = role;
    D.roleAuto = { ...role };
    D.roleAmbig = ambiguous;
    /* Roles the uploader already settled travel with the session. They win over the
       name match, and anything they do not cover falls back to it. */
    const saved = rolesFromNames(opts.roles, D.names, D.dupe);
    for (const k of Object.keys(saved)){
      D.role[k] = saved[k];
      delete D.roleAmbig[k];
    }
  }

  const roleIdx = k => (D.role && D.role[k] !== undefined ? D.role[k] : -1);
  const roleCol = k => { const i = roleIdx(k); return i >= 0 ? D.cols[i] : null; };
  const speedCol = () => roleCol('speed');

  const fmtRange = i => { const st = D.stats[i];
    return st.flat ? (st.min === st.min ? `flat ${fmtD(st.min)}` : 'no data')
                   : `${fmtD(st.min)}–${fmtD(st.max)}`; };
  function chanOptLabel(i){
    return `${D.label[i]}${D.units[i] ? '  — ' + D.units[i] : ''}  · ${fmtRange(i)}`;
  }
  function fillRoleSelect(sel, key){
    const R = ROLE[key], cur = roleIdx(key);
    sel.innerHTML = '';
    /* Logged channels only: roles are stored by name with the session, and a math
       channel is a per-browser definition that the next person to open it may not have. */
    const cands = roleCandidates(key).map(c => c.i).filter(i => i < D.nRaw);
    const rest = D.names.map((_,i) => i).filter(i => i < D.nRaw && !cands.includes(i));
    const add = (grp, i) => { const o = document.createElement('option');
      o.value = i; o.textContent = chanOptLabel(i); grp.appendChild(o); };
    const none = document.createElement('option');
    none.value = -1; none.textContent = R.none ? `— ${R.none} —` : '— not set —';
    sel.appendChild(none);
    if (cands.length){ const g1 = document.createElement('optgroup'); g1.label = 'likely';
      cands.forEach(i => add(g1, i)); sel.appendChild(g1); }
    const g2 = document.createElement('optgroup'); g2.label = 'all channels';
    rest.forEach(i => add(g2, i)); sel.appendChild(g2);
    sel.value = String(cur);
  }
  function setRole(key, i){
    D.role[key] = i;
    if (key === 'speed' || key === 'lat' || key === 'lon' || key === 'dist'){
      buildGeometry(); detectLaps();
      if (D.math.length) recomputeMath();
      const xs = xArr(); D.view = [xs[0], xs[D.n-1]]; D.selLap = -1;
      for (const S of D.sessions) S.cache.clear();
      charts.destroy(); lapview.destroy();
    }
    renderSidebar(true); render();
  }
  function renderRoles(){
    const wrap = $('#rolewrap');
    if (!wrap || !D.loaded) return;
    wrap.innerHTML = ROLES.map(R => {
      const open = roleIdx(R.key) < 0;
      const amb = open && (D.roleAmbig[R.key] || []).length > 1;
      const unset = open && !amb && !R.optional;
      const flag = amb
        ? ` <span class="warn" title="${D.roleAmbig[R.key].length} channels match this equally well — pick one">?</span>`
        : (unset ? ' <span class="warn" title="not found — pick one">!</span>' : '');
      return `<div class="role ${amb || unset ? 'needs' : ''}">
        <label title="used for ${R.used}">${R.label}${flag}</label>
        <select data-role="${R.key}"></select></div>`;
    }).join('')
      + (ROLES.some(R => roleIdx(R.key) < 0 && (D.roleAmbig[R.key] || []).length > 1)
        ? `<div class="hint" style="padding:8px 2px 2px">Marked roles have more than one
             equally good match in this file. The viewer will not choose for you — the
             range beside each name is usually enough to tell them apart.</div>`
        : '');
    bindRoleSelects(wrap);
    const changed = ROLES.filter(R => D.role[R.key] !== D.roleAuto[R.key]).length;
    $('#rolen').textContent = changed ? `${changed} overridden` : 'auto';
  }
  function bindRoleSelects(host){
    for (const sel of host.querySelectorAll('select[data-role]')){
      fillRoleSelect(sel, sel.dataset.role);
      sel.onchange = () => setRole(sel.dataset.role, +sel.value);
    }
  }

  /* Local tangent-plane metres from lat/lon, plus a cumulative distance channel. Imported
     sessions are re-projected about the same origin, so they share the map. */
  function buildGeometry(){
    const { x, y, origin } = buildXY(roleCol('lat'), roleCol('lon'), D.n);
    D.x = x; D.y = y; D.origin = origin;
    const dch = roleIdx('dist');
    D.dist = buildDistance({
      n: D.n, t: D.t, speed: speedCol(), x, y,
      distChannel: dch >= 0 && !D.stats[dch].flat && roleIdx('speed') === D.roleAuto.speed
        ? D.cols[dch] : null,
    });
    for (const S of D.sessions) project(S, origin);
  }
  const frame = () => ({ x: D.x, y: D.y, n: D.n, sf: D.sf, origin: D.origin });

  function detectLaps(sfIdx){
    const { laps, sf } = detectLapsIn({
      n: D.n, t: D.t, x: D.x, y: D.y, dist: D.dist, speed: speedCol(), sfIdx,
    });
    D.laps = laps; D.sf = sf;
    /* Imported sessions are timed from this session's line, so moving the line re-times
       them too. Their ticked laps survive where the lap still exists. */
    const kept = [...D.overlay].filter(k => !k.startsWith('p:'));
    for (const S of D.sessions) timeLaps(S, frame());
    D.overlay = new Set(); D.lapColor = new Map();

    const valid = laps.map((l, k) => ({ l, k })).filter(o => !o.l.partial).sort((a, b) => a.l.time - b.l.time);
    valid.slice(0, 3).map(o => o.k).sort((a, b) => a - b).forEach(k => { claimLapColor('p:' + k); D.overlay.add('p:' + k); });
    for (const key of kept) if (lapOf(key) && claimLapColor(key)) D.overlay.add(key);
    D.refLap = valid.length ? 'p:' + valid[0].k : '';
  }

  function lapOf(key){
    if (!key) return null;
    const [sk, ks] = key.split(':');
    const k = +ks;
    if (sk === 'p') return D.laps[k] ? { key, S: D, lap: D.laps[k], k, primary: true, sName: 'This session' } : null;
    const S = D.sessions.find(s => s.key === sk);
    return S && S.laps[k] ? { key, S, lap: S.laps[k], k, primary: false, sName: S.short } : null;
  }

  function toggleLap(key){
    if (D.overlay.has(key)){
      D.overlay.delete(key); D.lapColor.delete(key);
    } else if (claimLapColor(key)) D.overlay.add(key);
    else note(`${MAX_OVERLAY} laps is the most that stay distinguishable — untick one first`);
    renderLaps(); render();
  }

  /* ============================ imported sessions ============================ */
  let sessSeq = 0;

  function addSession(m, info){
    if (!D.loaded) throw new Error('open a session first');
    if (D.sessions.length >= MAX_SESSIONS)
      throw new Error(`${MAX_SESSIONS} imported sessions is the most one view compares — remove one first`);
    const S = deriveSession(m, {
      roles: info.roles, like: rolesToNames(D.role, D.names, D.dupe), frame: frame(),
    });
    S.key = 's' + (++sessSeq);
    S.name = info.name;
    S.short = info.name.length > 22 ? info.name.slice(0, 21) + '…' : info.name;
    S.sub = [S.meta.Date, S.meta.Racer && 'driver ' + S.meta.Racer].filter(Boolean).join(' · ');
    S.source = info.source;
    S.visible = true; S.offT = 0; S.offD = 0;
    const usedDash = new Set(D.sessions.map(s => s.dashIdx));
    S.dashIdx = SESSION_DASH.findIndex((_, i) => !usedDash.has(i));
    S.dash = SESSION_DASH[Math.max(0, S.dashIdx)];
    S.cache = new Map();
    D.sessions.push(S);
    computeSessionMath(S);
    D.sessVer++;

    const best = S.laps.findIndex(l => l.best);
    if (best >= 0 && claimLapColor(`${S.key}:${best}`)) D.overlay.add(`${S.key}:${best}`);

    const timed = S.laps.filter(l => !l.partial).length;
    note(!S.laps.length
      ? `Added ${S.short} — no laps found in it (it may need its speed or position channels)`
      : !S.sfMatched
        ? `Added ${S.short} — ${timed} laps, but it never passes this session's start/finish, so its laps are timed from its own line`
        : `Added ${S.short} — ${timed} timed laps, best lap ticked for comparison`);
    renderSidebar(true); render();
    return S;
  }

  function removeSession(key){
    D.sessions = D.sessions.filter(s => s.key !== key);
    for (const k of [...D.overlay]) if (k.startsWith(key + ':')){ D.overlay.delete(k); D.lapColor.delete(k); }
    if (D.refLap.startsWith(key + ':')){
      const best = D.laps.findIndex(l => l.best);
      D.refLap = best >= 0 ? 'p:' + best : '';
    }
    D.sessVer++;
    renderSidebar(true); render();
  }

  const sessSig = () => `${D.sessVer}:${D.sessions.filter(s => s.visible).map(s => `${s.key}@${s.offT}/${s.offD}`).join(',')}`;
  const visibleSessions = () => D.sessions.filter(s => s.visible)
    .map(S => ({ S, key: S.key, name: S.short, dash: S.dash }));

  /* The column in S standing in for this session's channel ci. */
  function colIn(S, ci){
    if (S === D) return D.cols[ci];
    if (ci < 0 || ci >= D.names.length) return null;
    if (isMath(ci)) return S.math.get(D.label[ci]) || null;
    const j = matchChannel(S, D.label[ci], D.names[ci]);
    return j >= 0 ? S.cols[j] : null;
  }
  const offsetOf = (S, mode) => (mode === 'dist' ? S.offD : S.offT);

  /* An imported channel read off at this session's samples, so it can share a uPlot
     with them. Cached: a line chart is rebuilt whenever its settings change. */
  function overlayColumn(s, ci, mode){
    const S = s.S, col = colIn(S, ci);
    if (!col) return null;
    const key = `${ci}:${D.colVer[ci] || 0}:${mode}:${offsetOf(S, mode)}`;
    if (!S.cache.has(key)){
      if (S.cache.size > 48) S.cache.clear();
      S.cache.set(key, resampleOnto(mode === 'dist' ? S.dist : S.t, col, xOf(mode), -offsetOf(S, mode)));
    }
    return S.cache.get(key);
  }

  function swin(S, all){
    if (all) return [0, S.n - 1];
    const off = offsetOf(S, D.xMode);
    return indexWindow(D.xMode === 'dist' ? S.dist : S.t, S.n, D.view[0] - off, D.view[1] - off);
  }

  function computeSessionMath(S){
    S.math = new Map();
    const done = new Set();
    const resolve = (name, quoted) => {
      let j = S.label.indexOf(name);
      if (j < 0 && S.byName[name] !== undefined) j = S.byName[name];
      if (j >= 0) return S.cols[j];
      const mk = D.math.findIndex(m => !m.gone && m.name === name);
      if (mk >= 0){ compute(mk); return S.math.get(name) || null; }
      if (!quoted && (name in CONSTS || name in BUILTINS)) return null;
      const lo = name.toLowerCase();
      j = S.label.findIndex(l => l.toLowerCase() === lo);
      return j >= 0 ? S.cols[j] : null;
    };
    const compute = k => {
      if (done.has(k)) return;
      done.add(k);
      const m = D.math[k];
      if (m.gone || m.error) return;
      try { S.math.set(m.name, evaluate(parse(m.expr), { n: S.n, time: S.t, dist: S.dist, channel: resolve })); }
      catch { /* this session lacks an input; the channel just is not overlaid */ }
    };
    D.math.forEach((_, k) => compute(k));
  }

  function importSession(){
    openImporter(root, {
      exclude: opts.datasetId || null,
      imported: () => D.sessions.filter(s => s.source.kind === 'library').map(s => s.source.id),
      loadLibrary: async (d, onProgress) => {
        const m = await fetchParsed(d.binUrl, onProgress);
        addSession(m, { name: d.title, source: { kind: 'library', id: d.id }, roles: d.roles });
      },
      loadFile: async (f, onProgress) => {
        const m = await parseCsvFile(f, onProgress);
        addSession(m, { name: f.name.replace(/\.csv$/i, ''), source: { kind: 'file' } });
      },
    });
  }

  /* ============================ math channels ============================ */
  /* A math channel is appended to the session's own columns, so every view takes it like
     a logged channel. The definitions are kept in this browser and applied to every
     session opened -- imported ones included, so "wheel slip" overlays like any other
     channel. The expression language itself is in math.js. */
  const MATH_KEY = 'telemetry-viewer.math-channels.v1';
  const isMath = ci => ci >= D.nRaw;
  const mathAt = ci => D.math[ci - D.nRaw];

  function loadMathLibrary(){
    try {
      const a = JSON.parse(localStorage.getItem(MATH_KEY) || '[]');
      return Array.isArray(a)
        ? a.filter(d => d && typeof d.name === 'string' && typeof d.expr === 'string')
        : [];
    } catch { return []; }
  }
  function saveMathLibrary(){
    try {
      localStorage.setItem(MATH_KEY, JSON.stringify(
        D.math.filter(m => !m.gone).map(({ name, unit, expr }) => ({ name, unit, expr }))));
    } catch { /* storage full or blocked: the channel still works for this session */ }
  }

  function applyMathLibrary(){
    D.math = []; D.gone = new Set(); D.colVer = [];
    for (const d of loadMathLibrary()){
      if (chanByName(d.name, true) >= 0) continue;
      addMathSlot(d);
    }
    recomputeMath();
  }

  function addMathSlot({ name, unit = '', expr }){
    const ci = D.names.length;
    D.names.push(name); D.label.push(name); D.units.push(unit);
    D.cols.push(new Float64Array(D.n).fill(NaN));
    D.stats.push({ min: NaN, max: NaN, mean: NaN, flat: true });
    D.math.push({ name, unit, expr, error: null, gone: false });
    return ci;
  }

  function chanByName(name, quoted){
    const live = j => !D.gone.has(j);
    let i = D.label.findIndex((l, j) => l === name && live(j));
    if (i < 0 && D.byName[name] !== undefined) i = D.byName[name];
    if (i >= 0) return i;
    if (!quoted && (name in CONSTS || name in BUILTINS)) return -1;
    const lo = name.toLowerCase();
    return D.label.findIndex((l, j) => live(j) && l.toLowerCase() === lo);
  }
  const mathEnv = channel => ({ n: D.n, time: D.t, dist: D.dist, channel });

  function recomputeMath(){
    const state = new Map();
    const compute = ci => {
      const st = state.get(ci);
      if (st === 'done') return;
      if (st === 'busy') throw new MathError(`"${D.label[ci]}" ends up depending on itself`);
      state.set(ci, 'busy');
      const m = mathAt(ci);
      try {
        D.cols[ci] = evaluate(parse(m.expr), mathEnv(resolveFor(ci)));
        m.error = null;
      } catch (err){
        D.cols[ci] = new Float64Array(D.n).fill(NaN);
        m.error = err instanceof MathError ? err : new MathError(String(err && err.message || err));
      }
      D.stats[ci] = channelStats([D.cols[ci]], D.n)[0];
      D.colVer[ci] = (D.colVer[ci] || 0) + 1;
      state.set(ci, 'done');
    };
    const resolveFor = self => (name, quoted) => {
      const i = chanByName(name, quoted);
      if (i < 0) return null;
      if (i === self) throw new MathError('a channel cannot use itself');
      if (isMath(i)){
        compute(i);
        if (mathAt(i).error) throw new MathError(`"${D.label[i]}" has an error of its own`);
      }
      return D.cols[i];
    };
    for (let k = 0; k < D.math.length; k++) if (!D.math[k].gone) compute(D.nRaw + k);
    for (const S of D.sessions){ computeSessionMath(S); S.cache.clear(); }
  }

  function previewMath(src, self){
    return evaluate(parse(src), mathEnv((name, quoted) => {
      const i = chanByName(name, quoted);
      if (i < 0) return null;
      if (i === self) throw new MathError('a channel cannot use itself');
      if (isMath(i)){
        if (self >= 0 && dependsOn(i, self))
          throw new MathError(`"${D.label[i]}" already uses this channel, so that would go round in a circle`);
        if (mathAt(i).error) throw new MathError(`"${D.label[i]}" has an error of its own`);
      }
      return D.cols[i];
    }));
  }
  function dependsOn(ci, target, seen = new Set()){
    if (seen.has(ci)) return false;
    seen.add(ci);
    let names;
    try { names = refs(parse(mathAt(ci).expr)); } catch { return false; }
    for (const nm of names){
      const j = chanByName(nm, false);
      if (j === target) return true;
      if (j >= 0 && isMath(j) && dependsOn(j, target, seen)) return true;
    }
    return false;
  }

  function editMath(ci){
    const m = ci >= 0 ? mathAt(ci) : null;
    openMathEditor(root, {
      def: m && { name: m.name, unit: m.unit, expr: m.expr },
      channels: () => D.label
        .map((label, i) => ({ label, unit: D.units[i], math: isMath(i), i }))
        .filter(c => c.i !== ci && !D.gone.has(c.i)),
      checkName: name => {
        if (!name) return 'give the channel a name';
        const j = chanByName(name, true);
        return j >= 0 && j !== ci ? `there is already a channel called "${D.label[j]}"` : null;
      },
      preview: src => previewMath(src, ci),
      fmt: v => fmtD(v, 2),
      onSave: def => saveMath(ci, def),
      onDelete: () => deleteMath(ci),
    });
  }

  function saveMath(ci, def){
    if (ci < 0){
      ci = addMathSlot(def);
      recomputeMath();
      /* Creating a channel is nearly always so as to look at it. */
      if (!mathAt(ci).error){
        if (D.mode === 'charts') toggleChannel(ci);
        else if (!D.cmpChans.includes(ci)) D.cmpChans.push(ci);
      }
    } else {
      const m = mathAt(ci), old = m.name;
      Object.assign(m, def);
      D.names[ci] = D.label[ci] = def.name;
      D.units[ci] = def.unit;
      if (old !== def.name)
        for (const o of D.math) if (o !== m && !o.gone) o.expr = renameRef(o.expr, old, def.name);
      recomputeMath();
    }
    saveMathLibrary();
    renderSidebar(true); render();
  }

  function deleteMath(ci){
    for (const c of D.charts){
      c.chans = c.chans.filter(x => x !== ci);
      if (c.xChan === ci) c.xChan = -1;
      if (c.colorBy === ci) c.colorBy = -1;
    }
    D.charts = D.charts.filter(c => c.chans.length);
    D.cmpChans = D.cmpChans.filter(x => x !== ci);
    mathAt(ci).gone = true;
    D.gone.add(ci);
    D.names[ci] = D.label[ci] = '';
    D.cols[ci] = new Float64Array(D.n).fill(NaN);
    if (D.mapChan === ci) D.mapChan = roleIdx('speed') >= 0 ? roleIdx('speed') : 1;
    recomputeMath();
    saveMathLibrary();
    renderSidebar(true); render();
  }

  /* ============================ axes and windows ============================ */
  const xArr = () => (D.xMode === 'time' ? D.t : D.dist);
  const xOf = mode => (mode === 'dist' ? D.dist : D.t);
  const xFmtFor = mode => (mode === 'time'
    ? v => (v >= 60 ? fmtT(v) : v.toFixed(1))
    : v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'k' : v.toFixed(0)));
  const win = all => (all ? [0, D.n - 1] : indexWindow(xArr(), D.n, D.view[0], D.view[1]));

  /* The zoom window is kept in the toolbar's x units. A chart on the other axis reads it
     through the samples: the window covers the same stretch of the run either way. */
  function viewFor(mode){
    if (mode === D.xMode) return D.view;
    const xs = xArr(), to = xOf(mode);
    const i0 = Math.min(D.n - 1, lowerBound(xs, D.view[0], 0, D.n));
    const i1 = Math.max(i0, Math.min(D.n - 1, lowerBound(xs, D.view[1], 0, D.n)));
    return [to[i0], to[i1] > to[i0] ? to[i1] : to[i0] + 1e-6];
  }
  function setViewFrom(mode, range){
    const xs = xArr();
    if (!range){ D.view = [xs[0], xs[D.n - 1]]; D.selLap = -1; }
    else if (mode === D.xMode) D.view = range;
    else {
      const from = xOf(mode);
      const i0 = Math.min(D.n - 1, lowerBound(from, range[0], 0, D.n));
      const i1 = Math.min(D.n - 1, lowerBound(from, range[1], 0, D.n));
      D.view = [xs[i0], xs[Math.max(i0 + 1, i1)] ?? xs[D.n - 1]];
    }
    clampView();
    render();
  }
  function clampView(){
    const xs = xArr(), lo = xs[0], hi = xs[D.n-1];
    let [a,b] = D.view;
    if (!(b > a)) b = a + (hi-lo)*1e-3;
    const span = Math.min(b-a, hi-lo);
    a = Math.max(lo, Math.min(a, hi-span)); b = a+span;
    D.view = [a,b];
  }

  function hover(idx, fromPlot){
    const i = Math.max(0, Math.min(D.n - 1, idx));
    if (i === D.cursor) return;
    D.cursor = i;
    updateCursorOut();
    if (D.mode === 'charts'){ drawStrip(); charts.syncCursor(fromPlot); }
  }

  /* ============================ views ============================ */
  function render(){
    if (!D.loaded) return;
    const v = $('#view');
    if (D.mode === 'charts') charts.render(v);
    else lapview.render(v);
    $('#strip').hidden = D.mode !== 'charts';
    if (D.mode === 'charts') drawStrip();
    updateCursorOut();
  }

  function toggleChannel(ci){
    const lines = D.charts.filter(c => c.type === 'line' && c.chans.includes(ci));
    if (lines.length){
      for (const c of lines) c.chans = c.chans.filter(x => x !== ci);
      D.charts = D.charts.filter(c => c.chans.length);
      return true;
    }
    if (!flatSel().includes(ci) && flatSel().length >= MAX_PLOTTED){
      note(`${MAX_PLOTTED} channels is the most one workspace will plot — remove one first`);
      return false;
    }
    D.charts.push(newChart('line', [ci]));
    return true;
  }

  function firstUseful(){
    const sp = roleIdx('speed');
    if (sp >= 0) return sp;
    const i = D.stats.findIndex((s, j) => j > 0 && !s.flat && !D.gone.has(j));
    return i >= 0 ? i : 0;
  }

  /* The toolbar's + Chart. A new chart starts from the channel of the last chart in the
     workspace -- usually the one just being looked at -- so a histogram of what is
     already on screen is one click. */
  function addChart(kind){
    const last = D.charts[D.charts.length - 1];
    const base = last ? last.chans[0] : firstUseful();
    let c;
    if (kind === 'gg'){
      const lat = roleIdx('latacc'), lon = roleIdx('lonacc');
      if (lat < 0 || lon < 0) note('Set the lateral and inline g channels under Channel roles for a g–g diagram');
      c = newChart('xy', [lon >= 0 ? lon : base], { xChan: lat, rings: true, equal: true, range: 'view' });
    } else if (kind === 'xy'){
      const x = firstUseful();
      const y = base !== x ? base : (roleIdx('latacc') >= 0 ? roleIdx('latacc') : base);
      c = newChart('xy', [y], { xChan: x });
    } else c = newChart(kind, [base]);
    D.charts.push(c);
    renderSidebar(); render();
    requestAnimationFrame(() => { const v = $('#view'); v.scrollTop = v.scrollHeight; });
  }

  const charts = createCharts({
    D, fmtD, esc, note, download: dl, maxPlotted: MAX_PLOTTED,
    chanColor, isMath,
    channelList: () => D.label.map((label, i) => ({ i, label, unit: D.units[i] }))
      .filter(c => c.label && !D.gone.has(c.i)),
    xOf, xFmtFor, viewFor, setViewFrom, hover,
    compare: visibleSessions, colIn, overlayColumn, win, swin, sessSig,
    lapSets: (ci, withSessions) => [{ name: 'this session', laps: D.laps, col: D.cols[ci] },
      ...(withSessions ? visibleSessions() : []).map(s => ({ name: s.name, laps: s.S.laps, col: colIn(s.S, ci) }))
        .filter(s => s.col)],
    removeFrom(chart, ci){
      chart.chans = chart.chans.filter(x => x !== ci);
      if (!chart.chans.length) D.charts = D.charts.filter(c => c !== chart);
      fillAllChannelLists(); render();
    },
    editChannel(ci){ if (isMath(ci)) editMath(ci); },
    onChanged(){ fillAllChannelLists(); render(); },
  });

  const lapview = createLapView({
    D, fmtD, fmtT, esc,
    entries: () => [...D.overlay].map(lapOf).filter(Boolean)
      .sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1)
        || D.sessions.indexOf(a.S) - D.sessions.indexOf(b.S) || a.k - b.k)
      .map(o => ({ ...o, hue: lapHue(o.key), dash: o.primary ? undefined : o.S.dash,
        label: `lap ${o.lap.n}${o.primary ? '' : ' · ' + o.S.short}`,
        short: o.primary ? `L${o.lap.n}` : `L${o.lap.n}·${o.S.short.slice(0, 8)}` })),
    ref: () => {
      const o = D.overlay.has(D.refLap) ? lapOf(D.refLap) : null;
      return o ? { ...o, hue: lapHue(o.key), label: `lap ${o.lap.n}${o.primary ? '' : ' · ' + o.S.short}`,
        short: o.primary ? `L${o.lap.n}` : `L${o.lap.n}·${o.S.short.slice(0, 8)}` } : null;
    },
    colIn,
    speedOf: S => (S === D ? speedCol() : (S.role.speed >= 0 ? S.cols[S.role.speed] : null)),
    channelList: () => D.label.map((label, i) => ({ i, label, unit: D.units[i] }))
      .filter(c => c.label && !D.gone.has(c.i)),
    sessSig,
    setRef(key){
      if (!D.overlay.has(key) && claimLapColor(key)) D.overlay.add(key);
      D.refLap = key;
      renderLaps(); render();
    },
    toggleLap,
    moveSF(i){ detectLaps(i); renderSidebar(true); render(); },
    hover(i){ hover(i, null); },
    onChanged(){ fillAllChannelLists(); render(); },
  });

  /* ---- session strip: whole run, with the zoom window brushed ---- */
  function setupCanvas(cv, h){
    const dpr = devicePixelRatio || 1, w = cv.clientWidth;
    cv.height = Math.round(h*dpr); cv.width = Math.round(w*dpr); cv.style.height = h+'px';
    const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
    return {g, w, h};
  }
  /* Min/max decimation: one vertical span per pixel column, so single-sample spikes
     survive being drawn 36 000 points into 900 px. */
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
        if (mnI <= mxI) pts.push([xs[mnI],mn],[xs[mxI],mx]);
        else pts.push([xs[mxI],mx],[xs[mnI],mn]);
      }
    }
    return pts;
  }
  function drawStrip(){
    const cv = $('#strip');
    if (cv.hidden) return;
    const {g,w,h} = setupCanvas(cv, 64);
    g.fillStyle = CSS('--surface'); g.fillRect(0,0,w,h);
    const spi = roleIdx('speed') >= 0 ? roleIdx('speed') : 1;
    const sp = D.cols[spi];
    if (!sp) return;
    const xs = xArr(), x0 = xs[0], x1 = xs[D.n-1];
    const st = D.stats[spi];
    const X = v => 4 + (w-8)*(v-x0)/((x1-x0)||1);
    const Y = v => h-4 - (h-12)*(v-st.min)/((st.max-st.min)||1);
    const pts = decimate(sp, 0, D.n-1, xs, x0, x1, w-8);
    g.strokeStyle = '#4a4a44'; g.lineWidth = 1; g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(X(px), Y(py)) : g.moveTo(X(px), Y(py))));
    g.stroke();
    g.strokeStyle = 'rgba(200,16,46,.3)';
    for (const l of D.laps){ const px = Math.round(X(D.xMode==='time'?l.t0:l.d0))+0.5;
      g.beginPath(); g.moveTo(px,2); g.lineTo(px,h-2); g.stroke(); }
    const wx0 = X(D.view[0]), wx1 = X(D.view[1]);
    g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(wx0, 2, Math.max(2,wx1-wx0), h-4);
    g.strokeStyle = CSS('--brand'); g.lineWidth = 1.5;
    g.strokeRect(wx0+0.5, 2.5, Math.max(2,wx1-wx0)-1, h-5);
    if (D.marker >= 0){
      const mx = X(xs[D.marker]);
      g.strokeStyle = CSS('--s4'); g.lineWidth = 1.5; g.setLineDash([3, 2]);
      g.beginPath(); g.moveTo(mx+0.5,2); g.lineTo(mx+0.5,h-2); g.stroke(); g.setLineDash([]);
    }
    const cx = X(xs[D.cursor]);
    g.strokeStyle = '#fff'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx+0.5,2); g.lineTo(cx+0.5,h-2); g.stroke();
    cv.onmousedown = e => {
      const r = cv.getBoundingClientRect();
      const toX = px => x0 + (px-4)/(w-8)*(x1-x0);
      const a = toX(e.clientX-r.left);
      let moved = false;
      const mv = ev => { moved = true; const b = toX(ev.clientX-r.left);
        D.view = [Math.min(a,b), Math.max(a,b)]; clampView(); render(); };
      const up = () => { document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up);
        if (!moved){ D.cursor = Math.min(D.n-1, lowerBound(xs, a)); const span = D.view[1]-D.view[0];
          D.view = [a-span/2, a+span/2]; clampView(); render(); } };
      document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    };
  }

  function updateCursorOut(){
    const i = D.cursor, sp = speedCol();
    const lap = D.laps.find(l => i >= l.i0 && i <= l.i1);
    const parts = [
      `t ${fmtT(D.t[i])}`,
      D.dist ? `${(D.dist[i]/1000).toFixed(3)} km` : '',
      lap ? `lap ${lap.n}` : '',
      sp ? `${sp[i].toFixed(1)} ${D.units[roleIdx('speed')]||'km/h'}` : '',
    ];
    if (D.marker >= 0){
      const dt = D.t[i] - D.t[D.marker], dd = D.dist ? D.dist[i] - D.dist[D.marker] : NaN;
      parts.push(`<span class="mk">Δ ${dt >= 0 ? '+' : ''}${dt.toFixed(2)} s${dd === dd ? ` · ${dd >= 0 ? '+' : ''}${dd.toFixed(0)} m` : ''}</span>`);
    }
    $('#cursorout').innerHTML = parts.filter(Boolean).join(' &nbsp;·&nbsp; ');
  }

  /* ============================ sidebar ============================ */
  /* The sidebar shows what the current view needs, and nothing else. Every panel
     collapses, and each view opens only the ones it is about. Sessions is in both, open:
     it is where a comparison starts. */
  const SIDEBAR = {
    charts: [
      { id: 'sess', kind: 'sessions', title: 'Sessions', open: true },
      { id: 'chan', kind: 'channels', title: 'Channels', open: true, grow: true,
        sel: () => flatSel(), toggle: ci => toggleChannel(ci), colour: ci => chanColor(ci) },
      { id: 'laps', kind: 'laps', title: 'Laps' },
    ],
    laps: [
      { id: 'sess', kind: 'sessions', title: 'Sessions', open: true },
      { id: 'laps', kind: 'laps', title: 'Laps', open: true, grow: true },
      { id: 'cmp', kind: 'channels', title: 'Compare channels', open: true, grow: true,
        sel: () => D.cmpChans,
        toggle: ci => {
          if (D.cmpChans.includes(ci)) D.cmpChans = D.cmpChans.filter(x => x !== ci);
          else if (D.cmpChans.length >= 6) note('6 channels is the most the lap view stacks — remove one first');
          else D.cmpChans.push(ci);
        },
        colour: () => 'var(--brand)' },
    ],
  };

  const openKey = (mode, id) => `${mode}.${id}`;
  function isOpen(mode, p){
    const k = openKey(mode, p.id);
    return D.panelOpen.has(k) ? D.panelOpen.get(k) : !!p.open;
  }

  function panelHTML(p, idx){
    const open = isOpen(D.mode, p);
    const grow = open && p.grow ? 'flex:1' : 'flex:none';
    const countId = p.kind === 'laps' ? ' id="lapn"' : '';
    const head = `<h3 class="disc" data-toggle="${idx}">
      <span class="tw">${open ? '▾' : '▸'}</span> ${p.title}
      <span class="n"${countId} data-count></span></h3>`;

    if (p.kind === 'laps'){
      return `<div class="panel" data-p="${idx}" style="${grow}">${head}
        <div class="body" id="lapwrap" ${open ? '' : 'hidden'}></div></div>`;
    }
    if (p.kind === 'sessions'){
      return `<div class="panel sesspanel" data-p="${idx}" style="flex:none">${head}
        <div class="body sesswrap" ${open ? '' : 'hidden'}></div></div>`;
    }
    return `<div class="panel ${open ? 'chanpanel' : ''}" data-p="${idx}" style="${grow}">${head}
      <div data-collapse ${open ? '' : 'hidden'}>
        <div class="ctl"><input type="search" data-search placeholder="Search channels&hellip;"></div>
        <div class="ctl" style="padding-top:0">
          <label class="flatlbl"><input type="checkbox" data-flat> hide flat</label>
          <div class="sp" style="flex:1"></div>
          <button data-newmath class="mini fxbtn"
            title="New math channel: a channel built from an expression over the others">+ &fnof; Math</button>
          <button data-clear class="mini">clear</button>
        </div>
      </div>
      <div class="body chanwrap" ${open ? '' : 'hidden'}></div></div>`;
  }

  function renderSidebar(rebuild){
    const side = $('#side');
    const panels = SIDEBAR[D.mode] || SIDEBAR.charts;
    if (rebuild || side.dataset.mode !== D.mode){
      side.dataset.mode = D.mode;
      side.innerHTML = panels.map(panelHTML).join('') + rolesPanelHTML();

      side.querySelectorAll('[data-toggle]').forEach(h => {
        h.onclick = () => {
          const p = panels[+h.dataset.toggle];
          D.panelOpen.set(openKey(D.mode, p.id), !isOpen(D.mode, p));
          renderSidebar(true);
        };
      });

      side.querySelectorAll('.panel').forEach(el => {
        const p = panels[+el.dataset.p];
        if (!p || p.kind !== 'channels' || !isOpen(D.mode, p)) return;
        const q = el.querySelector('[data-search]');
        const flat = el.querySelector('[data-flat]');
        q.value = D.chQuery;
        flat.checked = D.hideFlat;
        q.oninput = () => { D.chQuery = q.value; fillAllChannelLists(); };
        flat.onchange = () => { D.hideFlat = flat.checked; fillAllChannelLists(); };
        el.querySelector('[data-clear]').onclick = () => {
          if (D.mode === 'charts') D.charts = []; else D.cmpChans = [];
          renderSidebar(true); render();
        };
        el.querySelector('[data-newmath]').onclick = () => editMath(-1);
        const list = el.querySelector('.chanwrap');
        list.onclick = e => {
          const row = e.target.closest('.ch'); if (!row) return;
          if (charts.justDragged()) return;
          const i = +row.dataset.i;
          if (e.target.closest('[data-edit]') || (isMath(i) && mathAt(i).error)){ editMath(i); return; }
          p.toggle(i);
          fillAllChannelLists(); render();
        };
        /* In Charts a row can also be dragged straight into the workspace: between charts
           for a chart of its own, onto one to add it there. */
        list.onpointerdown = D.mode === 'charts' ? e => {
          const row = e.target.closest('.ch');
          if (!row || e.target.closest('button')) return;
          const i = +row.dataset.i;
          if (isMath(i) && mathAt(i).error) return;
          charts.pressChannel(e, i);
        } : null;
      });
      bindRolesPanel();
    }
    fillAllChannelLists();
    renderSessions();
    if (side.querySelector('#lapwrap')) renderLaps();
    renderRoles();
  }

  function fillAllChannelLists(){
    const panels = SIDEBAR[D.mode] || SIDEBAR.charts;
    $('#side').querySelectorAll('.panel').forEach(el => {
      const p = panels[+el.dataset.p];
      if (p && p.kind === 'channels' && isOpen(D.mode, p)) fillChannelList(el, p);
    });
  }

  function fillChannelList(el, p){
    const sel = p.sel();
    const q = D.chQuery.toLowerCase();
    const groups = new Map();
    const maths = [];
    D.names.forEach((n, i) => {
      if (D.gone.has(i)) return;
      const chosen = sel.includes(i);
      if (q && !D.label[i].toLowerCase().includes(q)) return;
      if (isMath(i)){ maths.push(i); return; }
      if (D.hideFlat && D.stats[i].flat && !chosen) return;
      const g = n.split(' ')[0];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    });
    const shown = maths.length + [...groups.values()].reduce((a, b) => a + b.length, 0);
    const count = el.querySelector('[data-count]');
    if (count) count.textContent = `${shown} / ${D.names.length - D.gone.size} · ${sel.length} ${D.mode === 'charts' ? 'plotted' : 'compared'}`;

    const row = i => {
      const on = sel.includes(i);
      const m = isMath(i) ? mathAt(i) : null;
      const cls = ['ch', on ? 'on' : '', D.stats[i].flat && !m ? 'dead' : '',
        m ? 'math' : '', m && m.error ? 'err' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" data-i="${i}"${m && m.error ? ` title="${esc(m.error.message)}"` : ''}>
          <span class="sw" style="${on ? `background:${p.colour(i)}` : ''}"></span>
          <span class="nm">${esc(D.label[i])}</span>
          <span class="rng">${m && m.error ? '<span class="warn">error</span>' : fmtRange(i)}</span>
          <span class="u">${esc(D.units[i] || '')}</span>
          ${m ? `<button class="ed" data-edit title="edit ${esc(D.label[i])}">✎</button>` : ''}</div>`;
    };

    const out = [];
    if (maths.length){
      out.push(`<div class="grp math">ƒ Math · ${maths.length}</div>`);
      maths.forEach(i => out.push(row(i)));
    }
    for (const [gn, list] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))){
      if (list.length > 1) out.push(`<div class="grp">${esc(gn)} · ${list.length}</div>`);
      for (const i of list) out.push(row(i));
    }
    el.querySelector('.chanwrap').innerHTML =
      out.join('') || '<div class="hint" style="padding:10px 12px">no matches</div>';
  }

  /* ---- sessions ---- */
  const dashSwatch = dash => `<svg class="dash" width="24" height="6" aria-hidden="true"><line x1="0" y1="3" x2="24" y2="3"
    stroke="currentColor" stroke-width="2" ${dash ? `stroke-dasharray="${dash.join(' ')}"` : ''}/></svg>`;
  const bestOf = laps => { const v = laps.filter(l => !l.partial); return v.length ? Math.min(...v.map(l => l.time)) : NaN; };

  function renderSessions(){
    const w = $('#side .sesswrap');
    const count = $('#side .sesspanel [data-count]');
    if (count) count.textContent = D.sessions.length ? `${D.sessions.length} imported` : '';
    if (!w) return;
    const unit = D.xMode === 'time' ? 's' : 'm';
    const laps = L => { const n = L.filter(l => !l.partial).length; return n ? `${n} laps · best ${fmtT(bestOf(L))}` : 'no laps'; };
    w.innerHTML = `
      <div class="sess this">${dashSwatch(null)}<div class="sm"><b>This session</b><span>${laps(D.laps)}</span></div></div>
      ${D.sessions.map(S => `<div class="sess ${S.visible ? '' : 'off'}" data-key="${S.key}">
        ${dashSwatch(S.dash)}
        <div class="sm">
          <b title="${esc(S.name)}">${esc(S.short)}</b>
          <span>${[S.sub, laps(S.laps)].filter(Boolean).map(esc).join(' · ')}${S.laps.length && !S.sfMatched
            ? ' <span class="warn" title="never passes this session’s start/finish line, so its laps are timed from its own and may not line up">≠ S/F</span>' : ''}</span>
          ${D.mode === 'charts' ? `<div class="sess-ctl">
            <label title="slide this session along the x axis to line it up">shift
              <input type="number" step="${unit === 's' ? 0.1 : 1}" data-off value="${+(D.xMode === 'time' ? S.offT : S.offD).toFixed(3)}"> ${unit}</label>
            <button class="mini" data-align title="shift so each session's best lap starts at the same point">align best laps</button>
          </div>` : ''}
        </div>
        <button class="icon" data-vis title="${S.visible ? 'hide from charts' : 'show in charts'}" aria-pressed="${S.visible}">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/>
          ${S.visible ? '<circle cx="8" cy="8" r="2" fill="currentColor"/>' : '<path d="M3 13 13 3" stroke="currentColor" stroke-width="1.3"/>'}</svg></button>
        <button class="icon drop" data-rm title="remove ${esc(S.name)}" aria-label="remove ${esc(S.name)}">×</button>
      </div>`).join('')}
      <div class="ctl"><button class="btn addsess" data-addsess ${D.sessions.length >= MAX_SESSIONS ? 'disabled' : ''}>+ Add session to compare…</button></div>
      ${D.sessions.length ? '' : '<div class="hint sess-hint">Overlay another day’s run from the team library or a CSV on this computer.</div>'}`;

    w.onclick = e => {
      if (e.target.closest('[data-addsess]')){ importSession(); return; }
      const row = e.target.closest('.sess[data-key]');
      if (!row) return;
      const S = D.sessions.find(s => s.key === row.dataset.key);
      if (e.target.closest('[data-rm]')){ removeSession(S.key); return; }
      if (e.target.closest('[data-vis]')){ S.visible = !S.visible; D.sessVer++; renderSessions(); render(); return; }
      if (e.target.closest('[data-align]')){
        const pb = D.laps.find(l => l.best), sb = S.laps.find(l => l.best);
        if (!pb || !sb){ note('Both sessions need a timed lap to line up on'); return; }
        S.offT = +(pb.t0 - sb.t0).toFixed(3); S.offD = +(pb.d0 - sb.d0).toFixed(2);
        D.sessVer++; renderSessions(); render();
      }
    };
    w.onchange = e => {
      const inp = e.target.closest('[data-off]');
      if (!inp) return;
      const S = D.sessions.find(s => s.key === inp.closest('.sess').dataset.key);
      const v = parseFloat(inp.value) || 0;
      if (D.xMode === 'time') S.offT = v; else S.offD = v;
      D.sessVer++; render();
    };
  }

  /* ---- roles panel ---- */
  function rolesTrouble(){
    const unset = ROLES.filter(R => !R.optional && roleIdx(R.key) < 0);
    const ambiguous = ROLES.filter(R => (D.roleAmbig[R.key] || []).length > 1);
    return { unset, ambiguous };
  }
  function rolesPanelHTML(){
    return `<div class="panel roles" style="flex:none">
      <h3 class="disc" id="rolehead">
        <span class="tw">▸</span> Channel roles <span class="n" id="rolen"></span>
      </h3>
      <div class="body" id="rolewrap" hidden></div></div>`;
  }
  function bindRolesPanel(){
    const head = $('#rolehead'), body = $('#rolewrap');
    if (!head) return;
    const set = open => {
      body.hidden = !open;
      head.querySelector('.tw').textContent = open ? '▾' : '▸';
      D.rolesOpen = open;
    };
    head.onclick = () => set(body.hidden);
    const { unset, ambiguous } = rolesTrouble();
    set(D.rolesOpen || unset.length > 0 || ambiguous.length > 0);
  }

  /* ---- laps panel: every session's laps, grouped ---- */
  function renderLaps(){
    const w = $('#lapwrap'), n = $('#lapn');
    if (!w || !n) return;
    const groups = [{ key: 'p', name: 'This session', laps: D.laps }]
      .concat(D.sessions.map(S => ({ key: S.key, name: S.short, laps: S.laps })));
    if (!groups.some(g => g.laps.length)){
      const why = roleIdx('speed') < 0 || !D.x
        ? 'needs a speed and a position channel — set them under Channel roles'
        : 'no laps detected';
      w.innerHTML = `<div class="hint" style="padding:8px 12px">${why}</div>`;
      n.textContent = ''; return;
    }
    const bt = bestOf(D.laps);
    n.textContent = `${D.laps.filter(l => !l.partial).length} timed · best ${fmtT(bt)} · ${D.overlay.size} ticked`;
    const rows = groups.map(g => {
      if (!g.laps.length) return '';
      const gbest = bestOf(g.laps);
      const head = D.sessions.length ? `<tr class="lg"><td colspan="4">${esc(g.name)}</td></tr>` : '';
      return head + g.laps.map((l, k) => {
        const key = `${g.key}:${k}`, ov = D.overlay.has(key);
        const sel = g.key === 'p' && k === D.selLap;
        return `<tr data-key="${key}" class="${sel ? 'sel' : ''} ${l.best ? 'best' : ''} ${l.partial ? 'partial' : ''}">
          <td class="tick" title="tick to compare"><span class="sw ${ov ? 'on' : ''}" style="${ov ? `background:${lapHue(key)}` : ''}"></span>${l.n}${key === D.refLap ? ' <span class="tag">ref</span>' : ''}</td>
          <td>${fmtT(l.time)}</td>
          <td>${l.partial || !isFinite(gbest) ? '—' : (l.time - gbest >= 0 ? '+' : '') + (l.time - gbest).toFixed(2)}</td>
          <td>${isFinite(l.maxSpeed) ? l.maxSpeed.toFixed(0) : '—'}</td></tr>`;
      }).join('');
    }).join('');
    w.innerHTML = `<table class="laps"><tr><th>Lap</th><th>Time</th><th>Δ best</th><th>Max</th></tr>${rows}</table>`;
    w.onclick = e => {
      const tr = e.target.closest('tr[data-key]'); if (!tr) return;
      const key = tr.dataset.key;
      if (D.mode === 'laps' || e.target.closest('td')?.cellIndex === 0){ toggleLap(key); return; }
      const o = lapOf(key);
      if (!o) return;
      const offT = o.primary ? 0 : o.S.offT, offD = o.primary ? 0 : o.S.offD;
      D.view = D.xMode === 'time' ? [o.lap.t0 + offT, o.lap.t1 + offT] : [o.lap.d0 + offD, o.lap.d1 + offD];
      clampView();
      D.selLap = o.primary ? o.k : -1;
      if (o.primary) D.cursor = o.lap.i0;
      renderLaps(); render();
    };
  }

  /* ============================ chrome ============================ */
  function syncChrome(){
    const charts = D.mode === 'charts';
    root.querySelectorAll('#modetabs [data-mode]').forEach(b => {
      b.classList.toggle('on', b.dataset.mode === D.mode);
      b.setAttribute('aria-selected', String(b.dataset.mode === D.mode));
    });
    for (const id of ['#xpick', '#addmenu', '#layoutmenu', '#marker', '#zoomlap']) {
      const el = $(id); if (el) el.hidden = !charts;
    }
    $('#marker')?.classList.toggle('on', D.marker >= 0);
  }

  $('#loadbtn').onclick = () => $('#file').click();
  $('#file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]).catch(() => {});
  on(document, 'dragover', e => { e.preventDefault(); $('#drop')?.classList.add('hot'); });
  on(document, 'dragleave', () => $('#drop')?.classList.remove('hot'));
  on(document, 'drop', e => { e.preventDefault();
    $('#drop')?.classList.remove('hot');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f).catch(() => {}); });

  $('#modetabs').onclick = e => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.dataset.mode === D.mode) return;
    D.mode = b.dataset.mode;
    charts.destroy(); lapview.destroy();
    $('#view').innerHTML = '';
    syncChrome();
    renderSidebar(); render();
  };
  $('#xsel').onchange = e => {
    D.xMode = e.target.value;
    const xs = xArr();
    const l = D.laps[D.selLap];
    D.view = l ? (D.xMode==='time'?[l.t0,l.t1]:[l.d0,l.d1]) : [xs[0], xs[D.n-1]];
    renderSessions(); render(); };
  $('#reset').onclick = () => {
    if (D.mode === 'laps'){ D.lapZoom = null; lapview.destroy(); render(); return; }
    const xs = xArr(); D.selLap = -1;
    D.view = [xs[0], xs[D.n-1]]; renderLaps(); render(); };
  $('#marker').onclick = () => toggleMarker();
  function toggleMarker(){
    D.marker = D.marker >= 0 ? -1 : D.cursor;
    if (D.marker >= 0) note('Marker set — readouts now show the difference from it. M again clears it.');
    syncChrome(); render();
  }
  $('#layoutmenu .pop').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const group = sel => [...$('#layoutmenu').querySelectorAll(sel)]
      .forEach(x => x.classList.toggle('on', x === b));
    if (b.dataset.cols){ D.traceCols = +b.dataset.cols; group('[data-cols]'); }
    else if (b.dataset.w){ D.lineW = +b.dataset.w; group('[data-w]'); }
    else if (b.dataset.h){
      /* Nudging the default clears the per-chart heights, otherwise the button appears to
         do nothing on exactly the charts somebody has already sized by hand. */
      D.traceH = Math.max(90, Math.min(900, D.traceH + (+b.dataset.h)));
      D.charts.forEach(c => { c.h = 0; });
    }
    render();
  };
  $('#addmenu .pop').onclick = e => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    closeMenus(null);
    addChart(b.dataset.add);
  };

  /* Menus hold mixed controls, so they are popovers -- one open at a time, closed by
     Escape or a click anywhere else. */
  function closeMenus(except){
    root.querySelectorAll('.menu').forEach(m => {
      if (m === except) return;
      m.querySelector('.pop').hidden = true;
      m.querySelector('[data-open]').setAttribute('aria-expanded', 'false');
    });
  }
  root.querySelectorAll('.menu').forEach(m => {
    const btn = m.querySelector('[data-open]'), pop = m.querySelector('.pop');
    btn.onclick = e => {
      e.stopPropagation();
      const show = pop.hidden;
      closeMenus(m);
      pop.hidden = !show;
      btn.setAttribute('aria-expanded', String(show));
    };
  });
  on(document, 'click', () => closeMenus(null));
  on(document, 'keydown', e => { if (e.key === 'Escape') closeMenus(null); });

  $('#zoomlap').onclick = () => { const lap = D.laps.find(l => D.cursor >= l.i0 && D.cursor <= l.i1);
    if (!lap) return; D.selLap = D.laps.indexOf(lap);
    D.view = D.xMode==='time' ? [lap.t0,lap.t1] : [lap.d0,lap.d1]; renderLaps(); render(); };

  /* The whole view as one image, laid out as it is on screen: charts in a grid stay in a
     grid, and each chart's header text is drawn above it. */
  $('#exportpng').onclick = () => {
    closeMenus(null);
    const view = $('#view'), vr = view.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const cvs = [...view.querySelectorAll('canvas')].filter(c => c.width && c.offsetParent !== null);
    if (!cvs.length) return;
    const W = view.scrollWidth, H = view.scrollHeight;
    const o = document.createElement('canvas');
    o.width = Math.round(W * dpr); o.height = Math.round(H * dpr);
    const g = o.getContext('2d');
    g.fillStyle = CSS('--bg'); g.fillRect(0, 0, o.width, o.height);
    const at = el => { const r = el.getBoundingClientRect();
      return { x: (r.left - vr.left + view.scrollLeft) * dpr, y: (r.top - vr.top + view.scrollTop) * dpr, w: r.width * dpr, h: r.height * dpr }; };
    for (const lane of view.querySelectorAll('.lane')){
      const r = at(lane);
      g.fillStyle = CSS('--surface'); g.fillRect(r.x, r.y, r.w, r.h);
    }
    for (const c of cvs){ const r = at(c); g.drawImage(c, r.x, r.y, r.w, r.h); }
    g.font = `600 ${11.5 * dpr}px system-ui`; g.textBaseline = 'middle';
    for (const hd of view.querySelectorAll('.lane-hd')){
      const r = at(hd);
      g.fillStyle = CSS('--ink');
      g.fillText(hd.textContent.replace(/[×⠇ƒ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160), r.x + 10 * dpr, r.y + r.h / 2, r.w - 20 * dpr);
    }
    o.toBlob(b => dl(b, `${(D.meta.Session||'session')}-${D.mode}.png`));
  };
  $('#exportcsv').onclick = () => {
    closeMenus(null);
    if (D.mode === 'laps'){
      const table = $('#view .lv-table');
      if (!table){ note('Tick some laps first — the export is the lap table'); return; }
      const lines = [...table.rows].map(tr => [...tr.cells].map(td => {
        const t = td.textContent.replace(/\s+/g, ' ').trim().replace(/×$/, '');
        return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      }).join(','));
      dl(new Blob([lines.join('\n')], { type: 'text/csv' }), `${(D.meta.Session||'session')}-laps.csv`);
      return;
    }
    const [i0, i1] = win(false);
    const cols = flatSel().length ? flatSel() : [0];
    const lines = [['Time', ...cols.map(c=>D.names[c])].join(',')];
    for (let i = i0; i <= i1; i++)
      lines.push([D.t[i].toFixed(3), ...cols.map(c=>D.cols[c][i])].join(','));
    dl(new Blob([lines.join('\n')], {type:'text/csv'}),
       `${(D.meta.Session||'session')}-${fmtT(D.view[0]).replace(':','m')}.csv`);
  };
  function dl(blob, name){ const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 5000); }

  on(window, 'keydown', e => {
    if (!D.loaded || /input|select|textarea/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal-back')) return;
    const step = e.shiftKey ? 40 : 4;
    if (e.key === 'ArrowRight'){ hover(Math.min(D.n-1, D.cursor+step), null); render(); e.preventDefault(); }
    if (e.key === 'ArrowLeft'){ hover(Math.max(0, D.cursor-step), null); render(); e.preventDefault(); }
    if (e.key === 'f'){ const xs = xArr(); D.view = [xs[0], xs[D.n-1]]; render(); }
    if (e.key === 'l' && D.mode === 'charts'){ $('#zoomlap').click(); }
    if (e.key === 'm' || e.key === 'M'){ toggleMarker(); }
  });
  let rt;
  on(window, 'resize', () => { clearTimeout(rt);
    /* Charts size themselves (a ResizeObserver per chart); the strip still needs a redraw. */
    rt = setTimeout(() => { if (D.mode === 'charts') drawStrip(); }, 120); });
  if (opts.onReady) opts.onReady();

  return {
    loadFile,
    loadParsed,
    /* Logged channels only -- math channels are this browser's, not the file's. */
    parsed: () => (D.loaded ? {
      meta: D.meta, names: D.names.slice(0, D.nRaw), units: D.units.slice(0, D.nRaw),
      cols: D.cols.slice(0, D.nRaw), n: D.n,
    } : null),
    summary: () => (D.loaded ? {
      samples: D.n,
      channels: D.nRaw,
      laps: D.laps.filter(l => !l.partial).length,
      durationS: D.n ? D.t[D.n-1] - D.t[0] : 0,
      session: D.meta.Session || '',
      vehicle: D.meta.Vehicle || '',
      racer: D.meta.Racer || '',
      recordedAt: [D.meta.Date, D.meta.Time].filter(Boolean).join(' '),
    } : null),
    busy,
    failed,
    /* Opens another session alongside this one, for comparison. */
    compareWith: (m, name) => addSession(m, { name, source: { kind: 'file' } }),
    roles: () => (D.loaded ? rolesToNames(D.role, D.names, D.dupe) : null),
    rolesUnanswered: () => (D.loaded
      ? ROLES.filter(R => !R.optional && roleIdx(R.key) < 0).map(R => R.label)
      : []),
    destroy(){ off.forEach(f => f()); off.length = 0; clearTimeout(rt); charts.destroy(); lapview.destroy(); },
  };
}
