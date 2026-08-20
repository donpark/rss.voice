# Self-hosted rss.voice deployment plan

## Goal

Allow a user to launch and own an rss.voice instance on a DigitalOcean Droplet using `cloud-init`/`user_data`, while keeping the deployment model extensible to other virtual machines, cloud providers, and bare-metal hosts.

DigitalOcean should be the first provider adapter, not the deployment architecture.

```text
control plane / local CLI
        │
        ├── canonical deployment manifest
        ├── release or OCI image
        └── cloud-init user_data
                │
                ▼
        host provider
        ├── DigitalOcean Droplet
        ├── generic VM
        ├── Hetzner server
        ├── AWS EC2
        └── bare metal
                │
                ▼
        self-host runtime
        ├── rss.voice Worker-compatible server
        ├── D1-compatible local database
        ├── Durable Object-compatible firehose
        ├── Astro frontend
        └── user-configured S3-compatible media
```

## Recommendation

Build a **self-host bundle** consisting of:

- one versioned application release or OCI image
- one canonical configuration schema
- one idempotent cloud-init document
- one local runtime launcher using systemd or Compose
- provider adapters that create the host and pass `user_data`
- a health/status protocol

Do not put DigitalOcean API calls, Droplet assumptions, or provider-specific networking logic into the application container or cloud-init core.

## Important celld prerequisite

The first implementation depends on confirming how celld can run on a user-controlled VM.

The repository currently has a celld Wrangler project:

```text
apps/server/celld/wrangler.toml
```

and documents deployment through:

```sh
celld deploy apps/server/celld ...
```

celld can be installed and operated as a Droplet-local runtime, and its runtime advertises hibernatable WebSocket support. Full rss.voice compatibility testing is deferred: celld v0.3.0 provides D1 and runs the scheduled handler, but the repository's celld configuration is still TOML and has not been validated against celld's supported surface, so the full application is not yet deployable there.

Before full self-host deployment, implement or verify:

- installation on Ubuntu or a supported Linux distribution
- non-interactive installation from cloud-init
- a long-running local service or container
- D1-backed application storage mapped to a supported Durable Object/SQLite design
- Durable Object-compatible state
- WebSocket upgrades and hibernation
- hourly cleanup through Durable Object alarms or an external scheduler
- static asset hosting or a supported frontend companion
- restart and recovery after host reboot
- backup and restore of local state
- configuration through environment variables or a file

Use celld's official self-hosted/OCI mode where appropriate. Do not claim the full rss.voice application is celld-compatible until the celld configuration is converted and the D1, scheduler, and S3-media surfaces are validated against celld v0.3.0.

## Deployment layers

### 1. Application release

The release is host-independent. It should include:

- server code
- compiled Astro assets
- database migrations
- runtime metadata containing the release version
- health-check behavior
- startup and migration commands
- compatibility/runtime requirements

Prefer a versioned OCI image if celld supports containers. Otherwise publish a versioned tarball with a documented launcher.

The release must not contain production secrets.

### 2. Runtime contract

Define the minimum runtime contract that any host implementation must provide:

```text
HTTP server:
  listen on configured address and port

Database:
  persistent D1-compatible SQLite storage

Durable Object:
  persistent state and WebSocket support for Firehose

Scheduler:
  hourly orphan-media cleanup, or an equivalent external schedule

Media:
  configured S3-compatible object storage

Email:
  configured mail webhook or equivalent delivery service

Frontend:
  serve Astro assets or route to a frontend companion
```

The application should depend on this contract, not on DigitalOcean APIs.

### 3. Host bootstrap

Cloud-init is the portable bootstrap format. The provider-specific adapter only supplies it to the host.

Cloud-init should:

1. install the required runtime and reverse proxy
2. create a dedicated `rssvoice` system user
3. create persistent data and configuration directories
4. install the selected application release
5. write configuration and secrets with restrictive permissions
6. run database migrations
7. create and enable the service
8. configure firewall rules
9. wait for the health endpoint
10. report success or failure

The script must be idempotent. Re-running it must not destroy the database, rotate credentials unexpectedly, or duplicate services.

## Canonical deployment manifest

Define one provider-neutral manifest. A provider adapter consumes it and produces infrastructure-specific actions.

Example:

```yaml
schema: rss.voice/deployment/v1
release: 2026.08.10
runtime: celld
instance_name: My rss.voice
base_url: https://voice.example.com
listen:
  address: 127.0.0.1
  port: 8780
storage:
  database_path: /var/lib/rssvoice/data.sqlite
  media:
    kind: s3
    endpoint: https://s3.example.com
    bucket: my-rss-voice-media
    region: auto
    prefix: rssvoice/my-instance/
mail:
  webhook_url: https://mail.example.com/rssvoice
limits:
  max_media_upload_bytes: 2097152
  auth_rate_limit: 5
  write_rate_limit: 60
  media_orphan_grace_hours: 24
network:
  tls: caddy
  domain: voice.example.com
```

