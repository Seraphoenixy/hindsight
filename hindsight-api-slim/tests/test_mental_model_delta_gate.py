"""Direct incremental edits: no reflect, complete pagination, atomic failure and usage."""

import asyncio
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from hindsight_api import MemoryEngine, RequestContext
from hindsight_api.config import get_config
from hindsight_api.engine.cross_encoder import RRFPassthroughCrossEncoder
from hindsight_api.engine.memories import get_memories
from hindsight_api.engine.memory_engine import MentalModelRefreshError
from hindsight_api.engine.reflect.delta_ops import DeltaOperationList
from hindsight_api.engine.response_models import LLMCallResult, TokenUsage
from hindsight_api.engine.schema import fq_table
from hindsight_api.engine.task_backend import SyncTaskBackend
from tests.conftest import _teardown_memory_engine
from tests.refresh_support import RefreshTestEmbeddings

TOPIC = "What are the user's durable collaboration preferences?"
RELEVANT = "The user prefers bullet points over prose."
UNRELATED = "The build server runs Linux."


@dataclass(frozen=True)
class _Page:
    bank_id: str
    mm_id: str


async def _page_with_new_memories(memory: MemoryEngine, request_context: RequestContext) -> _Page:
    bank_id = f"test-delta-gate-{uuid.uuid4().hex[:8]}"
    await memory.ensure_bank_profile(bank_id, request_context=request_context)
    mm = await memory.create_mental_model(
        bank_id=bank_id,
        name="User Preferences",
        source_query=TOPIC,
        content="# Preferences\n\nThe user prefers concise answers.\n",
        trigger={"mode": "delta"},
        request_context=request_context,
    )
    assert memory._pool is not None
    # Direct SQL because the window is the thing under test: the page must look
    # refreshed a day ago and the memories must land after that, and neither the
    # refresh nor retain lets a caller back-date ``last_refreshed_at``/``updated_at``.
    async with memory._pool.acquire() as conn:
        await conn.execute(
            "UPDATE mental_models SET last_refreshed_at = NOW() - INTERVAL '1 day', "
            "last_refreshed_source_query = source_query WHERE bank_id = $1 AND id = $2",
            bank_id,
            mm["id"],
        )
        for text in (RELEVANT, UNRELATED):
            await conn.execute(
                "INSERT INTO memory_units (id, bank_id, text, fact_type, tags, created_at, updated_at) "
                "VALUES ($1, $2, $3, 'world', ARRAY[]::varchar[], NOW() - INTERVAL '2 minutes', "
                "NOW() - INTERVAL '2 minutes')",
                uuid.uuid4(),
                bank_id,
                text,
            )
    return _Page(bank_id=bank_id, mm_id=mm["id"])


@pytest_asyncio.fixture
async def memory(pg0_db_url, query_analyzer):
    # These tests enumerate rows rather than rank them. A deterministic embedding
    # keeps the DB path real without installing the optional local ML stack.
    embedding = RefreshTestEmbeddings()
    engine = MemoryEngine(
        db_url=pg0_db_url,
        memory_llm_provider="mock",
        embeddings=embedding,
        cross_encoder=RRFPassthroughCrossEncoder(),
        query_analyzer=query_analyzer,
        run_migrations=False,
        task_backend=SyncTaskBackend(),
    )
    await engine.initialize()
    yield engine
    await _teardown_memory_engine(engine)


@pytest.fixture
def gated(memory: MemoryEngine, monkeypatch):
    calls = SimpleNamespace(reflect=AsyncMock(side_effect=AssertionError("delta must not reflect")), llm=[])

    async def fake_call(*, messages, **kwargs):
        calls.llm.append(messages)
        ops = DeltaOperationList.model_validate(
            {"operations": [{"op": "append_block", "section_id": "preferences", "text": f"Edit {len(calls.llm)}."}]}
        )
        return LLMCallResult(content=ops, usage=TokenUsage(input_tokens=11, output_tokens=3, total_tokens=14))

    monkeypatch.setattr(memory, "reflect_async", calls.reflect)
    monkeypatch.setattr(memory._mental_model_refresh_llm_config, "call", fake_call)
    return calls


