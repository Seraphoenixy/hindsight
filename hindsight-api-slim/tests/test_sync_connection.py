from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hindsight_api.admin import sync_pake
from hindsight_api.api.sync import build_router
from hindsight_api.engine.sync_scheduler import SyncScheduler
from hindsight_api.engine.sync_service import RelayDeviceProvisioned, SyncAuthError
from hindsight_api.models import RequestContext


class _Memory:
    def register_sync_write_listener(self, callback):
        pass


def test_sync_connection_is_local_and_saves_only_after_pake_login(tmp_path, monkeypatch):
    password = "example-master-password"
    ops_token = "example-operations-token"
    device_token = "hds_" + "a" * 48
    monkeypatch.setenv("HINDSIGHT_EMBED_OPS_TOKEN", ops_token)
    scheduler_args = {
        "memory": _Memory(),
        "relay_url": "https://old.example.com",
        "token": "old-token",
        "state_dir": tmp_path,
        "schema": "public",
    }
    scheduler = SyncScheduler(**scheduler_args)
    other_worker = SyncScheduler(**scheduler_args)
    app = FastAPI()
    app.state.sync_scheduler = scheduler

    def request_context():
        return RequestContext()

    app.include_router(build_router(request_context))
    relay_url = "https://new.example.com"
    origin = "http://localhost:9999"
    headers = {"Origin": origin, "X-Hindsight-Ops-Token": ops_token}
    path = "/v1/default/sync/connection"
    state = tmp_path / "device.json"

    async def fake_login(client, supplied_password, *, device_id, name):
        assert client.base_url == relay_url
        assert not client.token
        if supplied_password != password:
            raise SyncAuthError("Wrong password", status_code=401)
        return RelayDeviceProvisioned(
            device_id=device_id, name=name, token=device_token, created_at=datetime.now(timezone.utc).isoformat()
        )

    monkeypatch.setattr(sync_pake, "login_pake", fake_login)
    with TestClient(app, client=("192.0.2.1", 12345)) as remote:
        assert (
            remote.post(path, json={"relay_url": relay_url, "password": password}, headers=headers).status_code == 404
        )

    with TestClient(app, client=("127.0.0.1", 12345)) as local:
        preflight = local.options(
            path,
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-hindsight-ops-token",
            },
        )
        assert preflight.status_code == 204
        assert preflight.headers["Access-Control-Allow-Origin"] == origin
        invalid_origin = local.get(path, headers={**headers, "Origin": "https://outside.example.com"})
        assert invalid_origin.status_code == 404
        assert "Access-Control-Allow-Origin" not in invalid_origin.headers
        assert local.get(path, headers={"Origin": origin}).status_code == 404
        assert local.get(path, headers=headers).json() == {"relay_url": "https://old.example.com", "device_id": None}

        wrong = local.post(path, json={"relay_url": relay_url, "password": "wrong-password"}, headers=headers)
        assert wrong.status_code == 401
        assert wrong.headers["Access-Control-Allow-Origin"] == origin
        assert not state.exists()
        assert scheduler.relay_url == "https://old.example.com"

        success = local.post(path, json={"relay_url": relay_url, "password": password}, headers=headers)
        assert success.status_code == 200, success.text
        assert local.get(path, headers=headers).json() == success.json()
        assert success.json()["relay_url"] == relay_url
        assert device_token not in success.text
        assert password not in state.read_text()
        assert scheduler.relay_url == relay_url
        assert not scheduler.token
        assert scheduler._wakeup.is_set()
        assert other_worker.relay_url == relay_url

    assert SyncScheduler(**scheduler_args).relay_url == relay_url
