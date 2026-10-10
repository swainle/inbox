import test from 'node:test';
import assert from 'node:assert/strict';
import { mailboxFromSearch, mailboxPath, emailHtmlDocument } from '../src/api.js';

test('inbox link selects one mailbox by address name', () => {
  assert.deepEqual(mailboxFromSearch('?address=abc12'), { kind: 'public', id: 'abc12', address: 'abc12@e-com.cc' });
  assert.equal(mailboxPath(mailboxFromSearch('?address=abc12')), '/mailboxes/abc12/messages');
  assert.deepEqual(mailboxFromSearch('?address=my.box'), { kind: 'public', id: 'my.box', address: 'my.box@e-com.cc' });
  assert.equal(mailboxFromSearch(''), null);
  assert.equal(mailboxFromSearch('?address=abc12@e-com.cc'), false);
  assert.equal(mailboxFromSearch('?address=../secret'), false);
});

test('HTML email document starts with a restrictive policy', () => {
  const document = emailHtmlDocument('<script>alert(1)</script><img src="https://tracker.example/pixel">');
  assert.match(document, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.match(document, /default-src 'none'/);
  assert.match(document, /<meta name="referrer" content="no-referrer">/);
});
