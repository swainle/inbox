import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { mailboxName, htmlToText, cleanupOldMessages } from '../index.js';

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const objects = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = sqlite.prepare(sql);
          return {
            first: async () => statement.get(...args) || null,
            all: async () => ({ results: statement.all(...args) }),
            run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } })
          };
        }
      };
    },
    batch: async statements => Promise.all(statements.map(statement => statement.run()))
  };
  const BUCKET = {
    put: async (key, value) => objects.set(key, value),
    get: async key => objects.has(key) ? { body: objects.get(key), text: async () => String(objects.get(key)) } : null,
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }
  };
  return { env: { DB, BUCKET }, sqlite };
}

const base = 'https://mail.e-com.cc';
async function call(env, path, options = {}) { return worker.fetch(new Request(base + path, options), env); }
async function post(env, path, data, cookie) {
  return call(env, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
}
function session(response) { return response.headers.get('Set-Cookie').split(';')[0]; }

test('mail parsing helpers keep existing behavior', () => {
  assert.equal(mailboxName('Abc.ChatGPT@E-Com.CC'), 'abc.chatgpt');
  assert.equal(mailboxName('x@other.example'), null);
  assert.equal(htmlToText('<head>Hidden</head><p>Hello &amp; 世界<br>friend</p>'), 'Hello & 世界\nfriend');
});

test('existing mailbox rows remain public after API migration', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE mailboxes (name TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1); INSERT INTO mailboxes VALUES (\'oldbox\', 2);');
  sqlite.exec(readFileSync(new URL('../20261010235501_add_accounts.sql', import.meta.url), 'utf8'));
  assert.equal(sqlite.prepare('SELECT owner_id FROM mailboxes WHERE name = ?').get('oldbox').owner_id, null);
  sqlite.close();
});

test('temporary mailboxes are reserved and old public routes are gone', async () => {
  const { env, sqlite } = environment();
  const response = await call(env, '/api/temp-mailboxes', { method: 'POST' });
  assert.equal(response.status, 201);
  const { address } = await response.json();
  const name = address.split('@')[0];
  assert.match(address, /^[a-z0-9]{5}@e-com\.cc$/);
  assert.equal(sqlite.prepare('SELECT owner_id FROM mailboxes WHERE name = ?').get(name).owner_id, null);
  assert.deepEqual(await (await call(env, `/api/temp-mailboxes/${name}/messages`)).json(), []);
  assert.deepEqual(await (await call(env, `/api/mailboxes/${name}/messages`)).json(), []);
  sqlite.prepare("INSERT INTO messages (mailbox, seq, token, received_at, status) VALUES (?, 1, 'public-token', '2026-10-10T00:00:00Z', 'ready')").run(name);
  assert.equal((await call(env, `/api/mailboxes/${name}/messages/1`, { method: 'DELETE' })).status, 404);
  assert.equal((await call(env, `/inbox/${name}`)).status, 404);
  assert.equal((await call(env, '/rand')).status, 404);
  sqlite.close();
});

test('registration, login, public single-mailbox access and logout', async () => {
  const { env, sqlite } = environment();
  assert.equal((await post(env, '/api/register', { username: '', password: '123456' })).status, 400);
  assert.equal((await post(env, '/api/register', { username: 'a', password: '123456' })).status, 200);
  assert.equal((await post(env, '/api/register', { username: 'alice1', password: '12345' })).status, 400);
  const aliceResponse = await post(env, '/api/register', { username: 'alice1', password: '123456' });
  assert.equal(aliceResponse.status, 200);
  const alice = session(aliceResponse);
  assert.match(aliceResponse.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await post(env, '/api/register', { username: 'alice1', password: '123456' })).status, 409);
  assert.equal((await post(env, '/api/login', { username: 'alice1', password: '12345' })).status, 400);
  assert.equal((await post(env, '/api/login', { username: 'alice1', password: 'wrong6' })).status, 401);
  assert.equal((await post(env, '/api/login', { username: 'alice1', password: '123456' })).status, 200);
  const bob = session(await post(env, '/api/register', { username: 'bob123', password: 'another long password' }));
  assert.equal((await call(env, '/api/account-mailboxes', { method: 'POST' })).status, 401);
  const created = await call(env, '/api/account-mailboxes', { method: 'POST', headers: { Cookie: alice } });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.deepEqual((await (await call(env, '/api/me', { headers: { Cookie: alice } })).json()).mailboxes, [{ id, address: `${id}@e-com.cc` }]);
  assert.equal((await call(env, `/api/account-mailboxes/${id}/messages`, { headers: { Cookie: alice } })).status, 200);
  assert.equal((await call(env, `/api/account-mailboxes/${id}/messages`, { headers: { Cookie: bob } })).status, 404);
  assert.equal((await call(env, `/api/account-mailboxes/${id}/messages`)).status, 404);
  assert.equal((await call(env, `/api/mailboxes/${id}/messages`)).status, 404);
  assert.equal((await call(env, `/api/mailboxes/${id}/messages`, { headers: { Cookie: alice } })).status, 200);
  assert.equal((await call(env, '/api/mailboxes/missing/messages')).status, 404);
  assert.equal((await call(env, `/api/temp-mailboxes/${id}/messages`)).status, 404);
  assert.equal((await call(env, `/inbox/${id}`)).status, 404);
  sqlite.prepare("UPDATE users SET username = 'ali' WHERE username = 'alice1'").run();
  assert.equal((await post(env, '/api/login', { username: 'ali', password: '123456' })).status, 200);
  assert.equal((await call(env, '/api/logout', { method: 'POST', headers: { Cookie: alice } })).status, 200);
  assert.equal((await call(env, '/api/me', { headers: { Cookie: alice } })).status, 401);
  sqlite.close();
});

