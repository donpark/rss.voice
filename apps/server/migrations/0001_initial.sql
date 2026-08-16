CREATE TABLE IF NOT EXISTS users (
  tenant_id TEXT NOT NULL,
  screenname TEXT NOT NULL,
  email TEXT,
  email_secret_hash TEXT,
  display_name TEXT,
  feed_title TEXT,
  feed_link TEXT,
  feed_description TEXT,
  avatar_url TEXT,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, screenname),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT,
  description TEXT,
  markdowntext TEXT,
  link TEXT,
  in_reply_to INTEGER,
  enclosure_url TEXT,
  enclosure_type TEXT,
  enclosure_length INTEGER,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  FOREIGN KEY (tenant_id, author) REFERENCES users (tenant_id, screenname)
);

CREATE INDEX IF NOT EXISTS posts_recent
  ON posts (tenant_id, published_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS posts_author
  ON posts (tenant_id, author, published_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS posts_replies
  ON posts (tenant_id, in_reply_to)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS likes (
  tenant_id TEXT NOT NULL,
  screenname TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, screenname, post_id)
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
