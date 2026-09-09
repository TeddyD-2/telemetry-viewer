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
export default function Viewer({ source = { kind: 'local' }, title, onLoad, onMount }){
  const rootRef = useRef(null);

  useEffect(() => {
    const api = createViewer(rootRef.current, { title });
    let dead = false;

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

    return () => { dead = true; api.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="viewer-root" ref={rootRef}>
      <div id="top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img id="logo" src="/logo.webp" alt="Cornell Racing" />
        <div>
          <div id="sessname">{title || 'Telemetry Viewer'}</div>
          <div id="sessmeta">no session loaded</div>
        </div>
        <div className="sp" />
        <div id="cursorout" style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', color: 'var(--ink-2)' }} />
        <button id="loadbtn">Open CSV&hellip;</button>
        <input type="file" id="file" accept=".csv" hidden />
      </div>

      <div id="main">
        {/* Filled per mode by renderSidebar in lib/viewer/core.js -- Traces needs a
            channel multi-select, Track needs one channel, and showing both everywhere
            is what made this column useless. */}
        <div id="side" />

        <div id="content">
          <div id="bar" style={{ display: 'none' }}>
            <div className="seg" id="modes">
              <button data-mode="traces" className="on">Traces</button>
              <button data-mode="compare">Compare</button>
              <button data-mode="track">Track</button>
              <button data-mode="analysis">Analysis</button>
            </div>
            <div className="seg" id="xmodes">
              <button data-x="time" className="on">Time</button>
              <button data-x="dist">Distance</button>
            </div>
            <span className="seg" id="tracectl">
              <button data-cols="1" className="on" title="one lane per channel">Rows</button>
              <button data-cols="2" title="two columns">Tile</button>
              <button data-h="-40" title="shorter lanes">&minus;</button>
              <button data-h="40" title="taller lanes">+</button>
            </span>
            <button id="zoomlap">Zoom to lap</button>
            <button id="reset">Reset zoom</button>
            <div className="sp" style={{ flex: 1 }} />
            <span className="lbl" title="Which channel is speed. Drives distance, lap detection and the cursor readout.">speed</span>
            <select id="spdsel" style={{ width: 'auto', maxWidth: 230 }} />
            <span className="lbl" id="rangelbl" />
            <button id="exportpng">PNG</button>
            <button id="exportcsv">CSV</button>
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
