"""Shared pytest fixtures for hindsight-embed tests."""

import pytest


@pytest.fixture(autouse=True)
def _default_outside_windows_job(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep unit tests deterministic when the test runner itself runs in a Windows Job Object.

    Tests that specifically exercise Windows job-escape behaviour override
    ``hindsight_embed.daemon_embed_manager.in_windows_job`` explicitly.
    """
    monkeypatch.setattr("hindsight_embed.daemon_embed_manager.in_windows_job", lambda: False)
