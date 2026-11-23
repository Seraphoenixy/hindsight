---
sidebar_position: 5
---

# Daemon CLI (hindsight-embed)

Zero-configuration local memory system with automatic daemon management. Perfect for development, prototyping, and single-user applications.

## Overview

`hindsight-embed` is a zero-configuration SDK that wraps the Hindsight API and PostgreSQL database into a single auto-managed local daemon. It's designed for development, prototyping, and single-user applications where you want memory capabilities without infrastructure overhead.

**How it works:**

1. **First command triggers startup**: When you run any `hindsight-embed` command, it checks if a local daemon is running
2. **Auto-daemon management**: If no daemon exists, it automatically spawns `hindsight-api --daemon` in the background
3. **Embedded database**: The daemon uses `pg0` (embedded PostgreSQL) — no separate database installation required
4. **Command forwarding**: Your command is forwarded to the local daemon via HTTP (localhost:8888)
5. **Auto-shutdown**: After 5 minutes of inactivity (configurable), the daemon gracefully shuts down to free resources

**Key features:**

- **Zero setup** — One `configure` command and you're ready
- **Automatic lifecycle** — Daemon starts on-demand and is shared by every client
- **Isolated storage** — Each bank gets its own embedded PostgreSQL database
- **Local-only** — Binds to `127.0.0.1:8888`, not accessible from network
- **Production-grade engine** — Uses the same memory engine as the full API service

Think of it as SQLite for long-term memory — all the power of Hindsight without managing servers.

## Installation

Install via `uvx` (recommended - always latest version):

```bash
# Run directly without installation
uvx hindsight-embed@latest configure

# Or use pipx for persistent installation
pipx install hindsight-embed
```

## Quick Start

### 1. Configure

```bash
# Interactive configuration
hindsight-embed configure

# Or non-interactive via environment variables
export HINDSIGHT_API_LLM_PROVIDER=openai
export HINDSIGHT_API_LLM_API_KEY=sk-xxxxxxxxxxxx
export HINDSIGHT_API_LLM_MODEL=gpt-4o-mini
hindsight-embed configure
```

Configuration is saved to `~/.hindsight/embed`:

```bash
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_MODEL=gpt-4o-mini
HINDSIGHT_API_LLM_API_KEY=sk-xxxxxxxxxxxx

# Daemon settings (macOS: force CPU to avoid MPS/XPC issues)
HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU=1
HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU=1
```

### 2. Use Memory Operations

```bash
# Store a memory
hindsight-embed memory retain default "User prefers dark mode"

# Query memories
hindsight-embed memory recall default "user preferences"

# Reasoning with memory
hindsight-embed memory reflect default "What color scheme should I use?"
```

The daemon starts automatically on first use!

### 3. Open the Local Settings Page (optional)

Profile configuration and daemon control live in the **control plane**, on its
`/local` page — the same application that shows your memory banks:

```bash
# Start the control plane only, then open <ui-url>/local
hindsight-embed ui start

# Or start it and open that page in one step
hindsight-embed configure --web
```

The control plane prints its URL; `/local` is where the settings are. There is no
separate management process and no second access token: it reads and writes the
same profiles through `hindsight-embed`, and a profile it changes is what the
daemon starts with after a restart.

```bash
# The control plane only, when you need its URL or its log
hindsight-embed ui status
hindsight-embed ui logs -f
hindsight-embed ui stop
```

The page is in the same language as the rest of the control plane, with the same
language picker in the header.

`/local` has five tabs. **Quick config** sets the API and control-plane ports and
the per-profile component version pins. The LLM settings — provider, API key,
model, base URL and the tuning knobs — live on **Settings** only, which renders
them with the other core options as a grouped form — Service, LLM, Vision,
Embeddings, Reranker, Decision model, Retain and recall — so you do not have to
hand-edit env syntax:

- A field left blank means "unset": saving removes the key so the daemon falls back to its own
  default. Clearing the API key therefore deletes the stored key rather than keeping it — the two
  tabs no longer disagree about that.
- The provider dropdown lists the same catalog the daemon validates against, so a provider chosen
  here is never missing from the list.
- Fields with a finite set of values are dropdowns, not text boxes: the providers, the log level,
  the reasoning level, and the embedding and reranker models. Each model option shows the id, its
  dimensions and whether it is the default. Model fields also keep a **Custom…** entry, because the
  daemon accepts more than the shipped set — any HuggingFace id, a local `.gguf` path, a
  provider-specific reasoning level. A value already in the `.env` that is not in the list opens in
  that custom state, so saving another field never rewrites it.
