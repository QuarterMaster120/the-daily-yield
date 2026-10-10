const ID = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function response(body, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  } });
}

function page(title, content) {
  return response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;color:#152238;background:#f8fafc;max-width:40rem;margin:4rem auto;padding:1.5rem;line-height:1.6}button{font:inherit;background:#152238;color:white;border:0;border-radius:.25rem;padding:.75rem 1.25rem;cursor:pointer}button:focus-visible{outline:3px solid #2563eb;outline-offset:4px}</style></head><body><main><h1>${title}</h1>${content}</main></body></html>`, 200, 'text/html; charset=utf-8');
}

async function verifyToken(token, secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('Missing token key');
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !ID.test(parts[0]) || !ID.test(parts[1])) return null;
  const signature = Uint8Array.from(parts[1].match(/../g), byte => parseInt(byte, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts[0])) ? parts[0] : null;
}

async function authorized(header, secret) {
  if (typeof secret !== 'string' || !secret || !header?.startsWith('Bearer ')) return false;
  // Compare fixed-length cryptographic signatures rather than secret strings.
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(header.slice(7)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/status') {
        if (request.method !== 'POST') return response('Method not allowed', 405);
        if (!await authorized(request.headers.get('Authorization'), env.STATUS_KEY)) return response('Unauthorized', 401);
        let data;
        try { data = await request.json(); } catch { return response('Invalid JSON', 400); }
        if (!Array.isArray(data?.ids) || data.ids.length > 1000 || data.ids.some(id => typeof id !== 'string' || !ID.test(id))) return response('Invalid ids', 400);
        const unsubscribed = [];
        for (const id of new Set(data.ids)) {
          const row = await env.DB.prepare('SELECT id FROM unsubscribes WHERE id = ?').bind(id).first();
          if (row) unsubscribed.push(id);
        }
        return response(JSON.stringify({ unsubscribed }), 200, 'application/json; charset=utf-8');
      }
      if (url.pathname !== '/unsubscribe') return response('Not found', 404);
      if (!['GET', 'POST'].includes(request.method)) return response('Method not allowed', 405);
      const token = url.searchParams.get('token');
      const id = await verifyToken(token, env.TOKEN_KEY);
      if (!id) return response('Invalid unsubscribe link. Please use the link in your email.', 400);
      if (request.method === 'GET') {
        // GET is intentionally read-only: security scanners often follow email links.
        const action = `/unsubscribe?token=${token}`; // Validated lowercase hex plus a dot; HTML-safe.
        return page('Unsubscribe from The Daily Yield', `<p>To stop receiving The Daily Yield emails, confirm below.</p><form method="post" action="${action}"><button type="submit">Confirm unsubscribe</button></form>`);
      }
      const body = await request.text();
      await env.DB.prepare('INSERT OR IGNORE INTO unsubscribes (id) VALUES (?)').bind(id).run();
      if (new URLSearchParams(body).get('List-Unsubscribe') === 'One-Click') return response('');
      return page('You are unsubscribed', '<p>You will no longer receive The Daily Yield emails. No further action is needed.</p>');
    } catch {
      return response('Unable to process your request right now. Please try again later.', 503);
    }
  },
};
