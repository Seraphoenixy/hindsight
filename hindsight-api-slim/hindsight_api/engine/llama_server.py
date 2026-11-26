"""Managed llama-server(.exe) lifecycle and GGUF weight downloader.

Provides zero-external-service local inference for LLM, embeddings, and reranking
by auto-installing llama.cpp binaries (via ``llama_install``), downloading GGUF
weights from HuggingFace / hf-mirror with resume support, and managing loopback
``llama-server`` processes on demand.
"""

from __future__ import annotations

import asyncio
import atexit
import logging
import os
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import aiohttp

from .llama_install import download_file_async, ensure_llama_binaries_async, get_bin_dir, get_server_exe

logger = logging.getLogger(__name__)

ServerMode = Literal["llm", "embedding", "reranking"]

_DEFAULT_PORTS: dict[ServerMode, int] = {
    "llm": 8901,
    "embedding": 8905,
    "reranking": 8906,
}


def get_hf_endpoint() -> str:
    """Return the HuggingFace download base URL (defaults to hf-mirror.com)."""
    return (os.getenv("HINDSIGHT_API_HF_ENDPOINT") or os.getenv("HF_ENDPOINT") or "https://hf-mirror.com").rstrip("/")


def get_gguf_dir() -> Path:
    """Return the directory where downloaded GGUF model weights are stored."""
    env_dir = os.getenv("HINDSIGHT_API_LLAMACPP_MODELS_DIR")
    if env_dir:
        return Path(env_dir)
    if os.name == "nt":
        local_app_data = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local_app_data) / "hindsight" / "models" / "llama.cpp"
    xdg_cache = os.getenv("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(xdg_cache) / "hindsight" / "models" / "llama.cpp"


@dataclass(frozen=True)
class GGUFPreset:
    """Definition of a downloadable GGUF model preset."""

    name: str
    mode: ServerMode
    filename: str
    repo_id: str
    ctx: int = 8192
    dimensions: int | None = None
    kv_quant: bool = False
    reasoning: str | None = None
    extra_args: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()

    def download_url(self) -> str:
        base = get_hf_endpoint()
        return f"{base}/{self.repo_id}/resolve/main/{self.filename}"


_PRESET_LIST: tuple[GGUFPreset, ...] = (
    # LLM presets
    GGUFPreset(
        name="gemma-4-e2b-it",
        mode="llm",
        filename="gemma-4-E2B-it-Q4_K_M.gguf",
        repo_id="unsloth/gemma-4-E2B-it-GGUF",
        ctx=8192,
        extra_args=("--jinja",),
        aliases=("google/gemma-4-e2b-it",),
    ),
    GGUFPreset(
        name="qwen3.5-4b",
        mode="llm",
        filename="Qwen3.5-4B-UD-Q4_K_XL.gguf",
        repo_id="unsloth/Qwen3.5-4B-GGUF",
        ctx=32768,
        kv_quant=True,
        reasoning="off",
        extra_args=("--jinja",),
        aliases=("qwen/qwen3.5-4b", "summarizer-4b"),
    ),
    # Embedding presets
    GGUFPreset(
        name="BAAI/bge-small-en-v1.5",
        mode="embedding",
        filename="bge-small-en-v1.5-q8_0.gguf",
        repo_id="CompendiumLabs/bge-small-en-v1.5-gguf",
        ctx=2048,
        dimensions=384,
        aliases=("bge-small-en-v1.5",),
    ),
    GGUFPreset(
        name="qwen3-0.6b",
        mode="embedding",
        filename="Qwen3-Embedding-0.6B-Q8_0.gguf",
        repo_id="Qwen/Qwen3-Embedding-0.6B-GGUF",
        ctx=8192,
        dimensions=1024,
        aliases=("Qwen/Qwen3-Embedding-0.6B", "qwen3-embedding-0.6b", "Qwen3-Embedding-0.6B"),
    ),
    GGUFPreset(
        name="bge-m3",
        mode="embedding",
        filename="bge-m3-Q8_0.gguf",
        repo_id="gpustack/bge-m3-GGUF",
        ctx=8192,
        dimensions=1024,
        aliases=("BAAI/bge-m3", "bge-m3-q8_0"),
    ),
    GGUFPreset(
        name="qwen3-4b",
        mode="embedding",
        filename="Qwen3-Embedding-4B-Q8_0.gguf",
        repo_id="Qwen/Qwen3-Embedding-4B-GGUF",
        ctx=8192,
        dimensions=2560,
        aliases=("Qwen/Qwen3-Embedding-4B", "qwen3-embedding-4b", "Qwen3-Embedding-4B"),
    ),
    # Reranker presets
    GGUFPreset(
        name="hindsight-ai/hs-rerank-1",
        mode="reranking",
        filename="bge-reranker-base-q8_0.gguf",
        repo_id="cstr/bge-reranker-base-GGUF",
        ctx=2048,
        aliases=("hs-rerank-1", "bge-reranker-base", "BAAI/bge-reranker-base"),
    ),
    GGUFPreset(
        name="bge-reranker-v2-m3",
        mode="reranking",
        filename="bge-reranker-v2-m3-Q8_0.gguf",
        repo_id="gpustack/bge-reranker-v2-m3-GGUF",
        ctx=4096,
        aliases=("BAAI/bge-reranker-v2-m3",),
    ),
)

GGUF_PRESETS: dict[str, GGUFPreset] = {}
for _p in _PRESET_LIST:
    GGUF_PRESETS[_p.name.lower()] = _p
    for _alias in _p.aliases:
        GGUF_PRESETS[_alias.lower()] = _p


def resolve_preset(name: str) -> GGUFPreset | None:
    """Look up a GGUF preset by canonical name or alias (case-insensitive)."""
    return GGUF_PRESETS.get(name.strip().lower())


def get_embedding_preset_dimension(model_name: str) -> int | None:
    """Return known embedding dimension for a local GGUF preset, if known."""
    preset = resolve_preset(model_name)
    if preset and preset.mode == "embedding":
        return preset.dimensions
    return None


async def ensure_gguf_file_async(model_or_path: str) -> tuple[Path, GGUFPreset | None]:
    """Ensure a GGUF model file exists locally, downloading it if it matches a preset."""
    candidate = Path(model_or_path)
    if candidate.is_file():
        return candidate, resolve_preset(candidate.stem)

    preset = resolve_preset(model_or_path)
    if preset is None:
        gguf_dir = get_gguf_dir()
        in_dir = gguf_dir / model_or_path
        if in_dir.is_file():
            return in_dir, None
        known = sorted({p.name for p in _PRESET_LIST})
        raise FileNotFoundError(
            f"Local GGUF model '{model_or_path}' not found on disk and is not a built-in preset. "
            f"Pass a valid .gguf file path or one of: {known}"
        )

    dest = get_gguf_dir() / preset.filename
    if not dest.is_file():
        no_auto = os.getenv("HINDSIGHT_API_LLAMACPP_NO_AUTO_DOWNLOAD", "").strip().lower() in ("1", "true", "yes", "on")
        if no_auto:
            raise FileNotFoundError(
                f"Local GGUF model '{preset.filename}' is not downloaded yet. "
                f"Download it from Local Settings or run: "
                f"python -m hindsight_api.engine.llama_install --download-model {preset.name}"
            )
        logger.info("[llama-gguf] Downloading %s from %s", preset.filename, preset.download_url())
        await download_file_async(preset.download_url(), dest)
    return dest, preset


def _find_free_port(preferred: int) -> int:
    """Return preferred port if available on 127.0.0.1, else pick an ephemeral port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", preferred)) != 0:
            return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _has_cuda_device(server_exe: Path) -> bool:
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        out = subprocess.run(
            [str(server_exe), "--list-devices"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(server_exe.parent),
            creationflags=flags,
        )
        return "CUDA" in ((out.stdout or "") + (out.stderr or ""))
    except (OSError, subprocess.SubprocessError):
        return False


def _resolve_gpu_layers(server_exe: Path, requested: int) -> int:
    if requested == 0:
        return 0
    if requested > 0:
        return requested
    # -1 (auto): offload all layers if CUDA is detected, otherwise CPU
    return 99 if _has_cuda_device(server_exe) else 0


@dataclass
class ManagedLlamaServer:
    """Manages a single loopback ``llama-server`` subprocess."""

    mode: ServerMode
    model: str
    model_path: str | None = None
    gpu_layers: int = -1
    context_size: int | None = None
    extra_args: str | None = None
    startup_timeout: float = 180.0
    port: int | None = None

    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _proc: subprocess.Popen[bytes] | None = field(default=None, init=False, repr=False)
    _base_url: str | None = field(default=None, init=False, repr=False)

    @property
    def base_url(self) -> str:
        if not self._base_url:
            raise RuntimeError("LlamaServer has not been started yet")
        return self._base_url

    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def _healthy_async(self, url: str) -> bool:
        try:
            timeout = aiohttp.ClientTimeout(total=2.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(f"{url}/health") as resp:
                    return resp.status == 200
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
            return False

    async def ensure_started_async(self) -> str:
        """Ensure runtime + GGUF exist and ``llama-server`` is healthy; return base_url."""
        if self.is_running() and self._base_url and await self._healthy_async(self._base_url):
            return self._base_url

        await ensure_llama_binaries_async()
        server_exe = get_server_exe()
        gguf_path, preset = await ensure_gguf_file_async(self.model_path or self.model)

        with self._lock:
            if self.is_running() and self._base_url:
                return self._base_url

            port = self.port if self.port is not None else _find_free_port(_DEFAULT_PORTS[self.mode])
            url = f"http://127.0.0.1:{port}"

            ngl = _resolve_gpu_layers(server_exe, self.gpu_layers)
            ctx = self.context_size or (preset.ctx if preset else 8192)

            cmd: list[str] = [
                str(server_exe),
                "-m",
                str(gguf_path),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "-ngl",
                str(ngl),
                "-c",
                str(ctx),
                "-fa",
                "on",
            ]
            if self.mode == "embedding":
                cmd.extend(["--embedding", "-b", str(ctx), "-ub", str(ctx)])
            elif self.mode == "reranking":
                cmd.extend(["--reranking", "-b", str(ctx), "-ub", str(ctx)])

            if preset:
                if preset.kv_quant:
                    cmd.extend(["-ctk", "q8_0", "-ctv", "q8_0"])
                if preset.reasoning:
                    cmd.extend(["--reasoning", preset.reasoning])
                cmd.extend(preset.extra_args)

            if self.extra_args:
                cmd.extend(self.extra_args.split())

            logger.info(
                "[llama-server] Starting %s mode on %s (model=%s, ngl=%d, ctx=%d)",
                self.mode,
                url,
                gguf_path.name,
                ngl,
                ctx,
            )

            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            cwd = str(get_bin_dir()) if get_bin_dir().is_dir() else str(server_exe.parent)
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                cwd=cwd,
                creationflags=flags,
            )
            self._base_url = url

        deadline = time.monotonic() + self.startup_timeout
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                rc = self._proc.returncode
                self._proc = None
                self._base_url = None
                raise RuntimeError(f"llama-server exited prematurely with code {rc} (model={gguf_path.name})")
            if await self._healthy_async(url):
                logger.info("[llama-server] Ready on %s", url)
                return url
            await asyncio.sleep(0.5)

        self.stop()
        raise TimeoutError(f"llama-server did not become healthy within {self.startup_timeout}s")

    def stop(self) -> None:
        with self._lock:
            if self._proc is not None:
                try:
                    self._proc.terminate()
                    self._proc.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        self._proc.kill()
                    except OSError:
                        pass
                finally:
                    self._proc = None
                    self._base_url = None


_REGISTRY_LOCK = threading.Lock()
_SERVERS: dict[tuple[ServerMode, str, str | None], ManagedLlamaServer] = {}


def get_llama_server(
    mode: ServerMode,
    model: str,
    *,
    model_path: str | None = None,
    gpu_layers: int = -1,
    context_size: int | None = None,
    extra_args: str | None = None,
) -> ManagedLlamaServer:
    """Return a shared ``ManagedLlamaServer`` instance for the given (mode, model, model_path)."""
    key = (mode, model, model_path)
    with _REGISTRY_LOCK:
        srv = _SERVERS.get(key)
        if srv is None:
            srv = ManagedLlamaServer(
                mode=mode,
                model=model,
                model_path=model_path,
                gpu_layers=gpu_layers,
                context_size=context_size,
                extra_args=extra_args,
            )
            _SERVERS[key] = srv
        return srv


def stop_all_llama_servers() -> None:
    """Stop all managed llama-server processes on interpreter exit."""
    with _REGISTRY_LOCK:
        servers = list(_SERVERS.values())
    for srv in servers:
        srv.stop()


atexit.register(stop_all_llama_servers)