- The form writes only the keys it owns. Every other key in the profile's `.env` — including custom
  ones — is preserved, so **Settings** and the raw **Configuration** editor can be used
  interchangeably.
- Values are validated before writing (a select must be one of its options, a number must parse,
  a boolean must be `true`/`false`), so a typo is rejected instead of silently stored.
- A warning names the keys whose absence breaks LLM-backed work, such as an API key missing for a
  provider that requires one.

All tabs edit the same file (`~/.hindsight/profiles/<profile>.env`); settings take effect after the
API is restarted.

## Environment Variables

| Variable                                  | Description                                                                       | Default             |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| `HINDSIGHT_API_LLM_API_KEY`               | **Required**. API key for LLM provider                                            | -                   |
| `HINDSIGHT_API_LLM_PROVIDER`              | LLM provider: `openai`, `anthropic`, `gemini`, `groq`, `minimax`, `ollama`        | `openai`            |
| `HINDSIGHT_API_LLM_MODEL`                 | Model name                                                                        | `gpt-5-nano`        |
| `HINDSIGHT_EMBED_DAEMON_LOG_MAX_BYTES`    | Rotate the daemon log at startup when it reaches this size; `0` disables rotation | `10485760` (10 MiB) |
| `HINDSIGHT_EMBED_DAEMON_LOG_BACKUP_COUNT` | Retained backups; `0` truncates a full log at startup                             | `3`                 |
| `HINDSIGHT_EMBED_OPS_TOKEN`               | Access token for `hindsight-embed ops`, and for the control plane's `/api/local/*` routes | generated, `~/.hindsight/ops.token` |

The size is checked only when a daemon starts, so a single uninterrupted run is never truncated and can
grow past `MAX_BYTES` — and at the next start that whole file is kept as the first backup. Retained size
is therefore around `MAX_BYTES × (BACKUP_COUNT + 1)` (40 MiB by default) only for daemons that restart
regularly; a daemon left running for weeks keeps whatever it wrote. Restart it to keep the bound
meaningful.

**Provider Examples:**

```bash
# OpenAI
export HINDSIGHT_API_LLM_PROVIDER=openai
export HINDSIGHT_API_LLM_API_KEY=sk-xxxxxxxxxxxx
export HINDSIGHT_API_LLM_MODEL=gpt-4o

# Groq (fast inference)
export HINDSIGHT_API_LLM_PROVIDER=groq
export HINDSIGHT_API_LLM_API_KEY=gsk_xxxxxxxxxxxx
export HINDSIGHT_API_LLM_MODEL=llama-3.3-70b-versatile

# Anthropic
export HINDSIGHT_API_LLM_PROVIDER=anthropic
export HINDSIGHT_API_LLM_API_KEY=sk-ant-xxxxxxxxxxxx
export HINDSIGHT_API_LLM_MODEL=claude-sonnet-4-20250514
```

## Daemon Management

The daemon runs until you stop it — it never exits on its own, so a long retain, reflect or
consolidation is never cut short.

### Daemon Commands

```bash
# Check daemon status
hindsight-embed daemon status

# View daemon logs in real-time
hindsight-embed daemon logs -f

# Stop daemon manually
hindsight-embed daemon stop
```

### Reclaiming Disk Space

When the daemon is launched with `uvx` (the default for the npm package and the editor plugins), every Hindsight version it has run keeps its own cached Python environment — around 1.5 GB each — and these are not removed automatically. If disk space gets tight, stop the daemon before clearing the cache: unused entries can only be reclaimed while no daemon is running.

```bash
hindsight-embed daemon stop
uv cache prune
hindsight-embed daemon status   # starts fresh on the current version
```

### Local Management Commands

The management UI is the **control plane**. Its `/local` page edits this
machine's profiles, their `.env`, and the daemon, and it drives the operations
below through this CLI — one UI, one port, no second process to supervise.

```bash
# Start the control plane only, then open <ui-url>/local
hindsight-embed ui start

# Start it and open the local settings page in the browser
hindsight-embed configure --web

# Stop the control plane (the daemon keeps running)
hindsight-embed ui stop
```

The embed's own control center (port 7878) was removed. `hindsight-embed control`
now prints where those settings went instead of starting anything.

