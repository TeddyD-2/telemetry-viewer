/* What the deployment still needs before the library works.

   A half-configured deploy is the normal state for the first ten minutes of this app's
   life, and the difference between "500 Internal Server Error" and a page that names
   the two env vars you have not set yet is most of the setup experience. */

export function missingConfig(){
  const missing = [];
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL){
    missing.push({
      name: 'DATABASE_URL',
      how: 'vercel install neon — then `vercel env pull` for local work',
      why: 'stores session titles, notes and who uploaded what',
    });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN){
    missing.push({
      name: 'BLOB_READ_WRITE_TOKEN',
      how: 'Storage → Create → Blob, in the Vercel dashboard',
      why: 'holds the CSVs themselves',
    });
  }
  if (!process.env.SITE_PASSWORD){
    missing.push({
      name: 'SITE_PASSWORD',
      how: 'Settings → Environment Variables',
      why: 'the one password the team types to get in',
    });
  }
  return missing;
}

export const isConfigured = () => missingConfig().length === 0;
