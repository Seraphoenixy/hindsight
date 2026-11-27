"""Tests for progress-based streaming idle timeouts in OpenAI LLM providers."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from hindsight_api.engine.providers.openai_compatible_llm import OpenAICompatibleLLM
from hindsight_api.engine.providers.openai_responses_llm import OpenAIResponsesLLM


class _FakeAsyncStream:
    def __init__(self, items):
        self._items = items

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for delay, item in self._items:
            if delay > 0:
                await asyncio.sleep(delay)
            yield item

    async def aclose(self):
        return None


@pytest.mark.asyncio
async def test_openai_compatible_stream_survives_past_timeout_while_progressing():
    """Active token streaming longer than ``timeout`` total must not be killed."""
    chunks = [
        (
            0.08,
            SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="hel"), finish_reason=None, error=None)],
                usage=None,
                error=None,
            ),
        ),
        (
            0.08,
            SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="lo "), finish_reason=None, error=None)],
                usage=None,
                error=None,
            ),
        ),
        (
            0.08,
            SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="wor"), finish_reason=None, error=None)],
                usage=None,
                error=None,
            ),
        ),
        (
            0.08,
            SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="ld"), finish_reason="stop", error=None)],
                usage=SimpleNamespace(prompt_tokens=1, completion_tokens=4, total_tokens=5),
                error=None,
            ),
        ),
    ]
    llm = OpenAICompatibleLLM(
        provider="openai",
        api_key="test-key",
        base_url="http://localhost:1234/v1",
        model="test-model",
        timeout=0.2,
    )
    mock_client = MagicMock()

    async def _fake_create(**_kwargs):
        return _FakeAsyncStream(chunks)

    mock_client.chat.completions.create = _fake_create
    llm._request_client = lambda: mock_client  # type: ignore[method-assign]

    resp = await llm._create_chat_completion({"model": "test-model", "messages": []})
    assert resp.choices[0].message.content == "hello world"


@pytest.mark.asyncio
async def test_openai_compatible_stream_times_out_on_empty_keepalive_stall():
    """Empty chunks without real delta progress must still trip ``timeout``."""
    chunks = [
        (
            0.05,
            SimpleNamespace(choices=[], usage=None, error=None),
        )
        for _ in range(10)
    ]
    llm = OpenAICompatibleLLM(
        provider="openai",
        api_key="test-key",
        base_url="http://localhost:1234/v1",
        model="test-model",
        timeout=0.15,
    )
    mock_client = MagicMock()

    async def _fake_create(**_kwargs):
        return _FakeAsyncStream(chunks)

    mock_client.chat.completions.create = _fake_create
    llm._request_client = lambda: mock_client  # type: ignore[method-assign]

    with pytest.raises(asyncio.TimeoutError):
        await llm._create_chat_completion({"model": "test-model", "messages": []})


@pytest.mark.asyncio
async def test_openai_responses_stream_survives_past_timeout_while_progressing():
    """Active Responses streaming longer than ``timeout`` total must succeed."""
    final_resp = SimpleNamespace(
        output_text="done",
        output=[],
        usage=SimpleNamespace(input_tokens=1, output_tokens=2),
    )
    events = [
        (0.08, SimpleNamespace(type="response.output_text.delta", delta="do")),
        (0.08, SimpleNamespace(type="response.output_text.delta", delta="ne")),
        (0.08, SimpleNamespace(type="response.completed", response=final_resp)),
    ]
    llm = OpenAIResponsesLLM(
        provider="openai-responses",
        api_key="test-key",
        base_url="http://localhost:1234/v1",
        model="test-model",
        timeout=0.15,
    )
    mock_client = MagicMock()

    async def _fake_create(**_kwargs):
        return _FakeAsyncStream(events)

    mock_client.responses.create = _fake_create
    llm._client = mock_client

    resp = await llm._create_response({"model": "test-model", "input": "hi"})
    assert resp.output_text == "done"
