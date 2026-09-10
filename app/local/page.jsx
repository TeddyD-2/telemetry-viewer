'use client';

import Link from 'next/link';
import Viewer from '../../components/Viewer.jsx';

/* The original viewer: drop a CSV, work through it, nothing leaves the browser. Worth
   keeping as its own route -- most of the time someone just got off the track and wants
   to look at a file, not curate a library entry. */
export default function LocalPage(){
  return (
    <Viewer
      source={{ kind: 'local' }}
      back={<Link className="back" href="/" title="Library" aria-label="Library">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 7.2 8 2l6 5.2M3.6 6v7.2h8.8V6" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>}
      actions={<>
        <span className="by">local file · nothing is uploaded</span>
        <Link className="btn" href="/upload"><span className="t">Share this session</span></Link>
      </>}
    />
  );
}
