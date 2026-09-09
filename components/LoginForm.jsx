'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const LAST_NAME_KEY = 'tv_last_name';

function Form({ members }){
  const router = useRouter();
  const next = useSearchParams().get('next') || '/';
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /* Whoever signed in on this browser last is almost certainly signing in again, so the
     name starts where they left it. The password never does. */
  useEffect(() => {
    try {
      const last = localStorage.getItem(LAST_NAME_KEY);
      if (last && (!members.length || members.includes(last))) setName(last);
    } catch { /* private window; the picker just starts empty */ }
  }, [members]);

  async function submit(e){
    e.preventDefault();
    setBusy(true); setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, name }),
    });
    if (res.ok){
      try { localStorage.setItem(LAST_NAME_KEY, name); } catch { /* not important */ }
      router.replace(next);
      router.refresh();
      return;
    }
    const body = await res.json().catch(() => ({}));
    setError(body.error || 'Could not sign in');
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.webp" alt="Cornell Racing" />
      <div>
        <div style={{ fontWeight: 600 }}>Telemetry Viewer</div>
        <div style={{ color: 'var(--ink-3)', fontSize: 12 }}>Team password, then who you are</div>
      </div>

      <input
        type="password" value={password} autoFocus
        onChange={e => setPassword(e.target.value)}
        placeholder="Team password" aria-label="Team password"
      />

      {members.length > 0 ? (
        <select value={name} onChange={e => setName(e.target.value)} aria-label="Your name">
          <option value="">Who are you?</option>
          {members.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input
          type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="Your name" aria-label="Your name"
        />
      )}

      {error && <div className="err">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy || !password || !name}>
        {busy ? 'Checking…' : 'Enter'}
      </button>
      <div className="hint" style={{ textAlign: 'center' }}>
        Your name is how uploads are credited. It is not a login — pick your own.
      </div>
    </form>
  );
}

export default function LoginForm({ members }){
  return <Suspense fallback={null}><Form members={members} /></Suspense>;
}
