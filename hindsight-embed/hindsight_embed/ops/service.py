"""Business logic for the local operations surface.

A thin layer over ``ProfileManager`` (config read/write) and ``daemon_client``
(lifecycle) that returns typed results. ``cli.py`` only does argument routing and
JSON serialization on top of this, and the control plane talks to that CLI — so
this module is what the tests exercise directly, and it is the one implementation
of these operations.

There is deliberately no control-plane ("UI") lifecycle here. The control plane
is the process serving the browser page that calls these operations, so an
operation to start or stop it would be self-referential and could only answer by
killing the caller mid-request. Its lifecycle belongs to whoever launched it:
``hindsight-embed ui start`` or the coding-agents host half.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass

from .. import daemon_client
from .._http_probe import ProbeResponse, probe_get
from ..profile_manager import (
    ENV_API_PORT,
    ENV_CP_PORT,
    ProfileManager,
    lock_profile_env,
    parse_env_file,
    write_profile_env,
)
from . import models, settings
from .settings import SettingField

# Env var names the wizard owns. Writing config replaces these; everything else
# in the profile (idle timeout, bank id, custom keys) is preserved untouched.
_ENV_PROVIDER = "HINDSIGHT_API_LLM_PROVIDER"
_ENV_API_KEY = "HINDSIGHT_API_LLM_API_KEY"
_ENV_MODEL = "HINDSIGHT_API_LLM_MODEL"
_ENV_BASE_URL = "HINDSIGHT_API_LLM_BASE_URL"
# Per-profile component versions (default = the embed's own version when unset).
_ENV_API_VERSION = "HINDSIGHT_EMBED_API_VERSION"
_ENV_CP_VERSION = "HINDSIGHT_EMBED_CP_VERSION"

# Sentinel the UI sends back when the api-key field is left untouched, so we
# keep the stored key instead of overwriting it with the masked placeholder.
API_KEY_UNCHANGED = "__unchanged__"


@dataclass(frozen=True)
class ProfileSummary:
    """One row in the control center's profile list."""

    name: str  # "" for the default profile
    display_name: str  # "default" for the default profile
    port: int
    is_active: bool
    daemon_running: bool
    provider: str | None
    model: str | None
    has_api_key: bool


@dataclass(frozen=True)
class ProfileConfigView:
    """The editable LLM configuration of a single profile (key masked)."""

    name: str
    display_name: str
    provider: str | None
    model: str | None
    base_url: str | None
    api_key_masked: str | None  # None when no key is set
    has_api_key: bool
    api_port: int  # effective API/daemon port
    ui_port: int  # effective control-plane port
    ui_port_is_default: bool  # True when UI port is derived (API + offset), not pinned
    api_version: str | None  # pinned hindsight-api version (None = use embed default)
    cp_version: str | None  # pinned control-plane version (None = use embed default)


@dataclass(frozen=True)
class DaemonActionResult:
    """Outcome of a lifecycle action (start/stop/restart) or a status query.

    ``message_zh`` carries the Chinese counterpart of ``message``; the control
    center opens in Chinese, and a failure notice is the one place the user has
    to read the exact wording.
    """

    ok: bool
    running: bool
    url: str | None
    message: str
    message_zh: str


@dataclass(frozen=True)
class EnvFileView:
    """The raw contents of a profile's .env file, for direct editing."""

    name: str
    display_name: str
    path: str
    content: str
    exists: bool


@dataclass(frozen=True)
class ProfilePathsView:
    """On-disk references for a profile (config, logs, database, URLs)."""

    name: str
    display_name: str
    port: int
    config_path: str
    log_path: str
    lock_path: str
    database_url: str
    database_path: str | None  # local pg0 instance dir, when using pg0://
    daemon_url: str
    ui_url: str


@dataclass(frozen=True)
class LogTailView:
    """The tail of a profile's daemon log."""

    path: str
    exists: bool
    content: str


