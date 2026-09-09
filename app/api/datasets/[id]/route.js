import { NextResponse } from 'next/server';
import { del } from '@vercel/blob';
import { missingConfig } from '../../../../lib/config.js';
import { sql, ready } from '../../../../lib/db.js';
import { getDataset, updateDataset, deleteDataset, rowToDataset } from '../../../../lib/datasets.js';

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

export async function GET(req, { params }){
  const bad = configError(); if (bad) return bad;
  const { id } = await params;
  const row = await load(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    dataset: rowToDataset(row, req.nextUrl.searchParams.get('mine') || ''),
  });
}

/* Editing and deleting need the token the uploader's browser kept, not just the site
   password -- everyone has the site password, and a shared library where anyone can
   quietly retitle or bin someone else's session is a library nobody trusts. */
const isOwner = (row, token) => !!token && token === row.owner_token;

export async function PATCH(req, { params }){
  const bad = configError(); if (bad) return bad;
  const { id } = await params;
  const row = await load(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  if (!isOwner(row, b.ownerToken)){
    return NextResponse.json({ error: 'only the uploader can change this session' }, { status: 403 });
  }

  const title = b.title === undefined ? row.title : String(b.title).trim().slice(0, 200);
  if (!title) return NextResponse.json({ error: 'a title is required' }, { status: 400 });

  const updated = await updateDataset(sql(), id, {
    title,
    description: b.description === undefined ? row.description : String(b.description).trim().slice(0, 2000),
    uploader: b.uploader === undefined ? row.uploader : String(b.uploader).trim().slice(0, 80),
    listed: b.listed === undefined ? row.listed : !!b.listed,
    /* Lap count is not a field anyone types: it arrives from the viewer the first time
       the session is opened, because detection needs the whole session in memory. */
    laps: Number.isFinite(+b.laps) ? Math.trunc(+b.laps) : row.laps,
  });
  return NextResponse.json({ dataset: rowToDataset(updated, b.ownerToken) });
}

export async function DELETE(req, { params }){
  const bad = configError(); if (bad) return bad;
  const { id } = await params;
  const row = await load(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  if (!isOwner(row, req.nextUrl.searchParams.get('ownerToken'))){
    return NextResponse.json({ error: 'only the uploader can delete this session' }, { status: 403 });
  }

  /* Drop the row first. If the blob delete then fails we have leaked two files, which
     costs storage; the other order risks a library entry pointing at nothing, which
     costs someone ten minutes working out why a session will not open. */
  await deleteDataset(sql(), id);
  await del([row.csv_url, row.bin_url]).catch(() => {});
  return NextResponse.json({ ok: true });
}
