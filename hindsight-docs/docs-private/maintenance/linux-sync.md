# Local Memory Synchronization (v3 Object Sync)

Multi-device synchronization for local Hindsight PostgreSQL replicas using `hindsight-sync-server`.

## Overview

Each device runs an independent local PostgreSQL database and remains completely usable offline. Changes are tracked inside each PostgreSQL write transaction (`sync_object_state` and `sync_change_log`) and synchronized incrementally through a standalone Linux Go relay (`hindsight-sync-server`).

- **Protocol v3 (Object-Level Sync)**: Synchronizes individual objects (`working_rule`, `bank`, `directive`, `document` with chunks/facts/entities/causal links, `memory_unit`, `observation`, `mental_model`, `knowledge_page`, `kb_document`, `webhook`, `audit_log`) plus content-addressed attachments (`v3/blobs/<sha256>`).
- **Causal Merge & Tombstones**: Disjoint edits on different objects merge automatically across replicas. Deletions leave persistent tombstones so offline devices replaying older history never resurrect deleted objects; explicit restores generate new causal versions (`op='restore'`).
- **Per-Object Conflict Audit & Restore**: Concurrent conflicting edits to the same object keep the configured winner (default `remote` when `HINDSIGHT_SYNC_AUTO_RESOLVE=true`) while persisting the full local/remote snapshots and origin device IDs into `sync_conflicts` BEFORE applying the change. Both CLI and Control Plane allow line/JSON comparison, confirmation with notes, and optimistic-locked object restoration (`--expected-version`).
- **Rebuildable vs Synced Data**: Canonical documents, facts, entities, causal links, observations, mental models, working rules, directives, pages, webhooks, and KB documents/passages are synced transactionally; `bank_stats_cache`, FTS vectors, and per-bank vector indexes remain derived/local.

## Relay Deployment (Linux)

1. Build or unpack `hindsight-sync-server-linux-{x64,arm64}.tar.gz`.
2. Configure environment for the systemd unit:
   - `HINDSIGHT_SYNC_DATA_DIR`: persistent relay directory (default `$XDG_DATA_HOME/hindsight-sync`)
   - `HINDSIGHT_SYNC_TOKEN`: admin/bootstrap bearer token (>= 32 printable non-space ASCII characters)
   - `HINDSIGHT_SYNC_PORT`: loopback bind port (default `9078`, always bound to `127.0.0.1`)
   - `HINDSIGHT_SYNC_MAX_BYTES`: single payload/blob cap (default `536870912`)
3. Place a TLS-terminating reverse proxy (e.g., Caddy/Nginx HTTPS) in front of `127.0.0.1:9078`. Forward `/v3/`, including `/v3/auth/`. Clients refuse non-HTTPS remote URLs and disable HTTP redirects (`allow_redirects=False`).

## Client & Automatic Sync Configuration

Set on each Hindsight API / daemon process:

- `HINDSIGHT_SYNC_RELAY_URL`: HTTPS relay URL (HTTP permitted for loopback testing only)
- `HINDSIGHT_SYNC_TOKEN`: optional if a device credential is already saved by PAKE login. Existing administrator and provisioned device tokens also work.
- `HINDSIGHT_SYNC_STATE_DIR`: private `0700` directory storing `device.json` and `client.lock`
- `HINDSIGHT_SYNC_AUTO_ENABLED`: `true` (default) to start automatic lifecycle scheduler
- `HINDSIGHT_SYNC_INTERVAL_SECONDS`: `15` (default) check cadence; checks run `HEAD /v3/status` + local `MAX(seq)` HWM and transfer zero memory bodies when unchanged
- `HINDSIGHT_SYNC_AUTO_RESOLVE`: `true` (default) keeps remote on true same-object conflict
- `HINDSIGHT_SYNC_BATCH_MAX_ITEMS`: `100`
- `HINDSIGHT_SYNC_BATCH_MAX_BYTES`: `4194304` (4 MiB)

When auto-sync is disabled, both timer and focus checks are suspended. Manual sync remains available. A rejected credential suspends automatic requests until the local credential changes or a manual retry succeeds. A rate-limited relay can delay the next request with `Retry-After`.

