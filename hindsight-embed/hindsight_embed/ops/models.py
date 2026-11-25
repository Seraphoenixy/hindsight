"""Ask a provider which models its API currently serves.

The Settings form edits the provider, key, and base URL in memory; this module
turns those three values into the provider's model-discovery call without
touching the profile or the daemon. It runs before a save so a user can pick a
model that actually exists, and it stays advisory: the model field remains free
text because gateways routinely serve ids their own ``/models`` route omits.

Only discovery lives here. Provider construction, authentication defaults and
request translation remain in hindsight-api; duplicating them would create a
second list of provider quirks that can drift from the daemon's.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import json
from dataclasses import dataclass
from typing import Any

import aiohttp

from .providers import PROVIDER_CATALOG

REQUEST_TIMEOUT = 15.0

_PROVIDER_LABELS: dict[str, str] = {provider.id: provider.label for provider in PROVIDER_CATALOG}

# OpenAI-compatible bases. Keep these in step with
# ``hindsight_api.engine.providers.openai_compatible_llm``; a provider missing
# here has no honest default to query and asks the user for a Base URL.
_OPENAI_COMPATIBLE_BASE_URLS: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "openai-responses": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "minimax": "https://api.minimax.io/v1",
    "deepseek": "https://api.deepseek.com",
    "zai": "https://api.z.ai/api/coding/paas/v4",
    "opencode-go": "https://opencode.ai/zen/go/v1",
    "atlas": "https://api.atlascloud.ai/v1",
    "meta": "https://api.meta.ai/v1",
    "ollama": "http://localhost:11434/v1",
    "ollama-cloud": "https://ollama.com/v1",
    "lmstudio": "http://localhost:1234/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "requesty": "https://router.requesty.ai/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "nous": "https://inference-api.nousresearch.com/v1",
    "volcano": "https://ark.cn-beijing.volces.com/api/v3",
}

_UNSUPPORTED: dict[str, str] = {
    "none": "The 'none' provider does not use a model, so it has no model list.",
    "mock": "The mock provider has no model list; its model id is fixed.",
    "bedrock": "Bedrock has no single plain /models endpoint here. Enter the model id directly.",
    "vertexai": "Vertex AI model discovery needs Google credentials. Enter the model id directly.",
    "openai-codex": "OpenAI Codex uses OAuth credentials outside Hindsight. Enter the model id directly.",
    "chatgpt": "ChatGPT uses OAuth credentials outside Hindsight. Enter the model id directly.",
    "cursor": "Cursor manages its own model routing. Enter the model id directly.",
    "antigravity": "Antigravity uses the signed-in agy CLI. Run agy models and enter a model id.",
    "github-copilot": "GitHub Copilot uses OAuth credentials outside Hindsight. Enter the model id directly.",
    "xai-oauth": "xAI OAuth credentials are managed outside Hindsight. Enter the model id directly.",
}


@dataclass(frozen=True)
class ModelList:
    """Resolved provider, endpoint, and the ids it advertised."""

    provider: str
    base_url: str
    models: list[str]


class _HttpError(ValueError):
    """A provider answered, but not with a model list."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def list_models(provider: str, api_key: str, base_url: str) -> ModelList:
    """Return the model ids ``provider`` advertises for these settings.

    ``api_key`` is used as given (empty means no key); the caller decides whether
    it came from the form or the saved profile. ``base_url`` empty means the
    provider's own default.
    """
    name = (provider or "").strip().lower()
    key = (api_key or "").strip()
    if not name:
        raise ValueError("Choose a provider before fetching models.")
    if name in _UNSUPPORTED:
        raise ValueError(_UNSUPPORTED[name])
    if name in {"anthropic", "gemini"} and not key:
        raise ValueError(f"An API key is required to list {_label(name)} models.")

    base = (base_url or "").strip().rstrip("/")
    if name == "anthropic":
        return _anthropic_models(key, base)
    if name == "gemini":
        return _gemini_models(key, base)
    if name == "ollama":
        return _ollama_models(key, base or _OPENAI_COMPATIBLE_BASE_URLS["ollama"])
    if name == "llamacpp":
        if not base:
            raise ValueError(
                "llama.cpp serves the model it was launched with. Set the Base URL of its "
                "OpenAI-compatible endpoint (usually ending in /v1), or enter the model id directly."
            )
        return _openai_compatible_models(name, key, base)

    resolved = base or _OPENAI_COMPATIBLE_BASE_URLS.get(name, "")
    if not resolved:
        raise ValueError(f"{_label(name)} has no default model endpoint. Set a Base URL, then fetch models again.")
    return _openai_compatible_models(name, key, resolved)


def _label(provider: str) -> str:
    return _PROVIDER_LABELS.get(provider, provider or "provider")


