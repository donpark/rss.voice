/// <reference types="@cloudflare/workers-types" />

import {
  buildOpml,
  buildRssFeed,
  jsonPost,
  type Member,
  type Post,
} from "@rss-voice/protocol";

export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  FIREHOSE: DurableObjectNamespace;
  INSTANCE_NAME: string;
  TENANT_ID: string;
  BASE_URL?: string;
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
  return post;
}

function limit(value: string | null): number {
  const parsed = Number(value ?? 100);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 100;
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

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const base = baseUrl(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, {status: 204, headers: new Headers({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    })});
  }
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

  async fetch(request: Request): Promise<Response> {
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

  async broadcast(message: string): Promise<void> {
    for (const socket of this.sockets) {
      try {
        socket.send(message);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