@dataclass(frozen=True)
class UiStatusView:
    """Status of the control plane (Next.js) UI for a profile.

    Reported, not driven: the control plane is the process serving the page that
    would ask, so starting or stopping it from inside that page can only answer by
    killing the caller mid-request. Its lifecycle stays with whoever launched it
    (``hindsight-embed ui start`` or the coding-agents host half). What this view
    is for is the delete path below, which must free the UI's port before removing
    the profile those processes were configured from.
    """

    running: bool
    url: str


@dataclass(frozen=True)
class ProfileDeleteResult:
    """Outcome of deleting a profile."""

    ok: bool
    message: str
    message_zh: str


@dataclass(frozen=True)
class HealthView:
    """Live health of a profile's API daemon.

    ``api_detail_zh`` mirrors ``api_detail`` for the Chinese UI; both are built
    in one place so the two never drift apart.
    """

    api_ok: bool
    api_detail: str  # e.g. "healthy · db connected", "unreachable", "HTTP 503"
    api_detail_zh: str
    api_port: int
    api_url: str


@dataclass(frozen=True)
class OptionLabelView:
    """Display name for one ``select`` option value."""

    value: str
    label: str
    label_zh: str


@dataclass(frozen=True)
class SettingFieldView:
    """One field in the grouped settings form, with its current value.

    ``label_zh``/``description_zh`` ship alongside the English pair rather than
    replacing it: the UI opens in Chinese and can switch to English, so both
    have to reach the browser and the catalog stays the single source.
    """

    key: str
    label: str
    kind: str
    value: str  # "" when the key is absent from the .env (= daemon default)
    default: str
    description: str
    options: list[str]
    placeholder: str
    is_set: bool  # True when the .env states this key explicitly
    label_zh: str
    description_zh: str
    option_labels: list[OptionLabelView]


@dataclass(frozen=True)
class SettingGroupView:
    """A titled block of related settings."""

    id: str
    label: str
    description: str
    label_zh: str
    description_zh: str
    fields: list[SettingFieldView]


@dataclass(frozen=True)
class SettingsView:
    """The grouped form's whole payload: catalog + current values."""

    name: str
    display_name: str
    groups: list[SettingGroupView]
    # Which fields still have no value. The UI uses it to explain why an
    # otherwise running daemon fails every LLM call (e.g. a missing API key).
    unset_required: list[str]


def normalize_profile(name: str | None) -> str:
    """Map the URL/display name to the internal profile id ("" = default)."""
    if name is None or name in ("default", ""):
        return ""
    return name


def _display_name(name: str) -> str:
    return name or "default"


def _browser_url(url: str) -> str:
    """Render daemon/UI URLs with the localhost hostname for the browser.

    0.0.0.0 isn't routable, and we present localhost everywhere for consistency.
    """
    return url.replace("://0.0.0.0:", "://localhost:").replace("://127.0.0.1:", "://localhost:")


def _mask_key(key: str | None) -> str | None:
    if not key:
        return None
    if len(key) <= 8:
        return "****"
    return f"{key[:3]}…{key[-4:]}"


def _read_raw_env(name: str) -> dict[str, str]:
    """Parse a profile's .env into real env-var keys only (no simple aliases)."""
    return parse_env_file(ProfileManager().resolve_profile_paths(name).config)


def _write_raw_env(name: str, env: dict[str, str]) -> None:
    """Persist env vars to a profile's .env (default or named), 0600."""
    pm = ProfileManager()
    if name:
        # Named profile: create_profile writes the file and updates metadata
        # (port allocation/last_used) in one shot.
        pm.create_profile(name, env)
        path = pm.resolve_profile_paths(name).config
    else:
        path = pm.resolve_profile_paths("").config
        path.parent.mkdir(parents=True, exist_ok=True)
        write_profile_env(path, "".join(f"{k}={v}\n" for k, v in env.items()))
    # The .env holds the API key — keep it owner-only.
    path.chmod(0o600)


@contextmanager
def _edit_raw_env(name: str) -> Iterator[dict[str, str]]:
    path = ProfileManager().resolve_profile_paths(name).config
    with lock_profile_env(path):
        env = parse_env_file(path)
        yield env
        _write_raw_env(name, env)


