import dataclasses
import json
from datetime import datetime, timezone

import pytest

from hindsight_api.config import _get_raw_config
from hindsight_api.engine.llm_wrapper import LLMConfig
from hindsight_api.engine.retain.fact_extraction import extract_facts_from_text
from tests.llm_judge import assert_meets_criteria

pytestmark = pytest.mark.hs_llm_core


@pytest.mark.asyncio
async def test_engineering_change_dates_and_unknown_times_follow_source():
    source = (
        "On November 24, 2026 at 16:00 UTC, we deployed the production change from "
        "autoInject=reflect to autoInject=recall, replacing reflect as the default for that profile. "
        "The retry policy requires stable operation IDs, but its adoption date is unknown. "
        "A possible future switch to pages has only been proposed, not accepted or deployed."
    )
    config = dataclasses.replace(
        _get_raw_config(),
        retain_extraction_mode="concise",
        retain_extract_causal_links=False,
        retain_optional_fact_dimensions=True,
        retain_mission="Extract confirmed project decisions and constraints, preserving their applicability and dates.",
    )
    facts, _chunks, _usage = await extract_facts_from_text(
        text=source,
        event_date=datetime(2026, 11, 26, tzinfo=timezone.utc),
        llm_config=LLMConfig.from_env(),
        config=config,
    )
    response = json.dumps(
        [
            {"text": fact.fact, "occurred_start": fact.occurred_start, "occurred_end": fact.occurred_end}
            for fact in facts
        ],
        default=str,
    )
    await assert_meets_criteria(
        response=response,
        criteria=(
            "The confirmed deployment from reflect to recall is represented as an event with "
            "occurred_start and occurred_end on 2026-11-24 at 16:00 UTC. Its scope is the production "
            "profile. It is not dated using the November 26 reference/ingestion date. The retry policy "
            "has no invented occurrence date. The proposed switch to pages is not represented as "
            "an accepted or deployed replacement. The old reflect default is historical in this profile."
        ),
        context=source,
    )
