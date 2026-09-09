'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { upload } from '@vercel/blob/client';
import { parseCsvFile } from '../lib/viewer/parse.js';
import { encodeParsed, gzip } from '../lib/viewer/binary.js';
import {
  ROLES, channelStats, nameIndex, timeColumn, resolveRoles, roleCandidates, rolesToNames,
} from '../lib/viewer/session.js';
import { buildXY, buildDistance, detectLaps, timedLaps } from '../lib/viewer/track.js';
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
  /* Channel roles, settled here rather than by every teammate who opens the session. */
  const [insp, setInsp] = useState(null);
  const [roles, setRoles] = useState({});
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
      setStep('inspecting channels');
      const i = inspect(m);
      setParsed(m);
      setInsp(i);
      setRoles(i.role);
      setSummary({ ...describe(m), laps: i.laps });
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
          roles: rolesToNames(roles, parsed.names, insp.dupe),
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
  /* A session cannot be shared with an unanswered role: the whole point of asking here
     is that the next person does not have to. */
  const unanswered = insp
    ? ROLES.filter(R => !R.optional && insp.ambiguous[R.key] && !(roles[R.key] >= 0))
    : [];

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
            {summary.laps > 0 ? `${summary.laps} laps · ` : ''}
            {fmtDuration(summary.durationS)} · {fmtBytes(file.size)}
          </div>
        )}
      </div>

      {insp && <RolePicker insp={insp} roles={roles} onChange={setRoles} disabled={busy} />}

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
        <button
          className="btn primary" type="submit"
          disabled={!parsed || busy || !title.trim() || unanswered.length > 0}
        >
          {stage === 'uploading' ? 'Uploading…' : 'Upload'}
        </button>
        {unanswered.length > 0 && (
          <span className="note" style={{ marginLeft: 10 }}>
            Answer the {unanswered.length === 1 ? 'channel question' : 'channel questions'} above first.
          </span>
        )}
      </div>
    </form>
  );
}

/* Everything about the file that does not need a canvas: statistics, duplicate names,
   which roles the names settle and which they do not, and -- once the roles are known --
   the lap count. Doing it here means the library card is right the moment it appears and
   nobody who opens the session later is asked to resolve the same channel names. */
function inspect(m){
  const stats = channelStats(m.cols, m.n);
  const { byName, dupe, label } = nameIndex(m.names, stats);
  const t = timeColumn(m.cols, byName, m.n);
  const { role, ambiguous } = resolveRoles({ names: m.names, units: m.units, stats });

  const candidates = {};
  for (const R of ROLES){
    candidates[R.key] = roleCandidates(R.key, { names: m.names, units: m.units, stats });
  }
  return { stats, dupe, label, t, role, ambiguous, candidates, laps: countLaps(m, t, role, stats) };
}

function countLaps(m, t, role, stats){
  const col = k => (role[k] >= 0 ? m.cols[role[k]] : null);
  const { x, y } = buildXY(col('lat'), col('lon'), m.n);
  if (!x) return null;
  const di = role.dist;
  const dist = buildDistance({
    n: m.n, t, speed: col('speed'), x, y,
    distChannel: di >= 0 && !stats[di].flat ? m.cols[di] : null,
  });
  const { laps } = detectLaps({ n: m.n, t, x, y, dist, speed: col('speed') });
  return timedLaps(laps);
}

const fmtRange = (stats, i) => {
  const st = stats[i];
  return st.flat ? (st.min === st.min ? `flat ${st.min.toFixed(2)}` : 'no data')
                 : `${st.min.toFixed(2)}–${st.max.toFixed(2)}`;
};

/* Only roles the file cannot settle on its own are shown. On a clean export that is none
   of them, and this whole block stays out of the way. */
function RolePicker({ insp, roles, onChange, disabled }){
  const asked = ROLES.filter(R => insp.ambiguous[R.key]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? ROLES : asked;
  if (!asked.length && !showAll){
    return (
      <div className="field">
        <label>Channels</label>
        <div className="note">
          Every role matched one channel cleanly.{' '}
          <button type="button" className="linky" onClick={() => setShowAll(true)}>Review them</button>
        </div>
      </div>
    );
  }
  return (
    <div className="field">
      <label>Channels {asked.length > 0 && <span className="warn">· {asked.length} to answer</span>}</label>
      {asked.length > 0 && (
        <div className="note">
          More than one channel matches these equally well, so the file cannot say which is
          which. Answer once here and nobody who opens this session has to.
        </div>
      )}
      {shown.map(R => (
        <div className="role" key={R.key}>
          <label>{R.label}{insp.ambiguous[R.key] && !(roles[R.key] >= 0) ? ' ?' : ''}</label>
          <select
            disabled={disabled}
            value={roles[R.key] >= 0 ? String(roles[R.key]) : '-1'}
            onChange={e => onChange({ ...roles, [R.key]: +e.target.value })}
          >
            <option value="-1">— {R.none || 'not set'} —</option>
            {insp.candidates[R.key].map(c => (
              <option key={c.i} value={c.i}>
                {insp.label[c.i]} · {fmtRange(insp.stats, c.i)}
              </option>
            ))}
          </select>
        </div>
      ))}
      {!showAll && (
        <button type="button" className="linky" onClick={() => setShowAll(true)}>
          Show every role
        </button>
      )}
    </div>
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