Secrets must be represented by references, not plaintext values in the public manifest:

```yaml
secrets:
  media_access_key_id: media-access-key
  media_secret_access_key: media-secret-key
  mail_webhook_url: mail-webhook
```

The installer resolves these from a protected local bundle, environment file, secret manager, or interactive setup flow.

## DigitalOcean provider adapter

The DigitalOcean adapter should own only DigitalOcean-specific responsibilities:

- create or select a Droplet
- select image, size, region, and SSH keys
- attach optional block storage
- apply tags, project, and firewall configuration
- pass rendered `user_data`
- wait for the public IP and bootstrap status
- optionally configure DNS
- expose lifecycle operations: create, inspect, reboot, destroy

Suggested first target:

- Ubuntu LTS image
- one basic Droplet size for development/small communities
- optional block volume for database/media-independent persistent state
- DigitalOcean firewall allowing TCP 80 and 443
- SSH restricted to user-provided keys or disabled after setup
- public IPv4, with IPv6 enabled where practical

Do not make the application aware that it is running on DigitalOcean.

### DigitalOcean launch paths

Support two paths using the same rendered cloud-init:

1. **Control-plane provisioning**
   - WizOps or a local CLI calls the DigitalOcean API.
   - The adapter creates the Droplet and supplies `user_data`.
2. **User-created Droplet**
   - The UI or documentation displays/copies the same cloud-init payload.
   - The user pastes it into DigitalOcean's user-data field.
   - The user supplies their own secrets and domain configuration.

The second path is important for genuine ownership: the user can create and operate the Droplet without granting WizOps DigitalOcean credentials.

## Generic VM provider interface

Define an adapter interface around lifecycle operations rather than around DigitalOcean terminology:

```text
HostProvider
  validate(manifest)
  renderUserData(manifest, release)
  create(spec, userData)
  waitUntilReady(instance)
  getStatus(instance)
  update(instance, release)
  reboot(instance)
  destroy(instance)
```

Possible adapters:

```text
DigitalOceanProvider
GenericVmProvider
HetznerProvider
AwsEc2Provider
BareMetalProvider
LocalVmProvider
```

`GenericVmProvider` should not attempt to create infrastructure. It should produce cloud-init and installation instructions for a user-created VM.

This keeps the core deployment useful even when there is no provider API integration.

## Cloud-init design

### Bootstrap inputs

The cloud-init payload should receive:

- release identifier
- runtime type
- artifact URL or image reference
- artifact checksum/signature
- non-secret deployment configuration
- one-time bootstrap credential if remote status reporting is enabled
- encrypted or locally supplied secrets

Avoid embedding long-lived WizOps credentials. In particular, never include:

- a provisioner-wide R2 key
- a shared media secret
- a Cloudflare account API token
- a DigitalOcean API token
- a control-plane administrator credential

For control-plane provisioning, use a short-lived, candidate-specific bootstrap token. The token should be:

- scoped to one deployment
- usable only for fetching its release/configuration
- expiration checked independently by the server
- revocable after bootstrap
- excluded from normal logs

For direct user-created Droplets, the user can provide a local secrets file through a protected setup mechanism or complete setup through an authenticated first-run page. Do not require the user to paste permanent secrets into a public URL.

### Files and permissions

A conventional layout:

```text
/etc/rssvoice/
  deployment.yaml       0644 or 0600 as appropriate
  secrets.env           0600 root:rssvoice
  release               0644

/var/lib/rssvoice/
  data.sqlite
  backups/
  releases/

/var/log/rssvoice/
```

The service should run as an unprivileged `rssvoice` user. Only cloud-init/systemd installation steps run as root.

### Service management

Use systemd as the base service contract. If the runtime is containerized, systemd can manage Compose/Podman or a single container.

Required behavior:

- restart on failure
- start after network availability
- stop cleanly
- retain persistent volumes
- expose logs through `journalctl`
- support a versioned update command

Avoid making Docker a hard requirement unless celld's supported runtime requires it. A native binary or systemd service is simpler on a small Droplet; OCI support remains useful for portability.

### Reverse proxy and TLS

Use a host-independent proxy contract with a first implementation using Caddy:

```text
public :443 → Caddy → 127.0.0.1:8780
```

Caddy should handle:

