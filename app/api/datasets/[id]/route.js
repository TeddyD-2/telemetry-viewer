import { NextResponse } from 'next/server';
import { del } from '@vercel/blob';
import { missingConfig } from '../../../../lib/config.js';
import { sql, ready } from '../../../../lib/db.js';
import { getDataset, updateDataset, deleteDataset, rowToDataset } from '../../../../lib/datasets.js';
import { currentUser } from '../../../../lib/session.js';

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

async function load(id){
  await ready();
  return getDataset(sql(), id);
}

export async function GET(_req, { params }){
  const bad = configError(); if (bad) return bad;
  const { id } = await params;
  const row = await load(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ dataset: rowToDataset(row, await currentUser()) });
}

/* Anyone signed in can edit or delete anything.

   This started out restricted to whoever uploaded a session, on the reasoning that a
   library where a mis-click bins someone else's run is a library nobody trusts. But the
   whole site sits behind one shared password: everybody past it is already a teammate
   with full read access and the ability to upload. Making them chase down whoever
   happened to press the button first, to fix a typo'd title, is friction that buys
   nothing -- the person who wants to fix it and the person who uploaded it are on the
   same team either way.

   The uploader is still recorded, and still shown. It is attribution, not permission. */
const canEdit = me => !!me;

export async function PATCH(req, { params }){
  const bad = configError(); if (bad) return bad;
  const { id } = await params;
  const row = await load(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const me = await currentUser();
  if (!canEdit(me)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const title = b.title === undefined ? row.title : String(b.title).trim().slice(0, 200);
  if (!title) return NextResponse.json({ error: 'a title is required' }, { status: 400 });

  const updated = await updateDataset(sql(), id, {
    title,
    description: b.description === undefined ? row.description : String(b.description).trim().slice(0, 2000),
    /* Credit stays with whoever uploaded it; retitling does not reassign authorship. */
    uploader: row.uploader,
    listed: b.listed === undefined ? row.listed : !!b.listed,
    /* Lap count is not a field anyone types: it arrives from the viewer the first time
       the session is opened, because detection needs the whole session in memory. */
    laps: Number.isFinite(+b.laps) ? Math.trunc(+b.laps) : row.laps,
    /* Absent means "leave them alone", not "clear them". A lap-count writeback must not
       throw away the role choices the uploader made at import. */
    roles: b.roles === undefined ? row.roles : b.roles,
  });
  return NextResponse.json({ dataset: rowToDataset(updated, me) });
}

export async function DELETE(req, { params }){
  const bad = configError(); if (bad) return bad;
  const { id } = await params;
  const row = await load(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  if (!canEdit(await currentUser())){
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  /* Drop the row first. If the blob delete then fails we have leaked two files, which
     costs storage; the other order risks a library entry pointing at nothing, which
     costs someone ten minutes working out why a session will not open. */
  await deleteDataset(sql(), id);
  await del([row.csv_url, row.bin_url]).catch(() => {});
  return NextResponse.json({ ok: true });
}
