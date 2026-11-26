"""Automatic llama.cpp binary installer (Windows CUDA/Vulkan/CPU + PATH fallback).

Adapted from auto_summary/integration/llama_install.py for Hindsight's zero-external-service
local inference stack without requiring Python torch/llama-cpp-python wheels.

CLI usage:
    python -m hindsight_api.engine.llama_install                  # install llama.cpp runtime
    python -m hindsight_api.engine.llama_install --check          # check installation status
    python -m hindsight_api.engine.llama_install --backend cpu    # force CPU build
    python -m hindsight_api.engine.llama_install --download-model qwen3-0.6b
    python -m hindsight_api.engine.llama_install --all-defaults   # install runtime + default GGUFs
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
NIGHTLY_POINTER = "nightly-tag.txt"
MIN_BUILD = 10630

BACKENDS: dict[str, tuple[str, str | None]] = {
    "cuda12.4": ("cuda-12.4-x64", "cudart-llama-bin-win-cuda-12.4-x64.zip"),
    "cuda13": ("cuda-13.*-x64", "cudart-llama-bin-win-cuda-13.*-x64.zip"),
    "cuda13.3": ("cuda-13.*-x64", "cudart-llama-bin-win-cuda-13.*-x64.zip"),
    "vulkan": ("vulkan-x64", None),
    "cpu": ("cpu-x64", None),
}

REQUIRED_EXES = ["llama-server.exe"] if os.name == "nt" else ["llama-server"]

CUDA_RUNTIME_DLLS: dict[str, list[str]] = {
    "cuda12.4": ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
    "cuda13": ["cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll"],
    "cuda13.3": ["cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll"],
}

_CUDA13_MIN_DRIVER_API = 13000
_CUDA13_MIN_CC = 7.5
_PROGRESS_STEP = 128 * 1024 * 1024


def get_llama_root() -> Path:
    """Return the root directory for managed llama.cpp binaries and metadata."""
    env_dir = os.getenv("HINDSIGHT_API_LLAMACPP_DIR")
    if env_dir:
        return Path(env_dir)
    if os.name == "nt":
        local_app_data = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local_app_data) / "hindsight" / "llama.cpp"
    xdg_cache = os.getenv("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(xdg_cache) / "hindsight" / "llama.cpp"


def get_bin_dir() -> Path:
    """Return the directory containing llama-server executable."""
    return get_llama_root() / "bin"


def get_server_exe() -> Path:
    """Return the path to llama-server(.exe), falling back to PATH on non-Windows."""
    exe_name = "llama-server.exe" if os.name == "nt" else "llama-server"
    managed = get_bin_dir() / exe_name
    if managed.is_file():
        return managed
    on_path = shutil.which(exe_name)
    if on_path:
        return Path(on_path)
    return managed


def get_marker_path() -> Path:
    return get_llama_root() / "installed.json"


def _log(msg: str) -> None:
    logger.info("[llama-install] %s", msg)
    print(f"[llama-install] {msg}", flush=True)


def nvidia_gpu_info() -> dict[str, Any] | None:
    """Read NVIDIA GPU info from the Windows registry (more reliable than NVML)."""
    if os.name != "nt":
        return None
    try:
        import winreg
    except ImportError:
        return None
    class_key = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, class_key)
    except OSError:
        return None
    try:
        for i in range(32):
            try:
                sub_name = winreg.EnumKey(root, i)
            except OSError:
                break
            try:
                sub = winreg.OpenKey(root, sub_name)
                desc = winreg.QueryValueEx(sub, "DriverDesc")[0]
            except OSError:
                continue
            if "NVIDIA" not in str(desc).upper():
                continue
            info: dict[str, Any] = {"name": desc}
            try:
                info["driver"] = winreg.QueryValueEx(sub, "DriverVersion")[0]
            except OSError:
                info["driver"] = ""
            try:
                size = winreg.QueryValueEx(sub, "HardwareInformation.qwMemorySize")[0]
                info["vram_gb"] = round(size / (1024**3), 1)
            except OSError:
                info["vram_gb"] = None
            return info
    finally:
        root.Close()
    return None


def cuda_device_info() -> dict[str, Any] | None:
    """Query CUDA driver API (nvcuda.dll) directly for compute capability and driver API version."""
    if os.name != "nt":
        return None
    try:
        import ctypes

        cu = ctypes.WinDLL("nvcuda.dll")
        if cu.cuInit(0) != 0:
            return None
        dev = ctypes.c_int()
        if cu.cuDeviceGet(ctypes.byref(dev), 0) != 0:
            return None
        maj, mino = ctypes.c_int(), ctypes.c_int()
        if cu.cuDeviceComputeCapability(ctypes.byref(maj), ctypes.byref(mino), dev) != 0:
            return None
        name = ctypes.create_string_buffer(256)
        try:
            cu.cuDeviceGetName(name, 256, dev)
            gpu_name = name.value.decode(errors="replace")
        except Exception:
            gpu_name = ""
        api = ctypes.c_int()
        try:
            cu.cuDriverGetVersion(ctypes.byref(api))
        except Exception:
            api.value = 0
        return {
            "name": gpu_name,
            "cc": f"{maj.value}.{mino.value}",
            "cc_major": maj.value,
            "cc_minor": mino.value,
            "driver_api": api.value,
        }
    except (OSError, AttributeError):
        return None


def detect_backend() -> str:
    """Select the best llama.cpp prebuilt backend for this machine."""
    info = cuda_device_info()
    if info:
        api = info.get("driver_api") or 0
        cc = float(f"{info.get('cc_major') or 0}.{info.get('cc_minor') or 0}")
        if api >= _CUDA13_MIN_DRIVER_API and cc >= _CUDA13_MIN_CC:
            return "cuda13"
        return "cuda12.4"
    return "cuda12.4" if nvidia_gpu_info() else "cpu"


async def _api_get(session: aiohttp.ClientSession, url: str) -> Any:
    headers = {
        "User-Agent": "hindsight-llama-install",
        "Accept": "application/vnd.github+json",
    }
    async with session.get(url, headers=headers) as resp:
        resp.raise_for_status()
        return await resp.json()


async def _fetch_text(session: aiohttp.ClientSession, url: str) -> str:
    headers = {"User-Agent": "hindsight-llama-install"}
    async with session.get(url, headers=headers) as resp:
        resp.raise_for_status()
        return (await resp.text()).strip()


def _build_number(tag: str) -> int:
    tail = str(tag).lstrip("bB")
    return int(tail) if tail.isdigit() else 0


def _has_win_assets(release: dict[str, Any]) -> bool:
    return any(a["name"].endswith("bin-win-cpu-x64.zip") for a in release.get("assets", []))


async def _resolve_nightly(session: aiohttp.ClientSession, release: dict[str, Any]) -> dict[str, Any]:
    if _has_win_assets(release):
        return release
    pointer = next(
        (a["browser_download_url"] for a in release.get("assets", []) if a["name"] == NIGHTLY_POINTER),
        None,
    )
    if not pointer:
        return release
    tag = await _fetch_text(session, pointer)
    _log(f"Release pointer: {release.get('tag_name')} -> nightly {tag}")
    return await _api_get(session, f"{RELEASES_API}/tags/{tag}")


async def pick_release(
    session: aiohttp.ClientSession,
    build: str | int | None = None,
    min_build: int = MIN_BUILD,
    pages: int = 3,
) -> dict[str, Any] | None:
    """Pick a llama.cpp release that contains Windows prebuilt binaries."""
    if build:
        tag = str(build) if str(build).startswith("b") else f"b{build}"
        return await _api_get(session, f"{RELEASES_API}/tags/{tag}")

    try:
        rel = await _resolve_nightly(session, await _api_get(session, f"{RELEASES_API}/latest"))
        if _has_win_assets(rel) and _build_number(rel.get("tag_name", "")) >= min_build:
            return rel
    except (aiohttp.ClientError, ValueError, KeyError, RuntimeError):
        pass

    for page in range(1, pages + 1):
        releases = await _api_get(session, f"{RELEASES_API}?per_page=30&page={page}")
        for rel in releases:
            if rel.get("draft") or not _has_win_assets(rel):
                continue
            if _build_number(rel.get("tag_name", "")) < min_build:
                return None
            return rel
    return None


async def resolve_assets(
    session: aiohttp.ClientSession,
    release: dict[str, Any],
    backend: str,
) -> list[tuple[str, str]]:
    """Resolve the main zip and optional CUDA runtime zip from a release."""
    import fnmatch

    suffix, cudart_pattern = BACKENDS[backend]
    tag = release["tag_name"]
    by_name = {a["name"]: a["browser_download_url"] for a in release.get("assets", [])}
    main_matches = sorted(
        n for n in by_name if fnmatch.fnmatch(n, f"*bin-win-{suffix}.zip") and not n.startswith("cudart-")
    )
    if not main_matches and backend.startswith("cuda13"):
        # Fall back to cuda12.4 if a release doesn't ship cuda-13.*
        suffix, cudart_pattern = BACKENDS["cuda12.4"]
        main_matches = sorted(
            n for n in by_name if fnmatch.fnmatch(n, f"*bin-win-{suffix}.zip") and not n.startswith("cudart-")
        )
    main_name = main_matches[-1] if main_matches else None
    if not main_name:
        raise RuntimeError(f"{tag} does not contain a Windows {backend} package (suffix bin-win-{suffix}.zip)")

    picked = [(main_name, by_name[main_name])]
    if cudart_pattern:
        cudart_matches = sorted(n for n in by_name if fnmatch.fnmatch(n, cudart_pattern))
        url = by_name[cudart_matches[-1]] if cudart_matches else None
        if not url:
            try:
                latest = (await _api_get(session, f"{RELEASES_API}?per_page=1"))[0]
                latest_by_name = {a["name"]: a["browser_download_url"] for a in latest.get("assets", [])}
                m = sorted(n for n in latest_by_name if fnmatch.fnmatch(n, cudart_pattern))
                url = latest_by_name[m[-1]] if m else None
            except (aiohttp.ClientError, ValueError, IndexError):
                url = None
        if not url:
            try:
                nightly = await _resolve_nightly(session, await _api_get(session, f"{RELEASES_API}/latest"))
                nightly_by_name = {a["name"]: a["browser_download_url"] for a in nightly.get("assets", [])}
                m = sorted(n for n in nightly_by_name if fnmatch.fnmatch(n, cudart_pattern))
                url = nightly_by_name[m[-1]] if m else None
            except (aiohttp.ClientError, ValueError, KeyError, RuntimeError):
                url = None
        if url:
            cudart_name = url.rsplit("/", 1)[-1]
            picked.append((cudart_name, url))
        else:
            _log(f"Warning: {cudart_pattern} not found; installing main package only")
    return picked


def _write_download_progress(
    progress_path: Path,
    *,
    status: str,
    downloaded_bytes: int,
    total_bytes: int | None,
    error: str | None = None,
) -> None:
    payload = {
        "status": status,
        "downloaded_bytes": downloaded_bytes,
        "total_bytes": total_bytes,
        "error": error,
        "pid": os.getpid(),
        "updated_at": time.time(),  # noqa: TID251
    }
    try:
        tmp = progress_path.with_suffix(".progress.tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(progress_path)
    except OSError:
        pass


async def download_file_async(url: str, dest_path: Path, resume: bool = True, max_attempts: int = 40) -> Path:
    """Stream-download a file with HTTP Range resume and automatic retry."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = Path(f"{dest_path}.part")
    progress_path = Path(f"{dest_path}.progress.json")
    total: int | None = None
    attempt = 0

    timeout = aiohttp.ClientTimeout(connect=30.0, sock_read=180.0, sock_connect=30.0)
    async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
        while True:
            have = tmp_path.stat().st_size if (resume and tmp_path.exists()) else 0
            if total is not None and have >= total:
                break
            attempt += 1
            if attempt > max_attempts:
                msg = f"Download failed after {max_attempts} attempts: {dest_path.name}"
                _write_download_progress(
                    progress_path, status="error", downloaded_bytes=have, total_bytes=total, error=msg
                )
                raise RuntimeError(msg)

            headers = (
                {"Range": f"bytes={have}-", "User-Agent": "hindsight-llama-install"}
                if have
                else {"User-Agent": "hindsight-llama-install"}
            )
            mode = "ab" if have else "wb"
            try:
                async with session.get(url, headers=headers, allow_redirects=True) as resp:
                    content_len = resp.headers.get("Content-Length")
                    if have and resp.status == 206:
                        total = have + int(content_len or 0)
                    elif resp.status == 200:
                        if have:
                            _log("Server ignored Range header; restarting download")
                            have, mode = 0, "wb"
                        total = int(content_len) if content_len else None
                    else:
                        resp.raise_for_status()

                    done = have
                    next_mark = (have // _PROGRESS_STEP + 1) * _PROGRESS_STEP
                    last_progress_write = 0.0
                    _write_download_progress(
                        progress_path, status="downloading", downloaded_bytes=done, total_bytes=total
                    )
                    with open(tmp_path, mode) as f:
                        async for chunk in resp.content.iter_chunked(1024 * 1024):
                            if not chunk:
                                continue
                            f.write(chunk)
                            done += len(chunk)
                            now = time.monotonic()
                            if now - last_progress_write >= 0.5:
                                _write_download_progress(
                                    progress_path,
                                    status="downloading",
                                    downloaded_bytes=done,
                                    total_bytes=total,
                                )
                                last_progress_write = now
                            if done >= next_mark:
                                pct = f" ({done * 100 // total}%)" if total else ""
                                _log(f"  downloaded {done / 1048576:.0f}MB{pct}")
                                next_mark += _PROGRESS_STEP
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as exc:
                got = tmp_path.stat().st_size if tmp_path.exists() else 0
                _write_download_progress(
                    progress_path,
                    status="downloading",
                    downloaded_bytes=got,
                    total_bytes=total,
                    error=f"{type(exc).__name__}: {exc}",
                )
                _log(f"  interrupted at {got / 1048576:.0f}MB (attempt {attempt}): {type(exc).__name__}, retrying")
                await asyncio.sleep(3)
                continue

            if total is None:
                break

    shutil.move(str(tmp_path), str(dest_path))
    progress_path.unlink(missing_ok=True)
    return dest_path


def extract_zip(zip_path: Path, bin_dir: Path) -> None:
    """Extract binaries/DLLs from a llama.cpp zip archive into bin_dir."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            base = os.path.basename(member.filename)
            if not base:
                continue
            target = bin_dir / base
            with zf.open(member, "r") as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def read_marker() -> dict[str, Any]:
    marker_path = get_marker_path()
    if not marker_path.is_file():
        return {}
    try:
        return json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def installed_exes() -> list[str]:
    bin_dir = get_bin_dir()
    return [exe for exe in REQUIRED_EXES if (bin_dir / exe).is_file()]


def missing_cuda_runtime(backend: str | None = None) -> list[str]:
    if backend is None:
        backend = read_marker().get("backend")
    if backend not in CUDA_RUNTIME_DLLS:
        return []
    bin_dir = get_bin_dir()
    return [dll for dll in CUDA_RUNTIME_DLLS[backend] if not (bin_dir / dll).is_file()]


def is_installed() -> bool:
    """Return True if llama-server is available (managed or on PATH)."""
    if get_server_exe().is_file():
        marker = read_marker()
        if marker and missing_cuda_runtime(marker.get("backend")):
            return False
        return True
    return False


async def install_async(
    backend: str = "auto",
    build: str | int | None = None,
    force: bool = False,
    keep_zips: bool = False,
) -> dict[str, Any]:
    """Download and install llama.cpp Windows binaries into get_bin_dir()."""
    if os.name != "nt":
        exe = get_server_exe()
        if exe.is_file():
            return {"bin_dir": str(exe.parent), "backend": "system"}
        raise RuntimeError(
            "Automatic binary download is currently supported on Windows. "
            "On Linux/macOS, install llama.cpp (llama-server) and ensure it is on PATH."
        )

    if is_installed() and not force:
        return read_marker()

    if backend == "auto":
        backend = detect_backend()
        _log(f"Auto-detected backend: {backend}")

    timeout = aiohttp.ClientTimeout(total=60.0)
    async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
        release = await pick_release(session, build)
        if not release:
            raise RuntimeError(
                f"No Windows llama.cpp release >= b{MIN_BUILD} found; pass --build <num> or check GitHub connectivity."
            )
        tag = release["tag_name"]
        num = _build_number(tag)
        if num and num < MIN_BUILD:
            raise RuntimeError(f"{tag} is older than MIN_BUILD={MIN_BUILD}")
        assets = await resolve_assets(session, release, backend)

    _log(f"Installing {tag} ({backend}), {len(assets)} archive(s)")

    llama_root = get_llama_root()
    bin_dir = get_bin_dir()
    zip_dir = llama_root / "zips"
    marker = read_marker()
    extracted = set(marker.get("extracted", []))

    for name, url in assets:
        zip_path = zip_dir / name
        done_flag = Path(f"{zip_path}.done")
        if name in extracted and done_flag.is_file():
            _log(f"Already extracted {name}, skipping")
            continue
        if not zip_path.is_file():
            _log(f"Downloading {name}")
            await download_file_async(url, zip_path)
        _log(f"Extracting {name}")
        extract_zip(zip_path, bin_dir)
        done_flag.write_text("", encoding="utf-8")
        extracted.add(name)
        marker["extracted"] = sorted(extracted)
        llama_root.mkdir(parents=True, exist_ok=True)
        get_marker_path().write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
        if not keep_zips:
            zip_path.unlink(missing_ok=True)

    missing = [e for e in REQUIRED_EXES if e not in installed_exes()]
    missing += missing_cuda_runtime(backend)
    if missing:
        raise RuntimeError(f"Incomplete llama.cpp installation, missing: {missing} in {bin_dir}")

    marker = {
        "tag": tag,
        "build": num,
        "backend": backend,
        "installed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "bin_dir": str(bin_dir),
    }
    get_marker_path().write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
    _log(f"Installed {tag} ({backend}) -> {bin_dir}")
    return marker


async def ensure_llama_binaries_async(
    backend: str | None = None,
    build: str | int | None = None,
    auto_install: bool | None = None,
    force: bool = False,
) -> bool:
    """Ensure llama-server is available; auto-install if enabled."""
    if is_installed() and not force:
        return True
    if auto_install is None:
        auto_install = os.getenv("HINDSIGHT_API_LLAMACPP_AUTO_INSTALL", "true").lower() in ("1", "true", "yes")
    if not auto_install:
        raise RuntimeError(
            f"llama-server not found at {get_server_exe()} and HINDSIGHT_API_LLAMACPP_AUTO_INSTALL is disabled. "
            "Run `python -m hindsight_api.engine.llama_install` to install it."
        )
    chosen_backend = backend or os.getenv("HINDSIGHT_API_LLAMACPP_BACKEND", "auto")
    await install_async(backend=chosen_backend, build=build, force=force)
    return is_installed()


def verify() -> dict[str, Any]:
    """Inspect llama.cpp installation status."""
    marker = read_marker()
    exe = get_server_exe()
    report: dict[str, Any] = {
        "bin_dir": str(get_bin_dir()),
        "server_exe": str(exe),
        "installed": is_installed(),
        "exes_present": installed_exes(),
        "missing_cuda_runtime": missing_cuda_runtime(),
        "marker": marker,
        "build_ok": (marker.get("build") or 0) >= MIN_BUILD if marker else exe.is_file(),
        "min_build": MIN_BUILD,
        "version_output": "",
    }
    if exe.is_file():
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            out = subprocess.run(
                [str(exe), "--version"],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=str(exe.parent),
                creationflags=flags,
            )
            lines = ((out.stdout or "") + (out.stderr or "")).strip().splitlines()
            report["version_output"] = lines[0] if lines else ""
        except (OSError, subprocess.SubprocessError) as exc:
            report["version_output"] = f"error: {exc}"
    return report


async def _async_main(args: argparse.Namespace) -> int:
    await ensure_llama_binaries_async(backend=args.backend, build=args.build, auto_install=True, force=args.force)

    presets = list(args.download_model)
    if args.all_defaults:
        for p in ("gemma-4-e2b-it", "BAAI/bge-small-en-v1.5", "qwen3-0.6b"):
            if p not in presets:
                presets.append(p)

    if presets:
        from .llama_server import ensure_gguf_file_async

        for preset in presets:
            path, _ = await ensure_gguf_file_async(preset)
            print(f"[llama-install] Model ready: {preset} -> {path}")

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One-click installer for llama.cpp runtime and GGUF model weights")
    parser.add_argument("--backend", default=None, choices=["auto", *BACKENDS.keys()], help="Target backend")
    parser.add_argument("--build", default=None, help="Specific llama.cpp build tag (e.g. b10909)")
    parser.add_argument("--force", action="store_true", help="Reinstall even if already present")
    parser.add_argument("--check", action="store_true", help="Check installation status without downloading")
    parser.add_argument("--keep-zips", action="store_true", help="Keep downloaded zip archives")
    parser.add_argument(
        "--download-model",
        action="append",
        default=[],
        help="Download a GGUF preset (e.g. gemma-4-e2b-it, bge-small-en-v1.5, qwen3-0.6b, hs-rerank-1)",
    )
    parser.add_argument(
        "--all-defaults",
        action="store_true",
        help="Install llama.cpp runtime plus default local LLM, embeddings (including qwen3-0.6b), and reranker weights",
    )
    args = parser.parse_args(argv)

    if args.check:
        rep = verify()
        for k, v in rep.items():
            print(f"{k}: {v}")
        return 0 if rep["installed"] else 1

    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    sys.exit(main())
