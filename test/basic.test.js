import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { mailboxName, escapeHtml, htmlToText, cleanupOldMessages } from '../src/index.js';

test('mailbox names are normalized and checked', () => {
  assert.equal(mailboxName('Abc.ChatGPT@E-Com.CC'), 'abc.chatgpt');
  assert.equal(mailboxName('A/B@e-com.cc'), 'a/b');
  assert.equal(mailboxName('x@other.example'), null);
  assert.equal(mailboxName('bad\nname@e-com.cc'), null);
});

test('untrusted mail fields cannot become HTML', () => {
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('HTML-only mail becomes readable plain text', () => {
  assert.equal(htmlToText('<head><title>Hidden</title></head><p>Hello &amp; 世界<br><b>friend</b></p><script>alert(1)</script>'), 'Hello & 世界\nfriend');
});

test('public inbox shows fixed columns and escapes subjects', async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ seq: 1, sender: 'very.long.address@example.com', subject: '<script>alert(1)</script>', received_at: '2026-10-05T14:32:00Z', is_read: 0, spam_suspected: 1 }] }) }) }) } };
  const response = await worker.fetch(new Request('https://mail.e-com.cc/inbox/ABC'), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /href="\/inbox\/abc\/1">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/a>/);
  assert.match(html, /\[\*\]  very\.long\.address@example\.com\s+2026-10-05T22:32:00\+08:00  \[!\]/);
  assert.doesNotMatch(html, /<a[^>]*>\[\*\]/);
  assert.doesNotMatch(html, /<style>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('random mailbox checks existing names and retries a collision', async () => {
  let attempts = 0;
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => (++attempts === 1 ? { 1: 1 } : null) }) }) } };
  const response = await worker.fetch(new Request('https://mail.e-com.cc/rand'), env);
  const address = await response.text();
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.match(response.headers.get('Content-Type'), /^text\/plain/);
  assert.match(address, /^[a-z0-9]{5}@e-com\.cc$/);
});

test('batch endpoint returns distinct addresses without reserving and limits count', async () => {
  let queries = 0;
  const env = { DB: { prepare: sql => {
    assert.match(sql, /^SELECT name FROM mailboxes WHERE name IN /);
    return { bind: (...names) => ({ all: async () => {
      queries++;
      assert.ok(names.length <= 100);
      return { results: [] };
    } }) };
  } } };
  const response = await worker.fetch(new Request('https://mail.e-com.cc/randbat/1000'), env);
  const addresses = (await response.text()).split('\n');
  assert.equal(response.status, 200);
  assert.equal(addresses.length, 1000);
  assert.equal(new Set(addresses).size, 1000);
  assert.ok(queries <= 20);
  assert.ok(addresses.every(address => /^[a-z0-9]{5}@e-com\.cc$/.test(address)));
  assert.equal((await worker.fetch(new Request('https://mail.e-com.cc/randbat/1001'), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://mail.e-com.cc/randbat/10', { method: 'HEAD' }), env)).status, 405);
});

test('batch retries a duplicate generated within the same request', async () => {
  const original = crypto.getRandomValues;
  let calls = 0;
  let reads = 0;
  crypto.getRandomValues = bytes => { bytes.fill(calls++ < 2 ? 0 : 1); return bytes; };
  try {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { reads++; return { results: [] }; } }) }) } };
    const response = await worker.fetch(new Request('https://mail.e-com.cc/randbat/2'), env);
    assert.equal(await response.text(), 'aaaaa@e-com.cc\nbbbbb@e-com.cc');
    assert.equal(reads, 1);
  } finally {
    crypto.getRandomValues = original;
  }
});

test('opening a message marks it read and shows text with attachment sizes', async () => {
  const queries = [];
  const row = { sender: 'team@example.com', subject: '项目确认', received_at: '2026-10-05T06:32:00Z', text_body: '正文', body_key: null };
  const env = { DB: { prepare: sql => ({ bind: (...args) => {
    queries.push([sql, args]);
    return { first: async () => row, all: async () => ({ results: [{ part: 1, filename: '说明.pdf', byte_size: 262144 }] }), run: async () => ({}) };
  } }) } };
  const response = await worker.fetch(new Request('https://mail.e-com.cc/inbox/k7m2q/1'), env);
  const html = await response.text();
  assert.match(html, /时间    :2026-10-05T14:32:00\+08:00/);
  assert.match(html, /---\n正文\n---\n附件/);
  assert.match(html, /href="\/inbox\/k7m2q\/1\/attachments\/1">说明\.pdf<\/a> 256KB/);
  assert.ok(queries.some(([sql]) => sql.includes('SET is_read = 1')));
});

test('old mail cleanup deletes R2 objects before D1 records for the same mailbox', async () => {
  const events = [];
  let selected = false;
  const env = {
    DB: {
      prepare: sql => ({
        bind: (...args) => ({
          all: async () => {
            if (sql.includes('SELECT seq, body_key')) {
              assert.equal(args[0], 'k7m2q');
              assert.equal(args[1], '2026-09-05T00:00:00.000Z');
              if (selected) return { results: [] };
              selected = true;
              return { results: [{ seq: 3, body_key: 'mail/k7m2q/3/body.json' }] };
            }
            return { results: [{ object_key: 'mail/k7m2q/3/attachments/1' }] };
          },
          run: async () => { events.push('hide'); }
        }),
        sql
      }),
      batch: async statements => { events.push('delete D1'); assert.equal(statements.length, 2); }
    },
    BUCKET: { delete: async keys => { events.push('delete R2'); assert.deepEqual(keys, ['mail/k7m2q/3/body.json', 'mail/k7m2q/3/attachments/1']); } }
  };
  await cleanupOldMessages(env, 'k7m2q', Date.parse('2026-10-05T00:00:00.000Z'));
  assert.deepEqual(events, ['hide', 'delete R2', 'delete D1']);
});
