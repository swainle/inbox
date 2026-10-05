import PostalMime from 'postal-mime';

const encoder = new TextEncoder();
const BODY_IN_D1_LIMIT = 1024 * 1024;

export function mailboxName(address) {
  const at = address.lastIndexOf('@');
  if (at < 1 || address.slice(at + 1).toLowerCase() !== 'e-com.cc') return null;
  const name = address.slice(0, at).toLowerCase();
  return name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..' ? name : null;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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

function page(title, content) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${content}</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }
  });
}

function notFound() { return new Response('Not found', { status: 404 }); }

function inboxPath(name) { return `/inbox/${encodeURIComponent(name)}`; }
function pathFor(name, seq) { return `${inboxPath(name)}/${seq}`; }
function chinaTime(value) { return `${new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)}+08:00`; }
function fileSize(bytes) { return `${Math.ceil(bytes / 1024)}KB`; }

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

async function randomMailbox(env) {
  for (let length = 5; length <= 24; length++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const name = randomName(length);
      const existing = await env.DB.prepare('SELECT 1 FROM mailboxes WHERE name = ? LIMIT 1').bind(name).first();
      if (!existing) return name;
    }
  }
  return null;
}

async function randomMailboxes(env, count) {
  const addresses = [];
  const used = new Set();
  let queries = 0;
  for (let length = 5; length <= 24 && addresses.length < count && queries < 40; length++) {
    for (let round = 0; round < 3 && addresses.length < count && queries < 40; round++) {
      const candidates = [];
      for (let attempt = 0; candidates.length < count - addresses.length && attempt < count * 10; attempt++) {
        const name = randomName(length);
        if (used.has(name)) continue;
        used.add(name);
        candidates.push(name);
      }
      const existing = new Set();
      for (let i = 0; i < candidates.length; i += 100) {
        if (queries++ >= 40) return null;
        const batch = candidates.slice(i, i + 100);
        const placeholders = batch.map(() => '?').join(',');
        const rows = (await env.DB.prepare(`SELECT name FROM mailboxes WHERE name IN (${placeholders})`).bind(...batch).all()).results;
        for (const row of rows) existing.add(row.name);
      }
      for (const name of candidates) if (!existing.has(name)) addresses.push(`${name}@e-com.cc`);
    }
  }
  return addresses.length === count ? addresses : null;
}

async function getMessage(env, name, seq) {
  return env.DB.prepare('SELECT * FROM messages WHERE mailbox = ? AND seq = ? AND status = ?').bind(name, seq, 'ready').first();
}

async function fetchPage(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  if (url.pathname === '/') return page('公开收件箱', '<p><a href="/rand">生成随机邮箱</a></p><p>访问 <code>/inbox/收件人名字</code> 查看公开邮件列表。</p>');
  if (url.pathname === '/rand') {
    if (request.method === 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    const name = await randomMailbox(env);
    if (!name) return new Response('No available mailbox name', { status: 503 });
    return new Response(`${name}@e-com.cc`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname.startsWith('/randbat/')) {
    if (request.method === 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    const countPart = url.pathname.slice('/randbat/'.length);
    if (!/^[1-9]\d*$/.test(countPart) || Number(countPart) > 1000) return new Response('Count must be between 1 and 1000', { status: 400 });
    const addresses = await randomMailboxes(env, Number(countPart));
    if (!addresses) return new Response('No available mailbox name', { status: 503 });
    return new Response(addresses.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (!url.pathname.startsWith('/inbox/')) return notFound();
  const parts = url.pathname.slice('/inbox/'.length).split('/');
  if (parts.length > 4) return notFound();
  let rawName;
  try { rawName = decodeURIComponent(parts[0]); } catch { return notFound(); }
  const name = mailboxName(`${rawName}@e-com.cc`);
  if (!name) return notFound();
  if (parts.length === 1) {
    const rows = (await env.DB.prepare('SELECT seq, sender, subject, received_at, is_read, spam_suspected FROM messages WHERE mailbox = ? AND status = ? ORDER BY received_at DESC, seq DESC').bind(name, 'ready').all()).results;
    const senderWidth = Math.max(24, ...rows.map(row => row.sender.length));
    const items = rows.map(row => {
      const prefix = `${row.is_read ? '[ ]' : '[*]'}  ${row.sender.padEnd(senderWidth)}  ${chinaTime(row.received_at)}  ${row.spam_suspected ? '[!]' : '   '}  `;
      return `${escapeHtml(prefix)}<a href="${pathFor(name, row.seq)}">${escapeHtml(row.subject || '(无主题)')}</a>`;
    }).join('\n');
    return page(`${name} 的邮件`, `<pre>${escapeHtml(name)}@e-com.cc\n---\n${items || '暂无邮件。'}</pre>`);
  }
  const seqPart = parts[1];
  let seq;
  if (seqPart === 'latest') {
    const row = await env.DB.prepare('SELECT seq FROM messages WHERE mailbox = ? AND status = ? ORDER BY seq DESC LIMIT 1').bind(name, 'ready').first();
    if (!row) return notFound();
    seq = row.seq;
    if (parts.length === 2) return Response.redirect(`${url.origin}${pathFor(name, seq)}`, 302);
  } else {
    if (!/^[1-9]\d*$/.test(seqPart)) return notFound();
    seq = Number(seqPart);
    if (!Number.isSafeInteger(seq)) return notFound();
  }
  const row = await getMessage(env, name, seq);
  if (!row) return notFound();
  if (parts.length === 2) {
    const attachments = (await env.DB.prepare('SELECT part, filename, byte_size FROM attachments WHERE mailbox = ? AND seq = ? ORDER BY part').bind(name, seq).all()).results;
    const files = attachments.length ? `\n---\n附件\n${attachments.map(file => `${file.part}. <a href="${pathFor(name, seq)}/attachments/${file.part}">${escapeHtml(file.filename)}</a> ${fileSize(file.byte_size)}`).join('\n')}` : '';
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
    if (request.method === 'GET') await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE mailbox = ? AND seq = ?').bind(name, seq).run();
    return page(row.subject, `<pre>发件人  :${escapeHtml(row.sender)}\n收件人  :${escapeHtml(name)}@e-com.cc\n时间    :${chinaTime(row.received_at)}\n主题    :${escapeHtml(row.subject || '(无主题)')}\n---\n${escapeHtml(text || '')}${files}</pre>`);
  }
  if (parts.length === 4 && parts[2] === 'attachments' && /^[1-9]\d*$/.test(parts[3])) {
    const part = Number(parts[3]);
    if (!Number.isSafeInteger(part)) return notFound();
    const file = await env.DB.prepare('SELECT * FROM attachments WHERE mailbox = ? AND seq = ? AND part = ?').bind(name, seq, part).first();
    if (!file) return notFound();
    const object = await env.BUCKET.get(file.object_key);
    if (!object) return notFound();
    const safeName = file.filename.replace(/[\r\n"\\]/g, '_');
    return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
  }
  return notFound();
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
    env.DB.prepare('UPDATE mailboxes SET next_seq = next_seq + 1 WHERE name = ?').bind(name),
    env.DB.prepare("INSERT INTO messages (mailbox, seq, token, sender, subject, received_at, spam_suspected) SELECT name, next_seq - 1, ?, ?, ?, ?, ? FROM mailboxes WHERE name = ?").bind(token, message.from || '', parsed.subject || '', receivedAt, spam, name)
  ]);
  const allocated = await env.DB.prepare('SELECT seq FROM messages WHERE token = ?').bind(token).first();
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
  fetch: fetchPage,
  email: receive
};
