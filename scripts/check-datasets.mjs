/* Runs the library's SQL against a real Postgres, in-process.

   The queries in lib/datasets.js are the part of this app that nobody can eyeball for
   correctness -- a typo'd column or a boolean that arrives as a string does not fail
   the build, it fails in the paddock. PGlite is Postgres compiled to WASM, so this
   exercises the actual statements, the actual schema and the actual types without
   anyone provisioning a database first.

     node scripts/check-datasets.mjs                                                   */

import { PGlite } from '@electric-sql/pglite';
import {
  SCHEMA, listDatasets, getDataset, insertDataset, updateDataset, deleteDataset, rowToDataset,
} from '../lib/datasets.js';

const db = new PGlite();

/* Neon's client is a tagged template that returns rows. Give the queries the same shape
   over PGlite so they run here exactly as they run in production. */
const sql = async (strings, ...values) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
  const { rows } = await db.query(text, values);
  return rows;
};

let failures = 0;
function check(ok, what){
  if (ok) console.log(`  ok    ${what}`);
  else { console.log(`  FAIL  ${what}`); failures++; }
  return ok;
}

for (const stmt of SCHEMA) await db.exec(stmt);
check(true, 'schema applies');
for (const stmt of SCHEMA) await db.exec(stmt);
check(true, 'schema is idempotent (a second deploy does not fail)');

const base = {
  title: 'Michigan endurance', description: 'long run, brake temps',
  uploader: 'Teddy Duncker', csvUrl: 'https://x.public.blob.vercel-storage.com/a.csv',
  csvName: 'endurance.csv', csvBytes: 83021163,
  binUrl: 'https://x.public.blob.vercel-storage.com/a.tvb', binBytes: 14680064,
  samples: 36460, channels: 226, laps: 0, durationS: 1822.95,
  session: 'Michigan', vehicle: 'arg26', racer: 'comp', recordedAt: 'Saturday, June 20, 2026 12:03 PM',
};

const ME = 'Teddy Duncker', THEM = 'Priya Nair';
/* Roles travel as channel names plus which occurrence, never as column indices. */
const ROLES_AT_IMPORT = { speed: { name: 'GPS Speed', nth: 0 }, lat: { name: 'GPS Latitude' } };
/* jsonb does not preserve key order -- Postgres stores {name,nth} back as {nth,name} --
   so these have to be compared by value. Anything that diffs roles by serialising them
   would see a spurious change on every read. */
const sameRoles = (a, b) => {
  if (!a || !b) return a === b;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k =>
    b[k] && a[k].name === b[k].name && (a[k].nth ?? 0) === (b[k].nth ?? 0));
};
const mine = await insertDataset(sql, {
  ...base, id: 'aaa1', listed: true, ownerToken: '', roles: ROLES_AT_IMPORT,
});
check(sameRoles(mine.roles, ROLES_AT_IMPORT), 'roles round-trip as jsonb');
const theirsShared = await insertDataset(sql, {
  ...base, id: 'bbb2', title: 'Autocross practice', uploader: THEM, listed: true, ownerToken: '',
});
await insertDataset(sql, {
  ...base, id: 'ccc3', title: 'Scratch run', uploader: THEM, listed: false, ownerToken: '',
});
await insertDataset(sql, {
  ...base, id: 'ddd4', title: 'My rough run', listed: false, ownerToken: '',
});

check(mine.id === 'aaa1' && mine.title === 'Michigan endurance', 'insert returns the row');
check(mine.listed === true, 'listed round-trips as a boolean, not a string');
check(Number(mine.csv_bytes) === 83021163, 'an 83 MB byte count survives (bigint)');
check(Math.abs(mine.duration_s - 1822.95) < 1e-9, 'duration keeps its precision');
check(mine.created_at instanceof Date, 'created_at is set by the database');

const anon = await listDatasets(sql, '');
check(anon.length === 2, `signed-in stranger sees only shared sessions (${anon.length} of 4)`);
check(!anon.some(r => r.id === 'ccc3' || r.id === 'ddd4'), 'unlisted sessions stay out of the list');

const forMe = await listDatasets(sql, ME);
check(forMe.length === 3, `uploader also sees their own unlisted session (${forMe.length} of 4)`);
check(forMe.some(r => r.id === 'ddd4'), 'my unlisted session is in my list');
check(!forMe.some(r => r.id === 'ccc3'), "someone else's unlisted session is not");

check(forMe[0].created_at >= forMe[forMe.length - 1].created_at, 'newest first');

const dto = rowToDataset(mine, ME);
check(dto.mine === true, 'rowToDataset marks my own session');
check(rowToDataset(theirsShared, ME).mine === false, "and does not mark someone else's");
check(!('owner_token' in dto) && !('ownerToken' in dto), 'the legacy owner token is never sent to the browser');
check(dto.csvBytes === 83021163 && typeof dto.csvBytes === 'number', 'byte counts reach the browser as numbers');

const patched = await updateDataset(sql, 'aaa1', {
  title: 'Michigan endurance — rear brake test',
  description: base.description, uploader: base.uploader, listed: false, laps: 22,
  roles: mine.roles,
});
check(sameRoles(patched.roles, ROLES_AT_IMPORT),
  'a lap-count writeback does not clear the roles settled at import');
check(patched.uploader === ME, 'editing a session does not reassign its credit');
check(patched.title.endsWith('rear brake test'), 'update changes the title');
check(patched.listed === false, 'update can unshare a session');
check(patched.laps === 22, 'the viewer can fill in the lap count later');
check((await listDatasets(sql, '')).length === 1, 'unsharing removes it from the shared list');

await deleteDataset(sql, 'aaa1');
check((await getDataset(sql, 'aaa1')) === null, 'delete removes the row');
check((await getDataset(sql, 'nope')) === null, 'a missing id reads as null, not a crash');

/* The unique id the route mints has to actually fit the column. */
const wide = await insertDataset(sql, {
  ...base, id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
  listed: true, ownerToken: '',
  description: 'x'.repeat(2000), title: 'y'.repeat(200),
});
check(wide.description.length === 2000 && wide.title.length === 200, 'the longest allowed text fits');

await db.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
