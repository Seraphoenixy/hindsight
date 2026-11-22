"""LLM provider catalog: the one list of providers the control center offers.

Both the Settings form's provider dropdown and the "is a key required" warning
read from here. It used to be duplicated — this module held 19 entries for the
Quick-config wizard while ``settings.py`` carried its own 30-entry tuple — so the
two dropdowns disagreed and a provider chosen on one page could be unselectable
on the other. The Settings list was the superset and mirrors hindsight-api's
``PROVIDER_DEFAULT_MODELS``, so it is the one kept.

``label`` is the English name and ``label_zh`` its Chinese counterpart: the
control center opens in Chinese and can switch to English, so both ship from the
server and the browser keeps no second copy.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderInfo:
    """A provider the control center can configure."""

    id: str
    label: str
    needs_api_key: bool
    default_base_url: str | None = None
    label_zh: str = ""


# Ordered as hindsight-api's PROVIDER_DEFAULT_MODELS lists them: the hosted
# backends first, then the local ones, then the pass-through/no-LLM options.
PROVIDER_CATALOG: tuple[ProviderInfo, ...] = (
    ProviderInfo(
        "openai", "OpenAI", needs_api_key=True, default_base_url="https://api.openai.com/v1", label_zh="OpenAI"
    ),
    ProviderInfo("openai-responses", "OpenAI (Responses API)", needs_api_key=True, label_zh="OpenAI（Responses API）"),
    ProviderInfo(
        "anthropic",
        "Anthropic",
        needs_api_key=True,
        default_base_url="https://api.anthropic.com",
        label_zh="Anthropic",
    ),
    ProviderInfo("gemini", "Google Gemini", needs_api_key=True, label_zh="Google Gemini"),
    ProviderInfo(
        "groq", "Groq", needs_api_key=True, default_base_url="https://api.groq.com/openai/v1", label_zh="Groq"
    ),
    ProviderInfo("minimax", "MiniMax", needs_api_key=True, label_zh="MiniMax"),
    ProviderInfo("deepseek", "DeepSeek", needs_api_key=True, label_zh="DeepSeek"),
    ProviderInfo("zai", "Z.ai", needs_api_key=True, label_zh="Z.ai"),
    ProviderInfo("opencode-go", "OpenCode Go", needs_api_key=True, label_zh="OpenCode Go"),
    ProviderInfo(
        "atlas",
        "Atlas Cloud",
        needs_api_key=True,
        default_base_url="https://api.atlascloud.ai/v1",
        label_zh="Atlas Cloud",
    ),
    ProviderInfo(
        "meta",
        "Meta Model API",
        needs_api_key=True,
        default_base_url="https://api.meta.ai/v1",
        label_zh="Meta Model API",
    ),
    ProviderInfo(
        "ollama",
        "Ollama (local)",
        needs_api_key=False,
        default_base_url="http://localhost:11434",
        label_zh="Ollama（本地）",
    ),
    ProviderInfo("ollama-cloud", "Ollama Cloud", needs_api_key=True, label_zh="Ollama Cloud"),
    ProviderInfo("llamacpp", "llama.cpp (local GGUF)", needs_api_key=False, label_zh="llama.cpp（本地 GGUF）"),
    ProviderInfo(
        "lmstudio",
        "LM Studio (local)",
        needs_api_key=False,
        default_base_url="http://localhost:1234/v1",
        label_zh="LM Studio（本地）",
    ),
    ProviderInfo("vertexai", "Google Vertex AI", needs_api_key=False, label_zh="Google Vertex AI"),
    ProviderInfo("bedrock", "AWS Bedrock", needs_api_key=False, label_zh="AWS Bedrock"),
    ProviderInfo("litellm", "LiteLLM", needs_api_key=True, label_zh="LiteLLM"),
    ProviderInfo("litellmrouter", "LiteLLM Router", needs_api_key=True, label_zh="LiteLLM Router"),
    ProviderInfo("openrouter", "OpenRouter", needs_api_key=True, label_zh="OpenRouter"),
    ProviderInfo("requesty", "Requesty", needs_api_key=True, label_zh="Requesty"),
    ProviderInfo("fireworks", "Fireworks", needs_api_key=True, label_zh="Fireworks"),
    ProviderInfo("nous", "Nous", needs_api_key=True, label_zh="Nous"),
    ProviderInfo("volcano", "Volcano", needs_api_key=True, label_zh="Volcano"),
    ProviderInfo("xai-oauth", "xAI (OAuth)", needs_api_key=False, label_zh="xAI（OAuth）"),
    ProviderInfo("openai-codex", "OpenAI Codex (OAuth)", needs_api_key=False, label_zh="OpenAI Codex（OAuth）"),
    ProviderInfo("chatgpt", "ChatGPT (OAuth)", needs_api_key=False, label_zh="ChatGPT（OAuth）"),
    ProviderInfo("cursor", "Cursor", needs_api_key=False, label_zh="Cursor"),
    ProviderInfo("github-copilot", "GitHub Copilot", needs_api_key=False, label_zh="GitHub Copilot"),
    ProviderInfo("none", "None (no LLM / recall-only)", needs_api_key=False, label_zh="无（不用 LLM，仅召回）"),
)


def provider_ids() -> tuple[str, ...]:
    """Provider ids in display order, for the Settings dropdown's option list."""
    return tuple(p.id for p in PROVIDER_CATALOG)
