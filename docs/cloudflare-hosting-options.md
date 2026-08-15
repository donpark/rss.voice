# rss.voice hosting options

## Executive summary

rss.voice can support two complementary deployment products:

1. **Managed instance** — hosted by WizOps under a shared, multi-tenant deployment.
2. **Independent instance** — deployed into a user's claimed Cloudflare account and backed by the user's R2 bucket.

These should be treated as two hosting modes built on the same application and provisioning code.

```text
Managed:
  user → WizOps-hosted rss.voice tenant

Independent:
  user → temporary preview
       → Cloudflare claim
       → user-owned Worker/D1/Durable Object/R2
```

Keep both A1 and A3. Drop the permanent provisioner-owned R2-prefix model (A2) as a primary product: it has the operational complexity of independent hosting without giving the user independent ownership.

## Product modes

### Managed instance: A3

WizOps hosts the tenant under its own Cloudflare account and infrastructure.

```text
WizOps account
├── shared Worker
├── shared D1 or tenant-partitioned database
├── Durable Object namespace
└── tenant-prefixed R2 media storage
```

The user receives a ready-to-use rss.voice URL. WizOps owns upgrades, backups, storage, abuse handling, and operational support.

This should be the default path because it has the shortest onboarding flow and avoids Cloudflare account authorization and resource migration.

### Independent instance: A1

The user receives a separate Cloudflare account deployment.

```text
temporary account
├── Worker
├── D1
├── Durable Object
└── Astro static assets

media during preview:
  tenant-locked WizOps S3-compatible staging storage

after claim:
  user-owned R2 bucket
```

The user can claim the account, authorize WizOps to complete setup, and receive a deployment that no longer depends on WizOps media infrastructure.

This should be presented as an advanced “own your instance” option. It may be free, paid once, or included in a higher-tier offering.

## Common application architecture

Both modes should use the same application-level interfaces:

- Worker API
- D1 schema and migrations
- Durable Object firehose
- Astro frontend
- media storage abstraction
- scheduled orphan-media cleanup
- tenant-aware object keys
- deployment health checks

The storage abstraction already supports both R2 and S3-compatible storage:

```text
MEDIA binding       → R2
MEDIA_S3_* settings → S3-compatible provider
```

The deployment target, not application code, selects the backend.

## Managed mode design

### Tenant isolation

A managed deployment needs explicit isolation even though tenants share infrastructure.

Use tenant-specific identifiers in every data and media operation:

```text
D1 rows:
  tenant_id

R2 keys:
  tenants/{tenant-id}/media/{media-id}

Durable Object name:
  tenant-id
```

Every query and storage operation must carry the tenant ID. Do not rely only on URL routing or frontend-provided identifiers.

### Media

Managed tenants can use WizOps-owned R2 directly:

```text
managed Worker → WizOps R2 prefix
```

R2 is the correct long-term media store for managed hosting because it supports native range requests, has low storage pricing, and has no Internet egress charge.

### Deployment model

The simplest managed model is one shared Worker with tenant routing. A separate Worker per tenant is unnecessary unless isolation, custom domains, or deployment independence requires it.

Benefits of one shared Worker:

- fewer deployments
- one application version
- shared observability
- shared D1 and DO infrastructure
- no per-tenant account provisioning

The tradeoff is that managed mode becomes a multi-tenant service and must have strong authorization and resource limits.

## Independent mode design

### Preview provisioning

1. User selects independent hosting.
2. WizOps provisions a temporary Cloudflare account through the temporary-account REST API.
3. WizOps deploys the Worker, D1, Durable Object, and static assets.
4. The Worker uses a tenant-locked S3-compatible staging provider for media.
5. The user is redirected to the live preview.

Temporary media objects use a candidate-specific prefix:

```text
candidates/{candidate-id}/media/{tenant-id}/{media-id}
```

The staging credential must be:

- candidate-specific
- prefix-restricted
- short-lived
- revocable
- unavailable to the browser

### Claim and migration

1. User clicks **Claim**.
2. User completes Cloudflare's claim flow.
3. User returns to WizOps.
4. User authorizes WizOps through Cloudflare OAuth.
5. WizOps creates an R2 bucket in the claimed account.
6. WizOps copies staged media into that bucket.
7. WizOps verifies object sizes, MIME types, full reads, and range reads.
8. WizOps deploys a new Worker version with an R2 binding.
9. WizOps revokes staging credentials and deletes staged media.

Claiming does not itself authorize WizOps to create R2 or redeploy the Worker. The post-claim OAuth step is required.

### URL stability

Keep public media URLs as Worker routes:

```text
/media/{id}
```

D1 retains media metadata and object keys. The Worker changes its backend from S3 staging to R2 without changing RSS enclosure URLs.

### Cutover

Pause media uploads during the migration. A short media-only freeze is simpler and safer than dual-write.

If migration fails:

- keep staging storage active
- keep the staging credential valid
- leave the old Worker deployed
- retry migration

Revoke staging access only after the R2-backed Worker passes verification.

## Durable Object cost and architecture

### Billing model

Durable Object cost is not limited to horizontal fanout.

Cloudflare bills:

- requests
- active compute duration
- storage

Paid-plan pricing currently includes:

- 1 million DO requests/month
- 400,000 GB-s/month
- additional requests at $0.15/million
- additional duration at $12.50/million GB-s

Each active Durable Object is billed as if allocated 128 MB, even if multiple objects share a physical isolate.

### One object with many readers

