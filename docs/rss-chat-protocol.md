# rss.chat protocol (informal)

**Status:** working informal specification for the rewrite milestone.

This document separates three kinds of statements:

- **Observed** — behavior documented or implemented by the rss.chat reference server/client.
- **Proposed** — the contract the rewrite should preserve or make explicit.
- **Open** — questions that need more evidence or a deliberate later decision.

The protocol is a network of ordinary web resources and small interfaces, not only the shipped browser UI.

## 1. Core model

### Server and chatroom

**Proposed:** One rss.chat server exposes one default chatroom/community. The first protocol version does not define multiple named rooms.

**Observed:** The reference server publishes one server-wide subscription list, one everyone aggregate feed, and personal feeds for its users.

### Members and feeds

**Proposed:** A member is represented by a personal RSS feed listed in the chatroom subscription list. A member's personal feed is the canonical home of that member's posts and replies. Aggregate feeds and client timelines are derived views.

**Observed:** Every reference-server user has a feed at a predictable `users/<screenname>/rss.xml` address, and the server's OPML list contains one entry per user. The server-wide aggregate is available at `users/rss.xml`.

The feed URL, not the display name, is the stable identity of a member. Display names, feed titles, descriptions, avatars, and links may change.

### Posts and replies

A post is an RSS item in its author's personal feed. A post may contain:

- optional `title`;
- HTML body in `description`;
- original Markdown through `source:markdown` / the API's `markdowntext` representation;
- optional `link`;
- optional RSS enclosure;
- publication time;
- stable `guid` permalink;
- optional parent-post reference when it is a reply.

A reply remains a post in the replier's personal feed. It identifies its parent through the reference-server item/API fields (`inReplyToNum`, `inReplyToUrl`) and through the feed-level reply conventions, including `source:comments`.

**Proposed:** The wire contract defines parentage and ways to retrieve replies, not a required visual layout. A client may show a threaded tree, a two-level conversation view, or another faithful presentation.

## 2. Published representations

### RSS feeds

RSS 2.0 is the primary portable representation. A personal feed contains the author's recent items. An aggregate feed contains recent items from multiple members. The reference server limits the number of recent items according to server configuration.

A feed item uses its `guid` as its stable identity and permalink. `description` is renderable HTML. Where present, `source:markdown` preserves authoring input. The source namespace also carries attribution and reply-feed information used by interoperable clients.

The RSS representation should preserve the item's enclosure as standard `<enclosure url="..." length="..." type="..." />` metadata. `length` is a byte count, not a duration.

### OPML subscription list

**Proposed:** The server's OPML subscription list is the authoritative roster for its default chatroom. Adding or removing a feed changes the roster; posting does not implicitly add membership. A removed member's existing personal feed and history remain addressable, but future aggregate inclusion follows the roster.

**Observed:** The reference server exposes `/data/subs.opml` and `/getsubscriptionlist`, each listing one feed per server user. Explicit external management of OPML membership is not defined by the current API.

### Source and Textcasting conventions

The reference implementation uses conventions from the `source` namespace and Textcasting:

- `source:comments` identifies a feed of replies;
- `source:account` identifies the publishing account;
- `source:markdown` carries original Markdown alongside rendered HTML;
- titles are optional;
- links, simple styling, enclosures, long text, and editing are supported.

These conventions are part of the interoperability surface when present, but a consumer should remain tolerant of ordinary RSS consumers that ignore extension elements.

## 3. HTTP interface

The reference HTTP interface uses query parameters for both reads and writes. Reads are unauthenticated. Writes require the passwordless email credential pair (`emailaddress` and `emailcode`). Successful responses are JSON, except that RSS and OPML resources are returned as JSON-encoded strings by API endpoints. Reference errors use status `503` and a plain explanatory sentence.

### Read operations

The observed read surface includes:

