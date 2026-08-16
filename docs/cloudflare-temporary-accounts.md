# Cloudflare temporary accounts for rss.voice

## Summary

Cloudflare temporary accounts can support a preview-and-claim flow for rss.voice:

1. rss.voice provisions a temporary Cloudflare account on behalf of a user.
2. rss.voice deploys a Worker and supported resources into that account.
3. The user receives a preview URL and a Cloudflare claim URL.
4. The user signs in to Cloudflare or creates an account, then claims the temporary account.
5. The claimed account and its supported resources remain available to the user permanently.

This is not documented as a transfer of resources into an existing Cloudflare account. The safe assumption is that Cloudflare creates a distinct account, which the user later claims using an existing or newly created Cloudflare login. The account ID should be treated as distinct unless Cloudflare confirms an account-merge behavior.

The current rss.voice deployment is not fully compatible with temporary accounts because it depends on an R2 media bucket, while R2 is not listed in Cloudflare's documented temporary-account resource support.

## References

- [Cloudflare: Claim deployments (temporary accounts)](https://developers.cloudflare.com/workers/platform/claim-deployments/)
- [Cloudflare: Temporary Cloudflare Accounts for AI agents](https://blog.cloudflare.com/temporary-cloudflare-accounts-for-ai-agents/)
- [Cloudflare partner programs](https://www.cloudflare.com/partners/)

## Cloudflare provisioning flow

Cloudflare provides two integration paths:

- `wrangler deploy --temporary`, for an AI agent or tool that runs Wrangler directly.
- The REST API at `api.cloudflare.com/client/v4/provisioning/previews`, for a platform backend that controls the deployment experience.

rss.voice needs the REST API path because the rss.voice backend should provision and configure the instance on behalf of the user.

### Required steps

1. Obtain the user's acceptance of Cloudflare's Terms of Service and Privacy Policy.
2. Request a proof-of-work challenge:

   ```text
   POST /client/v4/provisioning/previews/challenge
   ```

3. Solve the challenge by computing the sequential SHA-256 checkpoint chain.
4. Create the temporary account:

   ```text
   POST /client/v4/provisioning/previews
   ```

5. Validate that the response contains the temporary account ID, API token, expiration time, claim URL, and claim expiration time.
6. Deploy supported resources using the temporary account ID and API token.
7. Return only the preview URL and claim URL to the intended user.
8. Require the user to complete the claim within 60 minutes.
9. Delete stored temporary credentials and claim URLs when they are no longer needed and no later than their expiration times.

The proof-of-work solver is CPU-intensive. Cloudflare recommends running it outside the main request thread, such as in a worker thread or background job.

## Claim semantics

Cloudflare documents the claim flow as follows:

- The user opens the bearer claim URL.
- The user signs in to Cloudflare or creates a Cloudflare account.
- The user completes Cloudflare's dashboard claim prompts.
- The Worker and supported resources remain in the claimed account.

The documentation does not say that the temporary account is copied into, merged with, or transferred to an existing account. Product and data models should therefore preserve the temporary Cloudflare account ID as the eventual user's account ID.

If the user does not complete the claim, Cloudflare deletes the account and its resources after the claim window expires.

## Supported resources and rss.voice requirements

Cloudflare currently documents these temporary-account capabilities and limits:

- Workers deployed on `workers.dev`
- Workers Static Assets, up to 1,000 files and 5 MiB per asset
- One D1 database, up to 100 MB per database and 100 MB total
- Durable Objects, including Worker bindings and migrations
- KV namespace and key operations
- Up to two Hyperdrive configurations and 10 connections
- Up to 10 Queues
- Some mTLS and CA certificate operations

The current rss.voice Cloudflare deployment requires:

- A Worker
- D1
- A Durable Object migration for the firehose
- An R2 media bucket
- A separate Astro frontend
- An hourly scheduled cleanup

R2 is not included in Cloudflare's temporary-account support table. R2 creation and operations must therefore be treated as unsupported until Cloudflare documents otherwise or confirms support directly.

## Recommended deployment shape

The simplest temporary preview should be one Worker containing both the API and the built Astro frontend:

```text
temporary Cloudflare account
├── rss.voice Worker API
├── D1 database
├── Durable Object firehose
└── Astro static assets
```

Using one Worker avoids requiring the user to claim separate frontend and backend deployments. The frontend should use a same-origin API URL by default, with an optional configured API URL retained for local development.

## Media options

### Option 1: Preview without media

Use temporary accounts for a disposable preview and disable media uploads. This is the smallest implementation and avoids falsely claiming that the instance is fully independent.

### Option 2: External S3-compatible media

The repository already supports an S3-compatible media path for the celld deployment. Temporary instances could use that path instead of R2.

This allows voice posts, but media would remain in rss.voice-operated storage rather than in the user's Cloudflare account. The instance would not be completely independent after the user claims it.

### Option 3: Wait for R2 support

This is the cleanest design for a genuinely self-contained instance, but it should not be implemented until R2 support for temporary credentials is documented or confirmed by Cloudflare.

## Repository changes needed

### 1. Add a permanent provisioning control plane

The existing Worker is a chat server, not a deployment control plane. Add a backend capability under rss.voice's permanent infrastructure that can:

- Authenticate the rss.voice user.
- Request and solve Cloudflare provisioning challenges.
- Create temporary accounts.
- Deploy the Worker and supported resources.
- Store temporary credentials server-side.
- Return only user-safe preview and claim URLs.
- Reconcile expired, failed, abandoned, and claimed instances.

The control plane must not run from an unclaimed temporary Worker.

### 2. Track instance provisioning state

Persist at least:

```text
instance_id
owner_user_id
cloudflare_account_id
preview_url
claim_url
account_expires_at
claim_expires_at
status
```

The temporary API token and claim token are secrets. Store them only in protected backend storage, never in browser responses, logs, analytics, or support telemetry.

### 3. Parameterize Wrangler/deployment configuration

The current configuration contains fixed deployment values in [`apps/server/wrangler.toml`](../apps/server/wrangler.toml):

- Worker name: `rss-voice`
- Tenant ID: `default`
- Local API and frontend URLs
- D1 database name and binding
- R2 bucket name and binding

An on-demand deployment needs generated values for the Worker name, instance/tenant ID, public URLs, D1 database, media mode, and instance metadata.

The existing `tenant_id` columns in the D1 schema can represent an instance-specific tenant, although a separate D1 database per instance would already provide isolation.

### 4. Deploy the Astro frontend as Static Assets

Build the Astro application and upload it as Worker Static Assets. Change the frontend so that a same-origin API is the default for claimed instances while `PUBLIC_API_URL` remains available for local development and split deployments.

### 5. Handle Durable Object migrations and schedules

Include the firehose Durable Object binding and its migrations in the temporary deployment. Verify that the scheduled cleanup is accepted for temporary credentials. If media is disabled, omit or simplify the orphan-media cleanup job.

### 6. Implement expiration and retry handling

Handle:

- Expired account credentials
- Expired claim URLs
- Failed proof-of-work
- Cloudflare rate limits
- Incomplete claims
- Duplicate instance requests
- Abandoned preview cleanup

An expired provisioning attempt should request a new challenge and create a new temporary account rather than reuse stale credentials.

### 7. Add claim UX

The UI should show:

- The live preview URL
- The claim deadline
- A clear `Claim your instance` action
- A warning that the claim URL is a bearer credential
- The consequence of missing the 60-minute deadline

## Suggested implementation phases

### Phase 1: disposable preview

Deploy a working preview containing:

- Worker API
- D1
- Durable Object
- Astro Static Assets

Disable media uploads or clearly label the deployment as a no-media preview.

### Phase 2: media support

Choose between external S3-compatible storage and native R2 after confirming the temporary-account limitations. External storage is easier but does not give the user a completely independent instance.

### Production guidance

Cloudflare recommends permanent accounts for production and continuous deployment. Temporary accounts should be treated as preview, evaluation, and onboarding infrastructure rather than the default path for long-lived production instances.

## Affiliate and partner-program findings

No public Cloudflare affiliate or referral program with a published commission structure was identified in Cloudflare's official documentation or partner pages.

Cloudflare's official public partner offering is the **PowerUP Partner Program**, with routes to revenue including:

- Resell
- Manage
- Distribute
- Consult

Cloudflare also lists technology-alliance and service-provider partnerships. These are business/channel partnerships, not a simple affiliate-link program for referring new developer accounts.

The temporary-account documentation does not mention affiliate attribution or referral credit. rss.voice should not assume that a temporary-account claim counts as a referred signup or produces revenue.

If commercial partnership is important, the appropriate next step is to contact Cloudflare through its partner program and present rss.voice as a developer-platform integration or service-provider use case.

## Cloudflare tenant auto-deployment plan

### User flow

1. User opens the Tacobell rss.voice page.
2. User clicks **Launch**.
3. Tacobell provisions a temporary Cloudflare account and deploys rss.voice.
4. User is redirected to the live temporary instance.
5. User clicks **Claim** when satisfied.
6. User completes Cloudflare's claim flow.
7. User returns to Tacobell and authorizes Tacobell to manage the claimed Cloudflare account.
8. Tacobell creates the user's R2 bucket, migrates media, and redeploys the Worker.
9. Tacobell revokes temporary storage access and deletes staging media.

Claiming alone does not authorize Tacobell to create R2 or redeploy the Worker. The post-claim OAuth authorization is required.

### Temporary deployment

Deploy one Worker containing:

- rss.voice API
- D1 database
- Durable Object firehose
- Astro static assets
- Tenant-specific configuration

Configure media through a tenant-locked provisioner S3-compatible service:

```text
MEDIA_S3_ENDPOINT
MEDIA_S3_BUCKET
MEDIA_S3_ACCESS_KEY_ID
MEDIA_S3_SECRET_ACCESS_KEY
MEDIA_S3_REGION
```

Store objects under a candidate-specific prefix such as:

```text
candidates/{candidate-id}/media/{tenant-id}/{media-id}
```

The staging credential must be limited to that prefix, short-lived, revocable, and never exposed to the browser.

### Post-claim migration

After OAuth authorization:

1. Create an R2 bucket in the claimed account.
2. Copy staged media to the user-owned bucket, preserving object keys where possible.
3. Verify object size, content type, full reads, and range reads.
4. Deploy a new Worker version with an R2 `MEDIA` binding.
5. Remove the temporary `MEDIA_S3_*` configuration.
6. Verify the instance and media URLs.
7. Revoke the staging credential.
8. Delete the candidate prefix.

The existing media URLs remain stable because the Worker continues serving `/media/{id}` and D1 retains the media records.

Pause media uploads during migration. A short media-only freeze is simpler than dual-write. If migration fails, retain staging storage and retry; do not revoke it first.

### Backend selection

The existing media abstraction already supports both deployment modes:

```text
MEDIA binding       → direct R2
MEDIA_S3_* settings → S3-compatible storage
```

The Worker should not provision R2 itself. R2 bindings are deployment configuration, and the Worker would need an account-authorized API token plus a self-redeployment step.

### Celld hosting

Celld is unaffected by the Cloudflare migration flow. It continues to use its configured S3-compatible application-media bucket:

```text
celld Worker → configured S3-compatible media storage
```

Use tenant-specific prefixes and cleanup policies there as well. Do not use celld's fleet bucket directly for application media.

### Expiration

If the user never claims the instance:

1. Revoke the candidate S3 credential.
2. Delete its staging prefix.
3. Delete control-plane records and secrets.
4. Let Cloudflare expire the temporary account and resources.

## Final recommendation

This is the best practical plan until Cloudflare supports R2 in temporary accounts:

```text
temporary Cloudflare instance
  → tenant-scoped provisioner S3

claimed Cloudflare instance
  → user-owned R2

celld instance
  → configured S3 provider permanently
```