def list_profiles() -> list[ProfileSummary]:
    """List all profiles with live daemon status and their LLM provider/model."""
    pm = ProfileManager()
    summaries: list[ProfileSummary] = []
    for info in pm.list_profiles():
        config = pm.load_profile_config(info.name)
        summaries.append(
            ProfileSummary(
                name=info.name,
                display_name=_display_name(info.name),
                port=info.port,
                is_active=info.is_active,
                daemon_running=info.daemon_running,
                provider=config.get(_ENV_PROVIDER),
                model=config.get(_ENV_MODEL),
                has_api_key=bool(config.get(_ENV_API_KEY)),
            )
        )
    if not summaries:
        ca_paths = pm.resolve_profile_paths("coding-agent")
        ca_cfg = pm.load_profile_config("coding-agent")
        summaries.append(
            ProfileSummary(
                name="coding-agent",
                display_name="coding-agent",
                port=ca_paths.port,
                is_active=True,
                daemon_running=pm._check_daemon_running(ca_paths.port),
                provider=ca_cfg.get(_ENV_PROVIDER),
                model=ca_cfg.get(_ENV_MODEL),
                has_api_key=bool(ca_cfg.get(_ENV_API_KEY)),
            )
        )
    return summaries


def get_profile_config(name: str) -> ProfileConfigView:
    """Return the editable LLM config of a profile, with the API key masked."""
    name = normalize_profile(name)
    pm = ProfileManager()
    config = pm.load_profile_config(name)
    api_key = config.get(_ENV_API_KEY)
    paths = pm.resolve_profile_paths(name)
    raw = _read_raw_env(name)
    return ProfileConfigView(
        name=name,
        display_name=_display_name(name),
        provider=config.get(_ENV_PROVIDER),
        model=config.get(_ENV_MODEL),
        base_url=config.get(_ENV_BASE_URL),
        api_key_masked=_mask_key(api_key),
        has_api_key=bool(api_key),
        api_port=paths.port,
        ui_port=paths.ui_port,
        ui_port_is_default=ENV_CP_PORT not in raw,
        api_version=raw.get(_ENV_API_VERSION),
        cp_version=raw.get(_ENV_CP_VERSION),
    )


def save_llm_config(
    name: str,
    provider: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    api_port: str | None = None,
    ui_port: str | None = None,
    api_version: str | None = None,
    cp_version: str | None = None,
) -> ProfileConfigView:
    """Write a profile's non-catalog settings: ports, component pins, and optionally LLM keys.

    The LLM provider/key/model are owned by the Settings form (``save_settings``)
    since the Quick-config tab stopped duplicating them; they remain accepted here
    so a caller can set them in one call, and every one of them is optional.

    ``provider``/``model``/``api_key`` of None mean "leave as is" — the previous
    behaviour of a missing value meaning "clear it" is what made the same field
    behave differently from the Settings form. An empty string still clears, and
    ``api_key == API_KEY_UNCHANGED`` is kept for the old caller.

    ``api_port`` pins HINDSIGHT_API_PORT; an empty ``ui_port`` removes the override
    so the control-plane port follows API + offset. Empty version fields remove the
    per-profile version pin (use the embed default). Every other key in the file is
    preserved untouched.
    """
    name = normalize_profile(name)
    with _edit_raw_env(name) as env:
        if provider:
            env[_ENV_PROVIDER] = provider

        if api_key == API_KEY_UNCHANGED or api_key is None:
            pass  # keep whatever is stored
        elif api_key == "":
            env.pop(_ENV_API_KEY, None)
        else:
            env[_ENV_API_KEY] = api_key

        if model:
            env[_ENV_MODEL] = model
        elif model == "":
            env.pop(_ENV_MODEL, None)

        # None preserves an existing override; "" clears it.
        if base_url:
            env[_ENV_BASE_URL] = base_url
        elif base_url == "":
            env.pop(_ENV_BASE_URL, None)

        # Ports live in the .env. API port is pinned; an empty UI port means "derive
        # from API + offset" (remove the override). No validation by design.
        if api_port:
            env[ENV_API_PORT] = api_port
        if ui_port:
            env[ENV_CP_PORT] = ui_port
        else:
            env.pop(ENV_CP_PORT, None)

        # Component versions: pin if set, else remove the override (use embed default).
        if api_version:
            env[_ENV_API_VERSION] = api_version
        else:
            env.pop(_ENV_API_VERSION, None)
        if cp_version:
            env[_ENV_CP_VERSION] = cp_version
        else:
            env.pop(_ENV_CP_VERSION, None)
    return get_profile_config(name)


