# rss.voice server

The server is a protocol implementation that runs as a Cloudflare Worker or as a celld Worker project. It does not share code with the reference rss.chat implementation.

## Local Worker development

```sh
npm install
npx wrangler d1 migrations apply rss-voice --local --config apps/server/wrangler.toml
npx wrangler dev --local --config apps/server/wrangler.toml
```

The current slice exposes `/health`, recent-item JSON, RSS feeds, the OPML roster, local-development magic links, and authenticated text-post creation. In production set `MAIL_WEBHOOK_URL` to an email service endpoint accepting `{to, screenname, operation, link}`; local requests return a development link directly.

## Cloudflare

Create the D1 database and R2 media bucket, replace `database_id`, `BASE_URL`, and `WEB_URL` in `wrangler.toml`, then apply migrations and deploy:

```sh
npx wrangler d1 create rss-voice
npx wrangler r2 bucket create rss-voice-media
npx wrangler d1 migrations apply rss-voice --remote --config apps/server/wrangler.toml
npx wrangler deploy --config apps/server/wrangler.toml
```

## celld

The `celld/` Wrangler project deliberately omits the Cloudflare R2 binding. celld's fleet bucket is infrastructure storage; application media will use a separate S3-compatible object-store adapter in the media slice.

```sh
celld deploy apps/server/celld \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"
```
