"""Launch a shared UI outside a Windows caller's kill-on-close job.

Magpie owns its plugin process tree in a Windows Job Object. CREATE_NEW_PROCESS_GROUP
does not leave that job, and Magpie disallows CREATE_BREAKAWAY_FROM_JOB. Use the
existing local WMI process provider as the launch broker, under the same user.
No service, scheduled task or elevated process is installed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class UiLaunch:
    command: list[str]
    env: dict[str, str]
    log_path: str
    cwd: str
    append: bool = False
    pid_path: str | None = None


@dataclass
class BrokerResult:
    ReturnValue: int
    ProcessId: int


def in_windows_job() -> bool:
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.IsProcessInJob.restype = wintypes.BOOL
    result = wintypes.BOOL()
    if not kernel.IsProcessInJob(kernel.GetCurrentProcess(), None, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    return bool(result.value)


_CREATE = r"""
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputDoc = [Console]::In.ReadToEnd() | ConvertFrom-Json
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($inputDoc.command, $inputDoc.cwd, $startup)
$result | Select-Object ReturnValue, ProcessId | ConvertTo-Json -Compress
"""


def launch_independent_process(spec: UiLaunch) -> int | None:
    """Hand a one-use launch document to the OS broker, never credentials in argv."""
    if sys.platform != "win32":
        raise OSError("The WMI UI broker is only used on Windows")
    log_path = Path(spec.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # The profile directory already contains private configuration. The helper
    # deletes this transient environment document before launching the process.
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix=".ui-launch-", suffix=".json", dir=log_path.parent, delete=False
    ) as payload:
        payload_path = Path(payload.name)
        pid_path = Path(spec.pid_path) if spec.pid_path else payload_path.with_suffix(".pid")
        doc = asdict(spec)
        doc["pid_path"] = str(pid_path)
        json.dump(doc, payload)
    python = Path(sys.executable)
    pythonw = python.with_name("pythonw.exe")
    executable = str(pythonw if pythonw.exists() else python)
    command = subprocess.list2cmdline([executable, "-m", "hindsight_embed._ui_broker", str(payload_path)])
    powershell = str(
        Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    try:
        # CREATE_NO_WINDOW hides the broker. Do not also pass -WindowStyle:
        # Windows PowerShell can hang applying that option without a console.
        result = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", _CREATE],
            input=json.dumps({"command": command, "cwd": spec.cwd}),
            encoding="utf-8",
            capture_output=True,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=True,
        )
        response = BrokerResult(**json.loads(result.stdout.lstrip("\ufeff")))
        if response.ReturnValue != 0:
            raise OSError(f"Windows UI launch broker returned {response.ReturnValue}")
        deadline = time.monotonic() + 10
        while payload_path.exists():
            if time.monotonic() >= deadline:
                raise OSError("Windows UI launch helper did not accept its launch document")
            time.sleep(0.05)
        if pid_path.exists():
            raw_pid = pid_path.read_text(encoding="utf-8").strip()
            return int(raw_pid) if raw_pid.isdigit() else None
        return None
    except BaseException:
        payload_path.unlink(missing_ok=True)
        raise
    finally:
        if not spec.pid_path:
            pid_path.unlink(missing_ok=True)


def launch_independent_ui(spec: UiLaunch) -> int | None:
    """Launch the control plane UI outside a Windows caller's kill-on-close job."""
    return launch_independent_process(spec)


def _run(payload_path: Path) -> None:
    try:
        spec = UiLaunch(**json.loads(payload_path.read_text(encoding="utf-8")))
    except BaseException:
        payload_path.unlink(missing_ok=True)
        raise
    # This helper was created by WMI, so neither it nor the child belongs to the
    # plugin's job. Ordinary hidden-process flags now provide independent life.
    from .daemon_embed_manager import _detach_popen_kwargs

    try:
        with open(spec.log_path, "ab" if spec.append else "wb") as log:
            try:
                proc = subprocess.Popen(spec.command, env=spec.env, cwd=spec.cwd, **_detach_popen_kwargs(log))
                if spec.pid_path:
                    Path(spec.pid_path).write_text(str(proc.pid), encoding="utf-8")
            except Exception:
                import traceback

                log.write(traceback.format_exc().encode("utf-8"))
                raise
    finally:
        payload_path.unlink(missing_ok=True)


if __name__ == "__main__":
    _run(Path(sys.argv[1]))