def _daemon_config(name: str) -> dict[str, str]:
    """Build the config dict daemon_client.ensure_daemon_running expects."""
    return ProfileManager().load_profile_config(name)


def _http_get(url: str, timeout: float = 2.0) -> ProbeResponse | None:
    """GET helper that returns the response or None on failure (patchable in tests)."""
    return probe_get(url, read_timeout=timeout)


def health(name: str) -> HealthView:
    """Probe the profile's API daemon (/health) right now.

    This is polled regularly by the control plane for the selected profile.
    """
    name = normalize_profile(name)
    paths = ProfileManager().resolve_profile_paths(name)
    api_ok = False
    detail = "unreachable"
    detail_zh = "无法连接"
    resp = _http_get(f"http://127.0.0.1:{paths.port}/health")
    if resp is None:
        pass
    elif resp.status_code != 200:
        detail = f"HTTP {resp.status_code}"
        detail_zh = f"HTTP {resp.status_code}"
    else:
        try:
            data = resp.json()
            api_ok = data.get("status") == "healthy"
            status = data.get("status", "ok")
            detail = f"{status} · db {data.get('database', '?')}"
            detail_zh = f"{status} · 数据库 {data.get('database', '?')}"
        except Exception:
            api_ok, detail, detail_zh = True, "ok", "正常"
    return HealthView(
        api_ok=api_ok,
        api_detail=detail,
        api_detail_zh=detail_zh,
        api_port=paths.port,
        api_url=_browser_url(f"http://127.0.0.1:{paths.port}"),
    )


def daemon_status(name: str) -> DaemonActionResult:
    """Report whether the profile's daemon is running, with its URL."""
    name = normalize_profile(name)
    running = daemon_client.is_daemon_running(name)
    url = _browser_url(daemon_client.get_daemon_url(name)) if running else None
    return DaemonActionResult(
        ok=True,
        running=running,
        url=url,
        message="Daemon is running." if running else "Daemon is not running.",
        message_zh="守护进程正在运行。" if running else "守护进程未运行。",
    )


def start_daemon(name: str) -> DaemonActionResult:
    """Start the profile's daemon (no-op if already healthy)."""
    name = normalize_profile(name)
    paths = ProfileManager().resolve_profile_paths(name)
    error_detail: str | None = None
    try:
        ok = daemon_client.ensure_daemon_running(_daemon_config(name), name)
    except Exception as exc:
        ok = False
        error_detail = f"{type(exc).__name__}: {exc}"
        try:
            paths.log.parent.mkdir(parents=True, exist_ok=True)
            with paths.log.open("a", encoding="utf-8", errors="replace") as f:
                f.write(f"\n[control-center] Failed to start daemon: {error_detail}\n")
        except OSError:
            pass
    running = daemon_client.is_daemon_running(name)
    if ok:
        message = "Daemon started."
        message_zh = "守护进程已启动。"
    else:
        tail = tail_log(name, lines=12, source="daemon").content.strip()
        snippet = error_detail or (tail.splitlines()[-1] if tail else "")
        # The underlying failure text comes from the API/launcher and stays in
        # its own language; only the wrapper sentence is translated.
        message = f"Failed to start daemon: {snippet}" if snippet else "Failed to start daemon — check the logs."
        message_zh = f"启动守护进程失败：{snippet}" if snippet else "启动守护进程失败，请检查日志。"
    return DaemonActionResult(
        ok=ok,
        running=running,
        url=_browser_url(daemon_client.get_daemon_url(name)) if running else None,
        message=message,
        message_zh=message_zh,
    )


