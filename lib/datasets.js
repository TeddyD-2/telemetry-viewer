/* Every query the app makes, in one place, each taking the tagged-template `sql` it
   should run against. The routes pass Neon's; scripts/check-datasets.mjs passes an
   in-process Postgres, which is how this SQL gets exercised without provisioning a
   database first. */

export const SCHEMA = [
  `create table if not exists datasets (
     id            text primary key,
     title         text not null,
     description   text not null default '',
     uploader      text not null default '',
     listed        boolean not null default false,
     owner_token   text not null,
     csv_url       text not null,
     csv_name      text not null default '',
     csv_bytes     bigint not null default 0,
     bin_url       text not null,
     bin_bytes     bigint not null default 0,
     samples       integer,
     channels      integer,
     laps          integer,
     duration_s    double precision,
     session_name  text not null default '',
     vehicle       text not null default '',
     racer         text not null default '',
     recorded_at   text not null default '',
     created_at    timestamptz not null default now()
   )`,
  `create index if not exists datasets_listed_idx on datasets (listed, created_at desc)`,
];

const LIMIT = 500;

/* Shared sessions, plus any unlisted ones the signed-in person uploaded. */
export function listDatasets(sql, me){
  return me
    ? sql`select * from datasets
          where listed = true or uploader = ${me}
          order by created_at desc limit ${LIMIT}`
    : sql`select * from datasets
          where listed = true
          order by created_at desc limit ${LIMIT}`;
}

export async function getDataset(sql, id){
  const rows = await sql`select * from datasets where id = ${id}`;
  return rows[0] || null;
}

export async function insertDataset(sql, d){
  const rows = await sql`
    insert into datasets (
      id, title, description, uploader, listed, owner_token,
      csv_url, csv_name, csv_bytes, bin_url, bin_bytes,
      samples, channels, laps, duration_s,
      session_name, vehicle, racer, recorded_at
    ) values (
      ${d.id}, ${d.title}, ${d.description}, ${d.uploader}, ${d.listed}, ${d.ownerToken},
      ${d.csvUrl}, ${d.csvName}, ${d.csvBytes}, ${d.binUrl}, ${d.binBytes},
      ${d.samples}, ${d.channels}, ${d.laps}, ${d.durationS},
      ${d.session}, ${d.vehicle}, ${d.racer}, ${d.recordedAt}
    ) returning *`;
  return rows[0];
}

export async function updateDataset(sql, id, d){
  const rows = await sql`
    update datasets set
      title       = ${d.title},
      description = ${d.description},
      uploader    = ${d.uploader},
      listed      = ${d.listed},
      laps        = ${d.laps}
    where id = ${id} returning *`;
  return rows[0];
}

export function deleteDataset(sql, id){
  return sql`delete from datasets where id = ${id}`;
}

/* `me` is the signed-in name. `owner_token` never leaves the server: it is the older
   browser-bound ownership scheme, and knowing someone else's would be enough to edit
   their session, so the comparison happens here and only the answer travels. */
export function rowToDataset(r, me){
  return {
    id: r.id,
    mine: !!me && r.uploader === me,
    title: r.title,
    description: r.description,
    uploader: r.uploader,
    listed: r.listed,
    csvUrl: r.csv_url,
    csvName: r.csv_name,
    csvBytes: Number(r.csv_bytes),
    binUrl: r.bin_url,
    binBytes: Number(r.bin_bytes),
    samples: r.samples,
    channels: r.channels,
    laps: r.laps,
    durationS: r.duration_s,
    session: r.session_name,
    vehicle: r.vehicle,
    racer: r.racer,
    recordedAt: r.recorded_at,
    createdAt: r.created_at,
  };
}
