import { NextResponse } from 'next/server';
import { missingConfig } from '../../../lib/config.js';
import { sql, ready } from '../../../lib/db.js';
import { listDatasets, insertDataset, rowToDataset } from '../../../lib/datasets.js';
import { currentUser } from '../../../lib/session.js';

export const dynamic = 'force-dynamic';

/* A deploy missing its database or blob store should say so, not surface a driver
   stack trace as a 500. */
function configError(){
  const missing = missingConfig().filter(m => m.name !== 'SITE_PASSWORD');
  return missing.length
    ? NextResponse.json(
        { error: `not set up yet — this deployment still needs ${missing.map(m => m.name).join(' and ')}` },
        { status: 503 })
    : null;
}

/* Sessions shared with the team, plus the unlisted ones the signed-in person uploaded.
   Who that is comes from the session cookie, not the query string -- the client has no
   say in whose sessions it gets to see. */
export async function GET(){
  const bad = configError(); if (bad) return bad;
  await ready();
  const me = await currentUser();
  const rows = await listDatasets(sql(), me);
  return NextResponse.json({ datasets: rows.map(r => rowToDataset(r, me)), me });
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
/* `+null` and `+''` are both 0 and both finite, so a plain isFinite check turns "not
   known yet" into a confident zero. Lap count arrives that way -- null until the viewer
   has actually counted -- and a stored 0 would read as "no laps in this session". */
const int = v => (v === null || v === undefined || v === '' || !Number.isFinite(+v)
  ? null : Math.trunc(+v));

/* Both URLs have to be blobs this store issued. Without the check a POST could point a
   library entry at any URL on the internet, and every teammate who opened it would
   fetch that instead. */
const BLOB_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^\s]+$/;

/* Called by the upload page once both blobs are in place. */
export async function POST(req){
  const bad = configError(); if (bad) return bad;
  await ready();
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ error: 'expected JSON' }, { status: 400 });

  const title = str(b.title, 200);
  if (!title) return NextResponse.json({ error: 'a title is required' }, { status: 400 });

  /* The uploader is whoever is signed in. It used to be a field on the form, which let
     the credit on a session and the permission to edit it disagree. */
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  if (!BLOB_HOST.test(String(b.csvUrl || '')) || !BLOB_HOST.test(String(b.binUrl || ''))){
    return NextResponse.json({ error: 'files must be uploaded through this site' }, { status: 400 });
  }

  const row = await insertDataset(sql(), {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    title,
    description: str(b.description, 2000),
    uploader: me,
    listed: !!b.listed,
    csvUrl: b.csvUrl,
    csvName: str(b.csvName, 200),
    csvBytes: int(b.csvBytes) || 0,
    binUrl: b.binUrl,
    binBytes: int(b.binBytes) || 0,
    samples: int(b.samples),
    channels: int(b.channels),
    laps: int(b.laps),
    durationS: Number.isFinite(+b.durationS) ? +b.durationS : null,
    session: str(b.session, 200),
    vehicle: str(b.vehicle, 120),
    racer: str(b.racer, 120),
    recordedAt: str(b.recordedAt, 120),
    /* Settled at import so no one downstream is asked the same question again. */
    roles: b.roles && typeof b.roles === 'object' ? b.roles : null,
  });

  return NextResponse.json({ dataset: rowToDataset(row, me) }, { status: 201 });
}
