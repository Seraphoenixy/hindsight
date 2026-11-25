from dataclasses import replace
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
import pytest_asyncio

from hindsight_api.config import _get_raw_config
from hindsight_api.engine.consolidation.consolidator import (
    _ConclusionBatchResponse,
    _config_for_scope,
    run_consolidation_job,
)
from hindsight_api.engine.cross_encoder import RRFPassthroughCrossEncoder
from hindsight_api.engine.memory_engine import MemoryEngine
from hindsight_api.engine.providers.mock_llm import MockLLM
from tests.consolidation_answers import batch_fact_texts
from tests.test_retain_same_document_concurrency import _StubEmbeddings


@pytest_asyncio.fixture
async def conclusion_memory(pg0_db_url):
    memory = MemoryEngine(
        db_url=pg0_db_url,
        memory_llm_provider="mock",
        memory_llm_api_key="",
        memory_llm_model="mock",
        embeddings=_StubEmbeddings(),
        cross_encoder=RRFPassthroughCrossEncoder(),
        run_migrations=False,
    )
    await memory.initialize()
    try:
        yield memory
    finally:
        await memory.close()


def test_a_backfill_cannot_rewrite_a_newer_conclusion():
    earlier = datetime(2026, 1, 1, tzinfo=timezone.utc)
    later = datetime(2026, 2, 1, tzinfo=timezone.utc)
    answer = _ConclusionBatchResponse(
        creates=[],
        updates=[{"observation_id": "O1", "text": "Use port 8443.", "source_fact_ids": ["F1"]}],
        skipped_fact_ids=[],
    )
    actual = answer.to_actions(
        {"F1": "old-fact", "O1": "known"}, {"old-fact": earlier}, {"known": later}, {"known": "Use port 9443."}
    )
    assert actual.updates[0].text == "Use port 9443."


def test_scope_can_opt_out_of_bank_conclusion_grouping():
    config = replace(
        _get_raw_config(),
        consolidation_group_by_conclusion=True,
        consolidation_strategies=[
            {"scopes": [{"tags": ["project:legacy"]}], "consolidation_group_by_conclusion": False}
        ],
    )
    assert _config_for_scope(config, ["project:legacy"]).consolidation_group_by_conclusion is False
    assert _config_for_scope(config, ["project:current"]).consolidation_group_by_conclusion is True


@pytest.mark.parametrize(
    ("updates", "skipped", "error"),
    [
        ([], [], "account for every fact"),
        ([], ["O1"], "unknown fact"),
        ([{"observation_id": "F1", "text": "New.", "source_fact_ids": ["F1"]}], [], "unknown or repeated"),
        ([{"observation_id": "O1", "text": None, "source_fact_ids": ["F1"]}] * 2, [], "unknown or repeated"),
    ],
)
def test_invalid_conclusion_actions_cannot_reach_storage(updates, skipped, error):
    answer = _ConclusionBatchResponse(creates=[], updates=updates, skipped_fact_ids=skipped)
    with pytest.raises(ValueError, match=error):
        answer.to_actions({"F1": "fact", "O1": "known"}, {"fact": None}, {"known": None}, {"known": "Current."})