When joining a second replica that already holds independent data alongside a populated relay, automatic sync pauses in `needs_prefer` until an operator chooses `hindsight-admin sync --prefer local|remote <url> --state-dir <dir>` (or confirms in Control Plane `/local` -> **Sync**).

## Per-Device Credentials & Revocation

### Master-password login (PAKE)

With the relay administrator token set in `HINDSIGHT_SYNC_TOKEN`, run this once to set the master password:

```bash
hindsight-admin sync-device pake-init https://sync.example.com
```

In the local Control Plane, open **Local Management → Sync**, select the profile, and enter the relay URL and master password under **Sync Server**. The profile's API daemon must be running. A successful login saves the address and device credential for that profile and takes effect immediately. Automatic sync runs according to the profile's existing sync settings.

For command-line clients, use the same state directory as the sync daemon:

```bash
hindsight-admin sync-device login https://sync.example.com --name laptop-a --state-dir ~/.local/share/hindsight-sync-a
```

Both commands prompt privately. The client derives an access secret with PBKDF2-HMAC-SHA256 (600,000 rounds) and verifies the relay's SRP-6a server proof. The relay stores the registration salts and verifier in `pake.json`, and keeps each login challenge in memory for up to two minutes and one verification attempt. The master password and derived secret stay on the client.

The daemon uses the saved `device.json` for unattended sync. Device tokens remain valid across relay restarts until rotated or revoked. Reusing an existing device ID requires its current token as well as a successful PAKE login. Revocation blocks that ID, and holders of the master password can still enroll a new device. The relay administrator token remains valid for administration and compatibility. PAKE covers authentication, while HTTPS protects sync traffic.

### Direct administration

```bash
# List active/revoked devices
hindsight-admin sync-device list https://sync.example.com

# Provision a dedicated token and save device.json locally
hindsight-admin sync-device register https://sync.example.com --name laptop-a --state-dir ~/.local/share/hindsight-sync-a

# Rotate compromised or aging token
hindsight-admin sync-device rotate https://sync.example.com dev-xxxx --state-dir ~/.local/share/hindsight-sync-a

# Revoke a lost device permanently (blocks reads/writes with HTTP 403 while other devices keep syncing)
hindsight-admin sync-device revoke https://sync.example.com dev-xxxx
```

## Conflict Review & Restore

```bash
# List pending and historical object conflicts (plus legacy snapshot conflicts)
hindsight-admin sync-conflicts --state-dir ~/.local/share/hindsight-sync-a

# Inspect side-by-side metadata and unified JSON diff
hindsight-admin sync-conflicts --show <conflict-id> --diff

# Confirm review with audit note
hindsight-admin sync-conflicts --confirm <conflict-id> --note "Verified merged version"

# Restore local or remote payload with optimistic version check (prevents overwriting newer edits)
hindsight-admin sync-conflicts --restore <conflict-id> --side local --expected-version <cur_ver> --note "Keep local edit"
```

## Upgrading from v1/v2 Snapshot Sync

1. Run database migrations (`hindsight-admin run-migrations`) to install `sync_object_state`, `sync_change_log`, `sync_cursors`, and `sync_conflicts` plus capture triggers.
2. Stop writes to the replica during its one-time upgrade. Run `hindsight-admin sync <relay-url> --state-dir <dir> --prefer remote` to adopt the legacy relay snapshot, or use `--prefer local` to publish the designated local library. Use the original relay credential to read the legacy revision. The relay checks that revision again before activating v3. Bootstrap then uploads the library in bounded batches. Run sync again if there is any remaining backlog.
3. Once v3 is active, `/v1/snapshot`, `/v2/manifest`, and `/v2/blocks` return `409 Conflict`. Keep the legacy archive as a recovery copy until the migrated library has been verified. Supply the relay administrator credential explicitly in the Control Plane device panel or the `X-Hindsight-Sync-Admin-Token` header when managing devices through the local API.
4. Historical `state_dir/conflicts/*.json` and `conflict-*.zip` records remain readable via `hindsight-admin sync-conflicts --state-dir <dir>`.
