"""The detached worker uses the selected profile and the installed pg0 API."""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hindsight_embed.ops import reembed_worker


@pytest.mark.asyncio
@pytest.mark.parametrize("uri", ["postgresql://localhost/test", None])
async def test_worker_reads_pg0_uri_and_refreshes_profile_config(tmp_path, monkeypatch, uri):
    import asyncpg
    import pg0
    from hindsight_api.admin import reembed
    from hindsight_api.config import clear_config_cache, get_config
    from hindsight_api.engine import embeddings as embeddings_module

    monkeypatch.setenv("HINDSIGHT_API_LLM_MAX_CONCURRENT", "2")
    clear_config_cache()
    assert get_config().llm_max_concurrent == 2
    config_path = tmp_path / "profile.env"
    config_path.write_text("HINDSIGHT_API_LLM_MAX_CONCURRENT=7\n", encoding="utf-8")
    monkeypatch.setattr(
        reembed_worker.ProfileManager,
        "resolve_profile_paths",
        lambda self, profile: SimpleNamespace(config=config_path),
    )
    monkeypatch.setattr(reembed_worker.DaemonEmbedManager, "resolve_database_url", lambda *args: "pg0://worker-test")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    pg = SimpleNamespace(uri=uri, start=Mock(), stop=Mock())
    monkeypatch.setattr(pg0, "Pg0", lambda **kwargs: pg)
    model = SimpleNamespace(initialize=AsyncMock())

    def factory():
        assert get_config().llm_max_concurrent == 7
        return model

    monkeypatch.setattr(embeddings_module, "create_embeddings_from_env", factory)
    conn = SimpleNamespace(close=AsyncMock())
    connect = AsyncMock(return_value=conn)
    monkeypatch.setattr(asyncpg, "connect", connect)
    run = AsyncMock(return_value=SimpleNamespace(rows_embedded=3))
    monkeypatch.setattr(reembed, "reembed_schema", run)
    monkeypatch.setattr(reembed, "finish_schema", AsyncMock())
    monkeypatch.setattr(reembed_worker.daemon_client, "ensure_daemon_running", lambda *args: True)
    status_path = tmp_path / "status.json"
    try:
        await reembed_worker._run_reembed_async("test", status_path)
        status = json.loads(status_path.read_text(encoding="utf-8"))
        if uri:
            assert status["status"] == "done", status
            assert status["rows_embedded"] == 3
            connect.assert_awaited_once_with(uri)
            run.assert_awaited_once_with(conn, uri, "public", model)
            model.initialize.assert_awaited_once()
        else:
            assert status["status"] == "error"
            assert "connection URI" in status["error"]
            connect.assert_not_awaited()
        pg.stop.assert_called_once()
    finally:
        clear_config_cache()
