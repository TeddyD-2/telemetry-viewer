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
      back={<Link className="back" href="/" title="Back to the library">←</Link>}
      actions={<>
        <span className="by">local file · nothing is uploaded</span>
        <Link className="btn" href="/upload">Share this session</Link>
      </>}
    />
  );
}
