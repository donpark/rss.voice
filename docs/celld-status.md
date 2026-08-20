# celld status for rss.voice

## Summary

celld is a promising self-hosting runtime for rss.voice, but it is not yet a drop-in deployment target for the current application.

As of celld v0.3.0, the D1 and cron-trigger blockers are addressed: celld provides a D1-compatible interface and runs the Worker `scheduled` handler on its own alarms. The remaining platform gap is Cloudflare R2 application-media binding, which celld does not provide; media must use the separate S3-compatible path.

The shared WebSocket hibernation change should remain runtime-neutral and should not be blocked on celld. Production celld integration is deferred only until the repository's celld configuration is converted and validated against celld v0.3.0.

## Remaining blockers

The D1 and cron/scheduler blockers are resolved in celld v0.3.0. What still stands between the current application and a celld deployment:

| # | Blocker | Status | What is needed |
|---|---------|--------|----------------|
| 1 | R2 application-media binding | Real platform gap | celld does not provide R2 (declared `r2_buckets` bindings load but every method throws). Use the existing S3-compatible media path with a user-owned bucket. |
| 2 | celld config format | Repo work | `apps/server/celld/wrangler.toml` is TOML; celld needs a supported Wrangler JSON/JSONC subset with a `d1_databases` binding. Convert and validate before deploy. |
| 3 | Frontend/static assets + ingress | Packaging work | celld does not terminate TLS or manage custom domains, and the repo has a separate Astro frontend. Choose one strategy: bundle assets with the Worker, serve the frontend separately and proxy, or put Caddy/nginx in front. |
| 4 | Unvalidated DO/hibernation surface | Untested | celld documents the hibernation/DO surface as supported, but the full application has not been run against a real celld instance. Requires a compatibility deployment and end-to-end test before claiming support. |

None of these block at the storage or scheduler level anymore. The path to celld support is: convert the config, validate D1 + scheduled + S3-media on a celld instance, package the frontend behind an ingress, then test end to end.

## What celld provides

celld is a self-hosted Durable Objects runtime. It runs Worker bundles on user-controlled machines and uses an S3-compatible or Google Cloud Storage bucket for:

- deployments
- cell ownership and leases
- Durable Object SQLite replication
- fleet coordination

A native macOS ARM64 binary and Linux OCI image are available. Docker is optional for local development and deployment.

celld supports the relevant Durable Object Firehose surface:

- Durable Object bindings
- SQLite-backed Durable Object state
- inbound WebSockets
- hibernatable WebSockets
- `acceptWebSocket()`
- `getWebSockets()`
- `webSocketMessage()`
- `webSocketClose()`
- `webSocketError()`

The runtime's fleet bucket must support conditional writes and read-after-write consistency. R2 qualifies. Community MinIO and some other S3-compatible services do not meet celld's documented fencing requirements.

## What the current application assumes

The current rss.voice Worker uses:

```text
D1 DB binding              application metadata and posts
R2 MEDIA binding           uploaded media on Cloudflare
Durable Object FIREHOSE   live post events
scheduled handler         hourly orphan-media cleanup
```

The celld Wrangler project omits the R2 binding intentionally because celld's fleet bucket is infrastructure storage, not an application R2 binding. The application already has an S3-compatible media fallback, so media can remain in a separately configured user-owned S3/R2 bucket once the runtime itself is supported.

## Current compatibility blockers

### D1

As of celld v0.3.0, D1 is supported. A D1 database is a cell: it holds one SQLite database that celld replicates to the fleet bucket, so it gets the same fencing, replication, and durable write acknowledgement as a Durable Object.

`d1_databases` bindings provide the D1-compatible surface the app uses:

- `prepare()`, `bind()`, `all()`, `first()`, `run()`, `raw()`, `exec()`
- `batch()` and `withSession()`

The current app declares a `d1_databases` binding and relies on the `D1Database` API throughout `apps/server/src/index.ts`, using only `prepare().bind().all()/.run()/.first()` — all within the supported surface. A celld deployment can therefore provide the app's `env.DB` contract.

