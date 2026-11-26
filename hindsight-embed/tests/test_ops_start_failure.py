"""Startup errors remain visible even when resource cleanup writes more log lines."""

from types import SimpleNamespace

import pytest

from hindsight_embed.ops import service


@pytest.mark.parametrize(
    ("log", "expected"),
    [
        (
            "RuntimeError: Cannot change embedding dimension from 384 to 1024\n"
            "ERROR: Application startup failed. Exiting.\n"
            "Error stopping pg0: cannot schedule new futures after interpreter shutdown",
            "RuntimeError: Cannot change embedding dimension from 384 to 1024",
        ),
        ("RuntimeError: bad model configuration\npg0 stopped.", "RuntimeError: bad model configuration"),
        ("Could not bind port 8888", "Could not bind port 8888"),
    ],
)
def test_start_failure_prefers_the_exception(monkeypatch, log, expected):
    monkeypatch.setattr(service.local_models, "missing_local_models", lambda name: [])
    monkeypatch.setattr(service.local_models, "check_embedding_compatibility", lambda name: None)
    monkeypatch.setattr(service.daemon_client, "is_daemon_running", lambda name: False)
    monkeypatch.setattr(service.daemon_client, "ensure_daemon_running", lambda config, name: False)
    monkeypatch.setattr(service.ProfileManager, "resolve_profile_paths", lambda *args: SimpleNamespace())
    monkeypatch.setattr(service, "_daemon_config", lambda name: {})
    monkeypatch.setattr(service, "tail_log", lambda *args, **kwargs: SimpleNamespace(content=log))
    result = service.start_daemon("")
    assert not result.ok
    assert result.message == f"Failed to start daemon: {expected}"
    assert result.message_zh == f"启动守护进程失败：{expected}"
