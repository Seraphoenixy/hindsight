"""Comprehensive dual-PostgreSQL E2E tests for v3 object sync, auto-scheduler, conflicts, and device credentials."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import asyncpg
import pytest
import pytest_asyncio
from aiohttp import web
from httpx import ASGITransport, AsyncClient
from typer.testing import CliRunner

from hindsight_api import MemoryEngine, RequestContext
from hindsight_api.admin.cli import app as admin_cli_app
from hindsight_api.api import create_app
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.db_utils import acquire_with_retry
from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.query_analyzer import DateparserQueryAnalyzer
from hindsight_api.engine.sync_scheduler import SyncScheduler
from hindsight_api.engine.sync_service import (
    RelayV3Client,
    SyncExchangeResult,
    SyncRateLimited,
    synchronize_v3,
)
from hindsight_api.engine.task_backend import SyncTaskBackend
from hindsight_api.engine.working_rules import WorkingRulesService
from hindsight_api.extensions.builtin.tenant import DefaultTenantExtension
from hindsight_api.migrations import run_migrations


@pytest.mark.asyncio
async def test_scheduler_pause_rate_limit_and_credential_recovery(tmp_path: Path, monkeypatch):
    run_sync = AsyncMock(
        side_effect=[
            SyncRateLimited("60"),
            SyncExchangeResult(status="auth_error", message="Revoked", auth_status="revoked"),
            SyncExchangeResult(status="synced", message="Updated"),
        ]
    )
    monkeypatch.setattr("hindsight_api.engine.sync_scheduler.synchronize_v3", run_sync)
    server = SyncScheduler(
        memory=Mock(spec=MemoryEngine, db_url="postgresql://localhost/test", _pool=None, _file_storage=None),
        relay_url="http://127.0.0.1:9078",
        token="test credential",
        state_dir=tmp_path,
        schema="public",
        auto_enabled=False,
    )
    credential = Mock(return_value="first credential")
    monkeypatch.setattr(server, "_current_credential", credential)

    assert (await server.trigger_sync(automatic=True)).status == "idle"
    run_sync.assert_not_awaited()
    # A manual check still runs. Further automatic triggers honor the retry window.
    assert (await server.trigger_sync()).status == "deferred"
    server._auto_enabled = True
    assert (await server.trigger_sync(automatic=True)).status == "deferred"
    assert run_sync.await_count == 1

    server._retry_at = 0
    assert (await server.trigger_sync(automatic=True)).status == "auth_error"
    assert (await server.trigger_sync(automatic=True)).status == "auth_error"
    assert run_sync.await_count == 2
    credential.return_value = "updated credential"
    assert (await server.trigger_sync(automatic=True)).status == "synced"
    assert run_sync.await_count == 3


class _StubEmbeddings(Embeddings):
    model_name = "stub-384"

    @property
    def provider_name(self) -> str:
        return "stub"

    @property
    def dimension(self) -> int:
        return 384

    async def initialize(self) -> None:
        return None

    async def encode(self, texts: list[str]) -> list[list[float]]:
        return [[0.01] * 384 for _ in texts]


class _StubCrossEncoder(CrossEncoderModel):
    @property
    def provider_name(self) -> str:
        return "stub"

    async def initialize(self) -> None:
        return None

    async def _predict(self, pairs: list[tuple[str, str]]) -> list[float]:
        return [0.5 for _ in pairs]


@dataclass
class _MockRelayV3Server:
    """Exact protocol-compatible v3 HTTP relay implementation for dual-PG acceptance tests."""

    admin_token: str
    epoch: str = field(default_factory=lambda: secrets.token_hex(16))
    relay_version: int = 0
    last_seq: int = 0
    initialized: bool = False
    objects: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)
    changes: list[dict[str, Any]] = field(default_factory=list)
    blobs: dict[str, bytes] = field(default_factory=dict)
    committed_batches: dict[str, dict[str, Any]] = field(default_factory=dict)
    devices: dict[str, dict[str, Any]] = field(default_factory=dict)

    def _auth(self, request: web.Request) -> tuple[bool, str] | web.Response:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return web.Response(status=401, text="Unauthorized")
        tok = auth[len("Bearer ") :]
        claimed = request.headers.get("X-Hindsight-Device-Id", "").strip()
        if tok == self.admin_token:
            if claimed and claimed in self.devices and self.devices[claimed].get("revoked_at"):
                return web.Response(status=403, text="Device credential revoked")
            return True, claimed
        thash = hashlib.sha256(auth.encode()).hexdigest()
        for dev in self.devices.values():
            if dev.get("token_hash") == thash:
                if dev.get("revoked_at"):
                    return web.Response(status=403, text="Device credential revoked")
                dev["last_seen_at"] = "2026-11-25T12:00:00Z"
                return False, dev["device_id"]
        return web.Response(status=401, text="Invalid token")

    def _apply_items(self, origin: str, items: list[dict[str, Any]]) -> tuple[list[dict], list[dict], list[str]]:
        missing: list[str] = []
        for it in items:
            if it["op"] == "delete":
                continue
            payload = it.get("payload") or {}
            for b in payload.get("blobs") or []:
                sha = b.get("sha256", "")
                if sha and sha not in self.blobs:
                    missing.append(sha)
        if missing:
            return [], [], sorted(set(missing))

        accepted: list[dict[str, Any]] = []
        conflicts: list[dict[str, Any]] = []
        for it in items:
            key = (it["object_type"], it.get("bank_id", ""), it["object_id"])
            existing = self.objects.get(key)
            is_del = it["op"] == "delete"
            if existing is not None:
                if existing["deleted"] == is_del and existing["content_hash"] == it["content_hash"]:
                    accepted.append(
                        {
                            "client_seq": it["client_seq"],
                            "object_type": key[0],
                            "bank_id": key[1],
                            "object_id": key[2],
                            "seq": existing["seq"],
                            "relay_version": existing["relay_version"],
                            "content_hash": existing["content_hash"],
                            "deleted": existing["deleted"],
                        }
                    )
                    continue
                if it.get("base_relay_version", 0) != existing["relay_version"]:
                    conflicts.append(
                        {
                            "client_seq": it["client_seq"],
                            "object_type": key[0],
                            "bank_id": key[1],
                            "object_id": key[2],
                            "local_version": it["local_version"],
                            "base_relay_version": it.get("base_relay_version", 0),
                            "relay_version": existing["relay_version"],
                            "relay_op": existing["op"],
                            "relay_content_hash": existing["content_hash"],
                            "relay_deleted": existing["deleted"],
                            "relay_payload": existing.get("payload"),
                            "relay_device_id": existing["origin_device_id"],
                            "relay_seq": existing["seq"],
                        }
                    )
                    continue
            elif it.get("base_relay_version", 0) != 0:
                conflicts.append(
                    {
                        "client_seq": it["client_seq"],
                        "object_type": key[0],
                        "bank_id": key[1],
                        "object_id": key[2],
                        "local_version": it["local_version"],
                        "base_relay_version": it.get("base_relay_version", 0),
                        "relay_version": 0,
                        "relay_op": "delete",
                        "relay_content_hash": "deleted",
                        "relay_deleted": True,
                        "relay_payload": None,
                        "relay_device_id": "",
                        "relay_seq": 0,
                    }
                )
                continue

            self.last_seq += 1
            self.relay_version += 1
            next_obj_ver = 1 if existing is None else existing["relay_version"] + 1
            rec = {
                "seq": self.last_seq,
                "object_type": key[0],
                "bank_id": key[1],
                "object_id": key[2],
                "op": it["op"],
                "relay_version": next_obj_ver,
                "base_relay_version": it.get("base_relay_version", 0),
                "content_hash": it["content_hash"],
                "deleted": is_del,
                "payload": None if is_del else it.get("payload"),
                "origin_device_id": origin,
                "updated_at": "2026-11-25T12:00:00Z",
            }
            self.objects[key] = rec
            self.changes.append(rec)
            accepted.append(
                {
                    "client_seq": it["client_seq"],
                    "object_type": key[0],
                    "bank_id": key[1],
                    "object_id": key[2],
                    "seq": self.last_seq,
                    "relay_version": next_obj_ver,
                    "content_hash": it["content_hash"],
                    "deleted": is_del,
                }
            )
        return accepted, conflicts, []

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024)

        async def handle_legacy(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            if self.initialized:
                return web.Response(status=409, text="Update the client to use object sync (v3)")
            return web.Response(status=404, headers={"ETag": '"0"'})

        async def handle_status(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            headers = {
                "X-Hindsight-Relay-Protocol": "3",
                "X-Hindsight-Relay-Epoch": self.epoch if self.initialized else "",
                "X-Hindsight-Relay-Version": str(self.relay_version),
                "X-Hindsight-Last-Seq": str(self.last_seq),
            }
            if request.method == "HEAD":
                return web.Response(status=200, headers=headers)
            return web.json_response(
                {
                    "protocol": 3,
                    "initialized": self.initialized,
                    "epoch": self.epoch if self.initialized else "",
                    "relay_version": self.relay_version,
                    "last_seq": self.last_seq,
                },
                headers=headers,
            )

        async def handle_bootstrap(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            _, dev_id = auth
            body = await request.json()
            origin = dev_id or body.get("device_id") or "legacy-shared"
            if self.initialized:
                return web.json_response(
                    {
                        "initialized_by_self": False,
                        "epoch": self.epoch,
                        "relay_version": self.relay_version,
                        "last_seq": self.last_seq,
                    }
                )
            self.initialized = True
            accepted, conflicts, missing = self._apply_items(origin, body.get("items") or [])
            if missing:
                return web.json_response({"missing_blobs": missing}, status=424)
            return web.json_response(
                {
                    "initialized_by_self": True,
                    "epoch": self.epoch,
                    "relay_version": self.relay_version,
                    "last_seq": self.last_seq,
                    "accepted": accepted,
                    "conflicts": conflicts,
                }
            )

        async def handle_changes(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            _, dev_id = auth
            if request.method == "POST":
                body = await request.json()
                origin = dev_id or body.get("device_id") or "legacy-shared"
                if not self.initialized:
                    self.initialized = True
                exp_epoch = body.get("expected_epoch") or ""
                if exp_epoch and exp_epoch != self.epoch:
                    return web.json_response({"error": "epoch_mismatch"}, status=409)
                bid = body.get("client_batch_id") or ""
                bkey = f"{origin}:{bid}"
                if bid and bkey in self.committed_batches:
                    cached = dict(self.committed_batches[bkey])
                    cached["duplicate_batch"] = True
                    return web.json_response(cached)
                accepted, conflicts, missing = self._apply_items(origin, body.get("items") or [])
                if missing:
                    return web.json_response({"missing_blobs": missing}, status=424)
                resp = {
                    "epoch": self.epoch,
                    "relay_version": self.relay_version,
                    "last_seq": self.last_seq,
                    "accepted": accepted,
                    "conflicts": conflicts,
                    "duplicate_batch": False,
                }
                if bid:
                    self.committed_batches[bkey] = resp
                return web.json_response(resp)

            after_seq = int(request.query.get("after_seq", "0"))
            limit = int(request.query.get("limit", "200"))
            max_bytes = int(request.query.get("max_bytes", str(8 * 1024 * 1024)))
            req_epoch = request.query.get("epoch", "")
            if not self.initialized:
                return web.json_response(
                    {
                        "epoch": "",
                        "relay_version": 0,
                        "last_seq": 0,
                        "reset_required": False,
                        "next_seq": 0,
                        "has_more": False,
                        "changes": [],
                    }
                )
            if (req_epoch and req_epoch != self.epoch) or after_seq < 0 or after_seq > self.last_seq:
                return web.json_response(
                    {
                        "epoch": self.epoch,
                        "relay_version": self.relay_version,
                        "last_seq": self.last_seq,
                        "reset_required": True,
                        "next_seq": self.last_seq,
                        "has_more": False,
                        "changes": [],
                    }
                )
            out: list[dict[str, Any]] = []
            next_seq = after_seq
            has_more = False
            total_bytes = 0
            for ch in self.changes:
                if ch["seq"] <= after_seq:
                    continue
                sz = len(json.dumps(ch, default=str))
                if len(out) >= limit or (out and total_bytes + sz > max_bytes):
                    has_more = True
                    break
                out.append(ch)
                next_seq = ch["seq"]
                total_bytes += sz
            return web.json_response(
                {
                    "epoch": self.epoch,
                    "relay_version": self.relay_version,
                    "last_seq": self.last_seq,
                    "reset_required": False,
                    "next_seq": next_seq,
                    "has_more": has_more,
                    "changes": out,
                }
            )

        async def handle_baseline(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            offset = int(request.query.get("offset", "0"))
            limit = int(request.query.get("limit", "200"))
            items = sorted(self.objects.values(), key=lambda r: (r["seq"], r["object_id"]))
            return web.json_response(
                {
                    "epoch": self.epoch,
                    "relay_version": self.relay_version,
                    "last_seq": self.last_seq,
                    "total": len(items),
                    "offset": offset,
                    "limit": limit,
                    "items": items[offset : offset + limit],
                }
            )

        async def handle_blobs_missing(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            body = await request.json()
            missing = [h for h in (body.get("hashes") or []) if h not in self.blobs]
            return web.json_response({"missing": missing})

        async def handle_blob(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            sha = request.match_info["sha"]
            if request.method == "PUT":
                data = await request.read()
                if hashlib.sha256(data).hexdigest() != sha:
                    return web.Response(status=422, text="SHA-256 mismatch")
                self.blobs[sha] = data
                return web.Response(status=204)
            if sha not in self.blobs:
                return web.Response(status=404)
            return web.Response(status=200, body=self.blobs[sha], content_type="application/octet-stream")

        async def handle_devices(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            is_admin, _ = auth
            if not is_admin:
                return web.Response(status=403, text="Admin token required")
            if request.method == "GET":
                views = [
                    {k: v for k, v in d.items() if k != "token_hash"} | {"active": not d.get("revoked_at")}
                    for d in sorted(self.devices.values(), key=lambda x: x["device_id"])
                ]
                return web.json_response({"devices": views, "total": len(views)})
            body = await request.json()
            dev_id = (body.get("device_id") or "").strip() or f"dev-{secrets.token_hex(6)}"
            name = (body.get("name") or dev_id).strip()
            raw_tok = "hds_" + secrets.token_urlsafe(32)
            thash = hashlib.sha256(("Bearer " + raw_tok).encode()).hexdigest()
            self.devices[dev_id] = {
                "device_id": dev_id,
                "name": name,
                "token_hash": thash,
                "created_at": "2026-11-25T12:00:00Z",
                "rotated_at": "2026-11-25T12:00:00Z",
                "revoked_at": "",
            }
            return web.json_response(
                {
                    "device_id": dev_id,
                    "name": name,
                    "token": raw_tok,
                    "created_at": "2026-11-25T12:00:00Z",
                    "active": True,
                },
                status=201,
            )

        async def handle_device_action(request: web.Request) -> web.Response:
            auth = self._auth(request)
            if isinstance(auth, web.Response):
                return auth
            is_admin, caller_dev = auth
            dev_id = request.match_info["device_id"]
            action = request.match_info["action"]
            dev = self.devices.get(dev_id)
            if dev is None:
                return web.Response(status=404)
            if action == "rotate":
                if not is_admin and caller_dev != dev_id:
                    return web.Response(status=403)
                if dev.get("revoked_at"):
                    return web.Response(status=403, text="Revoked")
                raw_tok = "hds_" + secrets.token_urlsafe(32)
                dev["token_hash"] = hashlib.sha256(("Bearer " + raw_tok).encode()).hexdigest()
                dev["rotated_at"] = "2026-11-25T12:01:00Z"
                return web.json_response(
                    {
                        "device_id": dev_id,
                        "name": dev["name"],
                        "token": raw_tok,
                        "rotated_at": dev["rotated_at"],
                        "active": True,
                    }
                )
            if action == "revoke":
                if not is_admin:
                    return web.Response(status=403)
                dev["revoked_at"] = "2026-11-25T12:02:00Z"
                view = {k: v for k, v in dev.items() if k != "token_hash"} | {"active": False}
                return web.json_response(view)
            return web.Response(status=404)

        app.router.add_get("/v1/snapshot", handle_legacy)
        app.router.add_get("/v2/manifest", handle_legacy)
        app.router.add_route("*", "/v3/status", handle_status)
        app.router.add_post("/v3/bootstrap", handle_bootstrap)
        app.router.add_route("*", "/v3/changes", handle_changes)
        app.router.add_get("/v3/baseline", handle_baseline)
        app.router.add_post("/v3/blobs/missing", handle_blobs_missing)
        app.router.add_route("*", "/v3/blobs/{sha}", handle_blob)
        app.router.add_route("*", "/v3/devices", handle_devices)
        app.router.add_post("/v3/devices/{device_id}/{action}", handle_device_action)
        return app


@pytest_asyncio.fixture
async def relay_server():
    token = "admin-token-" + "x" * 24
    mock_relay = _MockRelayV3Server(admin_token=token)
    runner = web.AppRunner(mock_relay.build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    try:
        yield f"http://127.0.0.1:{port}", token, mock_relay
    finally:
        await runner.cleanup()


async def _create_replica(pg0_db_url: str) -> tuple[MemoryEngine, str]:
    schema = f"sync_e2e_{uuid.uuid4().hex[:10]}"
    conn = await asyncpg.connect(pg0_db_url)
    try:
        await conn.execute(f'CREATE SCHEMA "{schema}"')
    finally:
        await conn.close()
    await asyncio.to_thread(run_migrations, pg0_db_url, schema=schema)
    mem = MemoryEngine(
        db_url=pg0_db_url,
        memory_llm_provider="mock",
        memory_llm_api_key="mock-key",
        memory_llm_model="mock-model",
        embeddings=_StubEmbeddings(),
        cross_encoder=_StubCrossEncoder(),
        query_analyzer=DateparserQueryAnalyzer(),
        tenant_extension=DefaultTenantExtension({"schema": schema}),
        pool_min_size=1,
        pool_max_size=5,
        run_migrations=False,
        task_backend=SyncTaskBackend(),
    )
    await mem.initialize()
    return mem, schema


@pytest.mark.asyncio
async def test_dual_replica_disjoint_merge_tombstones_conflicts_and_revocation(
    pg0_db_url: str, relay_server, tmp_path: Path, monkeypatch
):
    relay_url, admin_token, relay_state = relay_server
    mem_a, schema_a = await _create_replica(pg0_db_url)
    mem_b, schema_b = await _create_replica(pg0_db_url)
    try:
        rc_a = RequestContext()
        rc_b = RequestContext()
        rules_a = WorkingRulesService(mem_a)
        rules_b = WorkingRulesService(mem_b)
        state_a = tmp_path / "state_a"
        state_b = tmp_path / "state_b"
        bank_id = "shared-bank"

        # 1. Seed Replica A and bootstrap v3 relay; legacy endpoints start returning 409.
        r0 = (await rules_a.mutate_working_rule(action="add", content="Always run ruff", request_context=rc_a)).rule
        assert r0 is not None
        await mem_a.retain_batch_async(
            bank_id=bank_id,
            contents=[
                {"content": "Kyoto trip notes version 1.", "document_id": "doc-kyoto"},
                {"content": "Alice works with Bob. Alice mentors Bob.", "document_id": "doc-entities"},
            ],
            request_context=rc_a,
        )
        res_boot = await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        assert res_boot.pushed_count >= 2
        res_b_join = await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        assert res_b_join.pulled_count >= 2

        # A synced document carries several postings for the same entity. The
        # receiver must rebuild counters and co-occurrences, not initialize each
        # entity to 1 and leave its graph empty.
        entities_b = await mem_b.list_entities(bank_id, request_context=rc_b)
        alice_b = next(e for e in entities_b["items"] if e["canonical_name"] == "Alice")
        bob_b = next(e for e in entities_b["items"] if e["canonical_name"] == "Bob")
        assert alice_b["mention_count"] >= 2
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            alice_id = uuid.UUID(alice_b["id"])
            bob_id = uuid.UUID(bob_b["id"])
            actual = await conn_b.fetchval(
                f'SELECT COUNT(*) FROM "{schema_b}".unit_entities WHERE entity_id=$1', alice_id
            )
            cached = await conn_b.fetchval(f'SELECT mention_count FROM "{schema_b}".entities WHERE id=$1', alice_id)
            assert actual >= 2 and cached == actual
            first_id, second_id = sorted([alice_id, bob_id])
            assert (
                await conn_b.fetchval(
                    f'SELECT cooccurrence_count FROM "{schema_b}".entity_cooccurrences '
                    "WHERE entity_id_1=$1 AND entity_id_2=$2",
                    first_id,
                    second_id,
                )
                >= 2
            )
            # Temporal and semantic links created on A are also synced directly to B.
            temporal_cnt_b = await conn_b.fetchval(
                f"SELECT COUNT(*) FROM \"{schema_b}\".memory_links WHERE bank_id=$1 AND link_type='temporal'",
                bank_id,
            )
            semantic_cnt_b = await conn_b.fetchval(
                f"SELECT COUNT(*) FROM \"{schema_b}\".memory_links WHERE bank_id=$1 AND link_type='semantic'",
                bank_id,
            )
            assert temporal_cnt_b >= 2
            assert semantic_cnt_b >= 2

        # 2. Disjoint offline edits: A updates document, B adds a new working rule.
        await mem_a.update_document("doc-kyoto", bank_id=bank_id, tags=["travel", "japan"], request_context=rc_a)
        r_b = (
            await rules_b.mutate_working_rule(action="add", content="Never commit secrets", request_context=rc_b)
        ).rule
        assert r_b is not None

        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )

        # Verify both replicas possess both changes!
        assert any(
            r.content == "Never commit secrets" for r in (await rules_a.list_working_rules(request_context=rc_a)).items
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            doc_b = await conn_b.fetchrow(
                f'SELECT tags FROM "{schema_b}".documents WHERE id = $1 AND bank_id = $2', "doc-kyoto", bank_id
            )
            assert doc_b is not None and set(doc_b["tags"]) == {"travel", "japan"}

        # 3. Unchanged check: 0 uploads, 0 objects scanned, 0 db writes.
        idle_res = await synchronize_v3(
            database_url=pg0_db_url,
            schema=schema_a,
            relay_url=relay_url,
            token=admin_token,
            state_dir=state_a,
            automatic=True,
        )
        assert idle_res.status == "idle"
        assert idle_res.pushed_count == 0 and idle_res.pulled_count == 0
        assert idle_res.local_objects_scanned == 0 and idle_res.db_writes == 0 and idle_res.upload_bytes == 0

        # 4. Deletion tombstone: A deletes r0 and doc-kyoto; B comes back online and keeps deletions.
        await rules_a.mutate_working_rule(action="remove", old_text="Always run ruff", request_context=rc_a)
        await mem_a.delete_document("doc-kyoto", bank_id=bank_id, request_context=rc_a)
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        assert not any(
            r.content == "Always run ruff" for r in (await rules_b.list_working_rules(request_context=rc_b)).items
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".documents WHERE id = $1 AND bank_id = $2', "doc-kyoto", bank_id
                )
                == 0
            )

        # 5. Same-object conflict -> persisted before apply -> confirm -> optimistic restore -> propagates to A.
        await rules_a.mutate_working_rule(
            action="replace",
            old_text="Never commit secrets",
            content="Never commit secrets (A)",
            request_context=rc_a,
        )
        await rules_b.mutate_working_rule(
            action="replace",
            old_text="Never commit secrets",
            content="Never commit secrets (B)",
            request_context=rc_b,
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        conf_sync = await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        assert conf_sync.conflicts_created == 1

        # HTTP API on B: review diff, confirm, test stale expected_version 409, restore local.
        app_b = create_app(mem_b, initialize_memory=False)
        scheduler_b = SyncScheduler(
            memory=mem_b,
            relay_url=relay_url,
            token=admin_token,
            state_dir=state_b,
            schema=schema_b,
            interval_seconds=15.0,
        )
        app_b.state.sync_scheduler = scheduler_b

        async with AsyncClient(transport=ASGITransport(app=app_b), base_url="http://test") as api_b:
            clist = await api_b.get("/v1/default/sync/conflicts")
            assert clist.status_code == 200 and clist.json()["total"] == 1
            cid = clist.json()["items"][0]["id"]
            detail = (await api_b.get(f"/v1/default/sync/conflicts/{cid}")).json()
            assert detail["conflict"]["local_payload"]["content"] == "Never commit secrets (B)"
            assert detail["conflict"]["remote_payload"]["content"] == "Never commit secrets (A)"
            cur_ver = detail["current_object_version"]

            conf_resp = await api_b.post(f"/v1/default/sync/conflicts/{cid}/confirm", json={"note": "Checked diff"})
            assert conf_resp.status_code == 200 and conf_resp.json()["confirmation"]["note"] == "Checked diff"

            # Stale expected_version fails 409
            stale_restore = await api_b.post(
                f"/v1/default/sync/conflicts/{cid}/restore",
                json={"side": "local", "expected_version": cur_ver + 99},
            )
            assert stale_restore.status_code == 409

            good_restore = await api_b.post(
                f"/v1/default/sync/conflicts/{cid}/restore",
                json={"side": "local", "expected_version": cur_ver, "note": "Keep B edit"},
            )
            assert good_restore.status_code == 200 and good_restore.json()["restored_side"] == "local"

        # Push restored object from B to A
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        assert any(
            r.content == "Never commit secrets (B)"
            for r in (await rules_a.list_working_rules(request_context=rc_a)).items
        )

        # 6. Auto-scheduler test: active async_operations defers remote apply, window-focus/trigger coalesces, clean shutdown.
        await rules_a.mutate_working_rule(action="add", content="Deferred while busy", request_context=rc_a)
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            await conn_b.execute(
                f"INSERT INTO \"{schema_b}\".async_operations (operation_id, bank_id, operation_type, status) VALUES ($1, $2, 'retain', 'processing')",
                uuid.uuid4(),
                bank_id,
            )
        def_res = await scheduler_b.trigger_sync(automatic=True)
        assert def_res.status == "deferred"

        # Clear operation -> focus trigger applies cleanly
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            await conn_b.execute(f'DELETE FROM "{schema_b}".async_operations')
        async with AsyncClient(transport=ASGITransport(app=app_b), base_url="http://test") as api_b:
            trig_resp = await api_b.post("/v1/default/sync/trigger", json={"automatic": True})
            assert trig_resp.status_code == 200
        assert any(
            r.content == "Deferred while busy" for r in (await rules_b.list_working_rules(request_context=rc_b)).items
        )

        # Scheduler starts and stops cleanly
        scheduler_b.start()
        await asyncio.sleep(0.1)
        await scheduler_b.stop()

        # 7. Per-device revocation + duplicate batch idempotency + legacy conflict journal read preservation
        dev_b = json.loads((state_b / "device.json").read_text())["device_id"]
        async with AsyncClient(transport=ASGITransport(app=app_b), base_url="http://test") as api_b:
            monkeypatch.setenv("HINDSIGHT_SYNC_RELAY_URL", relay_url)
            monkeypatch.setenv("HINDSIGHT_SYNC_TOKEN", admin_token)
            monkeypatch.setenv("HINDSIGHT_SYNC_STATE_DIR", str(state_b))
            path = f"/v1/default/sync/devices/{dev_b}/revoke"
            assert (await api_b.post(path)).status_code == 403
            rev_resp = await api_b.post(path, headers={"X-Hindsight-Sync-Admin-Token": admin_token})
            assert rev_resp.status_code == 200 and rev_resp.json()["active"] is False

        # Duplicate batch submission does not advance relay_version
        import aiohttp

        async with aiohttp.ClientSession() as sess:
            cli_a = RelayV3Client(relay_url, sess, token=admin_token, device_id="dev-idemp")
            ver_before = relay_state.relay_version
            first_push = await cli_a.push_changes(
                device_id="dev-idemp",
                client_batch_id="batch-idemp-1",
                expected_epoch=relay_state.epoch,
                items=[
                    {
                        "client_seq": 1,
                        "object_type": "working_rule",
                        "bank_id": "",
                        "object_id": str(uuid.uuid4()),
                        "op": "upsert",
                        "local_version": 1,
                        "base_relay_version": 0,
                        "content_hash": "a" * 64,
                        "payload": {"id": str(uuid.uuid4()), "scope": "global", "content": "Idemp rule"},
                    }
                ],
            )
            second_push = await cli_a.push_changes(
                device_id="dev-idemp",
                client_batch_id="batch-idemp-1",
                expected_epoch=relay_state.epoch,
                items=[],
            )
            assert first_push.relay_version == ver_before + 1
            assert second_push.duplicate_batch is True
            assert second_push.relay_version == first_push.relay_version

        revoked_res = await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        assert revoked_res.status == "auth_error" and revoked_res.auth_status == "revoked"
        ok_res = await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        assert ok_res.auth_status == "ok"

        # 8. Initial auto-join guard when BOTH unjoined DB and relay contain independent data.
        mem_c, schema_c = await _create_replica(pg0_db_url)
        try:
            rc_c = RequestContext()
            rules_c = WorkingRulesService(mem_c)
            await rules_c.mutate_working_rule(action="add", content="Unjoined local C rule", request_context=rc_c)
            c_auto = await synchronize_v3(
                database_url=pg0_db_url,
                schema=schema_c,
                relay_url=relay_url,
                token=admin_token,
                state_dir=tmp_path / "state_c",
                automatic=True,
            )
            assert c_auto.status == "needs_prefer"
        finally:
            await mem_c.close()

        # 9. CLI sync-conflicts lists object conflicts.
        runner = CliRunner()
        monkeypatch.setenv("HINDSIGHT_API_DATABASE_URL", pg0_db_url)
        cli_out = await asyncio.to_thread(
            runner.invoke, admin_cli_app, ["sync-conflicts", "--state-dir", str(state_a), "--schema", schema_b]
        )
        assert cli_out.exit_code == 0
        assert "[object]" in cli_out.output
    finally:
        conn = await asyncpg.connect(pg0_db_url)
        try:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema_a}" CASCADE')
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema_b}" CASCADE')
        finally:
            await conn.close()
        await mem_a.close()
        await mem_b.close()


@pytest.mark.asyncio
async def test_memory_invalidation_revert_and_retention_sync(pg0_db_url: str, relay_server, tmp_path: Path):
    """Verify invalidation, revert, document partial invalidation, and retention pruning sync cleanly."""
    from datetime import datetime, timedelta, timezone

    from hindsight_api.engine.memories import get_memories
    from hindsight_api.engine.sync_journal import fetch_pending_changes, get_local_high_water, get_object_state

    relay_url, admin_token, _relay_state = relay_server
    mem_a, schema_a = await _create_replica(pg0_db_url)
    mem_b, schema_b = await _create_replica(pg0_db_url)
    try:
        rc_a = RequestContext()
        state_a = tmp_path / "state_a"
        state_b = tmp_path / "state_b"
        bank_id = "inval-sync-bank"

        # 1. Create one standalone fact (document_id=NULL) and retain one document with two facts.
        await mem_a.retain_batch_async(
            bank_id=bank_id,
            contents=[
                {
                    "content": "Bob lives in Berlin. Bob works at Acme.",
                    "document_id": "doc-inval",
                }
            ],
            request_context=rc_a,
        )

        async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
            standalone_uuid = uuid.uuid4()
            standalone_id = str(standalone_uuid)
            await conn_a.execute(
                f"""
                INSERT INTO "{schema_a}".memory_units (
                    id, bank_id, text, fact_type, event_date, embedding
                )
                VALUES ($1, $2, $3, 'world', now(), $4::vector)
                """,
                standalone_uuid,
                bank_id,
                "Standalone fact: Alice prefers green tea.",
                "[" + ",".join(["0.01"] * 384) + "]",
            )
            doc_units = await conn_a.fetch(
                f'SELECT id::text AS id, text FROM "{schema_a}".memory_units '
                "WHERE bank_id = $1 AND document_id = $2 AND fact_type <> 'observation' ORDER BY created_at, id",
                bank_id,
                "doc-inval",
            )
            assert standalone_id is not None
            assert len(doc_units) >= 2
            doc_fact_1 = doc_units[0]["id"]
            doc_fact_2 = doc_units[1]["id"]

            # Create an observation derived solely from doc_fact_2 so we can verify
            # invalidating doc_fact_1 does not wipe doc_fact_2's observation on replica B.
            obs_2_id = uuid.uuid4()
            await conn_a.execute(
                f"""
                INSERT INTO "{schema_a}".memory_units (
                    id, bank_id, text, fact_type, source_memory_ids, event_date, embedding
                )
                VALUES ($1, $2, $3, 'observation', $4::uuid[], now(), $5::vector)
                """,
                obs_2_id,
                bank_id,
                "Observation derived from doc_fact_2",
                [uuid.UUID(doc_fact_2)],
                "[" + ",".join(["0.01"] * 384) + "]",
            )

        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )

        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(standalone_id),
                    bank_id,
                )
                == 1
            )
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    obs_2_id,
                    bank_id,
                )
                == 1
            )

        # 2. Invalidate standalone unit on A -> check single clean changelog entry & sync to B.
        async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
            hwm_before_inval = await get_local_high_water(conn_a, schema=schema_a)

        await mem_a.update_memory_unit(
            bank_id=bank_id,
            memory_id=standalone_id,
            state="invalidated",
            reason="outdated preference",
            request_context=rc_a,
        )

        async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
            changes = await fetch_pending_changes(conn_a, after_seq=hwm_before_inval, limit=50, schema=schema_a)
            standalone_changes = [c for c in changes if c.object_type == "memory_unit" and c.object_id == standalone_id]
            assert len(standalone_changes) == 1
            assert standalone_changes[0].op == "upsert"
            st_a = await get_object_state(
                conn_a, object_type="memory_unit", bank_id=bank_id, object_id=standalone_id, schema=schema_a
            )
            assert st_a is not None and st_a.deleted is False

        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )

        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(standalone_id),
                    bank_id,
                )
                == 0
            )
            arch_b = await conn_b.fetchrow(
                f'SELECT invalidation_reason FROM "{schema_b}".invalidated_memory_units WHERE id = $1 AND bank_id = $2',
                uuid.UUID(standalone_id),
                bank_id,
            )
            assert arch_b is not None and arch_b["invalidation_reason"] == "outdated preference"

        # 3. Revert standalone unit on A -> verify B restores it to memory_units.
        await mem_a.update_memory_unit(
            bank_id=bank_id,
            memory_id=standalone_id,
            state="valid",
            request_context=rc_a,
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(standalone_id),
                    bank_id,
                )
                == 1
            )
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".invalidated_memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(standalone_id),
                    bank_id,
                )
                == 0
            )

        # 4. Invalidate one fact of doc-inval on A -> verify B archives doc_fact_1 and keeps doc_fact_2 + obs_2_id.
        await mem_a.update_memory_unit(
            bank_id=bank_id,
            memory_id=doc_fact_1,
            state="invalidated",
            reason="wrong city",
            request_context=rc_a,
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(doc_fact_1),
                    bank_id,
                )
                == 0
            )
            assert (
                await conn_b.fetchval(
                    f'SELECT invalidation_reason FROM "{schema_b}".invalidated_memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(doc_fact_1),
                    bank_id,
                )
                == "wrong city"
            )
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(doc_fact_2),
                    bank_id,
                )
                == 1
            )
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    obs_2_id,
                    bank_id,
                )
                == 1
            )

        # 5. Invalidate standalone unit again and expire both standalone & document-owned archived units -> verify B deletes both.
        await mem_a.update_memory_unit(
            bank_id=bank_id,
            memory_id=standalone_id,
            state="invalidated",
            reason="expired",
            request_context=rc_a,
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
            old_ts = datetime.now(timezone.utc) - timedelta(days=90)
            await conn_a.execute(
                f'UPDATE "{schema_a}".invalidated_memory_units SET invalidated_at = $1 WHERE id = ANY($2::uuid[]) AND bank_id = $3',
                old_ts,
                [uuid.UUID(standalone_id), uuid.UUID(doc_fact_1)],
                bank_id,
            )
            async with conn_a.transaction():
                pruned = await get_memories().prune_expired_invalidated_memories(
                    conn=conn_a,
                    cutoff=datetime.now(timezone.utc) - timedelta(days=30),
                    batch_size=100,
                )
            assert pruned >= 2
            st_pruned = await get_object_state(
                conn_a, object_type="memory_unit", bank_id=bank_id, object_id=standalone_id, schema=schema_a
            )
            assert st_pruned is not None and st_pruned.deleted is True

        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".invalidated_memory_units WHERE id = ANY($1::uuid[]) AND bank_id = $2',
                    [uuid.UUID(standalone_id), uuid.UUID(doc_fact_1)],
                    bank_id,
                )
                == 0
            )

        # 6. HTTP DELETE endpoint for invalidated memory unit: rejects live memory (400),
        #    deletes invalidated memory (200), syncs deletion to B, and returns 404 on missing.
        app_a = create_app(mem_a, initialize_memory=False)
        async with AsyncClient(transport=ASGITransport(app=app_a), base_url="http://test") as api_a:
            live_del = await api_a.delete(f"/v1/default/banks/{bank_id}/memories/{doc_fact_2}")
            assert live_del.status_code == 400

            await mem_a.update_memory_unit(
                bank_id=bank_id,
                memory_id=doc_fact_2,
                state="invalidated",
                reason="manual cleanup",
                request_context=rc_a,
            )
            arch_del = await api_a.delete(f"/v1/default/banks/{bank_id}/memories/{doc_fact_2}")
            assert arch_del.status_code == 200
            assert arch_del.json() == {"deleted": True, "memory_id": doc_fact_2}

            missing_del = await api_a.delete(f"/v1/default/banks/{bank_id}/memories/{doc_fact_2}")
            assert missing_del.status_code == 404

            # 7. Bulk clear invalidated memories via DELETE /memories/invalidated -> syncs to B.
            bulk_uuid = uuid.uuid4()
            bulk_id = str(bulk_uuid)
            async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
                await conn_a.execute(
                    f"""
                    INSERT INTO "{schema_a}".memory_units (
                        id, bank_id, text, fact_type, event_date, embedding
                    )
                    VALUES ($1, $2, $3, 'world', now(), $4::vector)
                    """,
                    bulk_uuid,
                    bank_id,
                    "Standalone fact for bulk clear",
                    "[" + ",".join(["0.01"] * 384) + "]",
                )
            await mem_a.update_memory_unit(
                bank_id=bank_id,
                memory_id=bulk_id,
                state="invalidated",
                reason="bulk test",
                request_context=rc_a,
            )
            await synchronize_v3(
                database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
            )
            await synchronize_v3(
                database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
            )
            clear_resp = await api_a.delete(f"/v1/default/banks/{bank_id}/memories/invalidated")
            assert clear_resp.status_code == 200
            assert clear_resp.json()["deleted"] >= 1

        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".invalidated_memory_units WHERE bank_id = $1',
                    bank_id,
                )
                == 0
            )

        # 8. Document aging: detaches facts (live & archived) to standalone memory_units and deletes document;
        #    syncs cleanly to B without deleting observations derived from those facts.
        await mem_a.retain_batch_async(
            bank_id=bank_id,
            contents=[{"content": "Carol plays violin in Vienna.", "document_id": "doc-age-sync"}],
            request_context=rc_a,
        )
        async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
            aged_fact_id = await conn_a.fetchval(
                f'SELECT id::text FROM "{schema_a}".memory_units '
                "WHERE bank_id = $1 AND document_id = 'doc-age-sync' AND fact_type <> 'observation'",
                bank_id,
            )
            assert aged_fact_id is not None
            aged_obs_id = uuid.uuid4()
            await conn_a.execute(
                f"""
                INSERT INTO "{schema_a}".memory_units (
                    id, bank_id, text, fact_type, source_memory_ids, event_date, embedding
                )
                VALUES ($1, $2, $3, 'observation', $4::uuid[], now(), $5::vector)
                """,
                aged_obs_id,
                bank_id,
                "Observation for aged document fact",
                [uuid.UUID(aged_fact_id)],
                "[" + ",".join(["0.01"] * 384) + "]",
            )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_a._get_backend()) as conn_a:
            async with conn_a.transaction():
                pruned_docs = await get_memories().prune_expired_document_text(
                    conn=conn_a,
                    cutoff=datetime.now(timezone.utc) + timedelta(days=1),
                    batch_size=50,
                )
            assert pruned_docs >= 1
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".documents WHERE id = $1 AND bank_id = $2',
                    "doc-age-sync",
                    bank_id,
                )
                == 0
            )
            detached_b = await conn_b.fetchrow(
                f'SELECT document_id, chunk_id FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                uuid.UUID(aged_fact_id),
                bank_id,
            )
            assert detached_b is not None
            assert detached_b["document_id"] is None and detached_b["chunk_id"] is None
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    aged_obs_id,
                    bank_id,
                )
                == 1
            )

        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_a, relay_url=relay_url, token=admin_token, state_dir=state_a
        )
        await synchronize_v3(
            database_url=pg0_db_url, schema=schema_b, relay_url=relay_url, token=admin_token, state_dir=state_b
        )
        async with acquire_with_retry(await mem_b._get_backend()) as conn_b:
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(doc_fact_2),
                    bank_id,
                )
                == 0
            )
            assert (
                await conn_b.fetchval(
                    f'SELECT count(*) FROM "{schema_b}".invalidated_memory_units WHERE id = $1 AND bank_id = $2',
                    uuid.UUID(doc_fact_2),
                    bank_id,
                )
                == 0
            )
    finally:
        conn = await asyncpg.connect(pg0_db_url)
        try:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema_a}" CASCADE')
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema_b}" CASCADE')
        finally:
            await conn.close()
        await mem_a.close()
        await mem_b.close()