- recent aggregate items: `/getrecentitems?ct=N`;
- recent personal items: `/getrecentuseritems?name=X`;
- one item by permalink: `/getitembyguid?guid=X`;
- direct replies: `/getitemandreplies?idparent=N`;
- full descendant thread: `/getthread?guid=X` or `id=N`;
- feed-form item representation: `/getiteminfo?guid=X&format=rss`;
- server/user metadata: `/getuserdata?screenname=X`;
- likers: `/getlikerslist?id=N`;
- activity: `/getmostactivetoday`;
- OPML roster: `/getsubscriptionlist`;
- user/email existence checks;
- personal feed: `/feed?screenname=X&format=xml|json`.

The static feed and OPML URLs are the portable resources. API endpoints are convenience and write/read surfaces for clients that want JSON or server-side thread assembly.

### Write operations

Authenticated writes include:

- `/newpost?jsontext=X`;
- `/updatepost?jsontext=X`;
- `/deletepost?id=N`;
- `/togglelike?id=N`;
- `/saveprefs?jsontext=X`;
- `/uploadmedia?type=T`.

`/newpost` and `/updatepost` accept ordinary post fields, including `markdowntext`, `description`, `title`, `inReplyTo`, and enclosure fields. Media upload returns a permanent public URL that can be placed in a post.

The passwordless identity flow sends a confirmation email and returns a credential through the redirect. The protocol does not require passwords.

### Item record

The JSON item record observed in the reference API includes:

- `id`, `guid`, `pubDate`;
- `title`, `link`, `description`, `markdowntext`;
- `author`, `screenname`, `feedUrl`, `feedLink`, `feedDescription`, `imageUrl`;
- `inReplyToNum`, `inReplyToUrl`, `inReplyToAuthor` for replies;
- `ctReplies`, `ctLikes`, and viewer-specific `flLiked`;
- `enclosureUrl`, `enclosureType`, `enclosureLength`;
- `whenCreated`, `whenUpdated`.

Fields without values may be omitted. A rewrite should preserve stable identifiers and the distinction between author identity, display metadata, and viewer-specific fields.

## 4. Realtime interface

**Observed:** The firehose is a WebSocket at the server-configured address. It sends text frames in this form:

```text
verb\rJSON-payload
```

The observed verbs are:

- `newItem` — a post or reply was published;
- `updatedItem` — an item changed, including edits or like-count changes.

The payload contains the same item record exposed by the HTTP API. Listeners should parse defensively, tolerate duplicate notifications, and reconnect after disconnection. Clients do not send a greeting or application message.

**Proposed:** The rewrite should preserve this as an open optional realtime interface. Polling RSS/API resources remains valid and authoritative; the firehose is a notification and freshness mechanism.

## 5. Cross-feed notifications

**Observed:** Reference feeds can include an `rssCloud` notification target. rssCloud is intended to notify subscribers when a feed changes, across server boundaries. It is distinct from the server-local WebSocket firehose.

**Proposed:** Treat rssCloud as an optional feed-notification integration, not a prerequisite for reading or publishing rss.chat posts.

## 6. Conformance posture

A compatible implementation should, at minimum, make personal feeds and stable item permalinks readable as RSS 2.0, preserve post identity and reply relationships, and expose enough item data for another client to render the post. The HTTP API and firehose are additional interoperability surfaces.

The following are intentionally not required to be identical across clients:

- timeline layout;
- thread layout;
- local caching;
- use of the browser API wrapper;
- storage engine and deployment platform.

## 7. Open questions

- Which membership-management operations, if any, should be added beyond the reference server's generated all-users OPML list?
- Which source-namespace elements are required for a minimal independent implementation versus merely recommended?
- Which HTTP endpoint names and error/status behaviors should be preserved exactly in the rewrite, versus treated as reference-server compatibility only?
- What exact RSS and feed-reader behavior should editing and deletion guarantee across caches?
- Which exact MIME/container combinations should be specified for AAC and Opus in the rss.voice profile?