test('only the owner can read an account mailbox message and attachment', async () => {
  const { env, sqlite } = environment();
  const alice = session(await post(env, '/api/register', { username: 'alice1', password: 'a very long password' }));
  const bob = session(await post(env, '/api/register', { username: 'bob123', password: 'another long password' }));
  const { id } = await (await call(env, '/api/account-mailboxes', { method: 'POST', headers: { Cookie: alice } })).json();
  sqlite.prepare("INSERT INTO messages (mailbox, seq, token, sender, subject, received_at, status, text_body, html_body) VALUES (?, 1, 'token', 'sender@example.com', 'Subject', '2026-10-10T00:00:00Z', 'ready', 'Body', '<p>Body</p>')").run(id);
  sqlite.prepare("INSERT INTO attachments (mailbox, seq, part, filename, content_type, byte_size, object_key) VALUES (?, 1, 1, 'file.txt', 'text/plain', 4, 'file-key')").run(id);
  await env.BUCKET.put('file-key', 'data');
  const detail = `/api/account-mailboxes/${id}/messages/1`;
  const file = `${detail}/attachments/1`;
  assert.equal((await call(env, detail, { headers: { Cookie: bob } })).status, 404);
  assert.equal((await call(env, file, { headers: { Cookie: bob } })).status, 404);
  assert.equal((await call(env, detail)).status, 404);
  assert.equal((await call(env, file)).status, 404);
  assert.equal((await call(env, `/api/mailboxes/${id}/messages/1`)).status, 404);
  assert.equal((await call(env, `/api/mailboxes/${id}/messages/1/attachments/1`)).status, 404);
  assert.equal((await (await call(env, `/api/mailboxes/${id}/messages/1`, { headers: { Cookie: alice } })).json()).text, 'Body');
  assert.equal(await (await call(env, `/api/mailboxes/${id}/messages/1/attachments/1`, { headers: { Cookie: alice } })).text(), 'data');
  const body = await (await call(env, detail, { headers: { Cookie: alice } })).json();
  assert.equal(body.text, 'Body');
  assert.equal(body.html, '<p>Body</p>');
  assert.equal(sqlite.prepare('SELECT is_read FROM messages WHERE mailbox = ?').get(id).is_read, 1);
  assert.equal(await (await call(env, file, { headers: { Cookie: alice } })).text(), 'data');
  assert.equal((await call(env, detail, { method: 'DELETE', headers: { Cookie: bob } })).status, 404);
  assert.equal((await call(env, detail, { method: 'DELETE' })).status, 404);
  assert.equal((await call(env, detail, { method: 'DELETE', headers: { Cookie: alice } })).status, 200);
  assert.equal((await call(env, detail, { headers: { Cookie: alice } })).status, 404);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM attachments WHERE mailbox = ?').get(id).count, 0);
  assert.equal(await env.BUCKET.get('file-key'), null);
  sqlite.close();
});

