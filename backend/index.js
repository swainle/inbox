import PostalMime from 'postal-mime';

const encoder = new TextEncoder();
const BODY_IN_D1_LIMIT = 1024 * 1024;

export function mailboxName(address) {
  const at = address.lastIndexOf('@');
  if (at < 1 || address.slice(at + 1).toLowerCase() !== 'e-com.cc') return null;
  const name = address.slice(0, at).toLowerCase();
  return name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..' ? name : null;
}

export function htmlToText(html) {
  return html
    .replace(/<!--[^]*?-->|<(script|style|head)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, entity => {
      const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
      if (entity[1] !== '#') return named[entity.toLowerCase()];
      const hex = entity[2].toLowerCase() === 'x';
      const number = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
    })
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

function notFound() { return json({ error: 'Not found' }, 404); }

export async function cleanupOldMessages(env, name, now = Date.now()) {
  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  while (true) {
    const rows = (await env.DB.prepare("SELECT seq, body_key FROM messages WHERE mailbox = ? AND received_at < ? AND status IN ('ready', 'deleting') ORDER BY received_at LIMIT 25").bind(name, cutoff).all()).results;
    if (!rows.length) return;
    for (const row of rows) {
      await env.DB.prepare("UPDATE messages SET status = 'deleting' WHERE mailbox = ? AND seq = ? AND status = 'ready'").bind(name, row.seq).run();
      const attachments = (await env.DB.prepare('SELECT object_key FROM attachments WHERE mailbox = ? AND seq = ?').bind(name, row.seq).all()).results;
      const keys = [row.body_key, ...attachments.map(file => file.object_key)].filter(Boolean);
      for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM attachments WHERE mailbox = ? AND seq = ?').bind(name, row.seq),
        env.DB.prepare("DELETE FROM messages WHERE mailbox = ? AND seq = ? AND status = 'deleting'").bind(name, row.seq)
      ]);
    }
  }
}

function randomName(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

async function randomMailbox(env, ownerId = null) {
  for (let length = 5; length <= 24; length++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const name = randomName(length);
      const result = await env.DB.prepare('INSERT OR IGNORE INTO mailboxes (name, next_seq, owner_id) VALUES (?, 1, ?)').bind(name, ownerId).run();
      if (result.meta.changes === 1) return name;
    }
  }
  return null;
}

async function getMessage(env, name, seq) {
  return env.DB.prepare('SELECT * FROM messages WHERE mailbox = ? AND seq = ? AND status = ?').bind(name, seq, 'ready').first();
}

const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
function cookie(value, maxAge) { return `session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=${maxAge}`; }

async function currentUser(request, env) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)session=([0-9a-f]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  return env.DB.prepare('SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), new Date().toISOString()).first();
}

async function credentials(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null;
  try {
    const value = await request.json();
    if (!value || !/^[a-z0-9_]{1,32}$/.test(value.username) || typeof value.password !== 'string' || value.password.length < 6 || value.password.length > 128) return null;
    return value;
  } catch { return null; }
}

async function loginResponse(user, env) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await digest(token), user.id, new Date(Date.now() + 30 * 86400000).toISOString()).run();
  return json({ id: user.id, username: user.username }, 200, { 'Set-Cookie': cookie(token, 30 * 86400) });
}

