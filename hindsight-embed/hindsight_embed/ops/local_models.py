"""Local GGUF model status/download and embedding dimension compatibility helpers."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import daemon_client
from ..profile_manager import ProfileManager, parse_env_file

_VECTOR_TYPE_RE = re.compile(r"^vector\((\d+)\)$")


@dataclass(frozen=True)
class LocalModelStatus:
    """Download and usage status for one built-in GGUF preset."""

    name: str
    mode: str
    filename: str
    dimensions: int | None
    ctx: int
    downloaded: bool
    downloading: bool
    downloaded_bytes: int
    total_bytes: int | None
    path: str
    in_use: bool
    error: str | None = None


@dataclass(frozen=True)
class LocalModelsView:
    """All built-in GGUF presets and their on-disk status."""

    gguf_dir: str
    models: list[LocalModelStatus]


@dataclass(frozen=True)
class DownloadLocalModelResult:
    """Outcome of initiating a local GGUF model download."""

    ok: bool
    status: str  # "downloading" | "already_downloaded"
    model: str
    filename: str
    message: str
    message_zh: str


@dataclass(frozen=True)
class EmbeddingCompatibilityView:
    """Whether the profile's database embedding dimension matches target settings."""

    compatible: bool
    reason: str  # "ok" | "no_database" | "dimension_mismatch" | "unknown_target_dimension" | "unsupported"
    current_dimension: int | None
    target_dimension: int | None
    memory_count: int
    mental_model_count: int
    is_pg0: bool
    can_reembed: bool
    message: str
    message_zh: str


@dataclass(frozen=True)
class ReembedStatusView:
    """Status of a background re-embed + switch job for a profile."""

    status: str  # "idle" | "running" | "done" | "error"
    phase: str
    rows_embedded: int
    message: str
    message_zh: str
    error: str | None = None


@dataclass(frozen=True)
class ResetMemoriesResult:
    """Outcome of clearing local memories and restarting the daemon."""

    ok: bool
    daemon_running: bool
    message: str
    message_zh: str


def _is_pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _detached_popen_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        return {"creationflags": CREATE_NO_WINDOW | DETACHED_PROCESS}
    return {"start_new_session": True}


def _effective_env(name: str, overrides: dict[str, str] | None = None) -> dict[str, str]:
    path = ProfileManager().resolve_profile_paths(name).config
    env = parse_env_file(path) if path.exists() else {}
    if overrides:
        for key, value in overrides.items():
            if value == "":
                env.pop(key, None)
            else:
                env[key] = value
    return env


def _active_preset_names(env: dict[str, str]) -> set[str]:
    from hindsight_api.config import (
        DEFAULT_EMBEDDINGS_LOCAL_MODEL,
        DEFAULT_EMBEDDINGS_PROVIDER,
        DEFAULT_LLM_PROVIDER,
        DEFAULT_RERANKER_LOCAL_MODEL,
        DEFAULT_RERANKER_PROVIDER,
    )
    from hindsight_api.engine.llama_server import resolve_preset

    active: set[str] = set()
    emb_provider = (env.get("HINDSIGHT_API_EMBEDDINGS_PROVIDER") or DEFAULT_EMBEDDINGS_PROVIDER).strip().lower()
    if emb_provider in ("local", "llamacpp"):
        emb_model = env.get("HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL") or DEFAULT_EMBEDDINGS_LOCAL_MODEL
        preset = resolve_preset(emb_model)
        if preset:
            active.add(preset.name)

    rerank_provider = (env.get("HINDSIGHT_API_RERANKER_PROVIDER") or DEFAULT_RERANKER_PROVIDER).strip().lower()
    if rerank_provider in ("local", "llamacpp"):
        rerank_model = env.get("HINDSIGHT_API_RERANKER_LOCAL_MODEL") or DEFAULT_RERANKER_LOCAL_MODEL
        preset = resolve_preset(rerank_model)
        if preset:
            active.add(preset.name)

    llm_provider = (env.get("HINDSIGHT_API_LLM_PROVIDER") or DEFAULT_LLM_PROVIDER).strip().lower()
    if llm_provider == "llamacpp":
        llm_model = env.get("HINDSIGHT_API_LLM_MODEL") or ""
        preset = resolve_preset(llm_model)
        if preset:
            active.add(preset.name)
    return active


