import { withSecurity } from './headers.ts';

const TYPES: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const NAME = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_BYTES = 8 * 1024 * 1024;

/** Safe media name -> content type, or null. No '%', '/', '\\' or '..' can get through the character class and the dot rule. */
export function mediaType(name: string): string | null {
  if (!NAME.test(name) || name.startsWith('.') || name.includes('..') || !name.includes('.')) return null;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? null;
}

function unauthorized(): Response {
  return withSecurity(new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
}

export async function putMedia(name: string, req: Request, kv: KVNamespace, token: string | undefined): Promise<Response> {
  const type = mediaType(name);
  if (!type || (type !== 'image/png' && type !== 'image/jpeg')) {
    return withSecurity(new Response('Unsupported media type', { status: 415, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  const auth = req.headers.get('Authorization') || '';
  if (!token || auth !== `Bearer ${token}`) return unauthorized();
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) {
    return withSecurity(new Response('Payload too large', { status: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  await kv.put(name, body, { metadata: { contentType: type } });
  return withSecurity(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));
}

const notFound = (): Response =>
  withSecurity(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }));

export async function media(name: string, kv: KVNamespace): Promise<Response> {
  const type = mediaType(name);
  if (!type) return notFound();
  const body = await kv.get(name, 'arrayBuffer');
  if (!body) return notFound();
  return withSecurity(new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'Content-Length': String(body.byteLength) } }));
}