async def test_delta_reads_facts_without_a_decision_model(memory, request_context, gated):
    page = await _page_with_new_memories(memory, request_context)
    refreshed = await memory.refresh_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    gated.reflect.assert_not_called()
    assert len(gated.llm) == 1
    assert RELEVANT in str(gated.llm[0]) and UNRELATED in str(gated.llm[0])
    assert "Edit 1." in refreshed["content"]
    rr = refreshed["reflect_response"]
    assert rr["delta_read"] == {"memories": 2}
    assert rr["delta_batches"] == 1 and rr["llm_call_count"] == 1
    assert rr["usage"]["input_tokens"] == 11 and rr["usage"]["output_tokens"] == 3


async def test_empty_window_costs_no_llm_call(memory, request_context, gated):
    page = await _page_with_new_memories(memory, request_context)
    await memory.refresh_mental_model(bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context)
    gated.llm.clear()
    refreshed = await memory.refresh_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    assert gated.llm == []
    gated.reflect.assert_not_called()
    assert refreshed["reflect_response"]["outcome"] == "content_preserved_no_new_facts"


async def test_operation_keeps_cost_after_the_page_is_refreshed_again(memory, request_context, gated):
    page = await _page_with_new_memories(memory, request_context)
    queued = await memory.submit_async_refresh_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )

    async def completed():
        while True:
            operation = await memory.get_operation_status(
                bank_id=page.bank_id, operation_id=queued["operation_id"], request_context=request_context
            )
            if operation["status"] in ("completed", "failed"):
                return operation
            await asyncio.sleep(0.05)

    operation = await asyncio.wait_for(completed(), timeout=10)
    assert operation["status"] == "completed"
    metadata = operation["result_metadata"]
    assert metadata["refresh_mode"] == "delta"
    assert metadata["llm_call_count"] == 1 and metadata["delta_batches"] == 1
    assert metadata["input_tokens"] == 11 and metadata["output_tokens"] == 3
    assert metadata["usage_complete"] is True
    await memory.refresh_mental_model(bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context)
    again = await memory.get_operation_status(
        bank_id=page.bank_id, operation_id=queued["operation_id"], request_context=request_context
    )
    assert again["result_metadata"] == metadata


async def test_over_cap_and_equal_timestamps_are_processed_in_batches(memory, request_context, gated, monkeypatch):
    monkeypatch.setattr(get_config()._config, "mental_model_delta_gate_max_memories", 1)
    page = await _page_with_new_memories(memory, request_context)
    # Real retains often write many facts in a single transaction, hence equal timestamps.
    async with memory._pool.acquire() as conn:
        await conn.execute(
            "UPDATE memory_units SET updated_at = NOW() - INTERVAL '1 minute' WHERE bank_id = $1", page.bank_id
        )
    refreshed = await memory.refresh_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    assert len(gated.llm) == 2
    assert "Edit 1." in str(gated.llm[1]), "the second batch edits the first batch's result"
    assert all(text in str(gated.llm) for text in (RELEVANT, UNRELATED))
    assert refreshed["reflect_response"]["delta_batches"] == 2
    assert refreshed["reflect_response"]["usage"]["total_tokens"] == 28
    async with memory._pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM mental_models WHERE bank_id=$1 AND id=$2", page.bank_id, page.mm_id)
        assert await memory.compute_mental_model_is_stale(conn, page.bank_id, row) is False


async def test_second_batch_failure_preserves_document_and_watermark(memory, request_context, gated, monkeypatch):
    monkeypatch.setattr(get_config()._config, "mental_model_delta_gate_max_memories", 1)
    page = await _page_with_new_memories(memory, request_context)
    before = await memory.get_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    original_call = memory._mental_model_refresh_llm_config.call

    async def fail_second(**kwargs):
        if gated.llm:
            raise ValueError("second batch failed")
        return await original_call(**kwargs)

    monkeypatch.setattr(memory._mental_model_refresh_llm_config, "call", fail_second)
    with pytest.raises(MentalModelRefreshError):
        await memory.refresh_mental_model(
            bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
        )
    after = await memory.get_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    assert after["content"] == before["content"]
    assert after["last_memory_seen_at"] == before["last_memory_seen_at"]


async def test_directives_reach_every_batch(memory, request_context, gated, monkeypatch):
    monkeypatch.setattr(get_config()._config, "mental_model_delta_gate_max_memories", 1)
    page = await _page_with_new_memories(memory, request_context)
    await memory.create_directive(
        page.bank_id, "Tone", "Always write dates as YYYY-MM-DD.", request_context=request_context
    )
    await memory.refresh_mental_model(bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context)
    assert len(gated.llm) == 2
    assert all("Always write dates as YYYY-MM-DD." in str(call) for call in gated.llm)


