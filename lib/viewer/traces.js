import uPlot from 'uplot';

/* The trace stack, on uPlot.

   This was hand-rolled canvas: decimate, draw a polyline, draw axes, draw a crosshair.
   It worked, but every improvement past that point -- a legend that tracks the cursor,
   two channels sharing a lane on separate scales, a cursor synchronised across lanes,
   drag-to-zoom that survives a resize -- meant reimplementing something uPlot already
   does properly. uPlot is ~45 KB, canvas-based, and built for exactly this shape of
   problem: a long ordered series you scrub through.

   What stays hand-rolled is everything that is *not* a time series -- the track map and
   the g-g scatter are x/y point clouds, which is not what uPlot is for.

   A lane is one chart. It usually holds one channel; dragging one lane onto another
   merges them, which is how brake pressure goes under speed. Channels in a merged lane
   keep independent vertical scales, because bar and km/h have no shared axis -- what a
   merged lane shows is shape against shape, which is the question being asked.

   Lanes are keyed by the channels they hold, not by their position. The stack used to be
   torn down and rebuilt on every change, which reset the scroll position, forgot every
   lane's height the moment one was merged, and made each drop a jump cut. Now a change
   keeps every lane it did not touch, moves the DOM nodes that moved, and animates them
   from where they were to where they are. */

const SYNC_KEY = 'traces';
const DRAG_SLOP = 5;          // px of travel before a press becomes a drag
const EDGE = 56;              // px from the top/bottom of the stack that scroll it while dragging

