import { json, withSecurity } from './headers.ts';

const ALLOWED = new Set([
  'posts.json',
  'journal.json',
  'experiences.json',
  'x-reading-list.json',
  'room.json',
  'owner.json',
]);
const MAX_BYTES = 1024 * 1024;

function unauthorized(): Response {
  return withSecurity(new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
}

function notFound(): Response {
  return json({ error: 'not_found' }, 404);
}

function bearerOk(req: Request, token: string | undefined): boolean {
  const auth = req.headers.get('Authorization') || '';
  return Boolean(token && auth === `Bearer ${token}`);
}

export async function putLive(name: string, req: Request, kv: KVNamespace, token: string | undefined): Promise<Response> {
  if (!ALLOWED.has(name)) {
    return withSecurity(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  if (!bearerOk(req, token)) return unauthorized();
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) {
    return withSecurity(new Response('Payload too large', { status: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'invalid_json' }, 400);
  }
  await kv.put(`live/${name}`, body, { metadata: { contentType: 'application/json' } });
  return withSecurity(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));
}

export async function getLive(name: string, kv: KVNamespace, method: string): Promise<Response> {
  if (!ALLOWED.has(name)) return notFound();
  const body = await kv.get(`live/${name}`, 'arrayBuffer');
  if (!body) return notFound();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Content-Length': String(body.byteLength),
  };
  if (method === 'HEAD') {
    return withSecurity(new Response(null, { status: 200, headers }));
  }
  return withSecurity(new Response(body, { status: 200, headers }));
}
