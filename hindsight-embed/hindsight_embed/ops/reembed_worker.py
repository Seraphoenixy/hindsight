"""Detached background worker to re-embed a profile's database and restart its daemon."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from .. import daemon_client
from ..daemon_embed_manager import DaemonEmbedManager
from ..profile_manager import ProfileManager, parse_env_file
from .local_models import reembed_status_path


def _write_status(
    path: Path,
    *,
    status: str,
    phase: str,
    rows_embedded: int,
    message: str,
    message_zh: str,
    error: str | None = None,
) -> None:
    payload = {
        "status": status,
        "phase": phase,
        "rows_embedded": rows_embedded,
        "message": message,
        "message_zh": message_zh,
        "error": error,
        "pid": os.getpid(),
        "updated_at": time.time(),
    }
    tmp = path.with_suffix(".reembed.tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)


async def _run_reembed_async(profile: str, status_path: Path) -> None:
    import asyncpg
    from hindsight_api.admin.reembed import finish_schema, reembed_schema
    from hindsight_api.config import clear_config_cache
    from hindsight_api.engine.embeddings import create_embeddings_from_env

    cfg_path = ProfileManager().resolve_profile_paths(profile).config
    env = parse_env_file(cfg_path) if cfg_path.exists() else {}
    for key, value in env.items():
        if key.startswith("HINDSIGHT_") and value is not None:
            os.environ[key] = str(value)

    manager = DaemonEmbedManager()
    database_url = manager.resolve_database_url(profile, env)
    os.environ["HINDSIGHT_API_DATABASE_URL"] = database_url
    schema = (env.get("HINDSIGHT_API_DATABASE_SCHEMA") or "public").strip() or "public"

    pg_instance = None
    started_pg0 = False
    embeddings = None
    conn = None

    try:
        if database_url.startswith("pg0://"):
            from .local_models import open_pg0_instance

            _write_status(
                status_path,
                status="running",
                phase="starting_db",
                rows_embedded=0,
                message="Starting local PostgreSQL...",
                message_zh="正在启动本地数据库…",
            )
            opened = open_pg0_instance(database_url)
            assert opened is not None
            pg_instance, pg_uri, started_pg0 = opened
        else:
            pg_uri = database_url

        _write_status(
            status_path,
            status="running",
            phase="initializing_model",
            rows_embedded=0,
            message="Initializing target embedding model...",
            message_zh="正在加载目标向量化模型…",
        )
        # The factory reads the cached config; refresh it after loading this profile.
        clear_config_cache()
        embeddings = create_embeddings_from_env()
        await embeddings.initialize()

        _write_status(
            status_path,
            status="running",
            phase="reembedding",
            rows_embedded=0,
            message="Re-embedding stored memories...",
            message_zh="正在原地重算所有记忆向量…",
        )
        conn = await asyncpg.connect(pg_uri)
        res = await reembed_schema(conn, pg_uri, schema, embeddings)
        await finish_schema(conn, schema)
        await conn.close()
        conn = None

        if started_pg0 and pg_instance is not None:
            pg_instance.stop()
            started_pg0 = False

        _write_status(
            status_path,
            status="running",
            phase="restarting_daemon",
            rows_embedded=res.rows_embedded,
            message="Starting daemon with new embedding model...",
            message_zh="向量重算完成，正在启动服务…",
        )
        daemon_cfg = {k: v for k, v in env.items()}
        ok = daemon_client.ensure_daemon_running(daemon_cfg, profile)
        if not ok:
            raise RuntimeError("Re-embed succeeded, but daemon failed to start. Check daemon logs.")

        _write_status(
            status_path,
            status="done",
            phase="done",
            rows_embedded=res.rows_embedded,
            message=f"Re-embedded {res.rows_embedded} rows and restarted daemon.",
            message_zh=f"已重算 {res.rows_embedded} 条向量并重启服务。",
        )
    except Exception as exc:  # noqa: BLE001
        _write_status(
            status_path,
            status="error",
            phase="error",
            rows_embedded=0,
            message=f"Re-embed failed: {exc}",
            message_zh=f"向量重算失败：{exc}",
            error=str(exc),
        )
    finally:
        if conn is not None:
            try:
                await conn.close()
            except Exception:
                pass
        if started_pg0 and pg_instance is not None:
            try:
                pg_instance.stop()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="")
    args = parser.parse_args()
    status_path = reembed_status_path(args.profile)
    asyncio.run(_run_reembed_async(args.profile, status_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