def stop_daemon(name: str) -> DaemonActionResult:
    """Stop the profile's daemon.

    Always delegates to the manager, never gated on /health: a busy daemon fails
    the health probe yet is still alive. The manager decides by port occupancy
    and returns True when nothing is listening.
    """
    name = normalize_profile(name)
    ok = daemon_client.stop_daemon(name)
    return DaemonActionResult(
        ok=ok,
        # Not is_daemon_running: a busy daemon that refused to stop fails /health
        # too, and would read as stopped. A failed stop means it is still there.
        running=not ok,
        url=None,
        message="Daemon stopped." if ok else "Failed to stop daemon.",
        message_zh="守护进程已停止。" if ok else "停止守护进程失败。",
    )


def restart_daemon(name: str) -> DaemonActionResult:
    """Restart the profile's daemon to pick up new config."""
    name = normalize_profile(name)
    # Same as stop_daemon: no /health gate, or a busy daemon is never stopped.
    if not daemon_client.stop_daemon(name):
        return DaemonActionResult(
            ok=False,
            running=True,
            url=None,
            message="Failed to stop daemon for restart.",
            message_zh="重启前停止守护进程失败。",
        )
    return start_daemon(name)


# --------------------------------------------------------------------------
# grouped settings form
# --------------------------------------------------------------------------
def _field_view(field: SettingField, env: dict[str, str]) -> SettingFieldView:
    """Project one catalog field onto its current value in a profile's .env."""
    value = env.get(field.key)
    return SettingFieldView(
        key=field.key,
        label=field.label,
        kind=field.kind,
        value=value if value is not None else "",
        default=field.default,
        description=field.description,
        options=list(field.options),
        placeholder=field.placeholder,
        is_set=value is not None,
        label_zh=field.label_zh,
        description_zh=field.description_zh,
        option_labels=[OptionLabelView(value=o.value, label=o.label, label_zh=o.label_zh) for o in field.option_labels],
    )


def _required_unset(env: dict[str, str]) -> list[str]:
    """Catalog keys that are empty AND matter for the daemon to do any work.

    Only the fields whose absence makes every LLM-backed operation fail are
    reported: a provider that needs a key but has none. The pairing is
    deliberately narrow — reporting every empty field would bury the one that
    actually explains the failure.
    """
    provider = env.get("HINDSIGHT_API_LLM_PROVIDER", "")
    has_key = bool(env.get("HINDSIGHT_API_LLM_API_KEY", "").strip())
    # Providers that authenticate out-of-band (OAuth, or nothing at all).
    keyless = {
        "",
        "chatgpt",
        "openai-codex",
        "cursor",
        "github-copilot",
        "ollama",
        "ollama-cloud",
        "llamacpp",
        "lmstudio",
        "none",
        "xai-oauth",
        "claude-code",
        "mock",
    }
    if provider and provider not in keyless and not has_key:
        return ["HINDSIGHT_API_LLM_API_KEY"]
    return []


def get_settings(name: str) -> SettingsView:
    """Return the grouped form: every catalog field with its current value."""
    name = normalize_profile(name)
    env = _read_raw_env(name)
    return SettingsView(
        name=name,
        display_name=_display_name(name),
        groups=[
            SettingGroupView(
                id=group.id,
                label=group.label,
                description=group.description,
                label_zh=group.label_zh,
                description_zh=group.description_zh,
                fields=[_field_view(field, env) for field in group.fields],
            )
            for group in settings.SETTING_GROUPS
        ],
        unset_required=_required_unset(env),
    )


def list_models(
    name: str,
    *,
    provider: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
) -> models.ModelList:
    """Ask a provider for its model ids using the form's unsaved values.

    ``None`` means "use the saved profile value"; an explicit empty string means
    the form cleared it. That distinction is what lets a user test a new key
    without persisting it, or discover a provider's default endpoint after
    clearing a Base URL override.
    """
    name = normalize_profile(name)
    env = _read_raw_env(name)
    resolved_provider = provider if provider is not None else env.get(_ENV_PROVIDER, "")
    resolved_key = env.get(_ENV_API_KEY, "") if api_key is None else api_key
    resolved_base = env.get(_ENV_BASE_URL, "") if base_url is None else base_url
    return models.list_models(resolved_provider or "", resolved_key or "", resolved_base or "")