def _openai_compatible_models(provider: str, api_key: str, base_url: str) -> ModelList:
    url = f"{base_url.rstrip('/')}/models"
    headers = {"Accept": "application/json", "User-Agent": "hindsight-embed"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = _request_json(url, headers, what=f"{_label(provider)} model list")
    return ModelList(provider=provider, base_url=base_url, models=_model_ids(payload))


def _anthropic_models(api_key: str, base_url: str) -> ModelList:
    base = (base_url or "https://api.anthropic.com").rstrip("/")
    url = f"{base}/models?limit=1000" if base.endswith("/v1") else f"{base}/v1/models?limit=1000"
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    headers = {
        "Accept": "application/json",
        "User-Agent": "hindsight-embed",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    payload = _request_json(url, headers, what="Anthropic model list")
    return ModelList(provider="anthropic", base_url=base, models=_model_ids(payload))


def _gemini_models(api_key: str, base_url: str) -> ModelList:
    base = (base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    if not base.endswith("/v1beta"):
        base = f"{base}/v1beta"
    url = f"{base}/models?pageSize=1000"
    headers = {"Accept": "application/json", "User-Agent": "hindsight-embed", "x-goog-api-key": api_key}
    payload = _request_json(url, headers, what="Gemini model list")
    models = [
        _strip_gemini_prefix(str(entry.get("name", "")))
        for entry in _payload_items(payload, preferred=("models",))
        if isinstance(entry, dict) and str(entry.get("name", "")).strip() and _gemini_can_generate(entry)
    ]
    return ModelList(provider="gemini", base_url=base, models=_dedupe(models))


def _ollama_models(api_key: str, base_url: str) -> ModelList:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    url = f"{base}/api/tags"
    headers = {"Accept": "application/json", "User-Agent": "hindsight-embed"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        payload = _request_json(url, headers, what="Ollama model list")
    except _HttpError as error:
        # A custom base may be an OpenAI-compatible proxy rather than Ollama
        # itself; /api/tags is absent there, but /v1/models usually is not.
        if error.status != 404:
            raise
        return _openai_compatible_models("ollama", api_key, f"{base}/v1")
    return ModelList(provider="ollama", base_url=base, models=_model_ids(payload, preferred=("models",)))


def _gemini_can_generate(entry: dict[str, Any]) -> bool:
    methods = entry.get("supportedGenerationMethods")
    return not isinstance(methods, list) or "generateContent" in methods


def _strip_gemini_prefix(name: str) -> str:
    return name[len("models/") :] if name.startswith("models/") else name


def _model_ids(payload: Any, preferred: tuple[str, ...] = ("data", "models", "items", "result")) -> list[str]:
    ids: list[str] = []
    for item in _payload_items(payload, preferred=preferred):
        if isinstance(item, str):
            ids.append(item)
            continue
        if isinstance(item, dict):
            for field in ("id", "name", "model"):
                value = item.get(field)
                if isinstance(value, str) and value.strip():
                    ids.append(value.strip())
                    break
    return _dedupe(ids)


def _payload_items(payload: Any, *, preferred: tuple[str, ...]) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for field in preferred:
        items = payload.get(field)
        if isinstance(items, list):
            return items
    return []


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        model = value.strip()
        if model and model not in seen:
            seen.add(model)
            unique.append(model)
    return sorted(unique, key=str.lower)


def _request_json(url: str, headers: dict[str, str], *, what: str) -> Any:
    """Synchronous boundary for the async request.

    The thread wrapper mirrors ``_http_probe.probe_get``: an ops call is sync,
    but a caller that reaches this from inside an event loop must not have its
    loop state cleared by ``asyncio.run``.
    """
    call = functools.partial(_arequest_json, url, headers, what=what)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, call()).result()


async def _arequest_json(url: str, headers: dict[str, str], *, what: str) -> Any:
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                status = response.status
                body = await response.read()
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
        raise ValueError(f"Could not reach {what}: {error}. Check the Base URL and network.") from None

    _raise_for_status(status, body, what)
    try:
        return json.loads(body.decode("utf-8", errors="replace"))
    except ValueError:
        raise ValueError(f"{what} returned a response that was not JSON.") from None


def _raise_for_status(status: int, body: bytes, what: str) -> None:
    if status in (401, 403):
        raise _HttpError(f"{what} rejected the credentials (HTTP {status}). Check the API key.", status)
    if status == 404:
        raise _HttpError(
            f"{what} returned HTTP 404. The provider may not expose a model list at this "
            "Base URL; check it, or enter the model id directly.",
            status,
        )
    if status >= 400:
        detail = body.decode("utf-8", errors="replace").strip()[:300]
        suffix = f" {detail}" if detail else ""
        raise _HttpError(f"{what} returned HTTP {status}.{suffix}", status)
