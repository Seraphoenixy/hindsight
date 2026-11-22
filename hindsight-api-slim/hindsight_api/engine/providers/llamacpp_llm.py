"""Managed llama.cpp LLM provider backed by ``llama-server`` (GGUF).

Replaces the removed ``llama-cpp-python`` in-process binding with a managed
loopback ``llama-server`` subprocess (auto-installed via ``llama_install``)
speaking the OpenAI-compatible ``/v1/chat/completions`` API.
"""

from __future__ import annotations

from typing import Any

from ..llama_server import get_llama_server
from .openai_compatible_llm import OpenAICompatibleLLM


class LlamaCppLLM(OpenAICompatibleLLM):
    """LLM provider that manages a local ``llama-server`` process and GGUF weights."""

    def __init__(
        self,
        provider: str,
        api_key: str,
        base_url: str,
        model: str,
        reasoning_effort: str | None = None,
        extra_body: dict[str, Any] | None = None,
        timeout: float | None = None,
        model_path: str | None = None,
        gpu_layers: int = -1,
        context_size: int = 8192,
        chat_format: str | None = None,
        no_grammar: bool = False,
        extra_args: str | None = None,
    ) -> None:
        self._managed_base_url = base_url.strip() if base_url else ""
        self._server = (
            None
            if self._managed_base_url
            else get_llama_server(
                "llm",
                model,
                model_path=model_path,
                gpu_layers=gpu_layers,
                context_size=context_size,
                extra_args=extra_args,
            )
        )
        super().__init__(
            provider="llamacpp",
            api_key=api_key or "llama-server",
            base_url=self._managed_base_url or "http://127.0.0.1:8901/v1",
            model=model,
            reasoning_effort=reasoning_effort,
            extra_body=extra_body,
            timeout=timeout,
        )
        self.chat_format = chat_format
        self.no_grammar = no_grammar

    async def _ensure_server(self) -> None:
        if self._server is not None:
            url = await self._server.ensure_started_async()
            target = f"{url}/v1"
            if self.base_url != target:
                self.base_url = target
                self._clients.clear()

    async def verify_connection(self) -> None:
        await self._ensure_server()
        await super().verify_connection()

    async def call(self, *args: Any, **kwargs: Any) -> Any:
        await self._ensure_server()
        return await super().call(*args, **kwargs)

    async def call_with_tools(self, *args: Any, **kwargs: Any) -> Any:
        await self._ensure_server()
        return await super().call_with_tools(*args, **kwargs)

    async def cleanup(self) -> None:
        await super().cleanup()
        if self._server is not None:
            self._server.stop()
