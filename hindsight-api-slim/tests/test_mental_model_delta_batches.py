"""Complete evidence batches and accounting are deterministic, not LLM judgements."""

from unittest.mock import AsyncMock

import pytest

from hindsight_api.config import HindsightConfig
from hindsight_api.engine.mental_model_delta import DeltaFact, batch_delta_facts
from hindsight_api.engine.reflect.delta_ops import DeltaCallAccounting, request_delta_operations
from hindsight_api.engine.reflect.prompts import build_structured_delta_prompt
from hindsight_api.engine.response_models import LLMCallResult, MentalModelTrigger, TokenUsage


def test_refresh_defaults_are_incremental_and_coalesced() -> None:
    assert MentalModelTrigger().mode == "delta"
    assert HindsightConfig.from_env().mental_model_min_refresh_interval_seconds == 300


def test_token_batches_keep_every_fact_and_repeat_directives() -> None:
    facts = [DeltaFact(id=str(i), text="fact " * 50, type="world") for i in range(4)]
    directive = DeltaFact(id="tone", text="Use exact dates.", type="directives")
    batches = batch_delta_facts([*facts, directive], max_memories=200, max_tokens=80)
    assert len(batches) == 4
    assert [f for batch in batches for f in batch if f.type != "directives"] == facts
    assert all(directive in batch for batch in batches)


def test_oversized_complete_input_fails_instead_of_skipping_evidence() -> None:
    with pytest.raises(ValueError, match="evidence cannot be skipped"):
        build_structured_delta_prompt(
            current_document_json="{}",
            supporting_facts=[{"id": "huge", "text": "unique fact " * 2000, "type": "world"}],
            source_query="Topic",
            max_input_tokens=1024,
            require_complete=True,
        )


async def test_schema_correction_accounts_for_both_calls() -> None:
    llm = AsyncMock()
    llm.call.side_effect = [
        LLMCallResult(content={"invalid": True}, usage=TokenUsage(input_tokens=10, output_tokens=2, total_tokens=12)),
        LLMCallResult(content={"operations": []}, usage=TokenUsage(input_tokens=20, output_tokens=3, total_tokens=23)),
    ]
    accounting = DeltaCallAccounting()
    result = await request_delta_operations(
        llm,
        system_prompt="Return operations.",
        user_prompt="No changes.",
        scope="mental_model_delta_ops",
        accounting=accounting,
    )
    assert result.operations == []
    assert len(accounting.calls) == 2
    assert accounting.usage.total_tokens == 35


async def test_failed_call_does_not_report_unknown_charges_as_complete_usage() -> None:
    llm = AsyncMock()
    llm.call.side_effect = RuntimeError("provider returned no usage")
    accounting = DeltaCallAccounting()
    with pytest.raises(RuntimeError):
        await request_delta_operations(
            llm,
            system_prompt="Return operations.",
            user_prompt="No changes.",
            scope="mental_model_delta_ops",
            accounting=accounting,
        )
    assert len(accounting.calls) == 1
    assert accounting.usage_complete is False