def save_settings(name: str, values: dict[str, str]) -> SettingsView:
    """Write the grouped form's values into a profile's .env.

    Only keys the catalog owns are touched, and an EMPTY value removes the key so
    the daemon falls back to its own default — that is what makes "blank means
    default" honest rather than writing an empty string the daemon would parse as
    a real (empty) setting. Every key the catalog does not name is preserved
    verbatim, so the raw .env editor and this form can be used interchangeably.
    """
    name = normalize_profile(name)
    known = settings.field_index()
    unknown = sorted(set(values) - set(known))
    if unknown:
        raise ValueError(f"unknown setting(s): {', '.join(unknown)}")

    with _edit_raw_env(name) as env:
        for key, raw in values.items():
            value = (raw or "").strip()
            if not value:
                env.pop(key, None)
                continue
            field = known[key]
            if field.kind == "boolean":
                lowered = value.lower()
                if lowered not in ("true", "false"):
                    raise ValueError(f"{key} must be true or false, got '{value}'")
                env[key] = lowered
                continue
            if field.kind == "number":
                try:
                    float(value)
                except ValueError:
                    raise ValueError(f"{key} must be a number, got '{value}'") from None
            # A closed set rejects anything outside it; a combo offers known values but
            # the daemon accepts more (any HuggingFace id, a local .gguf path, a
            # provider-specific reasoning level), so its stored value is not restricted.
            if field.kind == "select" and field.options and value not in field.options:
                raise ValueError(f"{key} must be one of {', '.join(field.options)}, got '{value}'")
            env[key] = value
    return get_settings(name)


# --------------------------------------------------------------------------
# raw .env editing
# --------------------------------------------------------------------------
def read_env_file(name: str) -> EnvFileView:
    """Return the raw text of a profile's .env for direct editing.

    Unlike get_profile_config, this exposes the file verbatim (API key
    included) — it's a power-user editor for a local, single-user tool.
    """
    name = normalize_profile(name)
    path = ProfileManager().resolve_profile_paths(name).config
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    return EnvFileView(
        name=name,
        display_name=_display_name(name),
        path=str(path),
        content=content,
        exists=path.exists(),
    )


def write_env_file(name: str, content: str) -> EnvFileView:
    """Overwrite a profile's .env with raw text (chmod 0600)."""
    name = normalize_profile(name)
    path = ProfileManager().resolve_profile_paths(name).config
    path.parent.mkdir(parents=True, exist_ok=True)
    # Normalize to a trailing newline so the file stays POSIX-clean.
    if content and not content.endswith("\n"):
        content += "\n"
    with lock_profile_env(path):
        write_profile_env(path, content)
        path.chmod(0o600)
    return read_env_file(name)


# --------------------------------------------------------------------------
# file references + logs
# --------------------------------------------------------------------------
def get_profile_paths(name: str) -> ProfilePathsView:
    """Resolve the on-disk references and URLs for a profile."""
    from pathlib import Path

    from .. import get_embed_manager

    name = normalize_profile(name)
    paths = ProfileManager().resolve_profile_paths(name)

    # Honor the same DB override the daemon uses, else the per-profile pg0.
    database_url = get_embed_manager().resolve_database_url(name)
    database_path: str | None = None
    if database_url.startswith("pg0://"):
        instance = database_url.removeprefix("pg0://")
        database_path = str(Path.home() / ".pg0" / "instances" / instance)

    return ProfilePathsView(
        name=name,
        display_name=_display_name(name),
        port=paths.port,
        config_path=str(paths.config),
        log_path=str(paths.log),
        lock_path=str(paths.lock),
        database_url=database_url,
        database_path=database_path,
        daemon_url=_browser_url(daemon_client.get_daemon_url(name)),
        ui_url=_browser_url(daemon_client.get_ui_url(name)),
    )