def missing_local_models(name: str, overrides: dict[str, str] | None = None) -> list[tuple[str, str]]:
    """Return ``[(preset_name, filename), ...]`` for configured local presets not yet on disk."""
    from hindsight_api.engine.llama_server import get_gguf_dir, resolve_preset

    env = _effective_env(name, overrides)
    gguf_dir = get_gguf_dir()
    missing: list[tuple[str, str]] = []
    for preset_name in sorted(_active_preset_names(env)):
        preset = resolve_preset(preset_name)
        if preset and not (gguf_dir / preset.filename).is_file():
            missing.append((preset.name, preset.filename))
    return missing


def list_local_models(name: str) -> LocalModelsView:
    """Return download and active-usage status for every built-in GGUF preset."""
    from hindsight_api.engine.llama_server import _PRESET_LIST, get_gguf_dir

    env = _effective_env(name)
    active = _active_preset_names(env)
    gguf_dir = get_gguf_dir()
    items: list[LocalModelStatus] = []

    for preset in _PRESET_LIST:
        dest = gguf_dir / preset.filename
        part = Path(f"{dest}.part")
        progress_path = Path(f"{dest}.progress.json")
        downloaded = dest.is_file()

        progress_data: dict[str, Any] = {}
        if not downloaded and progress_path.is_file():
            try:
                progress_data = json.loads(progress_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                progress_data = {}

        pid = progress_data.get("pid")
        alive = _is_pid_alive(int(pid)) if isinstance(pid, int) else False
        downloading = (not downloaded) and progress_data.get("status") == "downloading" and alive

        if downloaded:
            downloaded_bytes = dest.stat().st_size
            total_bytes: int | None = downloaded_bytes
            error: str | None = None
        else:
            downloaded_bytes = (
                part.stat().st_size if part.is_file() else int(progress_data.get("downloaded_bytes") or 0)
            )
            raw_total = progress_data.get("total_bytes")
            total_bytes = int(raw_total) if isinstance(raw_total, int) and raw_total > 0 else None
            error = progress_data.get("error") if isinstance(progress_data.get("error"), str) else None
            if not alive and progress_data.get("status") == "downloading" and not error:
                error = "Download process exited unexpectedly."

        items.append(
            LocalModelStatus(
                name=preset.name,
                mode=preset.mode,
                filename=preset.filename,
                dimensions=preset.dimensions,
                ctx=preset.ctx,
                downloaded=downloaded,
                downloading=downloading,
                downloaded_bytes=downloaded_bytes,
                total_bytes=total_bytes,
                path=str(dest),
                in_use=preset.name in active,
                error=error,
            )
        )

    return LocalModelsView(gguf_dir=str(gguf_dir), models=items)


def download_local_model(name: str, model: str) -> DownloadLocalModelResult:
    """Start a detached background download for a built-in GGUF preset."""
    from hindsight_api.engine.llama_server import get_gguf_dir, resolve_preset

    preset = resolve_preset(model)
    if preset is None:
        raise ValueError(f"Unknown local GGUF preset: {model}")

    gguf_dir = get_gguf_dir()
    gguf_dir.mkdir(parents=True, exist_ok=True)
    dest = gguf_dir / preset.filename
    if dest.is_file():
        return DownloadLocalModelResult(
            ok=True,
            status="already_downloaded",
            model=preset.name,
            filename=preset.filename,
            message=f"{preset.filename} is already downloaded.",
            message_zh=f"{preset.filename} 已下载完成。",
        )

    progress_path = Path(f"{dest}.progress.json")
    if progress_path.is_file():
        try:
            existing = json.loads(progress_path.read_text(encoding="utf-8"))
            pid = existing.get("pid")
            if existing.get("status") == "downloading" and isinstance(pid, int) and _is_pid_alive(pid):
                return DownloadLocalModelResult(
                    ok=True,
                    status="downloading",
                    model=preset.name,
                    filename=preset.filename,
                    message=f"{preset.filename} is already downloading.",
                    message_zh=f"{preset.filename} 正在后台下载中。",
                )
        except (OSError, ValueError):
            pass

    log_path = Path(f"{dest}.download.log")
    cmd = [sys.executable, "-m", "hindsight_api.engine.llama_install", "--download-model", preset.name]
    with log_path.open("ab") as log_file:
        proc = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            **_detached_popen_kwargs(),
        )

    part = Path(f"{dest}.part")
    have = part.stat().st_size if part.is_file() else 0
    progress_path.write_text(
        json.dumps(
            {
                "status": "downloading",
                "downloaded_bytes": have,
                "total_bytes": None,
                "error": None,
                "pid": proc.pid,
                "updated_at": time.time(),
            }
        ),
        encoding="utf-8",
    )

    return DownloadLocalModelResult(
        ok=True,
        status="downloading",
        model=preset.name,
        filename=preset.filename,
        message=f"Started downloading {preset.filename}.",
        message_zh=f"已开始下载 {preset.filename}。",
    )


