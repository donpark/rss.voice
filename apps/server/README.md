# rss.voice server

The server is a protocol implementation that runs as a Cloudflare Worker or as a celld Worker project. It does not share code with the reference rss.chat implementation.

## Local Worker development

```sh
npm install
npx wrangler d1 migrations apply rss-voice --local --config apps/server/wrangler.toml
npx wrangler dev --local --config apps/server/wrangler.toml
```

Copy `.dev.vars.example` to `.dev.vars` when testing mail or S3-compatible media locally. `.dev.vars` is ignored by git. Run the integration smoke test against a local Worker with:

```sh
TEST_SERVER_URL=http://127.0.0.1:8787 npm --workspace @rss-voice/server run test:integration
```

The current slice exposes `/health`, recent-item JSON, RSS feeds, the OPML roster, local-development magic links, authenticated text and voice-post creation, direct and recursive replies (`/getitemandreplies`, `/getthread`), editing, deletion, likes, media upload/download/delete, and the `/firehose` WebSocket. In production set `MAIL_WEBHOOK_URL` to an email service endpoint accepting `{to, screenname, operation, link}`; local requests return a development link directly.

For local end-to-end data matching the public reference server, see `fixtures/rss-chat/README.md`. The fixture generator downloads `/data/subs.opml` and `/users/rss.xml`, then writes an idempotent D1 seed file. The Worker serves the compatible `/data/subs.opml`, `/users/rss.xml`, and `/users/<username>/rss.xml` resources from that data.

## Cloudflare

Create the D1 database and R2 media bucket, replace `database_id`, `BASE_URL`, and `WEB_URL` in `wrangler.toml`, then apply migrations and deploy:

```sh
npx wrangler d1 create rss-voice
npx wrangler r2 bucket create rss-voice-media
npx wrangler d1 migrations apply rss-voice --remote --config apps/server/wrangler.toml
npx wrangler deploy --config apps/server/wrangler.toml
```

## celld

The `celld/` Wrangler project deliberately omits the Cloudflare R2 binding. celld's fleet bucket is infrastructure storage; application media uses a separate S3-compatible bucket. Configure these Worker variables/secrets for that bucket:

- `MEDIA_S3_ENDPOINT`
- `MEDIA_S3_BUCKET`
- `MEDIA_S3_REGION` (optional; defaults to `auto`)
- `MEDIA_S3_ACCESS_KEY_ID`
- `MEDIA_S3_SECRET_ACCESS_KEY`

The default upload limit is 2 MiB (`MAX_MEDIA_UPLOAD_BYTES`) and supports audio and image MIME types. Uploaded objects are tenant-prefixed and served through `/media/<id>`, including byte ranges and `HEAD` requests. Magic-link requests and confirmations are rate-limited to 5 per 15 minutes by default (`AUTH_RATE_LIMIT`). Authenticated writes are limited to 60 per 15 minutes by default (`WRITE_RATE_LIMIT`). An hourly scheduled cleanup removes unreferenced media older than 24 hours; configure the grace period with `MEDIA_ORPHAN_GRACE_HOURS`.

```sh
celld deploy apps/server/celld \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"
```
