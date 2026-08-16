# rss.chat and rss.voice

This context describes the open feed-based social network and the voice-post profile being specified for its rewrite.

## Protocol concepts

**rss.chat**:
The base feed-based social network protocol: people publish posts in personal RSS feeds, servers provide aggregate views and open interfaces, and clients can read or write through standard web protocols.
_Avoid_: RSS chat as only the browser UI.

**rss.voice**:
The voice-post profile of rss.chat. It adds no new post type; it defines how an ordinary rss.chat post carries an audio enclosure and related duration metadata.
_Avoid_: voice message as a separate protocol object.

**Server**:
A deployment of rss.chat that hosts accounts, personal feeds, aggregate views, and the HTTP and realtime interfaces for its community.
_Avoid_: instance when the deployment itself is meant.

**Chatroom**:
The default community represented by one rss.chat server's membership list and aggregate feed. Multi-room behavior is outside the first protocol milestone.
_Avoid_: timeline, unless referring specifically to a client presentation.

**Member**:
A person represented by a feed in a chatroom's subscription list.
_Avoid_: subscriber when describing community membership.

**Personal feed**:
The RSS feed that canonically contains a member's posts and replies.
_Avoid_: user feed when precision about ownership matters.

**Aggregate feed**:
An RSS feed derived from posts by multiple members, such as a server's everyone feed.
_Avoid_: room feed when the source is not specifically the chatroom aggregate.

**Post**:
An RSS item published by a member. A post may have text, a title, links, an enclosure, and a reply relationship.
_Avoid_: message when discussing the protocol object.

**Reply**:
A post that identifies another post as its parent.
_Avoid_: comment when describing the rss.chat relationship.

**Voice post**:
An ordinary rss.chat post carrying an audio enclosure.
_Avoid_: voice message as a separate item type.

**Enclosure**:
The standard RSS attachment metadata—URL, byte length, and MIME type—associated with a post's media.
_Avoid_: attachment when the RSS representation is the subject.

**Firehose**:
The server's unauthenticated WebSocket stream of post creation and update events.
_Avoid_: event bus when describing the public protocol.

**Subscription list**:
An OPML document listing member feed subscriptions and representing the server's default chatroom roster.
_Avoid_: room database.