export function createTraces(ctx){
  /* ctx: { D, xArr, xFmt, fmtD, chanColor, isMath, esc, laneHeight(id), setView, setCursor,
            removeChannel, editChannel, onLanesChanged, maxPlotted, note } */
  const views = new Map();    // lane id -> { id, cell, plot, sig, idx }
  let wrap = null;            // the grid the lanes live in, inside #view
  let viewRoot = null;        // #view, the scroll container
  let lastLayout = '';
  let bar = null;             // insertion marker shown while dragging
  let dragEndedAt = 0;

  const laneId = lane => lane.join('+');
  /* What a lane's plot was built from. A new line weight, x axis or recomputed math
     channel needs a new uPlot; a new position or height does not. */
  const sigOf = lane => lane.map(ci => `${ci}:${ctx.D.colVer[ci] || 0}`).join('+')
    + '|' + ctx.D.lineW + '|' + ctx.D.xMode;

  /* uPlot is told its size in pixels; it does not watch its container. An observer sizes
     each lane from what the grid actually settled on, which also covers window resizes,
     the sidebar changing width and the column count changing. */
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(entries => {
        for (const e of entries){
          const v = views.get(e.target.dataset.id);
          if (!v || !v.plot) continue;
          const w = Math.max(120, Math.round(e.contentRect.width));
          const h = ctx.laneHeight(v.id);
          if (w !== v.plot.width || h !== v.plot.height) v.plot.setSize({ width: w, height: h });
        }
      })
    : null;

  function destroyAll(){
    for (const v of views.values()){
      if (ro) ro.unobserve(v.cell);
      if (v.plot) v.plot.destroy();
      v.cell.remove();
    }
    views.clear();
    wrap = null;
    bar = null;
    lastLayout = '';
  }

  function render(root){
    const { D } = ctx;
    viewRoot = root;
    if (!D.lanes.length){
      destroyAll();
      root.className = '';
      root.innerHTML = `<div class="hint empty-traces">
        <b>Nothing plotted yet.</b>
        <div>Click channels in the sidebar, or drag them in. Drag a chart by its header to
          move it, or onto another chart to overlay the two.</div>
        <div class="keys"><kbd>drag</kbd> zoom <kbd>wheel</kbd> zoom
          <kbd>double-click</kbd> reset <kbd>ƒ Math</kbd> build a channel from others</div>
      </div>`;
      return;
    }

    /* Another view replaced #view's contents: whatever we held is detached. */
    if (!wrap || wrap.parentNode !== root){
      destroyAll();
      root.innerHTML = '';
      root.className = '';
      wrap = document.createElement('div');
      root.appendChild(wrap);
    }
    wrap.className = `lanes cols-${D.traceCols}`;

    const ids = D.lanes.map(laneId);
    const layout = ids.join(',') + '|' + D.traceCols;
    const structural = layout !== lastLayout;
    const before = structural && lastLayout ? measure() : null;
    lastLayout = layout;

    if (structural) reconcile(ids, !!before);

    ids.forEach((id, i) => {
      const v = views.get(id);
      const s = sigOf(D.lanes[i]);
      if (v.sig !== s){
        if (v.plot) v.plot.destroy();
        v.plot = makePlot(v.cell, D.lanes[i], id);
        v.sig = s;
      }
    });

    for (const v of views.values()) applyHeight(v);
    /* Only the x window changed: uPlot redraws from the data it already holds. */
    for (const v of views.values()) v.plot.setScale('x', { min: D.view[0], max: D.view[1] });
    syncCursorTo(D.cursor);
    if (before) flip(before);
  }

  /* Bring the DOM in line with D.lanes, keeping every node that can be kept.

     A lane whose channels changed has a new id, but it is still recognisably the same
     chart -- the lane something was merged into, the lane a channel was pulled out of.
     It adopts the old lane's node and height, so it stays where it was instead of
     vanishing and reappearing at the same spot. */
  function reconcile(ids, animate){
    const { D } = ctx;
    const stale = [...views.values()].filter(v => !ids.includes(v.id));
    const chansOf = id => id.split('+').map(Number);

    ids.forEach((id, i) => {
      if (views.has(id)) return;
      const lane = D.lanes[i];
      const pick = stale.find(v => chansOf(v.id)[0] === lane[0])
        || stale.find(v => chansOf(v.id).some(c => lane.includes(c)));
      if (pick){
        stale.splice(stale.indexOf(pick), 1);
        views.delete(pick.id);
        if (D.chartH.has(pick.id) && !D.chartH.has(id)) D.chartH.set(id, D.chartH.get(pick.id));
        D.chartH.delete(pick.id);
        pick.id = id;
        pick.cell.dataset.id = id;
        pick.sig = '';
        views.set(id, pick);
      } else {
        views.set(id, makeView(id, animate));
      }
    });
    for (const v of stale){
      if (ro) ro.unobserve(v.cell);
      if (v.plot) v.plot.destroy();
      v.cell.remove();
      views.delete(v.id);
      D.chartH.delete(v.id);
    }

    /* Every cell goes in before any plot is built: a plot measured while its cell was
       the grid's only child is built at the wrong width. */
    ids.forEach((id, i) => {
      const v = views.get(id);
      v.idx = i;
      if (wrap.children[i] !== v.cell) wrap.insertBefore(v.cell, wrap.children[i] || null);
    });
  }

  function makeView(id, fresh){
    const cell = document.createElement('div');
    cell.className = 'lane' + (fresh ? ' enter' : '');
    cell.dataset.id = id;
    const v = { id, cell, plot: null, sig: '', idx: -1 };
    addGrip(v);
    attachLaneDrag(v);
    if (ro) ro.observe(cell);
    cell.addEventListener('animationend', () => cell.classList.remove('enter'));
    return v;
  }

  /* ---- motion: FLIP ---------------------------------------------------------------
     Record where every lane was, let the layout change, then play each one from its old
     position to its new one. Grid reflow is instant; this is what makes it readable.
     Keyed by node, not id, because a lane that adopted another's node has a new id. */
  function measure(){
    const m = new Map();
    for (const v of views.values()) if (v.cell.isConnected) m.set(v.cell, v.cell.getBoundingClientRect());
    return m;
  }
  function flip(before){
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    for (const v of views.values()){
      const b = before.get(v.cell);
      if (!b) continue;
      const a = v.cell.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const c = v.cell;
      c.style.transition = 'none';
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      c.getBoundingClientRect();
      c.style.transition = '';
      c.style.transform = '';
    }
  }

  function makePlot(cell, lane, id){
    const { D, xArr, xFmt, fmtD, chanColor } = ctx;
    const xs = xArr();
    const data = [xs, ...lane.map(ci => D.cols[ci])];

    /* Each channel gets its own scale, so a merged lane does not squash a 0-3 bar trace
       against an 0-80 km/h one. */
    const series = [{}].concat(lane.map((ci, n) => ({
      label: D.label[ci],
      scale: 's' + n,
      stroke: chanColor(ci),
      width: D.lineW,
      points: { show: false },
      value: (u, v) => (v == null ? '—' : fmtD(v, 2)),
    })));

    const scales = { x: { time: false, min: D.view[0], max: D.view[1] } };
    lane.forEach((ci, n) => {
      scales['s' + n] = {
        /* Auto-range to what is actually on screen, with a little air, so scrubbing into
           a quiet section still fills the lane. */
        range: (u, min, max) => {
          if (!(max > min)){ const c = min || 0; return [c - 1, c + 1]; }
          const pad = (max - min) * 0.08;
          return [min - pad, max + pad];
        },
      };
    });

    const axes = [{
      stroke: css('--ink-3'),
      grid: { stroke: css('--grid'), width: 1 },
      ticks: { stroke: css('--grid'), width: 1 },
      font: '11px ui-monospace, monospace',
      values: (u, splits) => splits.map(xFmt),
    }];
    /* One channel gets a real labelled axis. A merged lane cannot have one that means
       anything, so it shows each channel's value in the header instead. */
    if (lane.length === 1){
      axes.push({
        scale: 's0',
        stroke: css('--ink-3'),
        grid: { stroke: css('--grid'), width: 1 },
        ticks: { stroke: css('--grid'), width: 1 },
        font: '11px ui-monospace, monospace',
        size: 52,
        values: (u, splits) => splits.map(v => fmtD(v, 2)),
      });
    } else {
      /* A merged lane has no honest y-axis, but hiding it outright would pull its plot
         area 52 px left of every other lane in the grid. The gutter stays; the numbers
         go, and the values live in the header instead. */
      axes.push({
        scale: 's0',
        stroke: 'transparent',
        grid: { stroke: css('--grid'), width: 1 },
        ticks: { show: false },
        size: 52,
        values: (u, splits) => splits.map(() => ''),
      });
    }

    const opts = {
      width: cellWidth(cell),
      height: ctx.laneHeight(id),
      padding: [10, 12, 0, 0],
      legend: { show: false },
      cursor: {
        sync: { key: SYNC_KEY, scales: ['x', null] },
        drag: { x: true, y: false, setScale: false },
        points: { show: false },
      },
      scales,
      series,
      axes,
      hooks: {
        setSelect: [u => {
          if (u.select.width <= 0) return;
          const a = u.posToVal(u.select.left, 'x');
          const b = u.posToVal(u.select.left + u.select.width, 'x');
          u.setSelect({ width: 0, height: 0 }, false);
          ctx.setView([Math.min(a, b), Math.max(a, b)]);
        }],
        setCursor: [u => {
          if (u.cursor.idx != null) ctx.setCursor(u.cursor.idx);
        }],
      },
      plugins: [wheelZoom(ctx), lapLines(ctx), headerPlugin(ctx, lane, () => dragEndedAt)],
    };

    const u = new uPlot(opts, data, cell);
    u.root.addEventListener('dblclick', () => ctx.setView(null));
    return u;
  }

  function syncCursorTo(idx){
    const { D } = ctx;
    const x = ctx.xArr()[idx];
    for (const v of views.values()){
      v.plot.setCursor({ left: v.plot.valToPos(x, 'x'), top: 0 }, false);
      updateHeader(v.plot, D.lanes[v.idx], ctx);
    }
  }

  function applyHeight(v){
    if (!v.plot) return;
    const h = ctx.laneHeight(v.id);
    if (v.plot.height !== h) v.plot.setSize({ width: v.plot.width, height: h });
  }

  /* ---- dragging ---------------------------------------------------------------------

     One gesture does three things, decided by where it is released:
       - on the middle of a chart      overlay onto that chart
       - near a chart's edge, or a gap  move there, as a chart of its own
       - anywhere else                 nothing; it goes back where it was

     What is picked up depends on where the press started: a chart's header (or its ⠿
     handle) lifts the whole chart; one channel's name in a merged chart lifts just that
     channel, which is how an overlay is undone; a row in the sidebar lifts that channel.

     Pointer events rather than HTML5 drag-and-drop: native DnD needs a drag image, fights
     uPlot for the pointer, does nothing on touch and cannot give live feedback. */

  function attachLaneDrag(v){
    v.cell.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const hd = e.target.closest('.lane-hd');
      if (!hd || e.target.closest('button')) return;
      e.preventDefault();
      const ser = e.target.closest('.ser');
      press(e, () => {
        const lane = ctx.D.lanes[v.idx];
        if (!lane) return null;
        if (ser && lane.length > 1){
          const ci = +ser.dataset.ci;
          return { chans: [ci], fromIdx: v.idx, whole: false };
        }
        return { chans: lane.slice(), fromIdx: v.idx, whole: true };
      });
    });
  }

  /* The sidebar hands a press on a channel row to here. A plain click still toggles it --
     the drag only starts once the pointer has travelled. */
  function pressChannel(e, ci){
    if (e.button !== 0) return;
    press(e, () => {
      const { D } = ctx;
      const k = D.lanes.findIndex(l => l.includes(ci));
      if (k >= 0) return { chans: [ci], fromIdx: k, whole: D.lanes[k].length === 1, fromSide: true };
      return { chans: [ci], fromIdx: -1, whole: false, fromSide: true };
    });
  }

  function press(e, payloadFn){
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    let drag = null;
    const move = ev => {
      if (ev.pointerId !== pid) return;
      if (!drag){
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP) return;
        const p = payloadFn();
        if (!p){ done(); return; }
        drag = beginDrag(p, ev);
      }
      ev.preventDefault();
      drag.move(ev.clientX, ev.clientY);
    };
    const up = ev => {
      if (ev.pointerId !== pid) return;
      done();
      if (drag) drag.end(ev.type === 'pointerup');
    };
    const key = ev => {
      if (ev.key !== 'Escape' || !drag) return;
      ev.preventDefault();
      done();
      drag.end(false);
    };
    function done(){
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('keydown', key, true);
    }
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('keydown', key, true);
  }

  function beginDrag(p, ev){
    const { D, chanColor, esc } = ctx;
    const html = document.documentElement;
    html.classList.add('tv-dragging');

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = `<span class="chips">${p.chans.map(ci => `<span class="chip">
        <span class="sw" style="background:${chanColor(ci)}"></span>${esc(D.label[ci])}</span>`).join('')}</span>
      <span class="act"></span>`;
    document.body.appendChild(ghost);
    const act = ghost.querySelector('.act');

    const src = p.whole ? viewAt(p.fromIdx) : null;
    src?.cell.classList.add('lifted');
    if (!p.whole && p.fromIdx >= 0)
      viewAt(p.fromIdx)?.cell.querySelector(`.ser[data-ci="${p.chans[0]}"]`)?.classList.add('lifted');

    let target = null, lx = ev.clientX, ly = ev.clientY, raf = 0, painted = null;

    function move(x, y){
      lx = x; ly = y;
      ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
      retarget();
      if (!raf) raf = requestAnimationFrame(tick);
    }
    /* Holding near the top or bottom edge scrolls the stack, faster the closer you are,
       so a chart can be carried past the ones that are off screen. */
    function tick(){
      raf = 0;
      if (!viewRoot) return;
      const r = viewRoot.getBoundingClientRect();
      let dy = 0;
      if (lx >= r.left && lx <= r.right){
        if (ly < r.top + EDGE) dy = -Math.ceil(18 * (1 - Math.max(0, ly - r.top) / EDGE));
        else if (ly > r.bottom - EDGE) dy = Math.ceil(18 * (1 - Math.max(0, r.bottom - ly) / EDGE));
      }
      if (dy){
        const before = viewRoot.scrollTop;
        viewRoot.scrollTop += dy;
        if (viewRoot.scrollTop !== before) retarget();
        raf = requestAnimationFrame(tick);
      }
    }
    function retarget(){
      target = hitTest(lx, ly, p);
      paint();
    }

    function paint(){
      const key = target ? `${target.kind}:${target.idx}` : '';
      if (key === painted) return;
      painted = key;
      wrap?.querySelectorAll('.drop-merge').forEach(c => c.classList.remove('drop-merge'));
      viewRoot?.querySelector('.empty-traces')?.classList.toggle('drop-hot', target?.kind === 'end');
      const b = ensureBar();
      if (b) b.classList.remove('on');
      if (!target){
        act.textContent = 'release to cancel';
        ghost.classList.add('idle');
        return;
      }
      ghost.classList.remove('idle');
      if (target.kind === 'merge'){
        const v = viewAt(target.idx);
        v.cell.dataset.drop = p.fromIdx < 0 ? 'Add to this chart' : 'Overlay here';
        v.cell.classList.add('drop-merge');
        act.textContent = p.fromIdx < 0 ? '+ add to chart' : '⇶ overlay';
        return;
      }
      if (target.kind === 'end'){
        act.textContent = '+ new chart';
        return;
      }
      act.textContent = p.fromIdx < 0 || !p.whole ? '+ new chart here' : '↕ move here';
      placeBar(viewAt(target.idx), target.kind);
    }

    function end(commit){
      cancelAnimationFrame(raf);
      html.classList.remove('tv-dragging');
      src?.cell.classList.remove('lifted');
      wrap?.querySelectorAll('.lifted').forEach(c => c.classList.remove('lifted'));
      wrap?.querySelectorAll('.drop-merge').forEach(c => c.classList.remove('drop-merge'));
      viewRoot?.querySelector('.empty-traces')?.classList.remove('drop-hot');
      bar?.classList.remove('on');
      ghost.classList.add('gone');
      setTimeout(() => ghost.remove(), 160);
      dragEndedAt = performance.now();
      if (commit && target) applyDrop(p, target);
    }

    move(ev.clientX, ev.clientY);
    return { move, end };
  }

  const viewAt = idx => [...views.values()].find(v => v.idx === idx);

  /* Where a chart sits in the layout, ignoring any transform. Right after a drop the
     charts are still sliding into place, and getBoundingClientRect reports where they
     are drawn mid-slide -- so a second drag started straight away would aim at the
     wrong chart. offsetLeft/Top are where they are going. */
  function layoutRect(cell){
    const wr = wrap.getBoundingClientRect();
    const left = wr.left + cell.offsetLeft, top = wr.top + cell.offsetTop;
    const width = cell.offsetWidth, height = cell.offsetHeight;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function columns(){
    if (!wrap) return 1;
    return getComputedStyle(wrap).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  }

  /* Where a release at (x, y) would put the payload, or null for "nowhere useful". */
  function hitTest(x, y, p){
    const { D } = ctx;
    if (!viewRoot) return null;
    const vr = viewRoot.getBoundingClientRect();
    if (x < vr.left || x > vr.right || y < vr.top || y > vr.bottom) return null;
    if (!views.size) return { kind: 'end', idx: -1 };

    const cols = columns();
    let best = null, bestD = Infinity;
    for (const v of views.values()){
      const r = layoutRect(v.cell);
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD){ bestD = d; best = { v, r }; }
    }
    const { v, r } = best;
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    let kind;
    /* In a gap, or past the last chart, the nearest edge wins -- no dead zones between
       charts where the marker flickers off. */
    if (bestD > 0) kind = cols > 1 ? (fx < 0.5 ? 'before' : 'after') : (fy < 0.5 ? 'before' : 'after');
    else if (cols > 1) kind = fx < 0.25 ? 'before' : fx > 0.75 ? 'after' : 'merge';
    else kind = fy < 0.3 ? 'before' : fy > 0.7 ? 'after' : 'merge';

    const idx = v.idx, from = p.fromIdx;
    if (kind === 'merge'){
      if (idx === from) return null;
      if (p.chans.every(c => D.lanes[idx].includes(c))) return null;
    } else if (p.whole){
      /* Dropping a chart right next to where it already is does nothing, so say so by
         showing nothing rather than a marker that promises a move. */
      if (idx === from) return null;
      if (kind === 'after' && idx === from - 1) return null;
      if (kind === 'before' && idx === from + 1) return null;
    }
    return { kind, idx };
  }

  function ensureBar(){
    if (!wrap) return null;
    if (!bar){ bar = document.createElement('div'); bar.className = 'drop-bar'; }
    if (bar.parentNode !== wrap) wrap.appendChild(bar);
    return bar;
  }
  function placeBar(v, kind){
    const b = ensureBar();
    if (!b || !v) return;
    const wr = wrap.getBoundingClientRect(), r = layoutRect(v.cell);
    const gap = parseFloat(getComputedStyle(wrap).columnGap) || 12;
    const T = 4;
    if (columns() > 1){
      const x = kind === 'before' ? r.left - gap / 2 : r.right + gap / 2;
      Object.assign(b.style, { left: `${x - wr.left - T / 2}px`, top: `${r.top - wr.top}px`,
        width: `${T}px`, height: `${r.height}px` });
    } else {
      const y = kind === 'before' ? r.top - gap / 2 : r.bottom + gap / 2;
      Object.assign(b.style, { left: `${r.left - wr.left}px`, top: `${y - wr.top - T / 2}px`,
        width: `${r.width}px`, height: `${T}px` });
    }
    /* First placement should appear in place, not slide in from the corner. */
    if (!b.classList.contains('on')){
      b.style.transition = 'none';
      b.getBoundingClientRect();
      b.style.transition = '';
    }
    b.classList.add('on');
  }

  function applyDrop(p, target){
    const { D } = ctx;
    if (p.fromIdx < 0 && D.lanes.flat().length + p.chans.length > ctx.maxPlotted){
      ctx.note(`${ctx.maxPlotted} channels is the most one stack will plot — remove one first`);
      return;
    }
    const W = D.lanes.map(l => ({ chans: l.slice() }));
    const at = target.idx >= 0 ? W[target.idx] : null;
    for (const w of W) w.chans = w.chans.filter(c => !p.chans.includes(c));

    if (target.kind === 'merge') at.chans.push(...p.chans);
    else if (target.kind === 'end') W.push({ chans: p.chans.slice() });
    else W.splice(W.indexOf(at) + (target.kind === 'after' ? 1 : 0), 0, { chans: p.chans.slice() });

    /* A moved chart keeps its height under its new position. */
    const oldId = p.whole ? laneId(D.lanes[p.fromIdx]) : null;
    const h = oldId && D.chartH.get(oldId);
    D.lanes = W.filter(w => w.chans.length).map(w => w.chans);
    if (h && target.kind !== 'merge') D.chartH.set(laneId(p.chans), h);
    ctx.onLanesChanged();
  }

  /* Drag the bottom edge to give one lane more room. It sets that lane only: the reason
     to enlarge one is that it is the channel being read, and the others should stay put.
     Double-click returns it to the default. */
  function addGrip(v){
    const { D } = ctx;
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'drag to resize · double-click to reset';
    v.cell.appendChild(grip);

    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      try { grip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      const y0 = e.clientY, h0 = ctx.laneHeight(v.id);
      v.cell.classList.add('resizing');
      document.documentElement.classList.add('tv-resizing');
      const move = ev => {
        D.chartH.set(v.id, Math.max(90, Math.min(900, Math.round(h0 + ev.clientY - y0))));
        applyHeight(v);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        v.cell.classList.remove('resizing');
        document.documentElement.classList.remove('tv-resizing');
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => { D.chartH.delete(v.id); applyHeight(v); });
  }

  return {
    render,
    destroy: destroyAll,
    pressChannel,
    /* A drag ends with a pointerup, which the browser may follow with a click on
       whatever was under the press. Callers that toggle on click ask this first. */
    justDragged: () => performance.now() - dragEndedAt < 250,
    /* Sizing is the ResizeObserver's job; nothing to do here. */
    resize(){},
  };
}