def tail_log(name: str, lines: int = 200, source: str = "daemon") -> LogTailView:
    """Return the last ``lines`` lines of the profile's daemon or control-plane log.

    ``source`` is "daemon" (the API daemon log) or "ui" (the control-plane log,
    so you can see why the UI failed to start).
    """
    name = normalize_profile(name)
    paths = ProfileManager().resolve_profile_paths(name)
    path = paths.ui_log if source == "ui" else paths.log
    if not path.exists():
        return LogTailView(path=str(path), exists=False, content="")
    # Small logs — reading then slicing is simpler than seeking and is fine for
    # the interactive tail in the UI.
    tail = path.read_text(encoding="utf-8", errors="replace").splitlines()[-max(lines, 1) :]
    return LogTailView(path=str(path), exists=True, content="\n".join(tail))


# --------------------------------------------------------------------------
# control plane (Next.js UI)
# --------------------------------------------------------------------------
def ui_status(name: str) -> UiStatusView:
    """Whether the control plane UI is running for this profile, and its URL."""
    name = normalize_profile(name)
    return UiStatusView(running=daemon_client.is_ui_running(name), url=_browser_url(daemon_client.get_ui_url(name)))


@dataclass(frozen=True)
class UiLaunchResult:
    """Outcome of starting the control plane, including the daemon's state.

    Starting the UI must not start the daemon: ``/local`` is precisely where a
    profile gets fixed, so it has to open even when the daemon is absent or
    broken. ``daemon_ok`` therefore reports whether one was already running, and
    the caller warns about it rather than treating it as a launch failure.
    """

    ui: UiStatusView
    daemon_ok: bool


def launch_ui(name: str) -> UiLaunchResult:
    """Start the control plane for this profile without starting its daemon.

    NOT an operation of the browser page — the page is served by this very
    process. It exists for launchers (``hindsight-embed ui start``, the
    coding-agents host half) that must bring the UI up before any page exists,
    and it is reached through the CLI, never through an HTTP route.
    """
    name = normalize_profile(name)
    # Read the daemon's state; never change it. The page opens against a stopped
    # daemon so the profile can be configured there.
    daemon_ok = bool(daemon_client.is_daemon_running(name))
    daemon_client.start_ui(name)
    return UiLaunchResult(ui=ui_status(name), daemon_ok=daemon_ok)


def delete_profile(name: str) -> ProfileDeleteResult:
    """Stop the profile's daemon and UI, then delete the profile.

    The default profile cannot be deleted (it has no metadata entry and is the
    fallback) — ProfileManager raises, which we surface as a failure.
    """
    name = normalize_profile(name)
    if not name:
        return ProfileDeleteResult(
            ok=False,
            message="The default profile cannot be deleted.",
            message_zh="默认配置档不可删除。",
        )
    # Check existence BEFORE stopping anything. A profile that is already gone has
    # no processes to stop, and asking the daemon manager to stop one first makes it
    # hunt for a listener on a port that was never allocated — which logs
    # "Could not find PID for port N" and makes a plain "does not exist" answer look
    # like a failed cleanup.
    manager = ProfileManager()
    if not manager.profile_exists(name):
        message = f"Profile '{name}' does not exist"
        return ProfileDeleteResult(ok=False, message=message, message_zh=message)
    # Free the port / processes before removing the config it points at. If a
    # stop fails, keep the profile: its config, logs and pid files are what the
    # user needs to find and retry the process that is still running.
    if not daemon_client.stop_daemon(name):
        return ProfileDeleteResult(
            ok=False,
            message="Failed to stop the daemon; the profile was not deleted.",
            message_zh="停止守护进程失败，配置档未删除。",
        )
    if not daemon_client.stop_ui(name):
        return ProfileDeleteResult(
            ok=False,
            message="Failed to stop the control plane UI; the profile was not deleted.",
            message_zh="停止控制平面失败，配置档未删除。",
        )
    try:
        manager.delete_profile(name)
    except ValueError as exc:
        # The profile manager's own message names the reason; keep it verbatim.
        return ProfileDeleteResult(ok=False, message=str(exc), message_zh=str(exc))
    return ProfileDeleteResult(
        ok=True,
        message=f"Deleted profile '{name}'.",
        message_zh=f"已删除配置档“{name}”。",
    )


def to_json(obj: object) -> dict:
    """Serialize an operations dataclass to a JSON-ready dict."""
    return asdict(obj)  # type: ignore[call-overload]
