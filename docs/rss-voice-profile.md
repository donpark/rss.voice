# rss.voice profile (informal)

**Status:** working profile of the rss.chat protocol.

`rss.voice` adds no new post type and no new transport. A **voice post is an ordinary rss.chat post carrying one audio enclosure**. The profile defines product defaults and interoperability guidance around that enclosure.

## 1. Relationship to rss.chat

Every rss.voice post is an rss.chat post. It keeps the ordinary RSS item identity, author, text, title, link, reply relationship, edit behavior, feed placement, API item record, and firehose behavior.

A client that does not understand the profile should still see a normal RSS item and its standard enclosure. A client that does understand the profile can provide recording and audio playback UI.

## 2. Voice-post representation

The portable representation is the standard RSS enclosure:

```xml
<item>
  <title>Optional title</title>
  <description>Optional text body.</description>
  <guid isPermaLink="true">https://example.test/?id=123</guid>
  <pubDate>Tue, 04 Aug 2026 12:00:00 GMT</pubDate>
  <enclosure
    url="https://example.test/media/456"
    length="1960000"
    type="audio/mpeg" />
  <itunes:duration>240</itunes:duration>
</item>
```

The enclosing RSS document declares the iTunes namespace when it uses the extension:

```xml
xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
```

The enclosure has the standard three pieces of metadata:

- `url` — public address of the audio bytes;
- `length` — byte length of the audio object;
- `type` — precise MIME type for the encoded media.

The audio bytes are the source of truth for duration. `<itunes:duration>` is recommended producer metadata, expressed as whole seconds, but it is optional for validity. Consumers must not require it; they may use it as a display or preload hint and may obtain duration by partially loading the audio through the HTML audio element.

Text and title are both optional. Transcription, when implemented, primarily populates the ordinary post text field. It is not a separate protocol field and is not required for consuming a voice post.

## 3. Recording and media policy

### Duration

The maximum voice recording duration is configurable. The default is **240 seconds**.

The client should stop recording at the configured duration. The server or media pipeline should treat the duration of the encoded audio itself as authoritative when it can validate it; submitted `<itunes:duration>` must not be trusted as the enforcement source.

The duration limit is a product policy, not a new RSS item field. A non-browser client may create an audio enclosure directly, but a conforming rss.voice deployment should apply its configured duration policy to accepted voice recordings.

### Size

rss.voice inherits rss.chat's existing media-upload settings. The current default is **2 MiB** per media upload. This remains configurable and is a recommended default/sizing target, not a hard rss.voice conformance ceiling.

Duration is the primary user-facing limit. Deployments may configure enough byte headroom for normal 240-second recordings; clients should encode efficiently rather than make users reason about bytes. Image and other-media policy remains server policy even if an implementation shares one upload setting across media types.

### Audio formats

The intended configurable format set is:

- MP3;
- AAC, preferred when the platform supports it;
- Opus as an alternate format.

The profile does not yet freeze exact container/MIME pairs for AAC and Opus. A producer must publish the actual precise MIME type in the enclosure, and the rewrite should document each tested encoder/container/player combination before declaring it interoperable. The current reference voice implementation produces `audio/mpeg`.

## 4. Client behavior

A voice-capable client may provide:

- microphone capture;
- a duration timer and stop/cancel controls;
- local transcription into the ordinary text field;
- encoding and upload before publishing;
- an audio player for enclosure items.

These are implementation features. The protocol does not require a particular recording UI, speech-recognition engine, JavaScript library, or storage platform.

A consumer may support only a subset of audio formats. When it encounters a valid unsupported audio enclosure, it should preserve and expose the post rather than treat the RSS item as malformed.

## 5. API and realtime behavior

A voice post uses the existing rss.chat API fields:

```json
{
  "description": "Optional text or generated transcript.",
  "enclosureUrl": "https://example.test/media/456",
  "enclosureType": "audio/mpeg",
  "enclosureLength": 1960000
}
```

Creation, editing, deletion, replies, feed publication, and firehose delivery remain ordinary rss.chat operations. No voice-specific endpoint or item discriminator is required.

## 6. Conformance guidance

### Producer

A voice-capable producer should:

1. publish an ordinary rss.chat post;
2. attach at most one audio enclosure;
3. publish accurate enclosure URL, MIME type, and byte length;
4. include `<itunes:duration>` as whole-second metadata when available;
5. enforce the configured maximum duration using the encoded audio;
6. remain within the deployment's configured media policy.

Missing duration metadata does not invalidate an otherwise valid voice post.

### Consumer

A voice-capable consumer should:

1. recognize an audio enclosure through its MIME type;
2. render the ordinary post text/title/reply information;
3. offer playback when the format is supported;
4. use `<itunes:duration>` as a hint when present;
5. tolerate missing or inaccurate duration metadata;
6. preserve posts whose audio format it cannot play.

## 7. Open questions

- Which exact MIME/container pairs should be standardized for AAC and Opus after encoder and browser testing?
- How should a server validate duration for each supported encoding, and what should it do when it cannot inspect a format?
- Should server metadata eventually advertise preferred/accepted audio formats and effective duration/media limits? The first rewrite should avoid a new capability API unless interoperability requires it.
- Should a future profile define transcript provenance or accessibility metadata? It is intentionally outside v1.