const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const cellWidth = cell => Math.max(120, cell.clientWidth || cell.parentElement.clientWidth);

/* ---- plugins ------------------------------------------------------------------- */

/* Wheel zoom about the pointer, which is what every map and every other telemetry tool
   does. uPlot ships drag-zoom but leaves the wheel alone. */
function wheelZoom(ctx){
  return {
    hooks: {
      ready: [u => {
        u.over.addEventListener('wheel', e => {
          e.preventDefault();
          /* Anchor on the pointer's own position, not u.cursor.left: the cursor is only
             set while uPlot is tracking a real hover, so reading it gives NaN whenever
             the wheel arrives without one. */
          const rect = u.over.getBoundingClientRect();
          const left = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
          const { min, max } = u.scales.x;
          if (!(max > min)) return;
          const at = u.posToVal(left, 'x');
          if (!(at === at)) return;
          const f = e.deltaY > 0 ? 1.25 : 0.8;
          ctx.setView([at - (at - min) * f, at + (max - at) * f]);
        }, { passive: false });
      }],
    },
  };
}

/* Start/finish lines, drawn under the series. */
function lapLines(ctx){
  return {
    hooks: {
      drawClear: [u => {
        const { D } = ctx;
        if (!D.laps.length) return;
        const g = u.ctx;
        g.save();
        g.beginPath();
        g.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        g.clip();
        g.strokeStyle = 'rgba(200,16,46,.35)';
        g.lineWidth = 1;
        for (const l of D.laps){
          const x = Math.round(u.valToPos(D.xMode === 'time' ? l.t0 : l.d0, 'x', true)) + 0.5;
          g.beginPath();
          g.moveTo(x, u.bbox.top);
          g.lineTo(x, u.bbox.top + u.bbox.height);
          g.stroke();
        }
        g.restore();
      }],
    },
  };
}

