'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Viewer from './Viewer.jsx';
import { ownerToken } from '../lib/owner.js';
import { fmtBytes } from '../lib/format.js';

export default function StoredSession({ dataset, members }){
  const [d, setD] = useState(dataset);
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState(false);
  const patched = useRef(false);

  /* Ownership is decided by asking the API with this browser's token, so the answer is
     the same one the API will give when an edit is actually attempted. */
  useEffect(() => {
    const t = ownerToken();
    if (!t) return;
    fetch(`/api/datasets/${d.id}?mine=${encodeURIComponent(t)}`)
      .then(r => r.json())
      .then(b => b.dataset && setMine(!!b.dataset.mine))
      .catch(() => {});
  }, [d.id]);

  /* Lap detection needs the whole session in memory, which the upload page does not
     have a viewer for, so the count is filled in the first time the uploader opens it.

     Two things have to arrive before that can happen -- the session has to finish
     loading, and the ownership answer has to come back -- and they race. A small
     session beats the ownership fetch every time, which is why this waits on both
     rather than doing the work inside the load callback. */
  const [detected, setDetected] = useState(null);
  const onLoad = api => setDetected(api.summary());

  useEffect(() => {
    if (!detected || !mine || patched.current) return;
    if (detected.laps === d.laps) return;
    const t = ownerToken();
    if (!t) return;
    patched.current = true;
    fetch(`/api/datasets/${d.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerToken: t, laps: detected.laps }),
    }).then(r => r.json()).then(b => b.dataset && setD(b.dataset)).catch(() => {});
  }, [detected, mine, d.id, d.laps]);

  return (
    <>
      <div className="viewbar">
        <Link href="/">← Library</Link>
        <span style={{ color: 'var(--ink-3)' }}>
          {d.uploader ? `uploaded by ${d.uploader}` : 'uploaded'}
          {d.listed ? '' : ' · unlisted'}
        </span>
        <div className="sp" />
        {mine && (
          <button className="btn" onClick={() => setEditing(v => !v)}>
            {editing ? 'Close' : 'Edit details'}
          </button>
        )}
        <a className="btn" href={d.csvUrl} download={d.csvName || 'session.csv'}>
          CSV ({fmtBytes(d.csvBytes)})
        </a>
      </div>

      {editing && (
        <EditPanel
          d={d} members={members}
          onSaved={next => { setD(next); setEditing(false); }}
        />
      )}

      <Viewer
        source={{ kind: 'stored', binUrl: d.binUrl, title: d.title }}
        title={d.title}
        onLoad={onLoad}
      />
    </>
  );
}

function EditPanel({ d, members, onSaved }){
  const router = useRouter();
  const [title, setTitle] = useState(d.title);
  const [description, setDescription] = useState(d.description || '');
  const [uploader, setUploader] = useState(d.uploader || '');
  const [listed, setListed] = useState(d.listed);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(){
    setBusy(true); setError('');
    const res = await fetch(`/api/datasets/${d.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerToken: ownerToken(), title, description, uploader, listed }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok){ setError(body.error || 'could not save'); return; }
    onSaved(body.dataset);
  }

  async function remove(){
    if (!confirm(`Delete "${d.title}"? The CSV and the cached copy go too, and this cannot be undone.`)) return;
    setBusy(true);
    const res = await fetch(`/api/datasets/${d.id}?ownerToken=${encodeURIComponent(ownerToken())}`, {
      method: 'DELETE',
    });
    if (res.ok){ router.push('/'); return; }
    const body = await res.json().catch(() => ({}));
    setError(body.error || 'could not delete');
    setBusy(false);
  }

  return (
    <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)', padding: '14px 22px' }}>
      <div className="form" style={{ gap: 12 }}>
        {error && <div className="err">{error}</div>}
        <div className="field">
          <label htmlFor="e-title">Title</label>
          <input id="e-title" type="text" value={title} onChange={e => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="e-desc">Notes</label>
          <textarea id="e-desc" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="e-who">Uploaded by</label>
          {members.length > 0 && (
            <select
              id="e-who" value={members.includes(uploader) ? uploader : '__other'}
              onChange={e => setUploader(e.target.value === '__other' ? '' : e.target.value)}
            >
              <option value="">—</option>
              {members.map(m => <option key={m} value={m}>{m}</option>)}
              <option value="__other">Someone else…</option>
            </select>
          )}
          {(members.length === 0 || !members.includes(uploader)) && (
            <input type="text" value={uploader} onChange={e => setUploader(e.target.value)}
                   placeholder="Name" aria-label="Uploaded by" />
          )}
        </div>
        <label className={`choice ${listed ? 'on' : ''}`}>
          <input type="checkbox" checked={listed} onChange={e => setListed(e.target.checked)} />
          <span>
            <b>Share with the team</b>
            <span>Listed in the library for everyone with the site password.</span>
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={save} disabled={busy || !title.trim()}>Save</button>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn" onClick={remove} disabled={busy}>Delete session</button>
        </div>
      </div>
    </div>
  );
}
