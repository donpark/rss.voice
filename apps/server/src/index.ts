/// <reference types="@cloudflare/workers-types" />

import {
  buildOpml,
  buildRssFeed,
  jsonPost,
  type Member,
  type Post,
} from "@rss-voice/protocol";
import {deleteMediaObject, getMedia, putMedia, type MediaRange} from "./object-store";

export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  FIREHOSE: DurableObjectNamespace;
  INSTANCE_NAME: string;
  TENANT_ID: string;
  BASE_URL?: string;
  WEB_URL?: string;
  MAIL_WEBHOOK_URL?: string;
  DEV_MODE?: string;
  MEDIA_S3_ENDPOINT?: string;
  MEDIA_S3_BUCKET?: string;
  MEDIA_S3_ACCESS_KEY_ID?: string;
  MEDIA_S3_SECRET_ACCESS_KEY?: string;
  MEDIA_S3_REGION?: string;
  MAX_MEDIA_UPLOAD_BYTES?: string;
  AUTH_RATE_LIMIT?: string;
  WRITE_RATE_LIMIT?: string;
  MEDIA_ORPHAN_GRACE_HOURS?: string;
}

type PostRow = {
  id: number;
  author: string;
  author_name: string | null;
  feed_title: string | null;
  feed_link: string | null;
  feed_description: string | null;
  avatar_url: string | null;
  title: string | null;
  description: string | null;
  markdowntext: string | null;
  link: string | null;
  in_reply_to: number | null;
  enclosure_url: string | null;
  enclosure_type: string | null;
  enclosure_length: number | null;
  ct_replies: number;
  ct_likes: number;
  published_at: string;
};

type UserRow = {
  screenname: string;
  display_name: string | null;
  feed_title: string | null;
  feed_link: string | null;
  feed_description: string | null;
  avatar_url: string | null;
};

const recentPostsSql = `
  SELECT p.id, p.author, p.title, p.description, p.markdowntext, p.link,
         p.in_reply_to, p.enclosure_url, p.enclosure_type, p.enclosure_length,
         (SELECT COUNT(*) FROM posts replies WHERE replies.tenant_id = p.tenant_id AND replies.in_reply_to = p.id AND replies.deleted_at IS NULL) AS ct_replies,
         (SELECT COUNT(*) FROM likes post_likes WHERE post_likes.tenant_id = p.tenant_id AND post_likes.post_id = p.id) AS ct_likes,
         p.published_at, u.display_name AS author_name, u.feed_title,
         u.feed_link, u.feed_description, u.avatar_url
  FROM posts p
  LEFT JOIN users u ON u.tenant_id = p.tenant_id AND u.screenname = p.author
  WHERE p.tenant_id = ? AND p.deleted_at IS NULL
`;

