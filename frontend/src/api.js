export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options });
  const data = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
  return data;
}

export function mailboxPath(mailbox) {
  return `/${mailbox.kind === 'public' ? 'mailboxes' : `${mailbox.kind}-mailboxes`}/${encodeURIComponent(mailbox.id)}/messages`;
}

export function mailboxFromSearch(search) {
  const params = new URLSearchParams(search);
  if (!params.has('address')) return null;
  const id = params.get('address');
  return /^[a-z0-9_][a-z0-9_.-]{0,127}$/.test(id) ? { kind: 'public', id, address: `${id}@e-com.cc` } : false;
}

export function emailHtmlDocument(html) {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer">${html}`;
}
