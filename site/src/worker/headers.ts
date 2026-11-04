// Security headers. public/_headers repeats the same CSP for the static assets (a test keeps the two in step).
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; media-src 'none'; " +
  "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
  "img-src 'self' data: https://upload.wikimedia.org https://images-assets.nasa.gov https://images-api.nasa.gov https://apod.nasa.gov";

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function withSecurity(res: Response, extra: Record<string, string> = {}): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) h.set(k, v);
  // never CORS: same-origin only
  for (const k of [...h.keys()]) if (k.toLowerCase().startsWith('access-control-')) h.delete(k);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return withSecurity(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }),
    extra,
  );
}