async def test_engineering_conclusions_replay_across_sources_and_rounds(conclusion_memory, request_context):
    memory = conclusion_memory
    bank_id = f"engineering-conclusions-{uuid4().hex}"
    project = "project:memory"
    first = "Memory edits require an exact text snapshot and reject stale writes to prevent lost updates."
    updated = first + " Use the text returned by Recall before editing."
    versioned = "Memory edits in offline format v1 use a revision number in place of a text snapshot."
    responses = [
        {"creates": [{"text": first, "source_fact_ids": ["F1"]}], "updates": [], "skipped_fact_ids": []},
        {"creates": [{"text": first, "source_fact_ids": ["F1", "F2"]}], "updates": [], "skipped_fact_ids": []},
        {
            "creates": [],
            "updates": [{"observation_id": "O1", "text": updated, "source_fact_ids": ["F1"]}],
            "skipped_fact_ids": [],
        },
        {"creates": [], "updates": [], "skipped_fact_ids": ["F1"]},
        {"creates": [{"text": versioned, "source_fact_ids": ["F1"]}], "updates": [], "skipped_fact_ids": []},
    ]
    observed_inputs = []
    llm = MockLLM(provider="mock", api_key="", base_url="", model="mock")

    def reply(messages, scope):
        assert scope == "consolidation"
        assert "Review the whole batch" in messages[0]["content"]
        user_prompt = messages[1]["content"]
        observed_inputs.append(user_prompt)
        assert batch_fact_texts(user_prompt)
        if len(observed_inputs) == 2:
            assert "account for every fact" in messages[-1]["content"]
        return responses[len(observed_inputs) - 1]

    llm.set_response_callback(reply)

    async def retain_and_consolidate(day, *facts):
        ids = await memory.retain_batch_async(
            bank_id,
            [
                {
                    "content": text,
                    "document_id": f"{source}-{day}",
                    "event_date": datetime(2026, 1, day, tzinfo=timezone.utc),
                    "tags": [project, f"source:{source}"],
                    "observation_scopes": [[project]],
                }
                for source, text in facts
            ],
            request_context=request_context,
        )
        await run_consolidation_job(memory_engine=memory, bank_id=bank_id, request_context=request_context)
        return {str(memory_id) for item in ids for memory_id in item}

    async def recall():
        return await memory.recall_async(
            bank_id,
            "memory edits require an exact text snapshot or revision number",
            fact_type=["observation"],
            tags=[project],
            tags_match="all_strict",
            include_source_facts=True,
            request_context=request_context,
        )

    original_llm = memory._consolidation_llm_config
    try:
        config = await memory.update_bank_config(
            bank_id,
            {
                "retain_extraction_mode": "chunks",
                "enable_observations": True,
                "enable_auto_consolidation": False,
                "consolidation_strategies": [
                    {"scopes": [{"tags": [project], "tags_match": "exact"}], "consolidation_group_by_conclusion": True}
                ],
            },
            request_context=request_context,
        )
        assert config.overrides["consolidation_strategies"][0]["consolidation_group_by_conclusion"] is True
        memory._consolidation_llm_config = AsyncMock()
        memory._consolidation_llm_config.with_config = lambda *_args, **_kwargs: llm
        with patch.object(memory, "submit_async_consolidation"):
            originals = await retain_and_consolidate(
                1,
                ("chat", "Memory edits require an exact text snapshot so concurrent changes are preserved."),
                ("survey", "Memory editing rejects stale text snapshots instead of applying a write."),
            )
            initial = await recall()
            assert [item.text for item in initial.results] == [first]
            observation_id = initial.results[0].id
            supplement = await retain_and_consolidate(
                2, ("upload", "Recall returns the exact text snapshot to supply when editing memory.")
            )
            routine = await retain_and_consolidate(
                3, ("chat", "Refactored the memory editing test file and ran tests.")
            )
            separate = await retain_and_consolidate(
                4, ("upload", "Offline memory editing format v1 uses a revision number rather than a text snapshot.")
            )

        final = await recall()
        stored = await memory.list_memory_units(bank_id, fact_type="observation", request_context=request_context)
        assert stored["total"] == 2
        assert len(observed_inputs) == 5
        assert {item.text for item in final.results} == {updated, versioned}
        current = next(item for item in final.results if item.id == observation_id)
        assert set(current.source_fact_ids) == originals | supplement
        assert set(next(item for item in final.results if item.text == versioned).source_fact_ids) == separate
        assert routine.isdisjoint(current.source_fact_ids)
    finally:
        memory._consolidation_llm_config = original_llm
        await memory.delete_bank(bank_id, request_context=request_context)