A single tenant firehose with many connected clients generally uses one active Durable Object allocation. More messages create more request billing, but duration is not multiplied by the number of connected clients.

### Many tenant objects

A managed deployment with one firehose object per tenant adds duration across active tenants:

```text
100 active tenant objects
  → approximately 100 × 128 MB of active allocation
```

Inactive objects eligible for hibernation do not incur duration charges. Therefore total registered tenants are not the key cost metric; simultaneously active tenants and message activity are.

### Implementation status

The shared `Firehose` implementation now uses the Durable Object WebSocket Hibernation API:

```ts
state.acceptWebSocket(server);
```

Broadcasts enumerate the runtime-managed socket set with `state.getWebSockets()`. This removes the application-owned socket set and allows idle connections to hibernate.

Cloudflare local integration tests cover connection, broadcast, and post delivery. Celld compatibility testing is deferred. The full rss.voice application still requires D1 and scheduler work before it can deploy to celld.

### Hibernation impact

With hibernation:

- idle connections can remain open without continuous JavaScript execution
- the object wakes for incoming events
- duration cost tracks active handler execution more closely
- many low-traffic tenants become substantially cheaper

This benefits both Cloudflare-hosted and celld-hosted deployments, provided celld supports the required hibernation APIs.

## Celld hosting considerations

Celld already uses the S3-compatible media path and does not depend on an R2 binding:

```text
celld Worker → configured S3-compatible application-media bucket
```

The current celld configuration intentionally omits R2 because celld provides its own compatible storage primitives. Application media should continue using the separately configured S3-compatible bucket, not celld's fleet bucket.

### What should remain shared

- media storage interface
- tenant-prefixed object keys
- media metadata in D1-compatible storage
- range-request behavior
- orphan cleanup
- upload limits
- authorization rules

### Celld issue to investigate

The main open question is Durable Object hibernation compatibility. Verify that celld supports:

- hibernatable WebSockets
- `acceptWebSocket()` or equivalent
- hibernation event handlers
- WebSocket tags and connection management
- Durable Object wake-up after hibernation
- compatible alarm and migration behavior

If celld does not support hibernation, the current firehose implementation may remain continuously active for connected clients. In that case, either:

- implement a celld-specific firehose strategy
- make live WebSocket updates optional
- default readers to RSS polling
- keep WebSockets for a smaller set of active clients

Do not assume Cloudflare Durable Object hibernation behavior is fully portable to celld without a compatibility test.

## Reader traffic and the firehose

The current Astro frontend opens `/firehose` for live updates. Therefore current browser readers do create WebSocket connections.

An alternative is:

```text
reader → CDN-cached RSS → Worker/D1 on cache miss
```

RSS generation currently reads D1, not R2. R2 is used for media only.

A hybrid model is preferable:

- RSS/CDN for default reader traffic
- optional WebSocket live mode
- WebSocket primarily for users who want immediate updates

This reduces Durable Object connection pressure in both managed Cloudflare hosting and celld hosting.

## Option comparison

| Concern | A1: independent | A3: managed |
|---|---|---|
| User owns Cloudflare account | Yes | No |
| User owns R2 after setup | Yes | No |
| Onboarding complexity | Higher | Low |
| Media during preview | Provisioner S3 staging | WizOps R2 |
| Media after setup | User R2 | WizOps R2 |
| Migration required | Yes | No |
| Multi-tenant isolation required | Limited per instance | Critical |
| Cloudflare OAuth required | Yes | No |
| Ongoing WizOps dependency | Minimal after migration | Full |
| Operational simplicity | Lower | Higher |
| Best product position | Own your instance | Managed hosting |

## Why not A2

A2 uses permanent WizOps R2 prefixes for user instances:

```text
claimed Worker → WizOps R2 prefix
```

It is operationally simpler than A1 but has an awkward product position:

- the Worker may be user-owned
- storage remains WizOps-owned
- WizOps pays and operates the media layer indefinitely
- the user does not receive a fully independent instance
- multi-tenant storage isolation is still required

A2 is acceptable as an internal fallback or migration failure mode, but should not be the primary product mode if the product promises ownership.

## Recommended product packaging

### Managed

Default option:

- instant launch
- WizOps-operated hosting
- no Cloudflare account required
- no migration
- optional subscription or usage pricing

### Independent

Advanced option:

- temporary preview
- user claims Cloudflare account
- one-time setup fee or premium tier
- user-owned R2 after migration
- user responsible for their Cloudflare account and ongoing usage

The UI should explain the distinction clearly:

```text
Managed:
  “We host and maintain it for you.”

Independent:
  “You own the Cloudflare account and storage.”
```

## Implementation order

1. Add conformance tests for Cloudflare and celld Durable Object behavior.
2. Make live WebSocket updates optional; support RSS/CDN-first readers.
3. Formalize the media storage interface and backend selection.
4. Build managed multi-tenant hosting with tenant-prefixed R2.
5. Build temporary-account provisioning with tenant-scoped S3 staging.
6. Add Cloudflare claim and OAuth authorization flow.
7. Add media migration and Worker redeployment.
8. Add expiration, revocation, cleanup, and migration retry handling.
9. Benchmark managed hosting by simultaneously active tenants and message rates.

## Decision

Support both:

```text
A3 managed hosting
A1 independent hosting
```

Use A3 as the default product and A1 for users who want Cloudflare ownership. Do not make A2 the primary mode. Resolve the Durable Object cost question through hibernation and an active-tenant benchmark rather than by counting total instances.
