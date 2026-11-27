"""Targeted coverage for a UI that outlives its Windows plugin caller."""

import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from hindsight_embed._ui_broker import UiLaunch, launch_independent_process, launch_independent_ui
from hindsight_embed.daemon_embed_manager import DaemonEmbedManager

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows WMI launch broker")


def test_broker_preserves_environment_and_removes_launch_document(tmp_path: Path) -> None:
    root = tmp_path / "独立进程 with spaces"
    root.mkdir()
    log = root / "child.log"
    spec = UiLaunch(
        command=[
            sys.executable,
            "-c",
            "import os,time; assert os.environ['BROKER_TEST'] == '中文'; print(os.getpid(),flush=True); time.sleep(30)",
        ],
        env={**os.environ, "BROKER_TEST": "中文"},
        log_path=str(log),
        cwd=str(root),
    )
    pid = None
    try:
        returned_pid = launch_independent_ui(spec)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if log.exists() and log.read_text().strip().isdigit():
                pid = int(log.read_text().strip())
                break
            time.sleep(0.05)
        assert pid is not None, log.read_text() if log.exists() else "No child log"
        assert isinstance(returned_pid, int) and returned_pid > 0
        assert not list(root.glob(".ui-launch-*"))
    finally:
        if pid is not None:
            assert DaemonEmbedManager._kill_process(pid)


def test_broker_append_mode_preserves_existing_log(tmp_path: Path) -> None:
    log = tmp_path / "daemon.log"
    log.write_text("existing-line\n", encoding="utf-8")
    spec = UiLaunch(
        command=[sys.executable, "-c", "import time; print('new-line', flush=True); time.sleep(30)"],
        env=dict(os.environ),
        log_path=str(log),
        cwd=str(tmp_path),
        append=True,
    )
    pid = None
    try:
        pid = launch_independent_process(spec)
        assert isinstance(pid, int) and pid > 0
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            content = log.read_text(encoding="utf-8")
            if "new-line" in content:
                break
            time.sleep(0.05)
        content = log.read_text(encoding="utf-8")
        assert "existing-line" in content
        assert "new-line" in content
        assert not list(tmp_path.glob(".ui-launch-*"))
    finally:
        if pid is not None:
            assert DaemonEmbedManager._kill_process(pid)


def test_failed_broker_cleans_transient_environment(tmp_path: Path) -> None:
    spec = UiLaunch(
        command=[sys.executable], env={"SECRET": "private"}, log_path=str(tmp_path / "ui.log"), cwd=str(tmp_path)
    )
    with patch("hindsight_embed._ui_broker.subprocess.run", side_effect=OSError("WMI unavailable")):
        with pytest.raises(OSError, match="WMI unavailable"):
            launch_independent_ui(spec)
    assert not list(tmp_path.glob(".ui-launch-*"))


def test_start_daemon_uses_broker_when_in_windows_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HINDSIGHT_HOME", str(tmp_path))
    manager = DaemonEmbedManager()
    paths = manager._profile_manager.resolve_profile_paths("job-test")
    paths.config.parent.mkdir(parents=True, exist_ok=True)
    paths.config.write_text("HINDSIGHT_API_PORT=19999\n", encoding="utf-8")

    monkeypatch.setattr("hindsight_embed.daemon_embed_manager.in_windows_job", lambda: True)
    monkeypatch.setattr(manager, "_windows_process_exit_code", lambda pid: None)
    monkeypatch.setattr(manager, "_clear_port", lambda port: True)
    monkeypatch.setattr(manager, "_wait_for_previous_daemon_exit", lambda p: None)
    monkeypatch.setattr(manager, "_find_api_command", lambda ver, env=None: ["hindsight-api"])
    monkeypatch.setattr(manager, "_register_profile", lambda profile, port, cfg: None)

    running_states = iter([False, True, True])
    monkeypatch.setattr(manager, "is_running", lambda profile: next(running_states, True))

    with (
        patch("hindsight_embed.daemon_embed_manager.launch_independent_process", return_value=42424) as broker,
        patch("hindsight_embed.daemon_embed_manager.subprocess.Popen") as popen,
    ):
        assert manager._start_daemon_locked({}, "job-test", paths) is True
        broker.assert_called_once()
        spec = broker.call_args.args[0]
        assert spec.append is True
        assert spec.log_path == str(paths.log)
        popen.assert_not_called()
        assert manager._daemon_pid_file(paths).read_text(encoding="utf-8") == "42424"