test('cross-origin writes are refused', async () => {
  const { env, sqlite } = environment();
  const response = await call(env, '/api/temp-mailboxes', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM mailboxes').get().count, 0);
  sqlite.close();
});

test('named account mailbox belongs to its creator and deletion removes stored mail', async () => {
  const { env, sqlite } = environment();
  const alice = session(await post(env, '/api/register', { username: 'a', password: '123456' }));
  const bob = session(await post(env, '/api/register', { username: 'b', password: '123456' }));
  assert.equal((await post(env, '/api/account-mailboxes', { name: '../bad' }, alice)).status, 400);
  assert.equal((await post(env, '/api/account-mailboxes', { name: 'chosen' }, alice)).status, 201);
  assert.equal((await post(env, '/api/account-mailboxes', { name: 'chosen' }, alice)).status, 409);
  sqlite.prepare("INSERT INTO messages (mailbox, seq, token, received_at, status, body_key) VALUES ('chosen', 1, 'chosen-token', '2026-10-10T00:00:00Z', 'ready', 'body-key')").run();
  sqlite.prepare("INSERT INTO attachments (mailbox, seq, part, filename, content_type, byte_size, object_key) VALUES ('chosen', 1, 1, 'file', 'text/plain', 4, 'file-key')").run();
  await env.BUCKET.put('body-key', '{}');
  await env.BUCKET.put('file-key', 'data');
  const path = '/api/account-mailboxes/chosen';
  assert.equal((await call(env, path, { method: 'DELETE', headers: { Cookie: bob } })).status, 404);
  assert.equal((await call(env, path, { method: 'DELETE', headers: { Cookie: alice } })).status, 200);
  assert.equal((await call(env, `${path}/messages`)).status, 404);
  assert.equal((await post(env, '/api/account-mailboxes', { name: 'chosen' }, alice)).status, 409);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM messages WHERE mailbox = ?').get('chosen').count, 0);
  assert.equal(await env.BUCKET.get('body-key'), null);
  assert.equal(await env.BUCKET.get('file-key'), null);
  let rejected = '';
  await worker.email({ to: 'chosen@e-com.cc', from: 'sender@example.com', raw: new TextEncoder().encode('From: sender@example.com\r\nTo: chosen@e-com.cc\r\nSubject: Late\r\n\r\nLate mail'), headers: new Headers(), setReject: reason => { rejected = reason; } }, env, { waitUntil() {} });
  assert.equal(rejected, 'Mailbox deleted');
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM messages WHERE mailbox = ?').get('chosen').count, 0);
  sqlite.close();
});

test('incoming mail is saved to a reserved account mailbox', async () => {
  const { env, sqlite } = environment();
  const alice = session(await post(env, '/api/register', { username: 'alice1', password: 'a very long password' }));
  const { id } = await (await call(env, '/api/account-mailboxes', { method: 'POST', headers: { Cookie: alice } })).json();
  const pending = [];
  const message = {
    to: `${id}@e-com.cc`,
    from: 'sender@example.com',
    raw: new TextEncoder().encode('From: sender@example.com\r\nTo: ' + id + '@e-com.cc\r\nSubject: Hello\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMessage body'),
    headers: new Headers(),
    setReject: reason => { throw new Error(reason); }
  };
  await worker.email(message, env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  const detail = `/api/account-mailboxes/${id}/messages/1`;
  assert.equal((await call(env, detail)).status, 404);
  const response = await call(env, detail, { headers: { Cookie: alice } });
  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /Message body/);
  assert.equal(sqlite.prepare('SELECT status FROM messages WHERE mailbox = ? AND seq = 1').get(id).status, 'ready');
  sqlite.close();
});

test('old mail cleanup removes R2 objects and D1 rows', async () => {
  const { env, sqlite } = environment();
  sqlite.prepare("INSERT INTO mailboxes (name) VALUES ('oldbox')").run();
  sqlite.prepare("INSERT INTO messages (mailbox, seq, token, received_at, status, body_key) VALUES ('oldbox', 1, 'old-token', '2026-08-01T00:00:00Z', 'ready', 'body-key')").run();
  sqlite.prepare("INSERT INTO attachments (mailbox, seq, part, filename, content_type, byte_size, object_key) VALUES ('oldbox', 1, 1, 'file', 'text/plain', 4, 'file-key')").run();
  await env.BUCKET.put('body-key', '{}');
  await env.BUCKET.put('file-key', 'data');
  await cleanupOldMessages(env, 'oldbox', Date.parse('2026-10-10T00:00:00Z'));
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM messages').get().count, 0);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM attachments').get().count, 0);
  assert.equal(await env.BUCKET.get('body-key'), null);
  assert.equal(await env.BUCKET.get('file-key'), null);
  sqlite.close();
});
