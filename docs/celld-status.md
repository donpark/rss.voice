# celld status for rss.voice

## Summary

celld is a promising self-hosting runtime for rss.voice, but it is not yet a drop-in deployment target for the current application.

The current application assumes Cloudflare platform services that celld 0.2.1 does not currently accept in the deployment configuration:

- D1 binding
- cron trigger
- Cloudflare R2 application-media binding

The shared WebSocket hibernation change should remain runtime-neutral and should not be blocked on celld. Defer production celld integration until the storage and scheduler gaps are designed and implemented.

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

celld 0.2.1 describes D1 as planned. The current app declares a `d1_databases` binding and relies on the `D1Database` API throughout `apps/server/src/index.ts`.

A celld deployment therefore cannot currently provide the app's `env.DB` contract.

The likely implementation choices are:

1. Replace the D1 binding with a tenant database Durable Object using SQLite storage.
2. Add a database service Durable Object and preserve a narrow application repository interface.
3. Add D1 compatibility to celld before porting rss.voice.

The first option is the most aligned with celld's architecture, but it changes query routing and transaction boundaries. It should be designed separately from the Firehose work.

### Cron triggers

celld does not support Cloudflare cron triggers or the Worker's `scheduled` handler. The current hourly orphan-media cleanup cannot run unchanged.

Alternatives:

- use a Durable Object alarm
- run a host-level systemd timer
- run an external scheduler that calls an authenticated maintenance endpoint

A Durable Object alarm is the most portable runtime-level option. Cleanup must still be made tenant-aware and safe to retry.

### R2 binding

celld does not provide Cloudflare R2 bindings. Its fleet bucket is used by celld itself, and declared R2 bindings are not an application media backend.

The existing S3-compatible media path is suitable for celld:

```text
celld Worker → user-configured S3-compatible media bucket
```

Keep fleet storage and application media in separate buckets or prefixes. Never give the Worker celld's fleet-admin credentials.

### Configuration format

celld 0.2.1 requires a supported Wrangler JSON/JSONC configuration subset. The current repository celld configuration is TOML and includes unsupported D1/cron entries.

Converting the file format alone does not make the full application deployable. The binding and scheduler gaps must be resolved first.

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

A temporary Firehose-only celld probe was also run during investigation, but it was deliberately removed from the repository. Production celld compatibility remains deferred until the full application has a supported database and scheduler design.

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
3. Define the database repository boundary in the application.
4. Prototype a tenant database Durable Object using SQLite storage.
5. Replace scheduled cleanup with a retry-safe alarm or host scheduler.
6. Package the Astro frontend and celld runtime behind a TLS ingress.
7. Create a temporary celld compatibility deployment using R2 fleet storage.
8. Test text posts, RSS, OPML, media, range reads, cleanup, and Firehose behavior.
9. Only then advertise celld as a supported self-hosting runtime.

## Decision

Do not make celld a prerequisite for the current release. Keep the hibernation API implementation in the shared Worker code, defer celld-specific testing and storage work, and revisit celld after the D1 and scheduler designs are settled.