async function fetchApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith('/api/')) return notFound();
  if (!['GET', 'POST', 'DELETE'].includes(method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST, DELETE' });
  if (method !== 'GET' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);

  if (path === '/api/register' && method === 'POST') {
    const input = await credentials(request);
    if (!input) return json({ error: 'Invalid username or password' }, 400);
    const salt = randomToken();
    const hash = await passwordHash(input.password, salt);
    const result = await env.DB.prepare('INSERT OR IGNORE INTO users (username, password_hash, salt) VALUES (?, ?, ?)').bind(input.username, hash, salt).run();
    if (!result.meta.changes) return json({ error: 'Username unavailable' }, 409);
    const user = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?').bind(input.username).first();
    return loginResponse(user, env);
  }
  if (path === '/api/login' && method === 'POST') {
    const input = await credentials(request);
    if (!input) return json({ error: 'Invalid username or password' }, 400);
    const user = await env.DB.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?').bind(input.username).first();
    const actual = await passwordHash(input.password, user?.salt || 'invalid');
    if (!user || actual !== user.password_hash) return json({ error: 'Invalid username or password' }, 401);
    return loginResponse(user, env);
  }
  if (path === '/api/logout' && method === 'POST') {
    const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)session=([0-9a-f]{64})(?:;|$)/)?.[1];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/temp-mailboxes' && method === 'POST') {
    const name = await randomMailbox(env);
    return name ? json({ address: `${name}@e-com.cc` }, 201) : json({ error: 'No available mailbox name' }, 503);
  }

  const user = await currentUser(request, env);
  if (path === '/api/me' && method === 'GET') {
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const mailboxes = (await env.DB.prepare('SELECT name FROM mailboxes WHERE owner_id = ? AND deleted_at IS NULL ORDER BY name').bind(user.id).all()).results.map(row => ({ id: row.name, address: `${row.name}@e-com.cc` }));
    return json({ id: user.id, username: user.username, mailboxes });
  }
  if (path === '/api/account-mailboxes' && method === 'POST') {
    if (!user) return json({ error: 'Unauthorized' }, 401);
    let input;
    try { input = request.headers.get('Content-Type')?.includes('application/json') ? await request.json() : { random: true }; } catch { return json({ error: 'Invalid mailbox name' }, 400); }
    if (input?.random === true) {
      const name = await randomMailbox(env, user.id);
      return name ? json({ id: name, address: `${name}@e-com.cc` }, 201) : json({ error: 'No available mailbox name' }, 503);
    }
    const name = input?.name;
    if (typeof name !== 'string' || !/^[a-z0-9_][a-z0-9_.-]{0,127}$/.test(name) || name === '..') return json({ error: 'Invalid mailbox name' }, 400);
    const result = await env.DB.prepare('INSERT OR IGNORE INTO mailboxes (name, next_seq, owner_id) VALUES (?, 1, ?)').bind(name, user.id).run();
    return result.meta.changes ? json({ id: name, address: `${name}@e-com.cc` }, 201) : json({ error: 'Mailbox name unavailable' }, 409);
  }

  const deletion = path.match(/^\/api\/account-mailboxes\/([a-z0-9_.-]+)$/);
  if (deletion && method === 'DELETE') {
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const name = deletion[1];
    const marked = await env.DB.prepare('UPDATE mailboxes SET deleted_at = ? WHERE name = ? AND owner_id = ?').bind(new Date().toISOString(), name, user.id).run();
    if (!marked.meta.changes) return notFound();
    const rows = (await env.DB.prepare('SELECT body_key FROM messages WHERE mailbox = ?').bind(name).all()).results;
    const files = (await env.DB.prepare('SELECT object_key FROM attachments WHERE mailbox = ?').bind(name).all()).results;
    const keys = [...rows.map(row => row.body_key), ...files.map(file => file.object_key)].filter(Boolean);
    for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM attachments WHERE mailbox = ?').bind(name),
      env.DB.prepare('DELETE FROM messages WHERE mailbox = ?').bind(name)
    ]);
    return json({ ok: true });
  }

  const match = path.match(/^\/api\/(mailboxes|temp-mailboxes|account-mailboxes)\/([^/]+)\/messages(?:\/([^/]+)(?:\/attachments\/([^/]+))?)?$/);
  if (!match || (method !== 'GET' && method !== 'DELETE')) return notFound();
  const [, kind, rawName, rawSeq, rawPart] = match;
  let name;
  try { name = decodeURIComponent(rawName); } catch { return notFound(); }
  if (name !== name.toLowerCase() || mailboxName(`${name}@e-com.cc`) !== name) return notFound();
  const mailbox = await env.DB.prepare('SELECT owner_id FROM mailboxes WHERE name = ? AND deleted_at IS NULL').bind(name).first();
  if (!mailbox) return notFound();
  if ((kind === 'temp-mailboxes' && mailbox.owner_id !== null) || (kind === 'account-mailboxes' && mailbox.owner_id === null)) return notFound();
  if (mailbox.owner_id !== null && mailbox.owner_id !== user?.id) return notFound();
  if (method === 'DELETE' && (!rawSeq || rawPart || mailbox.owner_id === null)) return notFound();
  if (!rawSeq) {
    const rows = (await env.DB.prepare("SELECT seq AS id, sender, subject, received_at AS receivedAt, is_read AS isRead, spam_suspected AS spamSuspected FROM messages WHERE mailbox = ? AND status = 'ready' ORDER BY received_at DESC, seq DESC").bind(name).all()).results;
    return json(rows);
  }
  if (!/^[1-9]\d*$/.test(rawSeq) || !Number.isSafeInteger(Number(rawSeq))) return notFound();
  const seq = Number(rawSeq);
  if (method === 'DELETE') {
    const message = await env.DB.prepare("SELECT body_key FROM messages WHERE mailbox = ? AND seq = ? AND status IN ('ready', 'deleting')").bind(name, seq).first();
    if (!message) return notFound();
    await env.DB.prepare("UPDATE messages SET status = 'deleting' WHERE mailbox = ? AND seq = ?").bind(name, seq).run();
    const files = (await env.DB.prepare('SELECT object_key FROM attachments WHERE mailbox = ? AND seq = ?').bind(name, seq).all()).results;
    const keys = [message.body_key, ...files.map(file => file.object_key)].filter(Boolean);
    for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM attachments WHERE mailbox = ? AND seq = ?').bind(name, seq),
      env.DB.prepare("DELETE FROM messages WHERE mailbox = ? AND seq = ? AND status = 'deleting'").bind(name, seq)
    ]);
    return json({ ok: true });
  }
  const row = await getMessage(env, name, seq);
  if (!row) return notFound();
  if (rawPart) {
    if (!/^[1-9]\d*$/.test(rawPart) || !Number.isSafeInteger(Number(rawPart))) return notFound();
    const file = await env.DB.prepare('SELECT filename, object_key FROM attachments WHERE mailbox = ? AND seq = ? AND part = ?').bind(name, seq, Number(rawPart)).first();
    if (!file) return notFound();
    const object = await env.BUCKET.get(file.object_key);
    if (!object) return notFound();
    const safeName = file.filename.replace(/[\r\n"\\]/g, '_');
    return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
  }
  const attachments = (await env.DB.prepare('SELECT part AS id, filename, byte_size AS size FROM attachments WHERE mailbox = ? AND seq = ? ORDER BY part').bind(name, seq).all()).results;
  let text = row.text_body;
  let html = row.html_body;
  if (row.body_key) {
    const object = await env.BUCKET.get(row.body_key);
    if (!object) return notFound();
    const body = JSON.parse(await object.text());
    text = body.text;
    html = body.html;
  }
  if (!text && html) text = htmlToText(html);
  await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE mailbox = ? AND seq = ?').bind(name, seq).run();
  return json({ id: seq, address: `${name}@e-com.cc`, sender: row.sender, subject: row.subject, receivedAt: row.received_at, text: text || '', html: html || '', attachments });
}

async function receive(message, env, ctx) {
  const name = mailboxName(message.to);
  if (!name) { message.setReject('Invalid recipient'); return; }
  const parsed = await PostalMime.parse(message.raw);
  const token = crypto.randomUUID();
  const spamFlag = message.headers.get('x-spam-flag') || '';
  const spamStatus = message.headers.get('x-spam-status') || '';
  const spam = /^yes\b/i.test(spamFlag.trim()) || /^yes\b/i.test(spamStatus.trim()) ? 1 : 0;
  const receivedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO mailboxes (name, next_seq) VALUES (?, 1)').bind(name),
    env.DB.prepare('UPDATE mailboxes SET next_seq = next_seq + 1 WHERE name = ? AND deleted_at IS NULL').bind(name),
    env.DB.prepare("INSERT INTO messages (mailbox, seq, token, sender, subject, received_at, spam_suspected) SELECT name, next_seq - 1, ?, ?, ?, ?, ? FROM mailboxes WHERE name = ? AND deleted_at IS NULL").bind(token, message.from || '', parsed.subject || '', receivedAt, spam, name)
  ]);
  const allocated = await env.DB.prepare('SELECT seq FROM messages WHERE token = ?').bind(token).first();
  if (!allocated) { message.setReject('Mailbox deleted'); return; }
  const seq = allocated.seq;
  const prefix = `mail/${encodeURIComponent(name)}/${seq}`;
  const written = [];
  try {
    const textBody = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
    const htmlBody = parsed.html || '';
    let bodyKey = null;
    let smallText = textBody;
    let smallHtml = htmlBody;
    if (encoder.encode(textBody).byteLength + encoder.encode(htmlBody).byteLength > BODY_IN_D1_LIMIT) {
      bodyKey = `${prefix}/body.json`;
      await env.BUCKET.put(bodyKey, JSON.stringify({ text: textBody, html: htmlBody }), { httpMetadata: { contentType: 'application/json' } });
      written.push(bodyKey);
      smallText = null;
      smallHtml = null;
    }
    const statements = [];
    for (const [index, attachment] of (parsed.attachments || []).entries()) {
      const part = index + 1;
      const key = `${prefix}/attachments/${part}`;
      await env.BUCKET.put(key, attachment.content);
      written.push(key);
      statements.push(env.DB.prepare('INSERT INTO attachments (mailbox, seq, part, filename, content_type, byte_size, object_key) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(name, seq, part, attachment.filename || `attachment-${part}`, attachment.mimeType || 'application/octet-stream', attachment.content.byteLength, key));
    }
    statements.push(env.DB.prepare("UPDATE messages SET text_body = ?, html_body = ?, body_key = ?, status = 'ready' WHERE mailbox = ? AND seq = ? AND status = 'pending'").bind(smallText, smallHtml, bodyKey, name, seq));
    await env.DB.batch(statements);
  } catch (error) {
    await Promise.allSettled(written.map(key => env.BUCKET.delete(key)));
    throw error;
  }
  ctx.waitUntil(cleanupOldMessages(env, name).catch(error => console.error('Old-mail cleanup failed', name, error)));
}

export default {
  fetch: fetchApi,
  email: receive
};