- automatic HTTPS when a domain is configured
- HTTP-to-HTTPS redirect
- WebSocket upgrade forwarding
- request body limits
- access logs without query-string auth codes

For initial setup without DNS, expose a health/setup endpoint only as appropriate and require the user to configure a domain before enabling normal public authentication. Magic-link codes currently travel in URLs, so HTTPS is mandatory for production use.

A reverse-proxy adapter can later support nginx, Traefik, a cloud load balancer, or a tunnel.

## Storage model

### Database

For a single self-hosted instance, use persistent local SQLite/D1-compatible storage:

```text
/var/lib/rssvoice/data.sqlite
```

Requirements:

- durable disk or volume
- migrations run before serving traffic
- WAL/checkpoint behavior documented
- regular backups
- restore test
- no database stored in an ephemeral container layer

The first implementation should not introduce PostgreSQL merely to support multiple host types. Add a database adapter only when a concrete runtime requires it.

### Media

Self-hosted deployments should use a user-configured S3-compatible provider permanently:

```text
rss.voice → user's S3/R2-compatible bucket
```

This avoids the temporary-account R2 problem entirely.

Use stable public routes:

```text
/media/{id}
```

Keep object keys tenant-prefixed even for a single instance:

```text
rssvoice/{deployment-id}/media/{media-id}
```

The server must continue to support full and byte-range reads, `HEAD`, MIME metadata, size limits, and orphan cleanup.

Local disk media should not be the default. It complicates backups, disk growth, migration, and multi-host recovery.

### Email

The user must configure a mail delivery webhook or provide an equivalent mail adapter. A self-hosted instance cannot assume WizOps mail delivery.

The setup process should validate delivery by sending a test magic link before declaring the deployment ready.

## First-run workflow

Recommended user journey:

1. User selects **Self-hosted**.
2. User chooses DigitalOcean or **I already have a VM**.
3. The setup wizard collects:
   - instance name
   - domain
   - S3-compatible media settings
   - mail webhook settings
   - optional resource sizing
4. The system renders a deployment manifest and cloud-init payload.
5. For DigitalOcean API provisioning, the user authorizes DigitalOcean or supplies no credentials and manually creates the Droplet.
6. Cloud-init installs and starts the runtime.
7. User points DNS to the host.
8. Caddy obtains TLS.
9. The setup endpoint reports health, database readiness, media readiness, mail readiness, and firehose readiness.
10. User creates the first member account through the email magic-link flow.

The setup wizard should make ownership boundaries explicit:

```text
You own:
  Droplet, disk, database, media bucket, domain, mail service

rss.voice provides:
  release, installer, updates, documentation
```

## Status and observability

Define a small status protocol independent of provider:

```text
GET /health
  process and basic runtime health

GET /health/ready
  database, migrations, media, mail configuration, scheduler

GET /health/version
  release and schema versions
```

Cloud-init should write a local status file and optionally send signed status callbacks:

```text
/var/lib/rssvoice/bootstrap-status.json
```

Do not make the hosted control plane a runtime dependency. If the status callback is unavailable, the self-hosted instance must continue operating.

Provider status should distinguish:

```text
requested
host_created
bootstrap_started
runtime_ready
dns_pending
tls_ready
failed
stopped
```

## Updates

Use immutable releases and a small update command:

```sh
rssvoice update --release 2026.08.10
```

Update sequence:

1. download artifact
2. verify checksum/signature
3. stage release
4. run migrations
5. restart runtime
6. run readiness checks
7. retain the previous release for rollback

Do not silently replace user configuration or secrets. Configuration schema changes must be explicit and versioned.

For users who do not want automatic updates, support pinned releases and a documented security-update path.

## Backups and recovery

Minimum backup plan:

- periodic SQLite backup
- backup encryption
- retention policy
- media bucket versioning or provider backup policy where available
- restore documentation
- tested restore command

The control plane must not be the only place where a backup exists. User-owned deployments should be recoverable without WizOps access.

A recovery flow should accept:

```text
deployment manifest
SQLite backup
media bucket
mail/S3 secrets
```

and produce a new host installation using the same cloud-init bundle.

## Security requirements

- HTTPS before production authentication.
- No permanent provider credentials in application code.
- No shared WizOps storage credentials in user instances.
- Cloud-init payloads must not be logged after rendering if they contain secrets.
- Bootstrap tokens are candidate-scoped and short-lived.
- S3 credentials are stored with mode `0600`.
- Database and local setup endpoints bind privately where possible.
- Firewall exposes only required ports.
- Setup endpoints are disabled or protected after completion.
- Health responses do not expose secrets or deployment tokens.
- Caddy/proxy logs must redact query strings because magic-link codes are currently URL parameters.
- Updates are checksum/signature verified.
- User receives a clear warning that they own patching, backups, and host security.

