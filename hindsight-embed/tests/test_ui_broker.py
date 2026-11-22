"""Targeted coverage for a UI that outlives its Windows plugin caller."""

import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from hindsight_embed._ui_broker import UiLaunch, launch_independent_ui
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
        launch_independent_ui(spec)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if log.exists() and log.read_text().strip().isdigit():
                pid = int(log.read_text().strip())
                break
            time.sleep(0.05)
        assert pid is not None, log.read_text() if log.exists() else "No child log"
        assert not list(root.glob(".ui-launch-*.json"))
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
    assert not list(tmp_path.glob(".ui-launch-*.json"))
