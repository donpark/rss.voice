export type Post = {
  id: number;
  tenantId?: string;
  author: string;
  authorName?: string;
  feedUrl: string;
  title?: string;
  description?: string;
  markdowntext?: string;
  link?: string;
  pubDate: string;
  guid: string;
  inReplyToNum?: number;
  inReplyToUrl?: string;
  enclosureUrl?: string;
  enclosureType?: string;
  enclosureLength?: number;
};

export type Member = {
  screenname: string;
  feedUrl: string;
};

export type FeedOptions = {
  title: string;
  link: string;
  description: string;
  selfUrl: string;
  items: Post[];
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function optionalElement(name: string, value: string | undefined): string {
  return value === undefined || value === "" ? "" : `<${name}>${cdata(value)}</${name}>`;
}

function itemXml(item: Post): string {
  const enclosure = item.enclosureUrl && item.enclosureType && item.enclosureLength !== undefined
    ? `<enclosure url="${escapeXml(item.enclosureUrl)}" length="${item.enclosureLength}" type="${escapeXml(item.enclosureType)}" />`
    : "";
  const reply = item.inReplyToNum === undefined
    ? ""
    : `<source:inReplyTo>${escapeXml(item.inReplyToUrl ?? String(item.inReplyToNum))}</source:inReplyTo>`;

  return [
    "<item>",
    optionalElement("title", item.title),
    optionalElement("description", item.description),
    optionalElement("link", item.link ?? item.guid),
    `<guid isPermaLink=\"true\">${escapeXml(item.guid)}</guid>`,
    `<pubDate>${escapeXml(new Date(item.pubDate).toUTCString())}</pubDate>`,
    `<source url=\"${escapeXml(item.feedUrl)}\">${escapeXml(item.authorName ?? item.author)}</source>`,
    optionalElement("source:markdown", item.markdowntext),
    reply,
    enclosure,
    "</item>",
  ].join("");
}

export function buildRssFeed(options: FeedOptions): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:source="http://source.scripting.com/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    "<channel>",
    `<title>${escapeXml(options.title)}</title>`,
    `<link>${escapeXml(options.link)}</link>`,
    `<description>${escapeXml(options.description)}</description>`,
    `<atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(options.selfUrl)}" rel="self" type="application/rss+xml" />`,
    options.items.map(itemXml).join(""),
    "</channel>",
    "</rss>",
  ].join("");
}

export function buildOpml(title: string, members: Member[], modified = new Date()): string {
  const outlines = members.map((member) =>
    `<outline type="rss" text="${escapeXml(member.screenname)}" xmlUrl="${escapeXml(member.feedUrl)}" />`,
  ).join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0"><head>',
    `<title>${escapeXml(title)}</title>`,
    `<dateModified>${escapeXml(modified.toUTCString())}</dateModified>`,
    `</head><body>${outlines}</body></opml>`,
  ].join("");
}

export function jsonPost(post: Post): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    id: post.id,
    guid: post.guid,
    title: post.title,
    description: post.description,
    markdowntext: post.markdowntext,
    link: post.link,
    pubDate: post.pubDate,
    author: post.authorName ?? post.author,
    screenname: post.author,
    feedUrl: post.feedUrl,
    inReplyToNum: post.inReplyToNum,
    inReplyToUrl: post.inReplyToUrl,
    enclosureUrl: post.enclosureUrl,
    enclosureType: post.enclosureType,
    enclosureLength: post.enclosureLength,
  }).filter(([, value]) => value !== undefined));
}