The existing long-lived local-storage auth token is a separate application security issue. Self-host deployment should not make that limitation worse; preferably require the session-security work before calling the installer production-ready.

## Testing strategy

### Cloud-init tests

- YAML parses successfully.
- Fresh Ubuntu VM completes bootstrap.
- Re-running cloud-init is safe.
- Interrupted bootstrap resumes.
- Invalid configuration fails before data migration.
- Secrets have correct ownership and permissions.
- Service restarts after reboot.

### Runtime tests

- health and readiness endpoints
- migration from empty database
- account creation and magic-link delivery
- text post
- voice/media upload
- full media read
- byte-range media read
- media deletion and orphan cleanup
- RSS and OPML generation
- WebSocket upgrade and firehose broadcast
- database backup and restore
- release rollback

### Provider tests

DigitalOcean:

- API-created Droplet
- manually created Droplet with copied user_data
- firewall and DNS setup
- reboot and resize behavior
- block-volume recovery

Generic VM:

- Ubuntu VM on a local hypervisor
- Hetzner or another second provider
- static IP and existing-domain setup

The generic VM test is important: it proves the core installer is not accidentally coupled to DigitalOcean.

## Implementation phases

### Phase 1: runtime contract

- Confirm celld self-hosting model.
- Convert the celld configuration to the JSON/JSONC form celld accepts with a d1_databases binding, and validate the D1-backed storage against celld v0.3.0.
- Validate the scheduled handler against celld's alarm-based cron support.
- Define local D1/DO/storage/scheduler contract.
- Add readiness checks.
- Document required environment and files.

### Phase 2: portable release

- Produce a versioned release artifact or OCI image.
- Add migrations and startup command.
- Add systemd/Compose launcher.
- Add update and rollback commands.

### Phase 3: cloud-init installer

- Build idempotent cloud-init template.
- Add secret/config injection.
- Add Caddy configuration.
- Add bootstrap status.
- Test on a clean Ubuntu VM.

### Phase 4: DigitalOcean adapter

- Implement Droplet create/inspect/destroy.
- Pass cloud-init through `user_data`.
- Configure firewall, SSH keys, region, size, and optional volume.
- Add manual copy/paste path using the same payload.

### Phase 5: generic host support

- Add a generic VM output mode.
- Separate provider lifecycle from installer rendering.
- Add a second provider integration only after the generic mode works.

### Phase 6: production hardening

- Signed releases.
- Backup/restore tooling.
- Update channels and rollback.
- Session/authentication improvements.
- Abuse controls and setup endpoint lockdown.
- Operational documentation for users.

## AI-assisted SSH deployment skills

The self-hosting plan should expose the deployment workflow through reusable AI-agent skills. These skills should operate over SSH against a user-selected host and use the same provider-neutral manifest and idempotent installer as the DigitalOcean path.

The agent should be an operator for the user's host, not a hidden control plane. The user must explicitly provide the host, authorize SSH access, review the planned changes, and approve destructive operations.

### `rss-voice-preflight`

Inspect a general host before installation.

Checks:

- SSH connectivity and authenticated user
- operating system and architecture
- available CPU, memory, disk, and swap
- systemd or container runtime availability
- open ports and firewall state
- DNS resolution for the requested domain
- existing rss.voice installation
- whether required outbound HTTPS and SMTP/webhook access work

The skill should produce a preflight report and stop on unsupported or unsafe conditions. It should not modify the host except for harmless read-only checks.

### `rss-voice-install`

Install rss.voice on a general Ubuntu/Debian host over SSH.

Workflow:

1. Run preflight.
2. Show the generated deployment manifest and change plan.
3. Ask for confirmation before writing files or installing packages.
4. Upload or render the signed release and cloud-init-equivalent setup files.
5. Create the `rssvoice` user, directories, service, reverse proxy, and firewall rules.
6. Inject user-owned media and mail configuration securely.
7. Run migrations.
8. Start the service and verify readiness.
9. Return the URL, release, service name, and recovery instructions.

The SSH path should share scripts with cloud-init instead of duplicating installation logic. Cloud-init can execute the same `rssvoice install` command non-interactively.

### `rss-voice-configure`

Apply safe configuration changes to an existing instance.

Supported operations may include:

- domain and TLS configuration
- instance name
- S3-compatible media settings
- mail webhook settings
- upload and rate limits
- log level
- update channel