Known D1 differences on celld:

- `dump()` and Time Travel are not available.
- `wrangler d1` commands and the D1 REST API do not operate against celld; use `celld d1` (for example `celld d1 migrations apply`) instead.
- One database has one writer; scale with more databases, not a larger one.
- A query through a binding must hold its full result in memory; celld refuses results over 100,000 rows or 32 MiB.

### Cron triggers

celld v0.3.0 runs the Worker `scheduled` handler on its own alarms, one time for each occurrence in the whole fleet. The current hourly orphan-media cleanup (`scheduled` → `cleanupOrphanMedia`) can therefore run on celld.

Cleanup must still be made tenant-aware and safe to retry. A Durable Object alarm remains the most portable runtime-level option where a host-level scheduler is preferred.

### R2 binding

celld does not provide Cloudflare R2 bindings. Its fleet bucket is used by celld itself, and declared R2 bindings are not an application media backend.

The existing S3-compatible media path is suitable for celld:

```text
celld Worker → user-configured S3-compatible media bucket
```

Keep fleet storage and application media in separate buckets or prefixes. Never give the Worker celld's fleet-admin credentials.

### Configuration format

celld requires a supported Wrangler JSON/JSONC configuration subset. The current repository celld configuration is TOML (`apps/server/celld/wrangler.toml`) and includes D1/cron entries. This needs converting to the JSON/JSONC form celld accepts (for example a `d1_databases` binding in JSON) before a celld deploy.

### Static assets and ingress

celld can serve supported Worker static assets, but the current repository has a separate Astro frontend. A production celld package will need one explicit frontend strategy:

- bundle Astro assets with the Worker
- serve the frontend through a separate static service and proxy API/WebSocket traffic
- use Caddy or another ingress proxy in front of celld

celld does not terminate public TLS or provide custom-domain management. Self-hosted deployments need an ingress proxy such as Caddy, nginx, or a cloud load balancer.

## WebSocket hibernation status

The shared `Firehose` now uses the Durable Object hibernation API rather than an application-owned socket set:

```ts
state.acceptWebSocket(server)
state.getWebSockets()
```

Cloudflare local integration coverage verifies connection and broadcast delivery.

A temporary Firehose-only celld probe was also run during investigation, but it was deliberately removed from the repository. Production celld compatibility remains deferred until the full application is validated against celld's supported D1, scheduled-handler, and S3-media surfaces.

Do not add celld-specific behavior to the shared Firehose merely to compensate for the current application-level blockers.

## Hosting implications

### Managed Cloudflare

This remains the most complete deployment target today:

- D1 is available
- Durable Objects are available
- R2 binding is available
- cron triggers are available
- static assets can be co-deployed

### Independent Cloudflare instance

The independent user-owned Cloudflare path also remains viable, subject to the temporary-account R2 staging and post-claim migration plan.

### celld self-hosted instance

Treat celld as a later self-hosting target:

```text
user VM or Droplet
  → celld runtime
  → R2 fleet bucket
  → user S3/R2 media bucket
  → Caddy or equivalent TLS ingress
```

It is not currently equivalent to a Cloudflare Worker deployment.

## Recommended order of work

1. Keep the shared Firehose hibernation fix provider-neutral.
2. Finish Cloudflare managed and independent deployment paths.
3. Convert the celld Wrangler configuration to the JSON/JSONC form celld accepts, with a d1_databases binding.
4. Validate the D1-backed storage and scheduled handler against celld's supported surface.
5. Package the Astro frontend and celld runtime behind a TLS ingress.
6. Create a temporary celld compatibility deployment using R2 fleet storage.
7. Test text posts, RSS, OPML, media, range reads, cleanup, and Firehose behavior.
8. Only then advertise celld as a supported self-hosting runtime.

## Decision

celld hosting is a supported goal to reach when it is ready, not a prerequisite for the current release. Keep the hibernation API implementation in the shared Worker code, and validate celld compatibility now that the D1 and scheduler gaps are addressed in celld v0.3.0.
