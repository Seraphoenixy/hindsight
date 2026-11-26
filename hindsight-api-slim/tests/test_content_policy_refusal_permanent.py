"""Regression tests for vectorize-io/hindsight#3690.

A provider content-policy (AUP) refusal is a deterministic response to the
content, not a transient fault. Before this fix it was treated as an ordinary
error: the provider replayed it through its full transport retry budget,
``extract_facts_from_text`` wrapped it in a generic ``RuntimeError``, and the
worker rescheduled the whole task — which replayed the identical refusal all
over again before finally failing the operation.

These tests pin the permanence at the two layers that outlive any one provider:

1. ``extract_facts_from_text`` re-raises the permanent type when any chunk was
   refused, instead of flattening it into ``RuntimeError``,
2. ``_is_non_retryable_task_error`` classifies it, so ``execute_task`` marks the
   operation failed instead of raising ``RetryTaskAt``.

The layer-1 tests (a provider not retrying its own refusal) were removed with the
``claude-code`` provider in this private build; ``test_gemini_content_block.py``
and the Anthropic suite cover the same permanence for the providers that remain.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hindsight_api.engine.llm_interface import ProviderContentPolicyError, ProviderRateLimitResetError
from hindsight_api.engine.memory_engine import _is_non_retryable_task_error
from hindsight_api.worker.exceptions import RetryTaskAt

# Verbatim shape of the refusal from the issue's worker log.
REFUSAL_TEXT = (
    "API Error: Sonnet 4.5 can't help with this. Start a new session to continue.\n\n"
    "Learn more: https://www.anthropic.com/legal/aup\n\n"
    "Request ID: req_011CeEwAh8ESFmbMGca7ZkrG"
)


# ---------------------------------------------------------------------------
# Layer 1: extract_facts_from_text keeps the permanent type
# ---------------------------------------------------------------------------


def _extraction_config() -> SimpleNamespace:
    """Only the chunking fields extract_facts_from_text reads before chunk dispatch."""
    return SimpleNamespace(
        retain_chunk_size=1000,
        retain_structured_chunk_size=1000,
        retain_chunk_context_tokens=0,
        # Chunking budgets the image-aware splitter reads; these bodies carry no
        # images, so the values only have to exist.
        retain_max_attachments_per_chunk=8,
    )


async def _run_extraction(chunk_errors: dict[int, Exception]):
    """Extract from a 2-chunk text where the given chunk indices raise."""
    from hindsight_api.engine.retain import fact_extraction

    async def fake_chunk_extract(*, chunk_index: int, **_kwargs):
        error = chunk_errors.get(chunk_index)
        if error is not None:
            raise error
        return [], fact_extraction.TokenUsage()

    with patch.object(fact_extraction, "_extract_facts_with_auto_split", side_effect=fake_chunk_extract):
        return await fact_extraction.extract_facts_from_text(
            text="First sentence. " * 100 + "\n\n" + "Second sentence. " * 100,
            event_date=None,
            llm_config=SimpleNamespace(),
            agent_name="agent",
            # Handed in ready-made so the stub config only needs the chunking
            # fields: what is under test is how the chunk error propagates, and
            # building the real prompt would drag in every extraction setting.
            extraction_prompt=fact_extraction.ExtractionPrompt(
                system_prompt="", response_schema=fact_extraction.FactExtractionResponse
            ),
            config=_extraction_config(),
        )


@pytest.mark.asyncio
async def test_refused_chunk_raises_permanent_error():
    """One refused chunk makes the whole extraction permanently failed, not retryable."""
    with pytest.raises(ProviderContentPolicyError) as excinfo:
        await _run_extraction({0: ProviderContentPolicyError(f"Claude Code reported an error: {REFUSAL_TEXT}")})

    assert "content policy" in str(excinfo.value).lower()
    assert "chunk 0" in str(excinfo.value)
    assert _is_non_retryable_task_error(excinfo.value) is True


@pytest.mark.asyncio
async def test_refusal_wins_over_a_sibling_quota_defer():
    """A refusal alongside a deferrable quota error still fails permanently.

    Deferring would reschedule the task for a batch that can never succeed: the
    refused chunk is refused again whenever the quota reopens.
    """
    errors = {
        0: ProviderRateLimitResetError(retry_at=datetime.now(UTC) + timedelta(hours=1), message="weekly limit"),
        1: ProviderContentPolicyError(f"Claude Code reported an error: {REFUSAL_TEXT}"),
    }
    with pytest.raises(ProviderContentPolicyError):
        await _run_extraction(errors)


@pytest.mark.asyncio
async def test_transient_chunk_failure_stays_retryable():
    """Without a refusal the existing generic failure (and its retry) is unchanged."""
    with pytest.raises(RuntimeError) as excinfo:
        await _run_extraction({1: RuntimeError("connection reset by peer")})

    assert not isinstance(excinfo.value, ProviderContentPolicyError)
    assert _is_non_retryable_task_error(excinfo.value) is False


# ---------------------------------------------------------------------------
# Layer 2: the worker fails the operation instead of rescheduling it
# ---------------------------------------------------------------------------


async def _ensure_bank(pool, bank_id: str) -> None:
    await pool.execute(
        "INSERT INTO banks (bank_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        bank_id,
        bank_id,
    )


async def _create_pending_operation(pool, bank_id: str, operation_id: uuid.UUID) -> None:
    payload = json.dumps(
        {
            "type": "batch_retain",
            "operation_id": str(operation_id),
            "bank_id": bank_id,
            "contents": [{"content": "test", "document_id": "doc-1"}],
        }
    )
    await pool.execute(
        """
        INSERT INTO async_operations (operation_id, bank_id, operation_type, status, task_payload)
        VALUES ($1, $2, 'retain', 'pending', $3::jsonb)
        """,
        operation_id,
        bank_id,
        payload,
    )


@pytest.mark.asyncio
async def test_execute_task_marks_refused_retain_failed_without_retry(memory):
    """execute_task must fail the operation on the first refusal, not RetryTaskAt."""
    bank_id = f"test-worker-{uuid.uuid4().hex[:8]}"
    operation_id = uuid.uuid4()

    pool = await memory._get_pool()
    await _ensure_bank(pool, bank_id)
    await _create_pending_operation(pool, bank_id, operation_id)

    refusal = ProviderContentPolicyError(
        "Fact extraction refused by provider content policy: 1 of 1 failed chunks (1 total) were refused; "
        f"retrying cannot succeed. First failures: chunk 0: ProviderContentPolicyError: {REFUSAL_TEXT}"
    )

    task_dict = {
        "type": "batch_retain",
        "operation_id": str(operation_id),
        "bank_id": bank_id,
        "contents": [{"content": "test", "document_id": "doc-1"}],
    }

    with patch.object(memory, "_handle_batch_retain", side_effect=refusal):
        try:
            await memory.execute_task(task_dict)
        except RetryTaskAt as exc:
            pytest.fail(f"A content-policy refusal must not be retried, but execute_task raised {exc!r}")

    row = await pool.fetchrow(
        "SELECT status, error_message FROM async_operations WHERE operation_id = $1",
        operation_id,
    )
    assert row is not None, "Operation row disappeared"
    assert row["status"] == "failed", f"Expected status='failed' after a refusal, got {row['status']!r}"
    assert "content policy" in (row["error_message"] or "").lower()

    await pool.execute("DELETE FROM async_operations WHERE operation_id = $1", operation_id)
    await pool.execute("DELETE FROM banks WHERE bank_id = $1", bank_id)


@pytest.mark.asyncio
async def test_failed_async_retain_names_the_providers_own_refusal(memory, monkeypatch):
    """The failed operation carries Gemini's block reason, not just "refused by content policy".

    The operation's error_message is the only place a worker-side refusal can be read from, so it must
    say what the provider actually answered. Drives the real Gemini provider (network mocked) through an
    async retain.
    """
    pytest.importorskip("google.genai")
    from google.genai import types as genai_types
    from hindsight_api.engine.providers.mock_llm import MockLLM
    from hindsight_api.models import RequestContext
    from tests.test_gemini_content_block import _empty_response, _make_gemini_provider

    gemini = _make_gemini_provider()
    gemini._client.aio.models.generate_content = AsyncMock(
        return_value=_empty_response(finish_reason=genai_types.FinishReason.PROHIBITED_CONTENT)
    )

    async def through_gemini(self, *args, **kwargs):
        return await gemini.call(*args, **kwargs)

    monkeypatch.setattr(MockLLM, "call", through_gemini)

    bank_id = f"test-gemini-refusal-{uuid.uuid4().hex[:8]}"
    ctx = RequestContext()
    submitted = await memory.submit_async_retain(bank_id, [{"content": "refused content"}], request_context=ctx)
    op = await memory.get_operation_status(bank_id, submitted["operation_id"], request_context=ctx)

    assert op["status"] == "failed"
    assert op["retry_count"] == 0
    assert "Gemini blocked the request (PROHIBITED_CONTENT)" in op["error_message"]
