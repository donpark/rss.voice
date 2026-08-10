#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
config=apps/server/wrangler.toml

echo "Applying local migrations..."
npx wrangler d1 migrations apply rss-voice --local --config "$config"

echo "Resetting local E2E data..."
npx wrangler d1 execute rss-voice --local --config "$config" --command \
  "DELETE FROM likes; DELETE FROM posts; DELETE FROM media; DELETE FROM rate_limits; DELETE FROM users;"

echo "Loading rss.chat fixture..."
npx wrangler d1 execute rss-voice --local --config "$config" \
  --file fixtures/rss-chat/seed.sql

echo "Local E2E data is ready."