function headers(contentType: string): Headers {
  return new Headers({
    "content-type": `${contentType}; charset=utf-8`,
    "access-control-allow-origin": "*",
    "cache-control": contentType === "application/json" ? "no-store" : "public, max-age=60",
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {status, headers: headers("application/json")});
}

function text(data: string, contentType: string, status = 200): Response {
  return new Response(data, {status, headers: headers(contentType)});
}

function redirect(location: string): Response {
  return new Response(null, {status: 302, headers: new Headers({location})});
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownToHtml(value: string): string {
  const escaped = htmlEscape(value.trim());
  const inline = escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
  return `<p>${inline.replaceAll("\n", "<br />")}</p>`;
}

function randomCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashCode(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validScreenname(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(value);
}

function authParams(url: URL): {email?: string; code?: string} {
  return {
    email: url.searchParams.get("emailaddress") ?? url.searchParams.get("email") ?? undefined,
    code: url.searchParams.get("emailcode") ?? url.searchParams.get("code") ?? undefined,
  };
}

function baseUrl(request: Request, env: Env): string {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/$/, "");
  const origin = new URL(request.url);
  if (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") return origin.origin;
  throw new Error("BASE_URL must be configured outside local development.");
}

function feedUrl(base: string, screenname: string): string {
  return `${base}/users/${encodeURIComponent(screenname)}/rss.xml`;
}

function postFromRow(row: PostRow, base: string): Post {
  const rawDate = row.published_at.includes("T") ? row.published_at : `${row.published_at.replace(" ", "T")}Z`;
  const parsedDate = new Date(rawDate);
  const post: Post = {
    id: row.id,
    author: row.author,
    feedUrl: feedUrl(base, row.author),
    guid: `${base}/?id=${row.id}`,
    pubDate: Number.isNaN(parsedDate.valueOf()) ? row.published_at : parsedDate.toISOString(),
  };

  if (row.author_name) post.authorName = row.author_name;
  if (row.title) post.title = row.title;
  if (row.description) post.description = row.description;
  if (row.markdowntext) post.markdowntext = row.markdowntext;
  if (row.link) post.link = row.link;
  if (row.in_reply_to !== null) {
    post.inReplyToNum = row.in_reply_to;
    post.inReplyToUrl = `${base}/?id=${row.in_reply_to}`;
  }
  if (row.enclosure_url) post.enclosureUrl = row.enclosure_url;
  if (row.enclosure_type) post.enclosureType = row.enclosure_type;
  if (row.enclosure_length !== null) post.enclosureLength = row.enclosure_length;
  post.ctReplies = row.ct_replies;
  post.ctLikes = row.ct_likes;
  return post;
}

function limit(value: string | null): number {
  const parsed = Number(value ?? 100);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 100;
}

function configuredRate(value: string | undefined, fallback: number): number {
  const configured = Number(value ?? fallback);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

async function withinRateLimit(env: Env, key: string, max: number): Promise<boolean> {
  const windowStarted = Math.floor(Date.now() / 900_000) * 900_000;
  await env.DB.prepare(`
    INSERT INTO rate_limits (tenant_id, rate_key, window_started, request_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT (tenant_id, rate_key) DO UPDATE SET
      request_count = CASE WHEN window_started = ? THEN request_count + 1 ELSE 1 END,
      window_started = CASE WHEN window_started = ? THEN window_started ELSE ? END
  `).bind(env.TENANT_ID, key, windowStarted, windowStarted, windowStarted, windowStarted).run();
  const row = await env.DB.prepare("SELECT request_count FROM rate_limits WHERE tenant_id = ? AND rate_key = ?")
    .bind(env.TENANT_ID, key).first<{request_count: number}>();
  return (row?.request_count ?? max + 1) <= max;
}

function rateLimited(message: string): Response {
  return new Response(message, {status: 429, headers: new Headers({"retry-after": "900"})});
}

async function recentPosts(env: Env, tenantId: string, max: number, author?: string): Promise<PostRow[]> {
  const authorClause = author === undefined ? "" : " AND p.author = ?";
  const statement = env.DB.prepare(`${recentPostsSql}${authorClause} ORDER BY p.published_at DESC LIMIT ?`);
  const result = author === undefined
    ? await statement.bind(tenantId, max).all<PostRow>()
    : await statement.bind(tenantId, author, max).all<PostRow>();
  return result.results;
}

async function post(env: Env, tenantId: string, id: number): Promise<PostRow | null> {
  return env.DB.prepare(`${recentPostsSql} AND p.id = ?`)
    .bind(tenantId, id)
    .first<PostRow>();
}

async function postAndReplies(env: Env, tenantId: string, id: number): Promise<PostRow[]> {
  const result = await env.DB.prepare(`${recentPostsSql} AND (p.id = ? OR p.in_reply_to = ?) ORDER BY p.published_at ASC`)
    .bind(tenantId, id, id)
    .all<PostRow>();
  return result.results;
}

async function thread(env: Env, tenantId: string, id: number, base: string, depth = 0): Promise<Post | null> {
  const row = await post(env, tenantId, id);
  if (!row) return null;
  const item = postFromRow(row, base);
  if (depth >= 50) return item;
  // ponytail: one query per thread node; batch the subtree if deep threads matter.
  const children = await env.DB.prepare(`${recentPostsSql} AND p.in_reply_to = ? ORDER BY p.published_at ASC`)
    .bind(tenantId, id)
    .all<PostRow>();
  if (children.results.length) {
    item.replies = [];
    for (const child of children.results) {
      const reply = await thread(env, tenantId, child.id, base, depth + 1);
      if (reply) item.replies.push(reply);
    }
  }
  return item;
}

async function user(env: Env, tenantId: string, screenname: string): Promise<UserRow | null> {
  return env.DB.prepare(`
    SELECT screenname, display_name, feed_title, feed_link, feed_description, avatar_url
    FROM users WHERE tenant_id = ? AND screenname = ?
  `).bind(tenantId, screenname).first<UserRow>();
}

async function members(env: Env, tenantId: string, base: string): Promise<Member[]> {
  const result = await env.DB.prepare(
    "SELECT screenname FROM users WHERE tenant_id = ? ORDER BY screenname",
  ).bind(tenantId).all<{screenname: string}>();
  return result.results.map(({screenname}) => ({screenname, feedUrl: feedUrl(base, screenname)}));
}

async function itemResponse(request: Request, env: Env, id: number): Promise<Response> {
  const row = await post(env, env.TENANT_ID, id);
  if (!row) return text("No post with that id.", "text/plain", 404);
  return json(jsonPost(postFromRow(row, baseUrl(request, env))));
}

async function feedResponse(request: Request, env: Env, screenname: string): Promise<Response> {
  const base = baseUrl(request, env);
  const account = await user(env, env.TENANT_ID, screenname);
  if (!account) return text("No member with that screenname.", "text/plain", 404);

  const items = (await recentPosts(env, env.TENANT_ID, 100, screenname))
    .map((row) => postFromRow(row, base));
  const selfUrl = feedUrl(base, screenname);
  const xml = buildRssFeed({
    title: account.feed_title ?? account.display_name ?? screenname,
    link: account.feed_link ?? `${base}/?name=${encodeURIComponent(screenname)}`,
    description: account.feed_description ?? `Posts by ${screenname}`,
    selfUrl,
    items,
  });
  return text(xml, "application/rss+xml");
}

async function everyoneFeedResponse(request: Request, env: Env): Promise<Response> {
  const base = baseUrl(request, env);
  const items = (await recentPosts(env, env.TENANT_ID, 100)).map((row) => postFromRow(row, base));
  const selfUrl = `${base}/users/rss.xml`;
  const xml = buildRssFeed({
    title: `${env.INSTANCE_NAME}: everyone`,
    link: `${base}/`,
    description: `Posts from everyone on ${env.INSTANCE_NAME}`,
    selfUrl,
    items,
  });
  return text(xml, "application/rss+xml");
}

async function userByEmail(env: Env, email: string): Promise<{screenname: string; email: string; email_secret_hash: string | null; confirmed_at: string | null} | null> {
  return env.DB.prepare(
    "SELECT screenname, email, email_secret_hash, confirmed_at FROM users WHERE tenant_id = ? AND email = ?",
  ).bind(env.TENANT_ID, email).first();
}

function mailIsConfigured(request: Request, env: Env): boolean {
  return Boolean(env.MAIL_WEBHOOK_URL || env.DEV_MODE === "true" || ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname));
}

function redirectTarget(request: Request, env: Env, value: string | null): string {
  const base = baseUrl(request, env);
  if (!value) return `${env.WEB_URL?.replace(/\/$/, "") ?? base}/`;
  try {
    const target = new URL(value);
    const allowedOrigins = [new URL(base).origin];
    if (env.WEB_URL) allowedOrigins.push(new URL(env.WEB_URL).origin);
    return allowedOrigins.includes(target.origin) ? target.toString() : `${base}/`;
  } catch {
    return `${base}/`;
  }
}

async function deliverMagicLink(
  request: Request,
  env: Env,
  email: string,
  screenname: string,
  code: string,
  urlredirect: string | null,
  operation: string,
): Promise<Response> {
  const link = new URL("/auth/confirm", baseUrl(request, env));
  link.searchParams.set("email", email);
  link.searchParams.set("code", code);
  link.searchParams.set("screenname", screenname);
  link.searchParams.set("urlredirect", redirectTarget(request, env, urlredirect));

  if (env.MAIL_WEBHOOK_URL) {
    const response = await fetch(env.MAIL_WEBHOOK_URL, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({to: email, screenname, operation, link: link.toString()}),
    });
    if (!response.ok) return text("The confirmation email could not be sent.", "text/plain", 502);
    return json({ok: true});
  }
  if (env.DEV_MODE === "true" || ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname)) {
    return json({ok: true, devMagicLink: link.toString()});
  }
  return text("Mail delivery is not configured.", "text/plain", 503);
}

async function createOrUpdateConfirmation(request: Request, env: Env, create: boolean): Promise<Response> {
  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  const requestedName = url.searchParams.get("name")?.trim();
  if (!email || !email.includes("@")) return text("A valid email is required.", "text/plain", 400);
  if (!mailIsConfigured(request, env)) return text("Mail delivery is not configured.", "text/plain", 503);

  let screenname = requestedName;
  if (!screenname) screenname = email.split("@", 1)[0].replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (!screenname || !validScreenname(screenname)) return text("The screenname is invalid.", "text/plain", 400);

  const existingByEmail = await userByEmail(env, email);
  const existingByName = await user(env, env.TENANT_ID, screenname);
  if (create && (existingByEmail || existingByName)) return text("That account already exists.", "text/plain", 409);
  if (!create && !existingByEmail) return text("No account exists for that email.", "text/plain", 404);

  const code = randomCode();
  const secretHash = await hashCode(code);
  if (create) {
    await env.DB.prepare(`
      INSERT INTO users (tenant_id, screenname, email, email_secret_hash)
      VALUES (?, ?, ?, ?)
    `).bind(env.TENANT_ID, screenname, email, secretHash).run();
  } else {
    await env.DB.prepare(
      "UPDATE users SET email_secret_hash = ?, confirmed_at = NULL, updated_at = ? WHERE tenant_id = ? AND email = ?",
    ).bind(secretHash, new Date().toISOString(), env.TENANT_ID, email).run();
    screenname = existingByEmail!.screenname;
  }
  return deliverMagicLink(request, env, email, screenname, code, url.searchParams.get("urlredirect"), create ? "create an account" : "sign in");
}

async function confirmMagicLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  const code = url.searchParams.get("code");
  const screenname = url.searchParams.get("screenname");
  if (!email || !code || !screenname) return text("The confirmation link is incomplete.", "text/plain", 400);
  const account = await userByEmail(env, email);
  if (!account || account.screenname !== screenname || account.email_secret_hash !== await hashCode(code)) {
    return text("The confirmation link is invalid.", "text/plain", 403);
  }
  await env.DB.prepare(
    "UPDATE users SET confirmed_at = ?, updated_at = ? WHERE tenant_id = ? AND email = ?",
  ).bind(new Date().toISOString(), new Date().toISOString(), env.TENANT_ID, email).run();
  const target = new URL(redirectTarget(request, env, url.searchParams.get("urlredirect")));
  target.searchParams.set("emailconfirmed", "true");
  target.searchParams.set("email", email);
  target.searchParams.set("code", code);
  target.searchParams.set("screenname", screenname);
  return redirect(target.toString());
}

