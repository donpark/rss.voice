# rss.chat local fixture

This is a small snapshot of the public rss.chat roster and recent aggregate feed,
used as seed data for local end-to-end tests. It is not application state or a
mirror of private data.

Regenerate it from the reference implementation:

```sh
python3 scripts/fetch-rss-chat-fixture.py
```

Reset and populate the local database in one step:

```sh
bash scripts/reset-local-e2e-data.sh
```

This applies migrations, clears local users/posts/likes/media/rate limits, and
loads the fixture. To load without clearing existing data:

```sh
npx wrangler d1 execute rss-voice --local --file fixtures/rss-chat/seed.sql \
  --config apps/server/wrangler.toml
```

The Worker then serves the compatibility resources at:

- `/data/subs.opml`
- `/users/rss.xml`
- `/users/<username>/rss.xml`