async def test_a_failed_direct_edit_says_why(memory, request_context, gated, monkeypatch):
    page = await _page_with_new_memories(memory, request_context)

    async def boom(**kwargs):
        raise ValueError("invalid reply")

    monkeypatch.setattr(memory._mental_model_refresh_llm_config, "call", boom)
    with pytest.raises(MentalModelRefreshError):
        await memory.refresh_mental_model(
            bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
        )
    after = await memory.get_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    assert after["reflect_response"]["refresh_skipped"] == "delta_ops_failed"


class _ProviderStatusError(Exception):
    """A provider SDK error carrying an HTTP status, like openai's APIStatusError."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"provider answered {status_code}")
        self.status_code = status_code


async def test_a_rate_limited_edit_fails_as_temporary_and_does_not_pause(memory, request_context, gated, monkeypatch):
    """#6674: a 429 on the delta edit was turned into ``delta_ops_failed``, which lost the
    error's type and paused automatic refresh. The same 429 in reflect does not pause."""
    page = await _page_with_new_memories(memory, request_context)

    async def rate_limited(*, messages, **kwargs):
        raise _ProviderStatusError(429)

    monkeypatch.setattr(memory._mental_model_refresh_llm_config, "call", rate_limited)
    with pytest.raises(_ProviderStatusError):
        await memory._handle_refresh_mental_model({"bank_id": page.bank_id, "mental_model_id": page.mm_id})

    assert await memory._automatic_refresh_paused(page.bank_id, page.mm_id) is False
    preserved = await memory.get_mental_model(
        bank_id=page.bank_id, mental_model_id=page.mm_id, request_context=request_context
    )
    assert preserved["content"] == "# Preferences\n\nThe user prefers concise answers.\n"


async def test_the_store_lists_new_memories_in_the_page_scope(memory: MemoryEngine, request_context):
    """The gate's read: the watermark's scope and window, oldest first, capped."""
    bank_id = f"test-delta-gate-scope-{uuid.uuid4().hex[:8]}"
    await memory.ensure_bank_profile(bank_id, request_context=request_context)
    now = datetime.now(UTC)
    since, until = now - timedelta(hours=1), now
    rows = [
        # (text, fact_type, tags, minutes ago)
        ("before the window", "world", ["a"], 120),
        ("on the lower bound", "world", ["a"], 60),
        ("oldest in window", "world", ["a"], 50),
        ("newer in window", "experience", ["a"], 40),
        ("wrong tag", "world", ["b"], 30),
        ("observation", "observation", ["a"], 20),
        ("newest in window", "world", ["a"], 10),
    ]
    # Direct SQL to place each row at an exact ``updated_at``, which retain cannot do.
    async with memory._pool.acquire() as conn:
        for text, fact_type, tags, minutes in rows:
            at = since if text == "on the lower bound" else now - timedelta(minutes=minutes)
            await conn.execute(
                "INSERT INTO memory_units (id, bank_id, text, fact_type, tags, created_at, updated_at) "
                "VALUES ($1, $2, $3, $4, $5, $6, $6)",
                uuid.uuid4(),
                bank_id,
                text,
                fact_type,
                tags,
                at,
            )

        async def listed(limit: int = 10) -> list[str]:
            found = await get_memories().memories_updated_between(
                conn=conn,
                fq_table=fq_table,
                bank_id=bank_id,
                until=until,
                since=since,
                limit=limit,
                fact_types=["world", "experience"],
                tags=["a"],
                tags_match="any_strict",
            )
            assert found is not None
            return [m.text for m in found]

        assert await listed() == ["oldest in window", "newer in window", "newest in window"]
        assert await listed(limit=2) == ["oldest in window", "newer in window"]


@pytest.mark.parametrize("raw", ["0", "-1", "lots"])
def test_gate_cap_must_be_a_positive_integer(monkeypatch, raw):
    from hindsight_api.config import ENV_MENTAL_MODEL_DELTA_GATE_MAX_MEMORIES, HindsightConfig

    monkeypatch.setenv(ENV_MENTAL_MODEL_DELTA_GATE_MAX_MEMORIES, raw)
    with pytest.raises(ValueError, match=ENV_MENTAL_MODEL_DELTA_GATE_MAX_MEMORIES):
        HindsightConfig.from_env()