/* The lane header: swatch, name, unit, live value, and a remove button per channel.
   It lives outside the canvas so the buttons are real buttons. */
function headerPlugin(ctx, lane, dragEndedAt){
  return {
    hooks: {
      ready: [u => {
        const { D, chanColor, isMath, esc } = ctx;
        const hd = document.createElement('div');
        hd.className = 'lane-hd' + (lane.length > 1 ? ' merged' : '');
        hd.innerHTML = lane.map(ci => `<span class="ser" data-ci="${ci}"
            title="${lane.length > 1 ? 'drag to pull this channel out' : 'drag to move this chart'}">
            <span class="sw" style="background:${chanColor(ci)}"></span>
            ${isMath(ci) ? `<button class="fx" data-edit title="edit math channel">ƒ</button>` : ''}
            <span class="nm">${esc(D.label[ci])}</span>
            <span class="u">${esc(D.units[ci] || '')}</span>
            <span class="v"></span>
            <button class="drop" title="remove ${esc(D.label[ci])}">×</button>
          </span>`).join('')
          + `<span class="grab" title="drag to move, or onto another chart to overlay">⠿</span>`;
        hd.onclick = e => {
          if (performance.now() - dragEndedAt() < 250) return;
          const ser = e.target.closest('.ser');
          if (!ser) return;
          if (e.target.closest('.drop')){
            e.stopPropagation();
            ctx.removeChannel(+ser.dataset.ci);
          } else if (e.target.closest('[data-edit]')){
            e.stopPropagation();
            ctx.editChannel(+ser.dataset.ci);
          }
        };
        u.root.prepend(hd);
        updateHeader(u, lane, ctx);
      }],
    },
  };
}

function updateHeader(u, lane, ctx){
  if (!lane) return;
  const { D, fmtD, chanColor } = ctx;
  const hd = u.root.querySelector('.lane-hd');
  if (!hd) return;
  hd.querySelectorAll('.ser').forEach(el => {
    const ci = +el.dataset.ci;
    const v = el.querySelector('.v');
    v.textContent = fmtD(D.cols[ci][D.cursor], 2);
    v.style.color = chanColor(ci);
  });
}