Secrets must be passed through an interactive prompt, an encrypted file, or a protected environment mechanism. They must not be placed in shell history, chat transcripts, command-line arguments, or normal logs.

### `rss-voice-update`

Update an existing deployment to a selected release.

Workflow:

1. Inspect current release and health.
2. Verify the target release signature/checksum.
3. Confirm a recent database backup exists.
4. Stage the new release.
5. Run migrations.
6. Restart the service.
7. Verify HTTP, RSS, media, and WebSocket behavior.
8. Roll back automatically if readiness fails.

The agent should never perform a major upgrade or destructive migration without explicit confirmation.

### `rss-voice-backup`

Create and verify an instance backup.

The skill should back up:

- SQLite/D1-compatible database
- deployment manifest
- non-secret configuration
- release metadata

Media remains in the configured S3-compatible bucket and should be covered by that provider's versioning or backup policy. The agent should verify that the backup can be read and report its location and retention.

### `rss-voice-diagnose`

Diagnose a running deployment without changing it by default.

Collect:

- service status
- recent logs with secrets and auth query parameters redacted
- health and readiness responses
- migration/schema version
- disk and memory usage
- reverse-proxy status
- DNS/TLS status
- media HEAD and range-read checks
- WebSocket upgrade and broadcast checks

The default mode is read-only. A separate `--repair` or explicit user approval is required for restarts, configuration changes, or cleanup.

### `rss-voice-recover`

Restore a deployment to a new or existing host.

Inputs:

- backup location
- release version
- deployment manifest
- user-owned S3 and mail configuration
- target SSH host

The skill should install the runtime, restore the database, verify the media bucket, configure the proxy, and perform the same readiness checks as a fresh installation.

### Agent safety rules

AI-assisted SSH deployment must follow these rules:

- Require explicit host and SSH target confirmation.
- Display commands or a summarized change plan before execution.
- Prefer a dedicated non-root SSH user with narrowly scoped `sudo`.
- Use SSH host-key verification; do not silently accept a changed host key.
- Keep a transcript of actions, excluding secrets.
- Never request or store WizOps-wide credentials.
- Never copy shared R2, Cloudflare, DigitalOcean, or mail credentials to a host.
- Use user-owned credentials only for that user's deployment.
- Treat cloud-init and shell scripts as code: validate before execution.
- Make install, configure, update, and repair operations idempotent.
- Require confirmation for data deletion, firewall lockout, DNS changes, major migrations, and host destruction.
- Stop when the host is ambiguous, unhealthy, or outside the supported matrix.

### Skill packaging

Package these workflows as project or global agent skills with stable procedures rather than as provider-specific prompts:

```text
rss-voice-preflight
rss-voice-install
rss-voice-configure
rss-voice-update
rss-voice-backup
rss-voice-diagnose
rss-voice-recover
```

Each skill should call the same checked-in scripts and manifest renderer used by cloud-init. The AI layer supplies judgment, gathers missing values, obtains confirmation, and interprets output; it should not reimplement installation logic in ad hoc shell commands.

A provider-specific skill such as `rss-voice-digitalocean-create` may create a Droplet, but after SSH becomes available it should hand off to `rss-voice-preflight` and `rss-voice-install`. This preserves one installation path for DigitalOcean, Hetzner, AWS, a home server, and a generic VM.

## Open decisions

1. What is the simplest celld-compatible D1 schema and query layer, given celld v0.3.0 provides a D1-compatible binding?
2. Should orphan cleanup use Durable Object alarms or an external host scheduler, given celld runs the scheduled handler on its own alarms?
3. Should the frontend run inside the celld service, behind Caddy, or as a separate static service?
4. Should the first self-host release require a domain, or support an IP-only setup with a later TLS step?
5. Will updates be manual, opt-in automatic, or controlled by a hosted release service?
6. Which S3-compatible providers should be documented first: Cloudflare R2, AWS S3, and GCS? celld's conditional-write requirements exclude some community S3 implementations.

## Acceptance criteria

The first release is successful when a user can:

1. Create a DigitalOcean Ubuntu Droplet.
2. Paste one generated `cloud-init` payload into `user_data`.
3. Supply their own domain, mail webhook, and S3-compatible media settings.
4. Boot a working rss.voice instance without WizOps runtime credentials.
5. Create a member and publish a text post.
6. Upload and play a voice post with range requests.
7. Read RSS and OPML feeds.
8. Reboot the Droplet without losing data.
9. Back up and restore the instance.
10. Repeat the same installation on a generic Ubuntu VM with no application changes.

The DigitalOcean-specific code should end at host creation and networking. Everything from bootstrap onward should be reusable across host types.
