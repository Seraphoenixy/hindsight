"""``hindsight-embed ops`` — the machine-readable management surface.

One invocation, one JSON document on stdout, no terminal rendering. This is what
the control plane's local-management page calls: it runs the subprocess, reads
the document, and renders it in the browser. Nothing here formats for a human,
so the same code serves a future script or test harness unchanged.

Why a subprocess rather than an HTTP service: the operations it exposes (write
the profile ``.env``, start and stop the daemon, kill the process holding a
port) are implemented in :mod:`hindsight_embed.ops.service`, which sits on
:class:`hindsight_embed.daemon_embed_manager.DaemonEmbedManager`. That manager
carries platform behaviour with no Node equivalent — Windows kernel queries for
the owning PID of a port, the detached-process flag combination that avoids a
console window, the cross-platform profile lock — and its regressions are only
reproducible on real hosts. Reimplementing it in TypeScript would reintroduce
them; a short-lived subprocess keeps one implementation and pays only an
interpreter start (~0.4 s) per action.

Exit codes: 0 for a result (including ``{"ok": false}`` on a domain failure the
caller should display), 1 for an exception, 2 for a usage error. Every non-zero
exit still prints a JSON object with an ``error`` field, so a caller never has
to parse a traceback.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def _emit(payload: Any) -> None:
    """Write one JSON document to stdout.

    ``ensure_ascii=False`` keeps Chinese profile names and messages readable in
    the control plane's log; the parent decodes UTF-8 explicitly. The trailing
    newline keeps a captured stream line-delimited for any tooling that reads it.
    """
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _read_body() -> dict[str, Any]:
    """Read the request document from stdin.

    An empty stdin is an empty object rather than an error: every mutating
    command except ``write-env`` treats "no changes" as a valid no-op.
    """
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("request body must be a JSON object")
    return parsed


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hindsight-embed ops",
        description="Machine-readable local management commands (JSON output).",
    )
    sub = parser.add_subparsers(dest="ops_command", required=True)

    def add(name: str, help_text: str) -> argparse.ArgumentParser:
        child = sub.add_parser(name, help=help_text)
        child.add_argument("-p", "--profile", help="Profile name (default profile when omitted)")
        return child

    # ---- read-only ------------------------------------------------------
    add("profiles", "List every profile with its daemon status")
    add("config", "The profile's editable configuration (API key masked)")
    add("settings", "The grouped settings catalog with current values")
    add("models", "List model ids available from a provider, using an unsaved request body")
    add("env", "The profile's raw .env contents")
    add("paths", "On-disk references and URLs for the profile")
    add("health", "Live daemon health for the profile")
    add("daemon-status", "Whether the profile's daemon is running")
    add("ui-status", "Whether the profile's control plane is running")
    add("token", "The operations access token (created on first use)")

    logs = add("logs", "Tail the profile's daemon or control-plane log")
    logs.add_argument("--lines", "-n", type=int, default=200, help="Number of lines to return")
    logs.add_argument(
        "--source",
        choices=["daemon", "ui"],
        default="daemon",
        help="Which log to read: the API daemon's, or the control plane's",
    )

    # ---- mutating (JSON request on stdin) --------------------------------
    add("save-config", "Write ports and component version pins from stdin")
    add("save-settings", "Write grouped settings values from stdin")
    add("write-env", "Overwrite the profile's .env from stdin")
    add("delete-profile", "Stop the profile's processes, then delete it")

    # ---- lifecycle (no stdin) -------------------------------------------
    add("daemon-start", "Start the profile's daemon (no-op when already healthy)")
    add("daemon-stop", "Stop the profile's daemon")
    add("daemon-restart", "Restart the profile's daemon to pick up new config")

    return parser


def _run(args: argparse.Namespace) -> Any:
    """Dispatch one command and return the JSON-ready result.

    Imported here rather than at module scope so ``ops --help`` and a usage error
    do not pay for the manager's imports.
    """
    from . import auth, service

    name = args.profile or ""
    command = args.ops_command

    if command == "token":
        return {"token": auth.get_or_create_token(), "path": str(auth.token_file())}

    if command == "profiles":
        return {"profiles": [service.to_json(p) for p in service.list_profiles()]}

    if command == "config":
        return service.to_json(service.get_profile_config(name))

    if command == "settings":
        return service.to_json(service.get_settings(name))

    if command == "models":
        body = _read_body()
        for field in ("provider", "api_key", "base_url"):
            value = body.get(field)
            if value is not None and not isinstance(value, str):
                raise ValueError(f"{field} must be a string or null")
        return service.to_json(
            service.list_models(
                name,
                provider=body.get("provider"),
                api_key=body.get("api_key"),
                base_url=body.get("base_url"),
            )
        )

    if command == "env":
        return service.to_json(service.read_env_file(name))

    if command == "paths":
        return service.to_json(service.get_profile_paths(name))

    if command == "health":
        return service.to_json(service.health(name))

    if command == "daemon-status":
        return service.to_json(service.daemon_status(name))

    if command == "ui-status":
        return service.to_json(service.ui_status(name))

    if command == "logs":
        return service.to_json(service.tail_log(name, lines=args.lines, source=args.source))

    if command == "save-config":
        body = _read_body()
        return service.to_json(
            service.save_llm_config(
                name=name,
                provider=body.get("provider"),
                api_key=body.get("api_key"),
                model=body.get("model"),
                base_url=body.get("base_url"),
                api_port=body.get("api_port"),
                ui_port=body.get("ui_port"),
                api_version=body.get("api_version"),
                cp_version=body.get("cp_version"),
            )
        )

    if command == "save-settings":
        values = _read_body().get("values") or {}
        if not isinstance(values, dict):
            raise ValueError("values must be an object of env-var name -> string")
        return service.to_json(service.save_settings(name, {str(k): str(v) for k, v in values.items()}))

    if command == "write-env":
        return service.to_json(service.write_env_file(name, _read_body().get("content", "")))

    if command == "delete-profile":
        return service.to_json(service.delete_profile(name))

    if command == "daemon-start":
        return service.to_json(service.start_daemon(name))

    if command == "daemon-stop":
        return service.to_json(service.stop_daemon(name))

    if command == "daemon-restart":
        return service.to_json(service.restart_daemon(name))

    raise ValueError(f"unknown ops command '{command}'")


def main(argv: list[str] | None = None) -> int:
    """Entry point for ``hindsight-embed ops``. Returns a process exit code."""
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse already printed its usage to stderr; the caller still expects a
        # JSON document, so emit one instead of exiting with a bare code.
        _emit({"error": "usage error"})
        return exc.code if isinstance(exc.code, int) else 2

    try:
        _emit(_run(args))
        return 0
    except ValueError as exc:
        _emit({"error": str(exc)})
        return 2
    except Exception as exc:  # noqa: BLE001 - one JSON error document, never a traceback
        _emit({"error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
