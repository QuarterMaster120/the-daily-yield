import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import worker from './unsubscribe-worker.mjs';

globalThis.crypto ??= webcrypto;
const id = 'a'.repeat(64);
const other = 'b'.repeat(64);
const secret = 'test-only-signing-secret';
const token = `${id}.${createHmac('sha256', secret).update(id).digest('hex')}`;
function fixture() {
  const rows = new Set();
  let writes = 0;
  return { rows, get writes() { return writes; }, env: {
    TOKEN_KEY: secret, STATUS_KEY: 'test-only-status-secret',
    DB: { prepare(sql) { return { bind(value) { return {
      async run() { assert.match(sql, /^INSERT OR IGNORE/); writes++; rows.add(value); return { success: true }; },
      async first() { assert.match(sql, /^SELECT id/); return rows.has(value) ? { id: value } : null; },
    }; } }; } },
  } };
}
const req = (method, value = token, body) => new Request(`https://example.test/unsubscribe?token=${value}`, { method, body });
test('GET verifies and renders accessible confirmation without mutation', async () => {
  const f = fixture();
  const res = await worker.fetch(req('GET'), f.env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.match(html, /lang="en"/);
  assert.match(html, /<form method="post" action="\/unsubscribe\?token=/);
  assert.equal(f.writes, 0);
});
test('manual POST persists only id and is idempotent', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const res = await worker.fetch(req('POST', token, ''), f.env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /You are unsubscribed/);
  }
  assert.deepEqual([...f.rows], [id]);
});
test('one-click POST succeeds with blank 200 response', async () => {
  const f = fixture();
  const res = await worker.fetch(req('POST', token, 'List-Unsubscribe=One-Click'), f.env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
  assert.ok(f.rows.has(id));
});
test('forged id, forged signature and malformed tokens never mutate', async () => {
  const f = fixture();
  for (const bad of [token.replace(id, other), `${id}.${'0'.repeat(64)}`, 'bad', token.toUpperCase(), token + '.extra']) {
    assert.equal((await worker.fetch(req('POST', bad, ''), f.env)).status, 400);
  }
  assert.equal(f.writes, 0);
});
test('status requires bearer authorization and returns matching ids only', async () => {
  const f = fixture();
  f.rows.add(id);
  const status = (auth, ids = [id, other, id]) => new Request('https://example.test/status', {
    method: 'POST', headers: auth ? { Authorization: auth } : {}, body: JSON.stringify({ ids }),
  });
  for (const auth of [undefined, 'Bearer wrong', 'Basic test-only-status-secret']) {
    assert.equal((await worker.fetch(status(auth), f.env)).status, 401);
  }
  const res = await worker.fetch(status('Bearer test-only-status-secret'), f.env);
  assert.deepEqual(await res.json(), { unsubscribed: [id] });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  for (const ids of [['invalid'], Array(1001).fill(id), null]) {
    assert.equal((await worker.fetch(status('Bearer test-only-status-secret', ids), f.env)).status, 400);
  }
});
test('database failures never claim unsubscribe succeeded', async () => {
  const f = fixture();
  f.env.DB.prepare = () => { throw new Error('unavailable'); };
  const res = await worker.fetch(req('POST', token, ''), f.env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});
