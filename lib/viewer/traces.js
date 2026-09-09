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
   merged lane shows is shape against shape, which is the question being asked. */

const SYNC_KEY = 'traces';

export function createTraces(ctx){
  /* ctx gives the view its world without it reaching into the viewer's internals:
     { D, xArr, xFmt, fmtD, chanColor, setView, setCursor, laneHeight, onLanesChanged } */
  let plots = [];          // one uPlot per lane, index-aligned with D.lanes
  let key = '';            // what the current DOM was built for

  /* uPlot is told its size in pixels; it does not watch its container. Measuring at
     construction is not good enough -- a freshly appended grid item can report zero
     width before the grid resolves, and the first lane ended up drawn at twice its
     cell's width. An observer sizes each lane from what the layout actually settled on,
     which also covers window resizes and the sidebar changing width. */
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(entries => {
        for (const e of entries){
          const i = +e.target.dataset.lane;
          const p = plots[i];
          if (!p) continue;
          const w = Math.max(120, Math.round(e.contentRect.width));
          const h = ctx.laneHeight(i);
          if (w !== p.width || h !== p.height) p.setSize({ width: w, height: h });
        }
      })
    : null;

  /* Tearing the plots down takes their DOM with it, so the cache key has to go too --
     otherwise the next render sees "nothing changed", skips the rebuild, and leaves a
     row of empty lanes behind. */
  function destroyAll(){
    if (ro) ro.disconnect();
    plots.forEach(p => p && p.destroy());
    plots = [];
    key = '';
  }

  function laneKey(){
    const { D } = ctx;
    return D.lanes.map(l => l.join('+')).join(',') + '|' + D.traceCols + '|' + D.lineW
      + '|' + D.xMode + '|' + [...D.chartH].join(';') + '|' + D.traceH;
  }

  function render(root){
    const { D } = ctx;
    if (!D.lanes.length){
      destroyAll();
      key = '';
      root.className = '';
      root.innerHTML = `<div class="hint empty-traces">
        <b>Nothing plotted yet.</b>
        <div>Pick channels in the sidebar. Drag one chart onto another to overlay them.</div>
        <div class="keys"><kbd>drag</kbd> zoom <kbd>wheel</kbd> zoom
          <kbd>shift</kbd>+drag pan <kbd>double-click</kbd> reset</div>
      </div>`;
      return;
    }

    const k = laneKey();
    if (k !== key){
      key = k;
      destroyAll();
      root.innerHTML = '';
      root.className = D.traceCols > 1 ? 'tiled' : '';

      /* Every cell goes in before any plot is built. The grid is `auto-fit`, so while
         lane 0 was the only child it filled the full width -- and a plot measured then
         was built twice as wide as the cell it ended up in. */
      const cells = D.lanes.map((lane, i) => {
        const cell = document.createElement('div');
        cell.className = 'lane';
        cell.dataset.lane = i;
        cell.draggable = true;
        root.appendChild(cell);
        attachLaneDrag(cell, root);
        return cell;
      });
      cells.forEach((cell, i) => {
        plots[i] = makePlot(cell, D.lanes[i], i);
        if (ro) ro.observe(cell);
      });
    }

    /* Only the x window changed: uPlot redraws from the data it already holds. */
    plots.forEach(p => p && p.setScale('x', { min: D.view[0], max: D.view[1] }));
    syncCursorTo(D.cursor);
  }

  function makePlot(cell, lane, laneIdx){
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
      height: ctx.laneHeight(laneIdx),
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
      plugins: [wheelZoom(ctx), lapLines(ctx), headerPlugin(ctx, lane, laneIdx)],
    };

    const u = new uPlot(opts, data, cell);
    u.root.addEventListener('dblclick', () => ctx.setView(null));
    return u;
  }

  function syncCursorTo(idx){
    const { D } = ctx;
    plots.forEach(p => {
      if (!p) return;
      const left = p.valToPos(ctx.xArr()[idx], 'x');
      p.setCursor({ left, top: 0 }, false);
    });
    /* The header values are ours, not uPlot's legend. */
    plots.forEach((p, i) => p && updateHeader(p, D.lanes[i], ctx));
  }

  function attachLaneDrag(cell, root){
    const { D } = ctx;
    cell.ondragstart = e => {
      /* uPlot owns pointer drags inside the plotting area for zoom; only the header is a
         handle for moving the lane, otherwise zooming would start a drag every time. */
      if (!e.target.closest('.lane-hd')){ e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', cell.dataset.lane);
      e.dataTransfer.effectAllowed = 'move';
      cell.classList.add('dragging');
    };
    cell.ondragend = () => {
      cell.classList.remove('dragging');
      [...root.children].forEach(c => c.classList.remove('over'));
    };
    cell.ondragover = e => {
      if (cell.classList.contains('dragging')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('over');
    };
    cell.ondragleave = () => cell.classList.remove('over');
    cell.ondrop = e => {
      e.preventDefault();
      cell.classList.remove('over');
      const from = +e.dataTransfer.getData('text/plain');
      const to = +cell.dataset.lane;
      if (!(from >= 0) || from === to || !D.lanes[from] || !D.lanes[to]) return;
      const moved = D.lanes[from].filter(ci => !D.lanes[to].includes(ci));
      D.lanes[to] = [...D.lanes[to], ...moved];
      D.lanes.splice(from, 1);
      /* Heights are keyed by lane position, which no longer means anything once the
         lanes are renumbered. */
      D.chartH.clear();
      ctx.onLanesChanged();
    };
  }

  return {
    render,
    destroy: destroyAll,
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
function headerPlugin(ctx, lane, laneIdx){
  return {
    hooks: {
      ready: [u => {
        const { D, chanColor } = ctx;
        const hd = document.createElement('div');
        hd.className = 'lane-hd';
        hd.innerHTML = lane.map(ci => `<span class="ser" data-ci="${ci}">
            <span class="sw" style="background:${chanColor(ci)}"></span>
            <span class="nm">${D.label[ci]}</span>
            <span class="u">${D.units[ci] || ''}</span>
            <span class="v"></span>
            <button class="drop" title="remove ${D.label[ci]}">×</button>
          </span>`).join('')
          + `<span class="grab" title="drag to move or merge this chart">⠿</span>`;
        hd.onclick = e => {
          const b = e.target.closest('.drop');
          if (!b) return;
          e.stopPropagation();
          ctx.removeChannel(+b.closest('.ser').dataset.ci);
        };
        u.root.prepend(hd);
        updateHeader(u, lane, ctx);
        void laneIdx;
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
