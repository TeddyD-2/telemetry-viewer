'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { upload } from '@vercel/blob/client';
import { parseCsvFile } from '../lib/viewer/parse.js';
import { encodeParsed, gzip } from '../lib/viewer/binary.js';
import { fmtBytes, fmtDuration } from '../lib/format.js';

/* The parse happens before the upload rather than after it, and does double duty: it
   proves the file is really an AiM export before 83 MB goes over the paddock wifi, and
   it fills in the title, vehicle and driver so nobody has to retype what the header
   already says. */
export default function UploadForm({ me }){
  const router = useRouter();

  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [summary, setSummary] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [listed, setListed] = useState(true);
  const [stage, setStage] = useState('idle');   // idle | parsing | ready | uploading | done
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState('');
  const [error, setError] = useState('');

  async function pick(f){
    if (!f) return;
    setError(''); setFile(f); setParsed(null); setSummary(null);
    setStage('parsing'); setPct(0); setStep(`reading ${f.name}`);
    try {
      const m = await parseCsvFile(f, p => { setPct(p); setStep('parsing'); });
      setParsed(m);
      setSummary(describe(m));
      setTitle(t => t || suggestTitle(m, f));
      setStage('ready');
    } catch (err){
      setStage('idle');
      setError(String(err && err.message || err));
    }
  }

  async function submit(e){
    e.preventDefault();
    if (!parsed || !title.trim()) return;
    setStage('uploading'); setError(''); setPct(0);

    try {
      setStep('packing a compact copy');
      const bin = new Blob([await gzip(encodeParsed(parsed))], { type: 'application/octet-stream' });

      const stamp = Date.now();
      setStep(`uploading ${file.name} (${fmtBytes(file.size)})`);
      const csvBlob = await upload(`sessions/${stamp}/${safeName(file.name)}`, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: 'text/csv',
        onUploadProgress: p => setPct(Math.round(p.percentage)),
      });

      setStep(`uploading the compact copy (${fmtBytes(bin.size)})`);
      setPct(0);
      const binBlob = await upload(`sessions/${stamp}/session.tvb`, bin, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: 'application/octet-stream',
        onUploadProgress: p => setPct(Math.round(p.percentage)),
      });

      setStep('saving the details');
      const res = await fetch('/api/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), description, listed,
          csvUrl: csvBlob.url, csvName: file.name, csvBytes: file.size,
          binUrl: binBlob.url, binBytes: bin.size,
          ...summary,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'could not save the session');

      setStage('done');
      router.push(`/view/${body.dataset.id}`);
    } catch (err){
      setStage('ready');
      setError(String(err && err.message || err));
    }
  }

  const busy = stage === 'parsing' || stage === 'uploading';

  return (
    <form className="form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="csv">AiM CSV export</label>
        <input
          id="csv" type="file" accept=".csv" disabled={busy}
          onChange={e => pick(e.target.files?.[0])}
        />
        {summary && (
          <div className="note">
            {summary.samples.toLocaleString()} samples · {summary.channels} channels ·{' '}
            {fmtDuration(summary.durationS)} · {fmtBytes(file.size)}
          </div>
        )}
      </div>

      {busy && (
        <div className="steps">
          <div className="step run"><span className="dot" />{step}</div>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      {error && <div className="err">{error}</div>}

      <div className="field">
        <label htmlFor="title">Title</label>
        <input
          id="title" type="text" value={title} disabled={!parsed || busy}
          onChange={e => setTitle(e.target.value)}
          placeholder="Michigan endurance — arg26"
        />
      </div>

      <div className="field">
        <label htmlFor="desc">Notes</label>
        <textarea
          id="desc" value={description} disabled={!parsed || busy}
          onChange={e => setDescription(e.target.value)}
          placeholder="What was being tested, what to look at, anything odd about the run."
        />
      </div>

      <div className="field">
        <label>Who can see it</label>
        <div className="note">Credited to {me || 'you'} — whoever is signed in.</div>
        <label className={`choice ${listed ? 'on' : ''}`}>
          <input type="checkbox" checked={listed} disabled={!parsed || busy}
                 onChange={e => setListed(e.target.checked)} />
          <span>
            <b>Share with the team</b>
            <span>
              Listed in the library for everyone with the site password. Leave this off and
              the session is unlisted — reachable only by its link, which is fine for a
              rough run you want to send to one person, but is not a security boundary.
            </span>
          </span>
        </label>
      </div>

      <div>
        <button className="btn primary" type="submit" disabled={!parsed || busy || !title.trim()}>
          {stage === 'uploading' ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}

function describe(m){
  const t = m.cols[m.names.indexOf('Time')];
  return {
    samples: m.n,
    channels: m.names.length,
    /* Lap detection needs the whole session in memory and the viewer is the only thing
       that has it, so this stays null until the session is first opened. A confident 0
       would be worse than an obvious blank. */
    laps: null,
    durationS: t && m.n ? t[m.n - 1] - t[0] : Number(m.meta.Duration) || 0,
    session: m.meta.Session || '',
    vehicle: m.meta.Vehicle || '',
    racer: m.meta.Racer || '',
    recordedAt: [m.meta.Date, m.meta.Time].filter(Boolean).join(' '),
  };
}

function suggestTitle(m, f){
  const bits = [m.meta.Session, m.meta.Vehicle].filter(Boolean);
  return bits.length ? bits.join(' — ') : f.name.replace(/\.csv$/i, '');
}

const safeName = n => n.replace(/[^\w.-]+/g, '_').slice(-120);
