/* The telemetry viewer.

   This is the original single-file viewer, unchanged in substance: canvas rendering
   driven by one mutable `D` state object and direct DOM writes. React owns the markup
   (see components/Viewer.jsx) and nothing else -- the charts are redrawn thousands of
   times while dragging a cursor, which is exactly the workload a virtual DOM is worst
   at, and the imperative code here is already the fast path.

   `createViewer` scopes every lookup to the mounted root and hands back a small handle,
   so the page can drop a session in and React can tear the whole thing down cleanly. */

import { parseCsvFile } from './parse.js';
import {
  ROLES, ROLE, channelStats, nameIndex, timeColumn,
  roleCandidates as candidatesFor, resolveRoles as resolveRolesFor,
  rolesFromNames, rolesToNames,
} from './session.js';
import { buildXY, buildDistance, detectLaps as detectLapsIn, colMax } from './track.js';
import { createTraces } from './traces.js';

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
    role:{}, roleAuto:{}, roleAmbig:{},          // which channel plays speed / lat / lon / ...
  chQuery:'', hideFlat:true, rolesOpen:false,  // sidebar controls, kept across rebuilds
  panelOpen:new Map(),                         // which sidebar panels are open, per mode
  traceH:230, traceCols:2, chartH:new Map(),   // trace layout: default height, tiling, per-lane overrides
  lineW:1.5,                                   // trace line weight
  lanes:[],                                    // each lane is one chart holding one or more channels
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
  /* A lane is one chart, holding one or more channels. See traces.js for why merging
     matters and how the scales work. */
  const flatSel = () => D.lanes.flat();
  function toggleChannel(ci){
    const k = D.lanes.findIndex(l => l.includes(ci));
    if (k >= 0){
      D.lanes[k] = D.lanes[k].filter(x => x !== ci);
      if (!D.lanes[k].length) D.lanes.splice(k, 1);
    } else {
      if (flatSel().length >= 8) D.lanes.shift();
      D.lanes.push([ci]);
    }
    D.chartH.clear();
  }
  /* Colour follows the channel's place in the whole selection, so it stays put when a
     lane above it is removed or merged. */
  const chanColor = ci => SLOT[Math.max(0, flatSel().indexOf(ci)) % 8];

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
  /* Errors have to land somewhere the user can see. The drop target is removed once a
     session opens, so anything that goes wrong after that used to fail to a blank panel
     and no message at all -- which cost an hour of staring at an empty viewer once. */
  function failed(msg){
    const empty = $('#empty');
    if (empty){
      empty.style.display = 'flex';
      $('#prog').style.display = 'none';
      $('#status').innerHTML = `<b style="color:var(--brand)">${msg}</b>`;
      return;
    }
    const v = $('#view');
    if (v) v.innerHTML = `<div class="rolefix"><b style="color:var(--brand)">Something went wrong</b>
      <div class="hint">${msg}</div></div>`;
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

    D.stats = channelStats(D.cols, D.n);
    Object.assign(D, nameIndex(D.names, D.stats));
    D.t = timeColumn(D.cols, D.byName, D.n);

    resolveRoles();
    buildGeometry();
    detectLaps();

    const g = n => D.byName[n];
    D.mapChan  = roleIdx('speed') >= 0 ? roleIdx('speed') : 1;
    D.cmpChan  = D.mapChan;
    D.histChan = D.mapChan;
    /* No channels chosen up front. A 250-channel export has no five channels that are
       right for everyone, and picking some meant every session opened onto plots nobody
       asked for, which had to be cleared before the real ones could be added. */
    D.lanes = [];

    D.view = [D.t[0], D.t[D.n-1]];
    D.cursor = 0;

    $('#sessname').textContent = opts.title || `${D.meta.Session || fname} \u2014 ${D.meta.Vehicle || ''}`;
    $('#sessmeta').textContent = [D.meta.Date, D.meta.Time, D.meta.Racer && 'driver ' + D.meta.Racer,
      `${D.n.toLocaleString()} samples`, `${D.names.length} channels`,
      `${D.meta['Sample Rate']||''} Hz`].filter(Boolean).join('  \u00b7  ');
    $('#bar').style.display = 'flex';
    $('#empty').remove();
    renderSidebar(); render();
  }

  /* Role definitions and the matching itself live in session.js, so the upload page
     can resolve them too. This keeps only the viewer's copy of the answer. */

  function roleCandidates(key){ return candidatesFor(key, D); }

  function resolveRoles(){
    const { role, ambiguous } = resolveRolesFor(D);
    D.role = role;
    D.roleAuto = { ...role };
    D.roleAmbig = ambiguous;

    /* Roles the uploader already settled travel with the session, so nobody downstream
       is asked the same question twice. They win over the name match, and anything they
       do not cover falls back to it. */
    const saved = rolesFromNames(opts.roles, D.names, D.dupe);
    for (const k of Object.keys(saved)){
      D.role[k] = saved[k];
      delete D.roleAmbig[k];
    }
  }

  /* Every consumer reads a role through these rather than looking a name up itself --
     that is the whole point of roles, and it is what stops two views disagreeing about
     which column is the speed. */
  const roleIdx = k => (D.role && D.role[k] !== undefined ? D.role[k] : -1);
  const roleCol = k => { const i = roleIdx(k); return i >= 0 ? D.cols[i] : null; };
  const speedCol = () => roleCol('speed');

  const fmtRange = i => { const st = D.stats[i];
    return st.flat ? (st.min === st.min ? `flat ${fmtD(st.min)}` : 'no data')
                   : `${fmtD(st.min)}\u2013${fmtD(st.max)}`; };

  /* name - unit - range: enough to tell apart two channels that share a name. */
  function chanOptLabel(i){
    return `${D.label[i]}${D.units[i] ? '  \u2014 ' + D.units[i] : ''}  \u00b7 ${fmtRange(i)}`;
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
    /* "not set" goes first. It used to be appended after all 250 channels, so an unset
       role -- exactly the case you are being asked to fix -- opened the list scrolled to
       the very bottom with the likely candidates a full page above. */
    const none = document.createElement('option');
    none.value = -1; none.textContent = R.none ? `\u2014 ${R.none} \u2014` : '\u2014 not set \u2014';
    sel.appendChild(none);
    if (cands.length){ const g1 = document.createElement('optgroup'); g1.label = 'likely';
      cands.forEach(i => add(g1, i)); sel.appendChild(g1); }
    const g2 = document.createElement('optgroup'); g2.label = 'all channels';
    rest.forEach(i => add(g2, i)); sel.appendChild(g2);
    sel.value = String(cur);
  }
  /* Changing a role re-derives everything downstream of it and redraws. */
  function setRole(key, i){
    D.role[key] = i;
    if (key === 'speed' || key === 'lat' || key === 'lon' || key === 'dist'){
      buildGeometry(); detectLaps();
      const xs = xArr(); D.view = [xs[0], xs[D.n-1]]; D.selLap = -1;
    }
    renderSidebar(); render();
  }
  function renderRoles(){
    const wrap = $('#rolewrap');
    if (!wrap || !D.loaded) return;
    wrap.innerHTML = ROLES.map(R => {
      /* A question mark means "still unanswered". Once a choice is made the role is
         settled, so the marker goes -- leaving it up would nag about a decision the
         user has already taken. */
      const open = roleIdx(R.key) < 0;
      const amb = open && (D.roleAmbig[R.key] || []).length > 1;
      const unset = open && !amb && !R.optional;
      const flag = amb
        ? ` <span class="warn" title="${D.roleAmbig[R.key].length} channels match this equally well \u2014 pick one">?</span>`
        : (unset ? ' <span class="warn" title="not found \u2014 pick one">!</span>' : '');
      return `<div class="role ${amb || unset ? 'needs' : ''}">
        <label title="used for ${R.used}">${R.label}${flag}</label>
        <select data-role="${R.key}"></select></div>`;
    }).join('')
      + (ROLES.some(R => roleIdx(R.key) < 0 && (D.roleAmbig[R.key] || []).length > 1)
        ? `<div class="hint" style="padding:8px 2px 2px">Marked roles have more than one
             equally good match in this file. The viewer will not choose for you \u2014 the
             range beside each name is usually enough to tell them apart.</div>`
        : '');
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
    const amb = keys.filter(k => (D.roleAmbig[k] || []).length > 1);
    const why = amb.length
      ? `This file has more than one channel that matches
         ${amb.map(k => `<b>${ROLE[k].label.toLowerCase()}</b>`).join(' and ')} equally well
         (${amb.map(k => D.roleAmbig[k].map(i => D.label[i]).join(', ')).join('; ')}),
         so the viewer has not picked one. The range beside each name usually settles it.`
      : `Name matching did not find ${keys.length > 1 ? 'these channels' : 'this channel'}
         in this file. Pick ${keys.length > 1 ? 'them' : 'it'} here.`;
    return `<div class="rolefix"><b>${what}</b>
      <div class="hint">${why}</div>${list}</div>`;
  }

  /* Local tangent-plane metres from lat/lon, plus a cumulative distance channel.
     Distance is integrated from GPS speed where available rather than summed from
     positions: position noise adds a metre or two of phantom distance every lap, and
     distance is the x-axis every lap comparison is aligned on. */
  function buildGeometry(){
    const { x, y } = buildXY(roleCol('lat'), roleCol('lon'), D.n);
    D.x = x; D.y = y;
    const dch = roleIdx('dist');
    D.dist = buildDistance({
      n: D.n, t: D.t, speed: speedCol(), x, y,
      distChannel: dch >= 0 && !D.stats[dch].flat && roleIdx('speed') === D.roleAuto.speed
        ? D.cols[dch] : null,
    });
  }

  function detectLaps(sfIdx){
    const { laps, sf } = detectLapsIn({
      n: D.n, t: D.t, x: D.x, y: D.y, dist: D.dist, speed: speedCol(), sfIdx,
    });
    D.laps = laps; D.sf = sf;
    D.refLap = laps.findIndex(l => l.best);
    const valid = laps.filter(l => !l.partial);
    D.overlay = new Set(valid.slice(0, 3).map(l => laps.indexOf(l)));
    D.lapColor = new Map();
    [...D.overlay].sort((a, b) => a - b).forEach(claimLapColor);
  }

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
    /* The tiled grid belongs to the trace stack alone. It used to be left on #view when
       switching away, which laid the track map out in two columns. */
    if (D.mode !== 'traces') v.className = '';
    if (D.mode === 'traces') renderTraces(v);
    else if (D.mode === 'compare') renderCompare(v);
    else if (D.mode === 'track') renderTrack(v);
    else renderAnalysis(v);
    drawStrip();
    updateCursorOut();
  }

  /* ---- traces: one lane per channel, shared x, shared crosshair ---- */
  /* The trace stack lives in traces.js, on uPlot. It gets a small context rather than
     the viewer's internals, so the two can move independently. */
  const traces = createTraces({
    D,
    xArr, xFmt, fmtD,
    chanColor,
    laneHeight: i => D.chartH.get(i) || D.traceH,
    setView(range){
      const xs = xArr();
      D.view = range ? range : [xs[0], xs[D.n-1]];
      clampView();
      if (!range) D.selLap = -1;
      render();
    },
    setCursor(idx){
      if (idx === D.cursor) return;
      D.cursor = Math.max(0, Math.min(D.n - 1, idx));
      updateCursorOut();
      drawStrip();
    },
    removeChannel(ci){ toggleChannel(ci); fillAllChannelLists(); render(); },
    onLanesChanged(){ fillAllChannelLists(); render(); },
  });

  function renderTraces(root){ traces.render(root); }

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
      <div class="viewnote">Click a lap's swatch in the sidebar to overlay it \u00b7
        pick the channel and the reference lap there too</div>
      <div class="chart"><canvas id="cmpc"></canvas>
        <div class="hd"><span>${D.label[D.cmpChan]}</span>
        <span class="u">${D.units[D.cmpChan]||''} \u00b7 vs distance into lap</span></div></div>
      <div class="chart"><canvas id="dtc"></canvas>
        <div class="hd"><span>Delta-t vs lap ${D.laps[D.refLap]?.n ?? '\u2014'}</span>
        <span class="u">s \u00b7 below zero = ahead of reference</span></div></div>`;
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
      <div class="viewnote">Click the trace to move the start/finish line and re-time the laps
        \u00b7 pick the colour channel in the sidebar</div>
      <div class="chart"><canvas id="mapc"></canvas>
        <div class="hd"><span>${D.label[D.mapChan]}</span><span class="u">${D.units[D.mapChan]||''}</span></div></div>`;
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
      <div class="chart" style="padding:8px 2px"><table class="stats" id="stab"></table></div>`;
    $('#hiu').textContent = `${D.label[D.histChan]}${D.units[D.histChan] ? ' \u00b7 ' + D.units[D.histChan] : ''}`;

    const xs = xArr(), [i0,i1] = idxRange(xs, D.view[0], D.view[1]);

    { const {g,w,h} = setupCanvas($('#ggc'), 300);
      const lat = roleCol('latacc'), lon = roleCol('lonacc');
      if (!lat || !lon){ g.fillStyle=CSS('--surface'); g.fillRect(0,0,w,h);
        g.fillStyle=CSS('--ink-3'); g.font='12px system-ui'; g.textAlign='center';
        g.fillText('set the lateral / inline g channels under Channel roles', w/2, h/2); }
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
    const rows = (flatSel().length ? flatSel() : [D.histChan]).map(ci => {
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

  /* The sidebar shows what the current view actually needs, and nothing else.

     It used to be the same three panels in every mode: a channel multi-select that only
     Traces uses, a lap table, and six role dropdowns. So Track and Analysis -- which
     each need exactly one channel chosen -- offered a 250-channel checklist that does
     nothing, and hid the choice that matters in a 260 px dropdown over on the right.

     Now each mode gets the picker it needs, at full sidebar width, searchable. The
     channel list is one component in two modes: `multi` for the trace stack, `single`
     for "colour the map by this". */

  /* Every panel collapses, and each mode opens only the one it is about.

     Traces is a channel picker and nothing else -- that is the whole view. Compare is
     about laps and one channel. Track and Analysis each want a single channel. The
     others stay in the column, one click away, rather than being three panels of
     furniture competing with the one that matters. */
  const SIDEBAR = {
    traces: [
      { id: 'chan', kind: 'channels', pick: 'multi', title: 'Channels', open: true, grow: true },
      { id: 'laps', kind: 'laps', title: 'Laps' },
    ],
    compare: [
      { id: 'laps', kind: 'laps', title: 'Laps', open: true, grow: true },
      { id: 'ref', kind: 'reflap', title: 'Reference lap', open: true },
      { id: 'cmp', kind: 'channels', pick: 'single', title: 'Compare channel', open: true, grow: true,
        get: () => D.cmpChan, set: v => { D.cmpChan = v; } },
    ],
    track: [
      { id: 'map', kind: 'channels', pick: 'single', title: 'Colour the map by', open: true, grow: true,
        get: () => D.mapChan, set: v => { D.mapChan = v; } },
      { id: 'laps', kind: 'laps', title: 'Laps' },
    ],
    analysis: [
      { id: 'hist', kind: 'channels', pick: 'single', title: 'Histogram of', open: true, grow: true,
        get: () => D.histChan, set: v => { D.histChan = v; } },
      { id: 'chan', kind: 'channels', pick: 'multi', title: 'Channels in the table' },
      { id: 'laps', kind: 'laps', title: 'Laps' },
    ],
  };

  /* Whether a panel is open is remembered per mode, so collapsing Laps in Traces does
     not also collapse it in Compare, where it is the point of the view. */
  const openKey = (mode, id) => `${mode}.${id}`;
  function isOpen(mode, p){
    const k = openKey(mode, p.id);
    return D.panelOpen.has(k) ? D.panelOpen.get(k) : !!p.open;
  }

  function panelHTML(p, idx){
    const open = isOpen(D.mode, p);
    const grow = open && p.grow ? 'flex:1' : 'flex:none';
    /* The lap summary keeps its own id: renderLaps writes the best-lap line into the
       header whether or not the panel body is open. */
    const countId = p.kind === 'laps' ? ' id="lapn"' : '';
    const head = `<h3 class="disc" data-toggle="${idx}">
      <span class="tw">${open ? '\u25be' : '\u25b8'}</span> ${p.title}
      <span class="n"${countId} data-count></span></h3>`;

    if (p.kind === 'laps'){
      return `<div class="panel" data-p="${idx}" style="${grow}">${head}
        <div class="body" id="lapwrap" ${open ? '' : 'hidden'}></div></div>`;
    }
    if (p.kind === 'reflap'){
      return `<div class="panel" data-p="${idx}" style="flex:none">${head}
        <div class="ctl" ${open ? '' : 'hidden'}><select id="refsel"></select></div></div>`;
    }
    return `<div class="panel ${open ? 'chanpanel' : ''}" data-p="${idx}" style="${grow}">${head}
      <div data-collapse ${open ? '' : 'hidden'}>
        <div class="ctl"><input type="search" data-search placeholder="Search channels&hellip;"></div>
        <div class="ctl" style="padding-top:0">
          <label class="flatlbl"><input type="checkbox" data-flat> hide flat</label>
          <div class="sp" style="flex:1"></div>
          ${p.pick === 'multi' ? '<button data-clear class="mini">clear</button>' : ''}
        </div>
      </div>
      <div class="body chanwrap" ${open ? '' : 'hidden'}></div></div>`;
  }

  /* Rebuilt when the mode changes or a panel is opened -- a rebuild mid-keystroke would
     drop the search box's focus, so typing only refills the list. */
  function renderSidebar(rebuild){
    const side = $('#side');
    const panels = SIDEBAR[D.mode] || SIDEBAR.traces;
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
        /* The roles panel is a .panel too and carries no index. */
        const p = panels[+el.dataset.p];
        if (!p || p.kind !== 'channels' || !isOpen(D.mode, p)) return;
        const q = el.querySelector('[data-search]');
        const flat = el.querySelector('[data-flat]');
        q.value = D.chQuery;
        flat.checked = D.hideFlat;
        q.oninput = () => { D.chQuery = q.value; fillAllChannelLists(); };
        flat.onchange = () => { D.hideFlat = flat.checked; fillAllChannelLists(); };
        el.querySelector('[data-clear]')?.addEventListener('click', () => {
          D.lanes = []; renderSidebar(true); render();
        });
        el.querySelector('.chanwrap').onclick = e => {
          const row = e.target.closest('.ch'); if (!row) return;
          const i = +row.dataset.i;
          if (p.pick === 'single'){ p.set(i); }
          else toggleChannel(i);
          fillAllChannelLists(); render();
        };
      });
      bindRolesPanel();
    }
    fillAllChannelLists();
    if (side.querySelector('#lapwrap')) renderLaps();
    if (side.querySelector('#refsel')) fillRefLap();
    renderRoles();
  }

  function fillAllChannelLists(){
    const panels = SIDEBAR[D.mode] || SIDEBAR.traces;
    $('#side').querySelectorAll('.panel').forEach(el => {
      const p = panels[+el.dataset.p];
      if (p && p.kind === 'channels' && isOpen(D.mode, p)) fillChannelList(el, p);
    });
  }

  function fillChannelList(el, p) {
    const single = p.pick === 'single';
    const cur = single ? p.get() : -1;
    const q = D.chQuery.toLowerCase();
    const groups = new Map();
    D.names.forEach((n, i) => {
      const chosen = single ? i === cur : flatSel().includes(i);
      if (D.hideFlat && D.stats[i].flat && !chosen) return;
      if (q && !n.toLowerCase().includes(q)) return;
      const g = n.split(' ')[0];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    });
    const shown = [...groups.values()].reduce((a, b) => a + b.length, 0);
    const count = el.querySelector('[data-count]');
    if (count) count.textContent =
      `${shown} / ${D.names.length}` + (single ? '' : ` \u00b7 ${flatSel().length} plotted`);

    const out = [];
    for (const [gn, list] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))){
      if (list.length > 1) out.push(`<div class="grp">${gn} \u00b7 ${list.length}</div>`);
      for (const i of list){
        const k = single ? (i === cur ? 0 : -1) : flatSel().indexOf(i);
        const colour = single ? 'var(--brand)' : chanColor(i);
        out.push(`<div class="ch ${k >= 0 ? 'on' : ''} ${D.stats[i].flat ? 'dead' : ''}" data-i="${i}">
          <span class="sw" style="${k >= 0 ? `background:${colour}` : ''}"></span>
          <span class="nm">${D.label[i]}</span>
          <span class="rng">${fmtRange(i)}</span>
          <span class="u">${D.units[i] || ''}</span></div>`);
      }
    }
    el.querySelector('.chanwrap').innerHTML =
      out.join('') || '<div class="hint" style="padding:10px 12px">no matches</div>';
  }

  function fillRefLap(){
    const rs = $('#refsel');
    rs.innerHTML = '';
    D.laps.forEach((l, k) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = `Lap ${l.n} \u2014 ${fmtT(l.time)}`;
      if (k === D.refLap) o.selected = true;
      rs.appendChild(o);
    });
    rs.onchange = () => { D.refLap = +rs.value; render(); };
  }

  /* The roles panel was six dropdowns on permanent display, and on a well-formed export
     there is never anything to do in it -- which is exactly what it looked like. It is
     worth its space only when the guess is wrong or unmade, so it collapses, and opens
     itself when a role is unset or a name is ambiguous. */
  function rolesTrouble(){
    const unset = ROLES.filter(R => !R.optional && roleIdx(R.key) < 0);
    const ambiguous = ROLES.filter(R => (D.roleAmbig[R.key] || []).length > 1);
    return { unset, ambiguous };
  }
  function rolesPanelHTML(){
    return `<div class="panel roles" style="flex:none">
      <h3 class="disc" id="rolehead">
        <span class="tw">\u25b8</span> Channel roles <span class="n" id="rolen"></span>
      </h3>
      <div class="body" id="rolewrap" hidden></div></div>`;
  }
  function bindRolesPanel(){
    const head = $('#rolehead'), body = $('#rolewrap');
    if (!head) return;
    const set = open => {
      body.hidden = !open;
      head.querySelector('.tw').textContent = open ? '\u25be' : '\u25b8';
      D.rolesOpen = open;
    };
    head.onclick = () => set(body.hidden);
    const { unset, ambiguous } = rolesTrouble();
    set(D.rolesOpen || unset.length > 0 || ambiguous.length > 0);
  }

  function renderLaps(){
    const w = $('#lapwrap'), n = $('#lapn');
    if (!w || !n) return;
    if (!D.laps.length){
      const why = roleIdx('speed') < 0 || !D.x
        ? 'needs a speed and a position channel \u2014 set them under Channel roles'
        : 'no laps detected';
      w.innerHTML = `<div class="hint" style="padding:8px 12px">${why}</div>`;
      n.textContent = ''; return; }
    const valid = D.laps.filter(l=>!l.partial);
    const bt = valid.length ? Math.min(...valid.map(l=>l.time)) : NaN;
    n.textContent = `${valid.length} timed \u00b7 best ${fmtT(bt)}`;
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
    $('#view').dataset.k = '';
    $('#tracectl').hidden = D.mode !== 'traces';
    renderSidebar(); render(); };
  $('#xmodes').onclick = e => { const b = e.target.closest('button'); if (!b) return;
    const xs0 = xArr(), c = D.cursor;
    D.xMode = b.dataset.x; [...$('#xmodes').children].forEach(x => x.classList.toggle('on', x===b));
    const xs = xArr();
    const l = D.laps[D.selLap];
    D.view = l ? (D.xMode==='time'?[l.t0,l.t1]:[l.d0,l.d1]) : [xs[0], xs[D.n-1]];
    render(); };
  $('#reset').onclick = () => { const xs = xArr(); D.selLap = -1;
    D.view = [xs[0], xs[D.n-1]]; renderLaps(); render(); };
  $('#tracectl').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cols){
      D.traceCols = +b.dataset.cols;
      [...$('#tracectl').querySelectorAll('[data-cols]')].forEach(x => x.classList.toggle('on', x === b));
    } else if (b.dataset.w){
      D.lineW = +b.dataset.w;
      [...$('#tracectl').querySelectorAll('[data-w]')].forEach(x => x.classList.toggle('on', x === b));
    } else if (b.dataset.h){
      /* Nudging the default clears the per-lane overrides, otherwise the button appears
         to do nothing on exactly the lanes somebody has already sized by hand. */
      D.traceH = Math.max(90, Math.min(900, D.traceH + (+b.dataset.h)));
      D.chartH.clear();
    }
    render();
  };
  $('#zoomlap').onclick = () => { const lap = D.laps.find(l => D.cursor >= l.i0 && D.cursor <= l.i1);
    if (!lap) return; D.selLap = D.laps.indexOf(lap);
    D.view = D.xMode==='time' ? [lap.t0,lap.t1] : [lap.d0,lap.d1]; renderLaps(); render(); };
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
    const cols = flatSel().length ? flatSel() : [0];
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
    rt = setTimeout(() => { $('#view').dataset.k = ''; traces.destroy(); render(); }, 120); });
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
    /* The current role bindings as channel names, for storing on the session. */
    roles: () => (D.loaded ? rolesToNames(D.role, D.names, D.dupe) : null),
    /* Which required roles are still unanswered, so a page can offer to save only
       once there is a complete answer worth saving. */
    rolesUnanswered: () => (D.loaded
      ? ROLES.filter(R => !R.optional && roleIdx(R.key) < 0).map(R => R.label)
      : []),
    destroy(){ off.forEach(f => f()); off.length = 0; clearTimeout(rt); traces.destroy(); },
  };
}
