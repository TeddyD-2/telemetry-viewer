'use client';

import { useRouter } from 'next/navigation';

export default function LogoutButton(){
  const router = useRouter();
  return (
    <button
      className="btn"
      onClick={async () => {
        await fetch('/api/logout', { method: 'POST' });
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
