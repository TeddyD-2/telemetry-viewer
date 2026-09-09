import { handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

/* Issues short-lived tokens so the browser can PUT straight to Vercel Blob.

   It has to work this way: a serverless function can only accept 4.5 MB of request
   body, and a normal AiM export is 83 MB. The file never passes through this app.

   Authorisation is the session cookie, which middleware has already checked before
   anything here runs -- an unauthenticated POST is answered with a 401 there and never
   reaches this handler. `onUploadCompleted` is deliberately unused: it cannot fire
   against localhost, so the dataset row is created by the client calling
   POST /api/datasets once both files are up. That path is identical in dev and prod. */
export async function POST(request){
  const body = await request.json();

  try {
    return NextResponse.json(await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['text/csv', 'application/octet-stream'],
        addRandomSuffix: true,
        maximumSizeInBytes: 1024 * 1024 * 1024,
      }),
      onUploadCompleted: async () => {},
    }));
  } catch (error){
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
