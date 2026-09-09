'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { fmtBytes, fmtDuration, fmtWhen } from '../lib/format.js';

export default function Library(){
  const [datasets, setDatasets] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('all');

  useEffect(() => {
    fetch('/api/datasets')
      .then(r => r.json())
      .then(b => (b.error ? setError(b.error) : setDatasets(b.datasets)))
      .catch(e => setError(String(e.message || e)));
  }, []);

  const shown = useMemo(() => {
    if (!datasets) return [];
    const needle = q.trim().toLowerCase();
    return datasets.filter(d => {
      if (scope === 'mine' && !d.mine) return false;
      if (!needle) return true;
      return [d.title, d.description, d.uploader, d.session, d.vehicle, d.racer]
        .filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [datasets, q, scope]);

  if (error) return <div className="err">{error}</div>;
  if (!datasets) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="filters">
        <input
          type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search titles, drivers, notes…" aria-label="Search sessions"
        />
        <div className="seg">
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All</button>
          <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>My uploads</button>
        </div>
        <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          {shown.length} of {datasets.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          {datasets.length === 0
            ? <>Nothing here yet. <Link href="/upload">Add the first session</Link>.</>
            : 'No sessions match that search.'}
        </div>
      ) : (
        <div className="cards">
          {shown.map(d => <Card key={d.id} d={d} />)}
        </div>
      )}
    </>
  );
}

function Card({ d }){
  const mine = d.mine;
  return (
    <div className="card">
      <div className="row1">
        <span className="name">{d.title}</span>
        {d.listed
          ? <span className="tag shared">shared</span>
          : <span className="tag unlisted">unlisted</span>}
        {mine && <span className="tag mine">yours</span>}
      </div>
      {d.description && <p className="desc">{d.description}</p>}
      <div className="facts">
        {d.uploader && <span>{d.uploader}</span>}
        <span>{fmtWhen(d.createdAt)}</span>
        {d.vehicle && <span>{d.vehicle}</span>}
        {d.racer && <span>driver {d.racer}</span>}
        {d.laps > 0 && <span>{d.laps} laps</span>}
        {d.durationS > 0 && <span>{fmtDuration(d.durationS)}</span>}
        {d.channels > 0 && <span>{d.channels} ch</span>}
        <span>{fmtBytes(d.csvBytes)} csv</span>
      </div>
      <div className="acts">
        <Link className="btn primary" href={`/view/${d.id}`}>Open</Link>
        <a className="btn" href={d.csvUrl} download={d.csvName || 'session.csv'}>Download CSV</a>
        {mine && <Link className="btn" href={`/view/${d.id}?edit=1`}>Edit details</Link>}
      </div>
    </div>
  );
}
