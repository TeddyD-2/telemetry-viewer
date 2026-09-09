'use client';

import { useRouter } from 'next/navigation';

export default function LogoutButton({ me }){
  const router = useRouter();
  return (
    <button
      className="btn who"
      title={me ? `Signed in as ${me} — click to sign out` : 'Sign out'}
      onClick={async () => {
        await fetch('/api/logout', { method: 'POST' });
        router.replace('/login');
        router.refresh();
      }}
    >
      {me ? <><span className="nm">{me}</span><span className="out">sign out</span></> : 'Sign out'}
    </button>
  );
}
