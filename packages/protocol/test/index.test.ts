import test from "node:test";
import assert from "node:assert/strict";
import { buildOpml, buildRssFeed, jsonPost, type Post } from "../src/index.ts";

const post: Post = {
  id: 7,
  author: "ada",
  authorName: "Ada & Co",
  feedUrl: "https://example.test/users/ada/rss.xml",
  guid: "https://example.test/?id=7",
  description: "<p>Hello &amp; welcome.</p>",
  markdowntext: "Hello & welcome.",
  pubDate: "2026-08-10T12:00:00.000Z",
  enclosureUrl: "https://media.example.test/7",
  enclosureType: "audio/mpeg",
  enclosureLength: 42,
};

test("builds an RSS voice post with a standard enclosure", () => {
  const xml = buildRssFeed({
    title: "Example",
    link: "https://example.test/",
    description: "A feed",
    selfUrl: "https://example.test/users/ada/rss.xml",
    items: [post],
  });

  assert.match(xml, /<enclosure url="https:\/\/media\.example\.test\/7" length="42" type="audio\/mpeg" \/>/);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/example\.test\/\?id=7<\/guid>/);
  assert.match(xml, /<!\[CDATA\[<p>Hello &amp; welcome\.<\/p>\]\]>/);
});

test("omits an enclosure when byte length is unknown", () => {
  const xml = buildRssFeed({
    title: "Example",
    link: "https://example.test/",
    description: "A feed",
    selfUrl: "https://example.test/users/ada/rss.xml",
    items: [{...post, enclosureLength: undefined}],
  });

  assert.doesNotMatch(xml, /<enclosure /);
});

test("builds an OPML roster", () => {
  const opml = buildOpml("Example members", [{
    screenname: "ada",
    feedUrl: post.feedUrl,
  }]);

  assert.match(opml, /type="rss" text="ada"/);
  assert.match(opml, /xmlUrl="https:\/\/example\.test\/users\/ada\/rss\.xml"/);
});

test("omits empty item fields from API records", () => {
  assert.deepEqual(jsonPost({...post, title: undefined}), {
    id: 7,
    guid: "https://example.test/?id=7",
    description: "<p>Hello &amp; welcome.</p>",
    markdowntext: "Hello & welcome.",
    pubDate: "2026-08-10T12:00:00.000Z",
    author: "Ada & Co",
    screenname: "ada",
    feedUrl: "https://example.test/users/ada/rss.xml",
    enclosureUrl: "https://media.example.test/7",
    enclosureType: "audio/mpeg",
    enclosureLength: 42,
  });
});
