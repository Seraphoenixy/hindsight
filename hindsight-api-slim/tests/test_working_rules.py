"""Tests for Working Rules domain logic, persistence, HTTP routes, and organization."""

from __future__ import annotations

import asyncio
import random
import string
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from hindsight_api import MemoryEngine, RequestContext
from hindsight_api.admin.cli import BACKUP_TABLES, _backup, _restore
from hindsight_api.api import create_app
from hindsight_api.config import _get_raw_config
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.query_analyzer import DateparserQueryAnalyzer
from hindsight_api.engine.response_models import LLMCallResult
from hindsight_api.engine.task_backend import SyncTaskBackend
from hindsight_api.engine.working_rules import (
    WorkingRuleCapacityError,
    WorkingRuleConflictError,
    WorkingRuleNotFoundError,
    WorkingRuleRecord,
    WorkingRuleValidationError,
    _LLMOrganizeOutput,
    _LLMOrganizeSuggestion,
    _match_rule_by_old_text,
    _pack_for_capacity,
    assert_pinned_budget,
    normalize_working_rule_branches,
    normalize_working_rule_content,
    working_rules_utf8_bytes,
)
from hindsight_api.extensions.builtin.tenant import DefaultTenantExtension
from hindsight_api.migrations import run_migrations


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


@pytest_asyncio.fixture
async def wr_schema(pg0_db_url: str):
    schema = f"test_wr_{uuid.uuid4().hex}"
    conn = await asyncpg.connect(pg0_db_url)
    try:
        await conn.execute(f'CREATE SCHEMA "{schema}"')
        try:
            await asyncio.to_thread(run_migrations, pg0_db_url, schema=schema)
            yield schema
        finally:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def wr_memory(pg0_db_url: str, wr_schema: str):
    mem = MemoryEngine(
        db_url=pg0_db_url,
        memory_llm_provider="mock",
        memory_llm_api_key="mock-key",
        memory_llm_model="mock-model",
        embeddings=_StubEmbeddings(),
        cross_encoder=_StubCrossEncoder(),
        query_analyzer=DateparserQueryAnalyzer(),
        tenant_extension=DefaultTenantExtension({"schema": wr_schema}),
        pool_min_size=1,
        pool_max_size=5,
        run_migrations=False,
        task_backend=SyncTaskBackend(),
    )
    await mem.initialize()
    try:
        yield mem
    finally:
        await mem.close()