async function authenticate(env: Env, url: URL): Promise<{screenname: string} | null> {
  const {email, code} = authParams(url);
  if (!email || !code) return null;
  const account = await userByEmail(env, email.toLowerCase());
  if (!account || !account.confirmed_at || !account.email_secret_hash || account.email_secret_hash !== await hashCode(code)) return null;
  return {screenname: account.screenname};
}

async function broadcast(env: Env, verb: string, item: Record<string, unknown>): Promise<void> {
  const id = env.FIREHOSE.idFromName(env.TENANT_ID);
  const stub = env.FIREHOSE.get(id);
  try {
    await stub.fetch("https://firehose/broadcast", {
      method: "POST",
      body: `${verb}\r${JSON.stringify({item})}`,
    });
  } catch {
    // A disconnected firehose must not make a successful post fail.
  }
}

type MediaRow = {
  id: number;
  tenant_id: string;
  owner: string;
  object_key: string;
  content_type: string;
  size: number;
  created_at: string;
};

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value.replaceAll(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function mediaTypeAllowed(type: string): boolean {
  return type.startsWith("audio/") || type.startsWith("image/");
}

function parseMediaRange(value: string | null, size: number): MediaRange | null | false {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isInteger(suffix) && suffix > 0 ? {start: Math.max(0, size - suffix), end: size - 1, total: size} : false;
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return false;
  return {start, end: Math.min(requestedEnd, size - 1), total: size};
}

async function uploadMedia(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const account = await authenticate(env, url);
  if (!account) return text("The authorization code is not correct.", "text/plain", 403);
  if (!(await withinRateLimit(env, `write:${account.screenname}`, configuredRate(env.WRITE_RATE_LIMIT, 60)))) return rateLimited("Too many write requests.");
  const type = url.searchParams.get("type")?.toLowerCase();
  if (!type || !mediaTypeAllowed(type)) return text("This media type is not supported.", "text/plain", 415);

  const configuredLimit = Number(env.MAX_MEDIA_UPLOAD_BYTES ?? 2 * 1024 * 1024);
  const maxBytes = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 2 * 1024 * 1024;
  const body = await request.arrayBuffer();
  if (body.byteLength > Math.ceil(maxBytes * 4 / 3) + 4) return text("The media item is too large.", "text/plain", 413);
  let bytes: ArrayBuffer;
  try {
    bytes = url.searchParams.get("encoding") === "raw" ? body : decodeBase64(new TextDecoder().decode(body));
  } catch {
    return text("The media body is not valid base64.", "text/plain", 400);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return text("The media item is too large.", "text/plain", 413);

  const placeholder = `pending/${crypto.randomUUID()}`;
  const inserted = await env.DB.prepare(`
    INSERT INTO media (tenant_id, owner, object_key, content_type, size)
    VALUES (?, ?, ?, ?, ?)
  `).bind(env.TENANT_ID, account.screenname, placeholder, type, bytes.byteLength).run();
  const id = Number(inserted.meta.last_row_id);
  const key = `media/${env.TENANT_ID}/${id}`;
  let stored = false;
  try {
    await putMedia(env, key, bytes, type);
    stored = true;
    await env.DB.prepare("UPDATE media SET object_key = ? WHERE tenant_id = ? AND id = ?")
      .bind(key, env.TENANT_ID, id).run();
  } catch {
    if (stored) await deleteMediaObject(env, key).catch(() => undefined);
    await env.DB.prepare("DELETE FROM media WHERE tenant_id = ? AND id = ?").bind(env.TENANT_ID, id).run();
    return text("The media item could not be stored.", "text/plain", 502);
  }
  return json({url: `${baseUrl(request, env)}/media/${id}`, id, type, size: bytes.byteLength});
}

async function serveMedia(request: Request, env: Env, id: number): Promise<Response> {
  const media = await env.DB.prepare(
    "SELECT id, tenant_id, owner, object_key, content_type, size FROM media WHERE tenant_id = ? AND id = ?",
  ).bind(env.TENANT_ID, id).first<MediaRow>();
  if (!media) return text("No media item with that id.", "text/plain", 404);
  const range = parseMediaRange(request.headers.get("range"), media.size);
  if (range === false) return new Response(null, {status: 416, headers: new Headers({"content-range": `bytes */${media.size}`})});
  const object = await getMedia(env, media.object_key, range ?? undefined);
  if (!object) return text("The media object is missing.", "text/plain", 404);
  const responseHeaders = new Headers(object.headers);
  responseHeaders.set("content-type", media.content_type);
  responseHeaders.set("content-length", String(range ? range.end - range.start + 1 : media.size));
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("accept-ranges", "bytes");
  if (range) responseHeaders.set("content-range", `bytes ${range.start}-${range.end}/${media.size}`);
  responseHeaders.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(request.method === "HEAD" ? null : object.body, {status: range ? 206 : 200, headers: responseHeaders});
}

async function cleanupOrphanMedia(env: Env): Promise<number> {
  const graceHours = Number(env.MEDIA_ORPHAN_GRACE_HOURS ?? 24);
  const cutoff = new Date(Date.now() - (Number.isFinite(graceHours) && graceHours > 0 ? graceHours : 24) * 3_600_000).toISOString();
  const result = await env.DB.prepare(`
    SELECT m.id, m.tenant_id, m.owner, m.object_key, m.content_type, m.size, m.created_at
    FROM media m
    WHERE m.tenant_id = ? AND m.created_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM posts p
        WHERE p.tenant_id = m.tenant_id
          AND p.enclosure_url LIKE '%/media/' || CAST(m.id AS TEXT)
      )
    LIMIT 100
  `).bind(env.TENANT_ID, cutoff).all<MediaRow>();
  let deleted = 0;
  for (const media of result.results) {
    try {
      await deleteMediaObject(env, media.object_key);
      await env.DB.prepare("DELETE FROM media WHERE tenant_id = ? AND id = ?").bind(env.TENANT_ID, media.id).run();
      deleted++;
    } catch {
      // Keep failed objects for the next scheduled cleanup attempt.
    }
  }
  return deleted;
}

async function deleteMedia(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const account = await authenticate(env, url);
  if (!account) return text("The authorization code is not correct.", "text/plain", 403);
  if (!(await withinRateLimit(env, `write:${account.screenname}`, configuredRate(env.WRITE_RATE_LIMIT, 60)))) return rateLimited("Too many write requests.");
  const id = Number(url.searchParams.get("id"));
  const media = await env.DB.prepare(
    "SELECT id, tenant_id, owner, object_key, content_type, size FROM media WHERE tenant_id = ? AND id = ?",
  ).bind(env.TENANT_ID, id).first<MediaRow>();
  if (!media) return text("No media item with that id.", "text/plain", 404);
  if (media.owner !== account.screenname) return text("The media item belongs to another member.", "text/plain", 403);
  await deleteMediaObject(env, media.object_key);
  await env.DB.prepare("DELETE FROM media WHERE tenant_id = ? AND id = ?").bind(env.TENANT_ID, id).run();
  return json({ok: true});
}

async function createPost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const account = await authenticate(env, url);
  if (!account) return text("The authorization code is not correct.", "text/plain", 403);
  if (!(await withinRateLimit(env, `write:${account.screenname}`, configuredRate(env.WRITE_RATE_LIMIT, 60)))) return rateLimited("Too many write requests.");

  const raw = url.searchParams.get("jsontext") ?? await request.text();
  if (!raw || raw.length > 100_000) return text("The post is missing or too large.", "text/plain", 400);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return text("The post does not contain valid JSON.", "text/plain", 400);
  }

  const source = typeof payload.markdowntext === "string" ? payload.markdowntext : typeof payload.description === "string" ? payload.description : "";
  const enclosureUrl = typeof payload.enclosureUrl === "string" ? payload.enclosureUrl : null;
  if (!source.trim() && !enclosureUrl) return text("The post has no text or media.", "text/plain", 400);
  const inReplyTo = payload.inReplyTo ?? payload.inReplyToNum;
  const replyId = inReplyTo === undefined || inReplyTo === null ? null : Number(inReplyTo);
  if (replyId !== null && (!Number.isInteger(replyId) || replyId < 1)) return text("The reply target is invalid.", "text/plain", 400);
  if (replyId !== null && !(await post(env, env.TENANT_ID, replyId))) return text("The reply target does not exist.", "text/plain", 400);

  const enclosureType = typeof payload.enclosureType === "string" ? payload.enclosureType : null;
  const enclosureLength = payload.enclosureLength === undefined ? null : Number(payload.enclosureLength);
  if (enclosureUrl && (enclosureLength === null || !enclosureType || !Number.isInteger(enclosureLength) || enclosureLength < 1)) {
    return text("An enclosure needs a type and byte length.", "text/plain", 400);
  }

  const result = await env.DB.prepare(`
    INSERT INTO posts (tenant_id, author, title, description, markdowntext, link, in_reply_to, enclosure_url, enclosure_type, enclosure_length, published_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    env.TENANT_ID,
    account.screenname,
    typeof payload.title === "string" ? payload.title.slice(0, 500) : null,
    source.trim() ? markdownToHtml(source) : null,
    source.trim() ? source : null,
    typeof payload.link === "string" ? payload.link : null,
    replyId,
    enclosureUrl,
    enclosureType,
    enclosureUrl ? enclosureLength : null,
    new Date().toISOString(),
    new Date().toISOString(),
  ).run();
  const id = Number(result.meta.last_row_id);
  const row = await post(env, env.TENANT_ID, id);
  if (!row) return text("The post was created but could not be read back.", "text/plain", 500);
  const item = jsonPost(postFromRow(row, baseUrl(request, env)));
  await broadcast(env, "newItem", item);
  return json(item);
}

async function updatePost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const account = await authenticate(env, url);
  if (!account) return text("The authorization code is not correct.", "text/plain", 403);
  if (!(await withinRateLimit(env, `write:${account.screenname}`, configuredRate(env.WRITE_RATE_LIMIT, 60)))) return rateLimited("Too many write requests.");
  const raw = url.searchParams.get("jsontext") ?? await request.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return text("The post does not contain valid JSON.", "text/plain", 400);
  }
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id < 1) return text("A numeric id is required.", "text/plain", 400);
  const current = await post(env, env.TENANT_ID, id);
  if (!current) return text("No post with that id.", "text/plain", 404);
  if (current.author !== account.screenname) return text("Only the author can edit this post.", "text/plain", 403);
  const source = typeof payload.markdowntext === "string"
    ? payload.markdowntext
    : typeof payload.description === "string" ? payload.description : current.markdowntext ?? "";
  if (!source.trim() && !current.enclosure_url) return text("The post has no text or media.", "text/plain", 400);
  await env.DB.prepare(`
    UPDATE posts
    SET title = ?, description = ?, markdowntext = ?, updated_at = ?
    WHERE tenant_id = ? AND id = ? AND author = ? AND deleted_at IS NULL
  `).bind(
    payload.title === null ? null : typeof payload.title === "string" ? payload.title.slice(0, 500) : current.title,
    source.trim() ? markdownToHtml(source) : null,
    source.trim() ? source : null,
    new Date().toISOString(), env.TENANT_ID, id, account.screenname,
  ).run();
  const updated = await post(env, env.TENANT_ID, id);
  if (!updated) return text("The post was updated but could not be read back.", "text/plain", 500);
  const item = jsonPost(postFromRow(updated, baseUrl(request, env)));
  await broadcast(env, "updatedItem", item);
  return json(item);
}

async function deletePost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const account = await authenticate(env, url);
  if (!account) return text("The authorization code is not correct.", "text/plain", 403);
  if (!(await withinRateLimit(env, `write:${account.screenname}`, configuredRate(env.WRITE_RATE_LIMIT, 60)))) return rateLimited("Too many write requests.");
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return text("A numeric id is required.", "text/plain", 400);
  const current = await post(env, env.TENANT_ID, id);
  if (!current) return text("No post with that id.", "text/plain", 404);
  if (current.author !== account.screenname) return text("Only the author can delete this post.", "text/plain", 403);
  await env.DB.prepare("UPDATE posts SET deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
    .bind(new Date().toISOString(), new Date().toISOString(), env.TENANT_ID, id).run();
  await broadcast(env, "updatedItem", {id, deleted: true});
  return json({ok: true, id, deleted: true});
}

async function toggleLike(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const account = await authenticate(env, url);
  if (!account) return text("The authorization code is not correct.", "text/plain", 403);
  if (!(await withinRateLimit(env, `write:${account.screenname}`, configuredRate(env.WRITE_RATE_LIMIT, 60)))) return rateLimited("Too many write requests.");
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return text("A numeric id is required.", "text/plain", 400);
  if (!(await post(env, env.TENANT_ID, id))) return text("No post with that id.", "text/plain", 404);
  const existing = await env.DB.prepare("SELECT 1 FROM likes WHERE tenant_id = ? AND screenname = ? AND post_id = ?")
    .bind(env.TENANT_ID, account.screenname, id).first();
  const liked = !existing;
  if (liked) {
    await env.DB.prepare("INSERT INTO likes (tenant_id, screenname, post_id) VALUES (?, ?, ?)")
      .bind(env.TENANT_ID, account.screenname, id).run();
  } else {
    await env.DB.prepare("DELETE FROM likes WHERE tenant_id = ? AND screenname = ? AND post_id = ?")
      .bind(env.TENANT_ID, account.screenname, id).run();
  }
  const current = await post(env, env.TENANT_ID, id);
  if (!current) return text("The post disappeared.", "text/plain", 404);
  const item = postFromRow(current, baseUrl(request, env));
  item.flLiked = liked;
  const output = jsonPost(item);
  await broadcast(env, "updatedItem", output);
  return json(output);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const base = baseUrl(request, env);

  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && (path === "/" || path === "/firehose")) {
    const id = env.FIREHOSE.idFromName(env.TENANT_ID);
    return env.FIREHOSE.get(id).fetch(request);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {status: 204, headers: new Headers({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    })});
  }
  if (request.method === "GET" && path === "/auth/confirm") {
    const email = url.searchParams.get("email")?.toLowerCase() ?? "unknown";
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await withinRateLimit(env, `confirm:${ip}:${email}`, configuredRate(env.AUTH_RATE_LIMIT, 5)))) return new Response("Too many confirmation attempts.", {status: 429, headers: new Headers({"retry-after": "900"})});
    return confirmMagicLink(request, env);
  }
  if (request.method === "GET" && (path === "/createnewuser" || path === "/sendconfirmingemail")) {
    const email = (url.searchParams.get("email") ?? "unknown").toLowerCase();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await withinRateLimit(env, `request:${ip}:${email}`, configuredRate(env.AUTH_RATE_LIMIT, 5)))) return new Response("Too many sign-in requests.", {status: 429, headers: new Headers({"retry-after": "900"})});
    return createOrUpdateConfirmation(request, env, path === "/createnewuser");
  }
  if (request.method === "POST" && path === "/newpost") return createPost(request, env);
  if (request.method === "POST" && path === "/updatepost") return updatePost(request, env);
  if (request.method === "POST" && path === "/deletepost") return deletePost(request, env);
  if (request.method === "POST" && path === "/togglelike") return toggleLike(request, env);
  if (request.method === "POST" && path === "/uploadmedia") return uploadMedia(request, env);
  if (request.method === "POST" && path === "/deletemedia") return deleteMedia(request, env);
  const mediaMatch = path.match(/^\/media\/(\d+)$/);
  if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) return serveMedia(request, env, Number(mediaMatch[1]));
  if (request.method !== "GET") return text("Method not allowed.", "text/plain", 405);

  if (path === "/") {
    const id = Number(url.searchParams.get("id"));
    return Number.isInteger(id) && id > 0
      ? itemResponse(request, env, id)
      : json({ok: true, service: "rss.voice"});
  }
  if (path === "/health") return json({ok: true, service: "rss.voice"});
  if (path === "/getitembyguid") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) return text("A numeric id is required.", "text/plain", 400);
    return itemResponse(request, env, id);
  }
  if (path === "/getitemandreplies") {
    const id = Number(url.searchParams.get("idparent"));
    if (!Number.isInteger(id) || id < 1) return text("A numeric idparent is required.", "text/plain", 400);
    const items = (await postAndReplies(env, env.TENANT_ID, id)).map((row) => jsonPost(postFromRow(row, base)));
    return json(items);
  }
  if (path === "/getthread") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) return text("A numeric id is required.", "text/plain", 400);
    const item = await thread(env, env.TENANT_ID, id, base);
    return item ? json(jsonPost(item)) : text("No post with that id.", "text/plain", 404);
  }
  if (path === "/getrecentitems") {
    const items = (await recentPosts(env, env.TENANT_ID, limit(url.searchParams.get("ct"))))
      .map((row) => jsonPost(postFromRow(row, base)));
    return json(items);
  }
  if (path === "/getrecentuseritems") {
    const screenname = url.searchParams.get("name");
    if (!screenname) return text("The name parameter is required.", "text/plain", 400);
    const items = (await recentPosts(env, env.TENANT_ID, 100, screenname))
      .map((row) => jsonPost(postFromRow(row, base)));
    return json(items);
  }
  if (path === "/feed") {
    const screenname = url.searchParams.get("screenname");
    if (!screenname) return text("The screenname parameter is required.", "text/plain", 400);
    return feedResponse(request, env, screenname);
  }
  if (path === "/getsubscriptionlist" || path === "/data/subs.opml") {
    const xml = buildOpml(`${env.INSTANCE_NAME} members`, await members(env, env.TENANT_ID, base));
    return text(xml, "text/x-opml");
  }

  if (path === "/users/rss.xml") return everyoneFeedResponse(request, env);

  const feedMatch = path.match(/^\/users\/([^/]+)\/rss\.xml$/);
  if (feedMatch) {
    try {
      return feedResponse(request, env, decodeURIComponent(feedMatch[1]));
    } catch (error) {
      if (error instanceof URIError) return text("Invalid screenname.", "text/plain", 400);
      throw error;
    }
  }

  return text("Not found.", "text/plain", 404);
}

export class Firehose {
  private readonly sockets = new Set<WebSocket>();

  constructor() {}

  private send(message: string): void {
    for (const socket of this.sockets) {
      try {
        socket.send(message);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/broadcast") {
      this.send(await request.text());
      return new Response("ok");
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return text("WebSocket upgrade required.", "text/plain", 426);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    return new Response(null, {status: 101, webSocket: client});
  }

}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupOrphanMedia(env);
  },
};
