import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE } from './auth.js';

/* Who the request is signed in as, for route handlers and server components.
   Null when signed out -- though the proxy has already turned those away. */
export async function currentUser(){
  const jar = await cookies();
  const s = await readSession(jar.get(SESSION_COOKIE)?.value);
  return s?.name || '';
}