@pytest_asyncio.fixture
async def wr_client(wr_memory):
    app = create_app(wr_memory, initialize_memory=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


def _sample_rule(
    rule_id: str,
    content: str,
    *,
    importance: str = "normal",
    pinned: bool = False,
    scope: str = "global",
    project_id: str | None = None,
    branches: list[str] | None = None,
    updated_at: datetime | None = None,
) -> WorkingRuleRecord:
    ts = updated_at or datetime(2026, 11, 24, 12, 0, 0, tzinfo=timezone.utc)
    return WorkingRuleRecord(
        id=rule_id,
        scope=scope,  # type: ignore[arg-type]
        project_id=project_id,
        content=content,
        importance=importance,  # type: ignore[arg-type]
        pinned=pinned,
        branches=branches or [],
        created_at=ts,
        updated_at=ts,
    )


def test_normalize_content_and_branches_validation():
    assert normalize_working_rule_content("  hello   world\nline2  ") == "hello world line2"

    with pytest.raises(WorkingRuleValidationError):
        normalize_working_rule_content("   ")

    with pytest.raises(WorkingRuleValidationError):
        normalize_working_rule_content("rule with § delimiter")

    with pytest.raises(WorkingRuleValidationError):
        normalize_working_rule_content("a" * 100, max_bytes=50)

    assert normalize_working_rule_branches(["main", "feat/work-1", "release_v2.0"]) == [
        "main",
        "feat/work-1",
        "release_v2.0",
    ]

    for bad in ([""], ["-flag"], ["a..b"], ["a//b"], ["a@{b}"], ["main", "main"], ["bad branch"]):
        with pytest.raises(WorkingRuleValidationError):
            normalize_working_rule_branches(bad)


def test_match_rule_exact_precedes_substring():
    r1 = _sample_rule("1", "Use strict mode")
    r2 = _sample_rule("2", "Use strict mode everywhere in TypeScript")
    assert _match_rule_by_old_text([r1, r2], "Use strict mode").matched.id == "1"

    with pytest.raises(WorkingRuleConflictError):
        _match_rule_by_old_text([r1, r2], "strict mode")

    with pytest.raises(WorkingRuleNotFoundError):
        _match_rule_by_old_text([r1, r2], "nonexistent")


def test_pack_for_capacity_preserves_pinned_and_evicts_lowest_priority():
    pinned = _sample_rule("p", "Pinned rule", importance="low", pinned=True)
    crit = _sample_rule("c", "Critical rule", importance="critical")
    low = _sample_rule("l", "Low rule to evict", importance="low")
    pending = _sample_rule("n", "Brand new normal rule", importance="normal")

    keep_bytes = working_rules_utf8_bytes([pinned, crit, pending])
    overflow = _pack_for_capacity([pinned, crit, low], pending, keep_bytes)
    assert [r.id for r in overflow] == ["l"]

    with pytest.raises(WorkingRuleCapacityError):
        assert_pinned_budget([_sample_rule("p2", "x" * 200, pinned=True)], pinned_limit_chars=100)


@pytest.mark.asyncio
async def test_working_rules_http_crud_projection_and_overflow(wr_client, wr_memory, monkeypatch):
    # 1. Create global critical pinned rule and normal branch-scoped rule.
    r1 = await wr_client.post(
        "/v1/default/working-rules",
        json={"content": "Always run lint before commit", "importance": "critical", "pinned": True},
    )
    assert r1.status_code == 200, r1.text
    r1_id = r1.json()["rule"]["id"]

    r2 = await wr_client.post(
        "/v1/default/working-rules",
        json={
            "content": "Use release checklist",
            "importance": "normal",
            "branches": ["release/1.0"],
        },
    )
    assert r2.status_code == 200, r2.text

    # 2. Project-scoped rule.
    r3 = await wr_client.post(
        "/v1/default/working-rules",
        json={
            "content": "Keep API handlers SQL-free",
            "scope": "project",
            "project_id": "proj-alpha",
            "importance": "critical",
        },
    )
    assert r3.status_code == 200, r3.text

    # 3. Projection on branch=main hides release/1.0 rule and excludes proj-alpha when project_id differs.
    proj_main = await wr_client.get(
        "/v1/default/working-rules/projection",
        params={"project_id": "proj-alpha", "branch": "main"},
    )
    assert proj_main.status_code == 200
    body_main = proj_main.json()
    assert "#### Pinned Rules (must follow)" in body_main["text"]
    assert "Always run lint before commit" in body_main["text"]
    assert "Keep API handlers SQL-free" in body_main["text"]
    assert "Use release checklist" not in body_main["text"]
    assert "critical" not in body_main["text"]

    # Projection on release/1.0 includes the branch-scoped rule.
    proj_rel = await wr_client.get(
        "/v1/default/working-rules/projection",
        params={"project_id": "proj-other", "branch": "release/1.0"},
    )
    assert proj_rel.status_code == 200
    assert "Use release checklist" in proj_rel.json()["text"]
    assert "Keep API handlers SQL-free" not in proj_rel.json()["text"]

    # Isolate the branch change from project scope when checking the revision.
    proj_other_main = await wr_client.get(
        "/v1/default/working-rules/projection",
        params={"project_id": "proj-other", "branch": "main"},
    )
    assert proj_other_main.status_code == 200
    assert proj_other_main.json()["revision"] != proj_rel.json()["revision"]

    # 4. Mutate: duplicate add is idempotent; replace preserves higher importance.
    dup = await wr_client.post(
        "/v1/default/working-rules/mutate",
        json={"action": "add", "content": "Always run lint before commit"},
    )
    assert dup.status_code == 200
    assert "already exists" in dup.json()["message"].lower()

    rep = await wr_client.post(
        "/v1/default/working-rules/mutate",
        json={
            "action": "replace",
            "old_text": "lint before commit",
            "content": "Always run lint and typecheck before commit",
            "importance": "low",
        },
    )
    assert rep.status_code == 200
    assert rep.json()["rule"]["importance"] == "critical"
    assert rep.json()["rule"]["pinned"] is True

    # 5. Export markdown.
    exp = await wr_client.get("/v1/default/working-rules/export")
    assert exp.status_code == 200
    assert "Always run lint and typecheck before commit" in exp.json()["markdown"]

    # 6. Overflow archiving under a tight pool limit, then restore and promote.
    cfg = _get_raw_config()
    monkeypatch.setattr(cfg, "working_rules_limit_bytes", 110)

    overflow_add = await wr_client.post(
        "/v1/default/working-rules/mutate",
        json={"action": "add", "content": "Prefer concise status tables in summaries", "importance": "critical"},
    )
    assert overflow_add.status_code == 200, overflow_add.text
    archived = overflow_add.json()["archived"]
    assert len(archived) == 1
    archived_id = archived[0]["id"]
    assert archived[0]["content"] == "Use release checklist"

    # Promote archived rule to a real memory bank.
    bank_id = "test-wr-promote-bank"
    await wr_memory.get_bank_profile(bank_id, request_context=RequestContext())
    promote = await wr_client.post(
        f"/v1/default/working-rules/{archived_id}/promote",
        json={"bank_id": bank_id, "tags": ["env:test"]},
    )
    assert promote.status_code == 200, promote.text
    assert promote.json()["document_id"] == f"working-rule:{archived_id}"

    # Raise limit and restore archived rule.
    monkeypatch.setattr(cfg, "working_rules_limit_bytes", 14336)
    restored = await wr_client.post(f"/v1/default/working-rules/{archived_id}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["is_archived"] is False

    # 7. Cleanup via DELETE.
    deleted = await wr_client.delete(f"/v1/default/working-rules/{r1_id}")
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "deleted"


@pytest.mark.asyncio
async def test_working_rules_organize_preview_and_apply(wr_client, wr_memory):
    res = await wr_client.post(
        "/v1/default/working-rules",
        json={"content": "Use uv run pytest for python tests", "importance": "normal"},
    )
    assert res.status_code == 200
    rule_id = res.json()["rule"]["id"]

    mock_output = _LLMOrganizeOutput(
        summary="Tighten wording",
        proposals=[
            _LLMOrganizeSuggestion(
                action="replace",
                reason="Clarify scope",
                rule_id=rule_id,
                content="Run Python tests with uv run pytest",
                importance="critical",
            )
        ],
    )
    with patch.object(
        wr_memory._llm_config,
        "call",
        new=AsyncMock(return_value=LLMCallResult(content=mock_output)),
    ):
        preview = await wr_client.post(
            "/v1/default/working-rules/organize/preview",
            json={"instructions": "Make rules concise"},
        )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert len(preview_body["proposals"]) == 1

    # A real edit after the preview invalidates its revision.
    edited = await wr_client.patch(f"/v1/default/working-rules/{rule_id}", json={"importance": "low"})
    assert edited.status_code == 200, edited.text
    stale = await wr_client.post(
        "/v1/default/working-rules/organize/apply",
        json={"expected_revision": preview_body["expected_revision"], "proposals": preview_body["proposals"]},
    )
    assert stale.status_code == 409
    assert (await wr_client.get(f"/v1/default/working-rules/{rule_id}")).json()["importance"] == "low"

    with patch.object(
        wr_memory._llm_config,
        "call",
        new=AsyncMock(return_value=LLMCallResult(content=mock_output)),
    ):
        preview = await wr_client.post("/v1/default/working-rules/organize/preview", json={})
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()

    # Valid revision applies cleanly.
    applied = await wr_client.post(
        "/v1/default/working-rules/organize/apply",
        json={
            "expected_revision": preview_body["expected_revision"],
            "proposals": [
                {"number": 0, "action": "replace", "reason": "Missing content", "rule_id": rule_id},
                *preview_body["proposals"],
            ],
        },
    )
    assert applied.status_code == 200, applied.text
    outcomes = applied.json()["results"]
    assert outcomes[0]["ok"] is False
    assert outcomes[1]["ok"] is True
    assert outcomes[1]["rule"]["content"] == "Run Python tests with uv run pytest"
    assert outcomes[1]["rule"]["importance"] == "critical"


@pytest.mark.asyncio
async def test_working_rules_concurrent_pinned_adds_share_budget(
    wr_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(_get_raw_config(), "working_rules_pinned_limit_chars", 60)
    responses = await asyncio.gather(
        wr_client.post("/v1/default/working-rules", json={"content": "First pinned rule", "pinned": True}),
        wr_client.post("/v1/default/working-rules", json={"content": "Second pinned rule", "pinned": True}),
    )
    assert sorted(response.status_code for response in responses) == [200, 400]
    listing = await wr_client.get("/v1/default/working-rules")
    assert listing.json()["total"] == 1


@pytest.mark.asyncio
async def test_working_rules_backup_round_trip_includes_long_rules(
    wr_client: AsyncClient, pg0_db_url: str, wr_schema: str, tmp_path: Path
) -> None:
    rng = random.Random(742)
    content = "".join(rng.choices(string.ascii_letters + string.digits, k=8000))
    created = await wr_client.post("/v1/default/working-rules", json={"content": content})
    assert created.status_code == 200, created.text
    rule_id = created.json()["rule"]["id"]
    rule_url = f"/v1/default/working-rules/{rule_id}"
    duplicate = await wr_client.post("/v1/default/working-rules", json={"content": content})
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["rule"]["id"] == rule_id

    backup = tmp_path / "backup.zip"
    manifest = await _backup(pg0_db_url, backup, wr_schema)
    assert manifest["tables"]["working_rules"]["rows"] == 1
    assert (await wr_client.delete(rule_url)).status_code == 200
    assert (await wr_client.get(rule_url)).status_code == 404
    await _restore(pg0_db_url, backup, wr_schema)
    assert (await wr_client.get(rule_url)).json()["content"] == content

    legacy_backup = tmp_path / "legacy.zip"
    legacy_tables = [table for table in BACKUP_TABLES if table != "working_rules"]
    await _backup(pg0_db_url, legacy_backup, wr_schema, backup_tables=legacy_tables)
    await _restore(pg0_db_url, legacy_backup, wr_schema)
    assert (await wr_client.get(rule_url)).json()["content"] == content
