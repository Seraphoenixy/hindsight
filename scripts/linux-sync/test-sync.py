#!/usr/bin/env python3
"""Dual-PostgreSQL end-to-end acceptance test against an HTTP sync relay (v3 + legacy upgrade protection)."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import tempfile
import uuid
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import aiohttp
import asyncpg
from hindsight_api import MemoryEngine, RequestContext
from hindsight_api.admin.sync_pake import initialize_pake, login_pake
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.query_analyzer import DateparserQueryAnalyzer
from hindsight_api.engine.sync_journal import (
    confirm_sync_conflict,
    get_object_state,
    list_sync_conflicts,
)
from hindsight_api.engine.sync_service import (
    DeviceIdentity,
    RelayV3Client,
    SyncAuthError,
    restore_sync_conflict_object,
    save_device_identity,
    synchronize_v3,
)
from hindsight_api.engine.task_backend import SyncTaskBackend
from hindsight_api.engine.working_rules import WorkingRulesService
from hindsight_api.extensions.builtin.tenant import DefaultTenantExtension
from hindsight_api.migrations import run_migrations
from hindsight_api.pg0 import EmbeddedPostgres


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


async def _make_engine(db_url: str, schema: str) -> MemoryEngine:
    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    finally:
        await conn.close()
    await asyncio.to_thread(run_migrations, db_url, schema=schema)
    mem = MemoryEngine(
        db_url=db_url,
        memory_llm_provider="mock",
        memory_llm_api_key="mock-key",
        memory_llm_model="mock-model",
        embeddings=_StubEmbeddings(),
        cross_encoder=_StubCrossEncoder(),
        query_analyzer=DateparserQueryAnalyzer(),
        tenant_extension=DefaultTenantExtension({"schema": schema}),
        pool_min_size=1,
        pool_max_size=4,
        run_migrations=False,
        task_backend=SyncTaskBackend(),
    )
    await mem.initialize()
    return mem


async def run_acceptance(server_url: str, token: str) -> dict[str, int]:
    rc = RequestContext()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        pg_a = EmbeddedPostgres(name=f"accept_a_{uuid.uuid4().hex[:8]}")
        pg_b = EmbeddedPostgres(name=f"accept_b_{uuid.uuid4().hex[:8]}")
        db_a = await pg_a.start()
        db_b = await pg_b.start()
        mem_a = await _make_engine(db_a, "public")
        mem_b = await _make_engine(db_b, "public")
        try:
            state_a = root / "state_a"
            state_b = root / "state_b"
            rules_a = WorkingRulesService(mem_a)
            rules_b = WorkingRulesService(mem_b)
            bank_id = "sync-accept-bank"

            # 1. Seed initial working rule & document on A, bootstrap relay, join B
            r_shared = (
                await rules_a.mutate_working_rule(
                    action="add",
                    content="Shared baseline rule",
                    request_context=rc,
                )
            ).rule
            assert r_shared is not None
            await mem_a.retain_batch_async(
                bank_id=bank_id,
                contents=[{"content": "Initial shared doc about Kyoto shrines.", "document_id": "doc-shared"}],
                request_context=rc,
            )
            current_snapshot = root / "current.zip"
            legacy_snapshot = root / "legacy.zip"
            await capture_snapshot(db_a, "public", current_snapshot)
            with ZipFile(current_snapshot) as source, ZipFile(legacy_snapshot, "w", ZIP_DEFLATED) as target:
                for member in source.namelist():
                    payload = source.read(member)
                    if member == "sync.json":
                        metadata = json.loads(payload)
                        metadata["migrations"] = ["f42c9a8e613b"]
                        payload = json.dumps(metadata).encode()
                    target.writestr(member, payload)
            async with aiohttp.ClientSession() as session:
                async with session.put(
                    f"{server_url}/v1/snapshot",
                    data=legacy_snapshot.read_bytes(),
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/zip", "If-Match": '"0"'},
                ) as published:
                    assert published.status == 204, await published.text()
            await rules_a.mutate_working_rule(
                action="add", content="Local draft to keep in the recovery copy", request_context=rc
            )
            pending_upgrade = await synchronize_v3(
                database_url=db_a,
                schema="public",
                relay_url=server_url,
                token=token,
                state_dir=state_a,
                automatic=True,
            )
            assert pending_upgrade.status == "needs_prefer"
            res_boot = await synchronize_v3(
                database_url=db_a,
                schema="public",
                relay_url=server_url,
                token=token,
                state_dir=state_a,
                prefer="remote",
                batch_max_items=1,
            )
            assert res_boot.pushed_count >= 1
            assert list(state_a.glob("conflict-local-*.zip"))
            password = secrets.token_urlsafe(24)
            async with aiohttp.ClientSession() as session:
                await initialize_pake(RelayV3Client(server_url, session, token=token), password)
                device = await login_pake(
                    RelayV3Client(server_url, session, token=""), password, device_id="dev-accept-b", name="Replica B"
                )
                await RelayV3Client(server_url, session, token=device.token).get_status()
            save_device_identity(
                state_b,
                DeviceIdentity(
                    device_id=device.device_id,
                    name=device.name,
                    token=device.token,
                    relay_url=server_url,
                    per_device_token=True,
                    created_at=device.created_at,
                ),
            )
            res_join_b = await synchronize_v3(
                database_url=db_b, schema="public", relay_url=server_url, token="", state_dir=state_b
            )
            assert res_join_b.pulled_count >= 1

            # 2. Disjoint offline edits: A updates doc, B adds working rule -> both keep both!
            await mem_a.retain_batch_async(
                bank_id=bank_id,
                contents=[{"content": "Updated Kyoto notes from A.", "document_id": "doc-shared"}],
                request_context=rc,
            )
            r_b = (
                await rules_b.mutate_working_rule(
                    action="add",
                    content="Working rule created on offline replica B",
                    request_context=rc,
                )
            ).rule
            assert r_b is not None
            await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a
            )
            await synchronize_v3(
                database_url=db_b, schema="public", relay_url=server_url, token=token, state_dir=state_b
            )
            await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a
            )

            rules_on_a = {r.content for r in (await rules_a.list_working_rules(request_context=rc)).items}
            assert "Working rule created on offline replica B" in rules_on_a

            # 3. Unchanged tick transfers minimal metadata only (0 objects pushed/pulled)
            idle = await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a, automatic=True
            )
            assert idle.status == "idle" and idle.pushed_count == 0 and idle.pulled_count == 0

            # 4. Deletion tombstone: A deletes r_shared; B stays offline then reconnects -> stays deleted
            await rules_a.mutate_working_rule(
                action="remove", old_text="Shared baseline rule", request_context=rc
            )
            await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a
            )
            await synchronize_v3(
                database_url=db_b, schema="public", relay_url=server_url, token=token, state_dir=state_b
            )
            rules_on_b = {r.content for r in (await rules_b.list_working_rules(request_context=rc)).items}
            assert "Shared baseline rule" not in rules_on_b

            # 5. True same-object conflict -> captured, confirmed, restored -> converges everywhere
            await rules_a.mutate_working_rule(
                action="replace",
                old_text="Working rule created on offline replica B",
                content="Rule text edited on A",
                request_context=rc,
            )
            await rules_b.mutate_working_rule(
                action="replace",
                old_text="Working rule created on offline replica B",
                content="Rule text edited on B",
                request_context=rc,
            )
            await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a
            )
            res_conf_b = await synchronize_v3(
                database_url=db_b, schema="public", relay_url=server_url, token=token, state_dir=state_b
            )
            assert res_conf_b.conflicts_created == 1

            conn_b = await asyncpg.connect(db_b)
            try:
                page = await list_sync_conflicts(conn_b, schema="public")
                assert page.total == 1
                conf = page.items[0]
                st = await get_object_state(
                    conn_b, object_type="working_rule", bank_id="", object_id=r_b.id, schema="public"
                )
                assert st is not None
                await confirm_sync_conflict(conn_b, conf.id, note="Reviewed offline divergence", schema="public")
                await restore_sync_conflict_object(
                    conn_b,
                    conflict_id=conf.id,
                    side="local",
                    expected_version=st.version,
                    note="Restore B's wording",
                    schema="public",
                )
            finally:
                await conn_b.close()

            await synchronize_v3(
                database_url=db_b, schema="public", relay_url=server_url, token=token, state_dir=state_b
            )
            await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a
            )
            final_a = {r.content for r in (await rules_a.list_working_rules(request_context=rc)).items}
            assert "Rule text edited on B" in final_a

            # 6. Device revocation blocks revoked device only
            dev_b_id = json.loads((state_b / "device.json").read_text())["device_id"]
            async with aiohttp.ClientSession() as sess:
                admin_client = RelayV3Client(server_url, sess, token=token)
                await admin_client.revoke_device(dev_b_id)

            revoked_res = await synchronize_v3(
                database_url=db_b, schema="public", relay_url=server_url, token=token, state_dir=state_b
            )
            assert revoked_res.status == "auth_error" and revoked_res.auth_status == "revoked"
            ok_a = await synchronize_v3(
                database_url=db_a, schema="public", relay_url=server_url, token=token, state_dir=state_a
            )
            assert ok_a.auth_status == "ok"

            return {
                "idle_upload_bytes": idle.upload_bytes,
                "idle_download_bytes": idle.download_bytes,
            }
        finally:
            await mem_a.close()
            await mem_b.close()
            await pg_a.stop()
            await pg_b.stop()


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: test-sync.py <relay_url>", file=sys.stderr)
        return 2
    server_url = sys.argv[1].rstrip("/")
    token = os.environ["HINDSIGHT_SYNC_TOKEN"]
    os.environ.setdefault("HINDSIGHT_API_LLM_PROVIDER", "mock")
    metrics = asyncio.run(run_acceptance(server_url, token))
    print(f"Dual-replica v3 sync acceptance passed: {metrics}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