### Machine-Readable Operations (`ops`)

`hindsight-embed ops` is the surface the control plane's `/local` page calls. Each
invocation prints exactly one JSON document on stdout; mutating commands read
their request document from stdin. Use it from scripts, or when a browser is not
available.

```bash
hindsight-embed ops profiles                  # every profile with daemon status
hindsight-embed ops settings -p coding-agent  # grouped settings catalog + values
echo '{"provider":"groq","api_key":null}' | hindsight-embed ops models  # ids the provider advertises; nothing saved
hindsight-embed ops config                    # editable config (API key masked)
hindsight-embed ops env                       # raw .env, verbatim
hindsight-embed ops paths                     # files, database URL, addresses
hindsight-embed ops health                    # live daemon health
hindsight-embed ops logs -n 200 --source daemon
hindsight-embed ops daemon-status             # is the daemon up, and on which URL
hindsight-embed ops ui-status                 # is the control plane up (reports only)
hindsight-embed ops daemon-start|daemon-stop|daemon-restart
hindsight-embed ops token                     # access token, created on first use

# Writes take a JSON request document on stdin
echo '{"values":{"HINDSIGHT_API_LLM_PROVIDER":"groq"}}' | hindsight-embed ops save-settings
echo '{"content":"HINDSIGHT_API_LLM_PROVIDER=openai\n"}' | hindsight-embed ops write-env
echo '{"api_port":"9200"}' | hindsight-embed ops save-config
hindsight-embed ops delete-profile -p staging
```

`daemon-status` and `ui-status` report only. The control plane's lifecycle is not
driven from `ops`, because the page that would call it is served by that very
process — starting or stopping it there could only answer by killing the caller.
Launch it with `hindsight-embed ui start`.

Exit codes: `0` for a result (including `{"ok": false}` for a domain failure, such
as the daemon refusing to stop), `1` for an exception, `2` for a rejected value or
usage error. Every non-zero exit still prints a JSON object with an `error` field.

The control plane's routes into these commands are gated twice: the request must
come from this machine (loopback `Host`) **and** carry the token at
`~/.hindsight/ops.token` (issued by this CLI). That token gates process control
and profile writes, so it is read server-side and never exposed to the browser as
a fetchable value.

## Commands

All memory operations follow the same interface as the CLI:

### Retain (Store Memory)

```bash
hindsight-embed memory retain <bank_id> "content"

# With context
hindsight-embed memory retain <bank_id> "content" --context "source information"

# Background processing
hindsight-embed memory retain <bank_id> "content" --async
```

### Recall (Search)

```bash
hindsight-embed memory recall <bank_id> "query"

# With budget control
hindsight-embed memory recall <bank_id> "query" --budget high

# Show trace
hindsight-embed memory recall <bank_id> "query" --trace
```

### Reflect (Generate Response)

```bash
hindsight-embed memory reflect <bank_id> "prompt"

# With additional context
hindsight-embed memory reflect <bank_id> "prompt" --context "additional info"
```

### Bank Management

```bash
# List all banks
hindsight-embed bank list

# View bank stats
hindsight-embed bank stats <bank_id>

# Set bank name
hindsight-embed bank name <bank_id> "My Assistant"

# Set bank mission
hindsight-embed bank mission <bank_id> "I am a helpful AI assistant"
```

## Troubleshooting

### Daemon Won't Start

Check the daemon logs:

```bash
hindsight-embed daemon logs
# Or watch in real-time
hindsight-embed daemon logs -f
```

Common issues:

- **Missing API key**: Set `HINDSIGHT_API_LLM_API_KEY`
- **Port conflict**: Another service using port 8888
- **Permissions**: Check `~/.hindsight/` directory permissions

### Daemon Exits Immediately

The daemon never stops itself, so an exit is a crash or a failed startup. Check the log:

```bash
hindsight-embed daemon status
tail -n 100 ~/.hindsight/daemon.log
```

### Reset Configuration

```bash
# Remove config file and reconfigure
rm ~/.hindsight/embed
hindsight-embed configure
```

## When to Use

**Perfect for:**

- Development and prototyping
- Single-user applications
- Local-first tools
- Quick experiments with Hindsight

**Not suitable for:**

- Production multi-user deployments
- Network-accessible services
- High-availability requirements
- Multi-tenant applications

For production deployments, use the [API Service](/developer/services) with external PostgreSQL instead.
