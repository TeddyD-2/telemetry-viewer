'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginForm(){
  const router = useRouter();
  const next = useSearchParams().get('next') || '/';
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e){
    e.preventDefault();
    setBusy(true); setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok){ router.replace(next); router.refresh(); return; }
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
        <div style={{ color: 'var(--ink-3)', fontSize: 12 }}>Team password required</div>
      </div>
      <input
        type="password" value={password} autoFocus
        onChange={e => setPassword(e.target.value)}
        placeholder="Password" aria-label="Team password"
      />
      {error && <div className="err">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy || !password}>
        {busy ? 'Checking…' : 'Enter'}
      </button>
    </form>
  );
}

export default function LoginPage(){
  return (
    <div className="login">
      <Suspense fallback={null}><LoginForm /></Suspense>
    </div>
  );
}
