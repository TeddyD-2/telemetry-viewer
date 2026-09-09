/* Dataset metadata in Postgres (Neon, via `vercel install neon`).

   The blobs hold the sessions; this holds the sentence that tells you which session it
   is. The schema is created on first use rather than through a migration step: there is
   one table, the team has no DBA, and a deploy that silently 500s because nobody ran a
   migration is exactly the kind of failure this tool should not have.

   The queries themselves live in lib/datasets.js so they can be run against an
   in-process Postgres in scripts/check-datasets.mjs. */

import { neon } from '@neondatabase/serverless';
import { SCHEMA } from './datasets.js';

let _sql = null;
let _ready = null;

export function sql(){
  if (!_sql){
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set — run `vercel install neon`, then `vercel env pull`');
    _sql = neon(url);
  }
  return _sql;
}

export function ready(){
  if (!_ready){
    const q = sql();
    _ready = (async () => { for (const stmt of SCHEMA) await q.query(stmt); })()
      .catch(err => { _ready = null; throw err; });
  }
  return _ready;
}

export { rowToDataset } from './datasets.js';
