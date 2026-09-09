'use client';

import { useEffect, useRef } from 'react';
import { createViewer } from '../lib/viewer/core.js';
import { fetchParsed } from '../lib/viewer/binary.js';

/* The viewer's markup, and nothing else. React renders this once and hands the node to
   createViewer, which owns everything inside it from then on -- see lib/viewer/core.js
   for why the drawing stays imperative.

   `source` picks what gets opened:
     {kind:'local'}                     wait for a drop or the file picker
     {kind:'stored', binUrl, title}     download a parsed session and open it
     {kind:'handoff'}                   opened elsewhere; onMount hands the session over  */
export default function Viewer({
  source = { kind: 'local' }, title, roles, onLoad, onMount,
  /* The page owns what sits at each end of the bar: where 'back' goes, and which
     actions this session has. The middle -- name, metadata, live cursor readout --
     belongs to the viewer, which is the only thing that knows it. */
  back, actions, showOpen = true,
}){
  const rootRef = useRef(null);

  useEffect(() => {
    const api = createViewer(rootRef.current, { title, roles });
    let dead = false;
    const off = [];

    /* One `loaded` hook for every path in, so a page can react to a session opening
       without caring whether it came off disk or off the network. */
    const announce = () => { if (!dead && onLoad) onLoad(api); };
    const origLoadFile = api.loadFile;
    api.loadFile = f => origLoadFile(f).then(m => { announce(); return m; });
    const origLoadParsed = api.loadParsed;
    api.loadParsed = (m, n) => { origLoadParsed(m, n); announce(); };

    if (source.kind === 'stored'){
      api.busy('downloading session…', 0);
      fetchParsed(source.binUrl, pct => {
        if (!dead) api.busy('downloading session…', pct);
      })
        .then(m => { if (!dead) api.loadParsed(m, source.title || 'session'); })
        .catch(err => { if (!dead) api.failed(String(err && err.message || err)); });
    }

    if (onMount) onMount(api);

    /* Role changes happen inside the viewer's own DOM, so a page that wants to know
       (to offer "save these choices") watches the panel rather than being called back
       from a dozen places in core.js. */
    const watch = new MutationObserver(() => onLoad && onLoad(api));
    const panel = rootRef.current.querySelector('#side');
    if (panel) watch.observe(panel, { subtree: true, childList: true });
    off.push(() => watch.disconnect());

    return () => { dead = true; off.forEach(f => f()); api.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="viewer-root" ref={rootRef}>
      <div id="top">
        {back}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img id="logo" src="/logo.webp" alt="Cornell Racing" />
        <div className="who">
          <div id="sessname">{title || 'Telemetry Viewer'}</div>
          <div id="sessmeta">no session loaded</div>
        </div>
        <div className="sp" />
        <div id="cursorout" />
        <div className="acts">
          {actions}
          <button id="loadbtn" className="btn" hidden={!showOpen}>Open CSV&hellip;</button>
        </div>
        <input type="file" id="file" accept=".csv" hidden />
      </div>

      <div id="main">
        {/* Filled per mode by renderSidebar in lib/viewer/core.js -- Traces needs a
            channel multi-select, Track needs one channel, and showing both everywhere
            is what made this column useless. */}
        <div id="side" />

        <div id="content">
          <div id="bar" style={{ display: 'none' }}>
            <label className="pick">
              <span>View</span>
              <select id="modesel">
                <option value="traces">Traces</option>
                <option value="compare">Compare</option>
                <option value="track">Track</option>
                <option value="analysis">Analysis</option>
              </select>
            </label>
            <label className="pick">
              <span>X axis</span>
              <select id="xsel">
                <option value="time">Time</option>
                <option value="dist">Distance</option>
              </select>
            </label>

            {/* Chart appearance is a preference you set once, not a control you reach for
                mid-session, so it folds into a menu instead of spending six slots on the
                bar. */}
            <div className="menu" id="layoutmenu" hidden>
              <button className="btn" data-open aria-haspopup="true" aria-expanded="false">
                Layout <span className="caret">▾</span>
              </button>
              <div className="pop" hidden>
                <div className="row">
                  <span>Arrangement</span>
                  <span className="seg">
                    <button data-cols="1">Rows</button>
                    <button data-cols="2" className="on">Tile</button>
                  </span>
                </div>
                <div className="row">
                  <span>Line</span>
                  <span className="seg">
                    <button data-w="1" title="hairline">&thinsp;·&thinsp;</button>
                    <button data-w="1.5" className="on" title="normal">&ndash;</button>
                    <button data-w="2.5" title="thick">&#9473;</button>
                  </span>
                </div>
                <div className="row">
                  <span>Height</span>
                  <span className="seg">
                    <button data-h="-40" title="shorter">&minus;</button>
                    <button data-h="40" title="taller">+</button>
                  </span>
                </div>
              </div>
            </div>

            <button id="zoomlap" className="btn">Zoom to lap</button>
            <button id="reset" className="btn">Reset zoom</button>
            <div className="sp" style={{ flex: 1 }} />

            <div className="menu" id="savemenu">
              <button className="btn" data-open aria-haspopup="true" aria-expanded="false"
                      title="Save what is on screen">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1v9M4.5 7L8 10.5 11.5 7M2 13.5h12" fill="none"
                        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
                        strokeLinejoin="round" />
                </svg>
                <span className="caret">▾</span>
              </button>
              <div className="pop right" hidden>
                <button className="item" id="exportpng">Save image (PNG)</button>
                <button className="item" id="exportcsv">Export data (CSV)</button>
              </div>
            </div>
          </div>
          <div id="view">
            <div id="empty">
              <div id="drop">
                <b>Drop an AiM CSV here</b><br />
                <span style={{ fontSize: 12 }}>
                  or click &ldquo;Open CSV&hellip;&rdquo; &nbsp;&middot;&nbsp; parsing runs in your browser
                </span>
              </div>
              <div id="prog"><i /></div>
              <div id="status" />
            </div>
          </div>
          <canvas id="strip" />
        </div>
      </div>
    </div>
  );
}
