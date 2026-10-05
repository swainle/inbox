CREATE TABLE IF NOT EXISTS mailboxes (
  name TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  mailbox TEXT NOT NULL,
  seq INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  spam_suspected INTEGER NOT NULL DEFAULT 0,
  text_body TEXT,
  html_body TEXT,
  body_key TEXT,
  PRIMARY KEY (mailbox, seq)
);

CREATE INDEX IF NOT EXISTS messages_ready ON messages (mailbox, status, seq DESC);

CREATE TABLE IF NOT EXISTS attachments (
  mailbox TEXT NOT NULL,
  seq INTEGER NOT NULL,
  part INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (mailbox, seq, part),
  FOREIGN KEY (mailbox, seq) REFERENCES messages(mailbox, seq)
);