def _target_embedding_dimension(env: dict[str, str]) -> int | None:
    from hindsight_api.config import (
        DEFAULT_EMBEDDINGS_LOCAL_MODEL,
        DEFAULT_EMBEDDINGS_OPENAI_MODEL,
        DEFAULT_EMBEDDINGS_PROVIDER,
    )
    from hindsight_api.engine.embeddings import OpenAIEmbeddings
    from hindsight_api.engine.llama_server import get_embedding_preset_dimension

    provider = (env.get("HINDSIGHT_API_EMBEDDINGS_PROVIDER") or DEFAULT_EMBEDDINGS_PROVIDER).strip().lower()
    if provider in ("local", "llamacpp"):
        model = env.get("HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL") or DEFAULT_EMBEDDINGS_LOCAL_MODEL
        return get_embedding_preset_dimension(model)

    if provider == "openai":
        dim_raw = (env.get("HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS") or "").strip()
        if dim_raw.isdigit():
            return int(dim_raw)
        model = (env.get("HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL") or DEFAULT_EMBEDDINGS_OPENAI_MODEL).strip()
        return OpenAIEmbeddings.MODEL_DIMENSIONS.get(model)

    if provider == "cohere":
        return 1024
    return None


def _resolve_db_url(name: str, env: dict[str, str]) -> str:
    from ..daemon_embed_manager import DaemonEmbedManager

    return DaemonEmbedManager().resolve_database_url(name, env)


def _pg0_instance_name(database_url: str) -> str:
    from hindsight_api.pg0 import parse_pg0_url

    parsed = parse_pg0_url(database_url)
    if parsed.is_pg0 and parsed.instance_name:
        return parsed.instance_name
    return database_url.removeprefix("pg0://").split("?", 1)[0].strip("/")


def open_pg0_instance(database_url: str, *, require_existing: bool = False) -> tuple[Any, str, bool] | None:
    """Resolve and start (if needed) a local pg0 instance.

    Returns ``(pg_instance, uri, started_temp)`` or ``None`` if ``require_existing``
    is True and the instance data directory does not exist yet.
    """
    import pg0

    instance = _pg0_instance_name(database_url)
    data_dir = Path.home() / ".pg0" / "instances" / instance / "data"
    if require_existing and not data_dir.exists():
        return None
    pg_instance = pg0.Pg0(name=instance)
    started_temp = False
    if not (data_dir / "postmaster.pid").exists():
        pg_instance.start()
        started_temp = True
    uri = pg_instance.uri
    if not uri:
        if started_temp:
            pg_instance.stop()
        raise RuntimeError("Local PostgreSQL did not provide a connection URI")
    return pg_instance, uri, started_temp


