'use client';

import Link from 'next/link';
import Viewer from '../../components/Viewer.jsx';

/* The original viewer, unchanged: drop a CSV, work through it, nothing leaves the
   browser. Worth keeping as its own route -- most of the time someone just got off the
   track and wants to look at a file, not curate a library entry. */
export default function LocalPage(){
  return (
    <>
      <div className="viewbar">
        <Link href="/">← Library</Link>
        <span style={{ color: 'var(--ink-3)' }}>local file · nothing is uploaded</span>
        <div className="sp" />
        <Link className="btn" href="/upload">Share this session instead</Link>
      </div>
      <Viewer source={{ kind: 'local' }} />
    </>
  );
}