def _inspect_pg_embeddings(uri: str, schema: str) -> tuple[int | None, int, int]:
    import psycopg2
    from psycopg2 import sql

    conn = psycopg2.connect(uri, connect_timeout=5)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT format_type(a.atttypid, a.atttypmod)
                FROM pg_attribute a
                JOIN pg_class c ON a.attrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = %s AND c.relname = 'memory_units' AND a.attname = 'embedding'
                  AND NOT a.attisdropped
                """,
                (schema,),
            )
            row = cur.fetchone()
            if not row or not row[0]:
                return None, 0, 0
            match = _VECTOR_TYPE_RE.match(row[0])
            current_dim = int(match.group(1)) if match else None

            cur.execute(
                sql.SQL("SELECT COUNT(*) FROM {}.{} WHERE embedding IS NOT NULL").format(
                    sql.Identifier(schema), sql.Identifier("memory_units")
                )
            )
            memory_count = int(cur.fetchone()[0])

            mental_model_count = 0
            cur.execute(
                """
                SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = %s AND c.relname = 'mental_models'
                """,
                (schema,),
            )
            if cur.fetchone():
                cur.execute(
                    sql.SQL("SELECT COUNT(*) FROM {}.{} WHERE embedding IS NOT NULL").format(
                        sql.Identifier(schema), sql.Identifier("mental_models")
                    )
                )
                mental_model_count = int(cur.fetchone()[0])

            return current_dim, memory_count, mental_model_count
    finally:
        conn.close()


def check_embedding_compatibility(
    name: str,
    candidate_values: dict[str, str] | None = None,
) -> EmbeddingCompatibilityView:
    """Inspect existing database vector dimension vs target embedding settings."""
    env = _effective_env(name, candidate_values)
    target_dim = _target_embedding_dimension(env)
    database_url = _resolve_db_url(name, env)
    schema = (env.get("HINDSIGHT_API_DATABASE_SCHEMA") or "public").strip() or "public"
    is_pg0 = database_url.startswith("pg0://")

    if database_url.lower().startswith("oracle"):
        return EmbeddingCompatibilityView(
            compatible=True,
            reason="unsupported",
            current_dimension=None,
            target_dimension=target_dim,
            memory_count=0,
            mental_model_count=0,
            is_pg0=False,
            can_reembed=False,
            message="Pre-flight dimension check is PostgreSQL-only.",
            message_zh="前置维度检查仅支持 PostgreSQL。",
        )

    pg_instance: Any = None
    started_temp_pg0 = False
    try:
        if is_pg0:
            opened = open_pg0_instance(database_url, require_existing=True)
            if opened is None:
                return EmbeddingCompatibilityView(
                    compatible=True,
                    reason="no_database",
                    current_dimension=None,
                    target_dimension=target_dim,
                    memory_count=0,
                    mental_model_count=0,
                    is_pg0=True,
                    can_reembed=False,
                    message="Local database has not been initialized yet.",
                    message_zh="本地数据库尚未初始化，可直接启动。",
                )
            pg_instance, uri, started_temp_pg0 = opened
        else:
            uri = database_url

        current_dim, memory_count, mental_model_count = _inspect_pg_embeddings(uri, schema)
    except Exception as exc:  # noqa: BLE001
        return EmbeddingCompatibilityView(
            compatible=True,
            reason="ok",
            current_dimension=None,
            target_dimension=target_dim,
            memory_count=0,
            mental_model_count=0,
            is_pg0=is_pg0,
            can_reembed=False,
            message=f"Could not inspect database ({type(exc).__name__}); skipping pre-flight check.",
            message_zh=f"未能检查数据库（{type(exc).__name__}），跳过前置校验。",
        )
    finally:
        if started_temp_pg0 and pg_instance is not None:
            try:
                pg_instance.stop()
            except Exception:
                pass

    if current_dim is None or (memory_count == 0 and mental_model_count == 0):
        return EmbeddingCompatibilityView(
            compatible=True,
            reason="ok",
            current_dimension=current_dim,
            target_dimension=target_dim,
            memory_count=memory_count,
            mental_model_count=mental_model_count,
            is_pg0=is_pg0,
            can_reembed=False,
            message="Database is compatible with the selected embedding model.",
            message_zh="数据库与当前向量化模型兼容。",
        )

    if target_dim is None:
        return EmbeddingCompatibilityView(
            compatible=True,
            reason="unknown_target_dimension",
            current_dimension=current_dim,
            target_dimension=None,
            memory_count=memory_count,
            mental_model_count=mental_model_count,
            is_pg0=is_pg0,
            can_reembed=False,
            message=f"Database uses {current_dim} dims; target model dimension is custom/unknown.",
            message_zh=f"当前数据库为 {current_dim} 维；目标模型维度未知，将在启动时校验。",
        )

    if current_dim != target_dim:
        can_reembed = target_dim <= 2000
        return EmbeddingCompatibilityView(
            compatible=False,
            reason="dimension_mismatch",
            current_dimension=current_dim,
            target_dimension=target_dim,
            memory_count=memory_count,
            mental_model_count=mental_model_count,
            is_pg0=is_pg0,
            can_reembed=can_reembed,
            message=(
                f"Database has {memory_count} memories at {current_dim} dims, "
                f"but the selected model outputs {target_dim} dims."
            ),
            message_zh=(
                f"当前数据库包含 {memory_count} 条记忆（{current_dim} 维），"
                f"而目标模型输出 {target_dim} 维，直接启动会因维度不兼容失败。"
            ),
        )

    return EmbeddingCompatibilityView(
        compatible=True,
        reason="ok",
        current_dimension=current_dim,
        target_dimension=target_dim,
        memory_count=memory_count,
        mental_model_count=mental_model_count,
        is_pg0=is_pg0,
        can_reembed=True,
        message="Database embedding dimension matches the selected model.",
        message_zh="数据库向量维度与目标模型一致。",
    )


def reembed_status_path(name: str) -> Path:
    """Return the per-profile JSON status file for background re-embed jobs."""
    cfg_path = ProfileManager().resolve_profile_paths(name).config
    return cfg_path.with_name(f"{cfg_path.name}.reembed.json")


def get_reembed_status(name: str) -> ReembedStatusView:
    """Read the latest background re-embed status for a profile."""
    path = reembed_status_path(name)
    if not path.is_file():
        return ReembedStatusView(
            status="idle",
            phase="idle",
            rows_embedded=0,
            message="No re-embed job is running.",
            message_zh="当前没有运行中的向量重算任务。",
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ReembedStatusView(
            status="idle",
            phase="idle",
            rows_embedded=0,
            message="No re-embed job is running.",
            message_zh="当前没有运行中的向量重算任务。",
        )

    status = str(data.get("status") or "idle")
    pid = data.get("pid")
    if status == "running" and isinstance(pid, int) and not _is_pid_alive(pid):
        return ReembedStatusView(
            status="error",
            phase=str(data.get("phase") or "failed"),
            rows_embedded=int(data.get("rows_embedded") or 0),
            message="Re-embed worker exited unexpectedly.",
            message_zh="向量重算后台进程异常退出。",
            error=data.get("error") or "Re-embed worker exited unexpectedly.",
        )

    return ReembedStatusView(
        status=status,
        phase=str(data.get("phase") or status),
        rows_embedded=int(data.get("rows_embedded") or 0),
        message=str(data.get("message") or ""),
        message_zh=str(data.get("message_zh") or ""),
        error=data.get("error") if isinstance(data.get("error"), str) else None,
    )


def start_reembed(name: str, candidate_values: dict[str, str] | None = None) -> ReembedStatusView:
    """Save settings (optional), stop daemon, and launch background re-embed + restart."""
    from . import service

    if candidate_values:
        service.save_settings(name, candidate_values)

    missing = missing_local_models(name)
    if missing:
        names = ", ".join(filename for _, filename in missing)
        raise ValueError(f"Local GGUF model not downloaded yet: {names}")

    current = get_reembed_status(name)
    if current.status == "running":
        return current

    daemon_client.stop_daemon(name)

    status_path = reembed_status_path(name)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = status_path.with_suffix(".log")

    cmd = [sys.executable, "-m", "hindsight_embed.ops.reembed_worker", "--profile", name]
    with log_path.open("wb") as log_file:
        proc = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            **_detached_popen_kwargs(),
        )

    payload = {
        "status": "running",
        "phase": "starting",
        "rows_embedded": 0,
        "message": "Starting background re-embed job...",
        "message_zh": "正在启动后台向量重算任务…",
        "error": None,
        "pid": proc.pid,
        "updated_at": time.time(),
    }
    status_path.write_text(json.dumps(payload), encoding="utf-8")
    return get_reembed_status(name)


def reset_local_memories(name: str, candidate_values: dict[str, str] | None = None) -> ResetMemoriesResult:
    """Stop daemon, clear stored memories/vectors, save settings, and start daemon."""
    from . import service

    if candidate_values:
        service.save_settings(name, candidate_values)

    missing = missing_local_models(name)
    if missing:
        names = ", ".join(filename for _, filename in missing)
        raise ValueError(f"Local GGUF model not downloaded yet: {names}")

    daemon_client.stop_daemon(name)
    env = _effective_env(name)
    database_url = _resolve_db_url(name, env)
    schema = (env.get("HINDSIGHT_API_DATABASE_SCHEMA") or "public").strip() or "public"

    if database_url.startswith("pg0://"):
        instance = _pg0_instance_name(database_url)
        inst_dir = Path.home() / ".pg0" / "instances" / instance
        if (inst_dir / "data" / "postmaster.pid").exists():
            try:
                import pg0

                pg0.Pg0(name=instance).stop()
            except Exception:
                pass
        if inst_dir.exists():
            shutil.rmtree(inst_dir)
    else:
        import psycopg2
        from psycopg2 import sql

        conn = psycopg2.connect(database_url, connect_timeout=10)
        try:
            with conn:
                with conn.cursor() as cur:
                    for table in ("memory_units", "mental_models"):
                        cur.execute(
                            """
                            SELECT 1 FROM pg_class c
                            JOIN pg_namespace n ON c.relnamespace = n.oid
                            WHERE n.nspname = %s AND c.relname = %s
                            """,
                            (schema, table),
                        )
                        if cur.fetchone():
                            cur.execute(
                                sql.SQL("DELETE FROM {}.{}").format(sql.Identifier(schema), sql.Identifier(table))
                            )
        finally:
            conn.close()

    res = service.start_daemon(name)
    return ResetMemoriesResult(
        ok=res.ok,
        daemon_running=res.running,
        message="Local memories cleared and daemon restarted." if res.ok else res.message,
        message_zh="已清空本地记忆并重新启动服务。" if res.ok else res.message_zh,
    )
