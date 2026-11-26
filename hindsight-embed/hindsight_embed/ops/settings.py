"""Catalog of the settings the control center renders as a grouped form.

The profile ``.env`` carries ~360 documented options (see ``env.example``). A form
over all of them would be unusable, so this module names the CORE set a user
actually changes — provider selection, embeddings, reranking, and the handful of
service knobs worth a field — and groups them.

This is the single source of truth for that set: the API returns it (so the
browser never hardcodes a field list that could drift from the server) and the
save path uses it to decide which keys the form owns. Every other key in the file
is preserved untouched, and the raw ``.env`` editor remains the way to reach the
options this catalog does not name.

Every human-readable label and description carries an English primary and a
Chinese companion (``label_zh`` / ``description_zh``). The control center opens in
Chinese and can switch to English, so both must ship from this one catalog — the
browser must not keep a second copy of these strings that drifts from the server.

Field types drive both the widget and the write path:

- ``string``/``password``/``number``  — a text/number input.
- ``select``                          — one of ``options``, closed set; anything else is rejected.
- ``combo``                           — a dropdown of the known ``options`` with a custom entry for
  values the daemon also accepts (an arbitrary HuggingFace id, a local ``.gguf`` path, a
  provider-specific reasoning level). The dropdown is a real ``<select>``, so the common
  choices are picked rather than typed; the custom entry keeps the open values reachable.
- ``boolean``                         — a true/false select; written as ``true``/``false``.

An empty value means "unset": the key is REMOVED from the ``.env`` so the daemon
falls back to its own default, which is what ``default`` documents.

The LLM provider/key/model fields live here and nowhere else: the Quick-config tab
used to duplicate them through its own save path, with a different blank-value
rule for the key and a shorter provider list. The Settings form is now the single
place those three are written.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from . import providers

FieldKind = Literal["string", "password", "number", "select", "combo", "boolean"]


@dataclass(frozen=True)
class OptionLabel:
    """A display label for one ``select`` option value.

    A select's stored value is a machine id (``openai``, ``none``); rendering that
    id is readable enough for most fields but loses the Chinese name the UI is in,
    and for sentinel values like ``none`` it is actively misleading. Fields that
    can supply labels do so from the same catalog the daemon validates against.
    """

    value: str
    label: str
    label_zh: str


@dataclass(frozen=True)
class SettingField:
    """One editable setting in a group."""

    key: str
    label: str
    kind: FieldKind
    default: str = ""
    description: str = ""
    options: tuple[str, ...] = ()  # for select/enum
    placeholder: str = ""
    label_zh: str = ""
    description_zh: str = ""
    option_labels: tuple[OptionLabel, ...] = ()  # optional display names for options


@dataclass(frozen=True)
class SettingGroup:
    """A titled block of related settings."""

    id: str
    label: str
    description: str
    fields: tuple[SettingField, ...]
    label_zh: str = ""
    description_zh: str = ""


# The provider list is owned by ``providers.PROVIDER_CATALOG`` — one list, so the
# dropdown's options and their display labels cannot drift apart. It mirrors
# hindsight-api's PROVIDER_DEFAULT_MODELS: the daemon owns validation and picks its
# own default when MODEL is unset, so this only drives the dropdown and a hint.
_PROVIDER_IDS: tuple[str, ...] = providers.provider_ids()

_PROVIDER_OPTION_LABELS: tuple[OptionLabel, ...] = tuple(
    OptionLabel(value=p.id, label=p.label, label_zh=p.label_zh) for p in providers.PROVIDER_CATALOG
)

_EMBEDDINGS_PROVIDERS: tuple[str, ...] = (
    "local",
    "onnx",
    "tei",
    "openai",
    "cohere",
    "google",
    "openrouter",
    "zeroentropy",
    "litellm",
    "litellm-sdk",
    "nvidia",
    "gemini",
)

_RERANKER_PROVIDERS: tuple[str, ...] = (
    "local",
    "rrf",
    "tei",
    "cohere",
    "flashrank",
    "onnx",
    "litellm",
    "zeroentropy",
    "google",
    "alibaba",
    "nvidia",
    "typesafe",
)

_DECISION_MODEL_PROVIDERS: tuple[str, ...] = ("none", "hindsight", "typesafe", "cloudflare", "openai")


SETTING_GROUPS: tuple[SettingGroup, ...] = (
    SettingGroup(
        id="service",
        label="Service",
        description="Where the API listens and how loudly it logs. Change these before a restart, not during one.",
        label_zh="服务",
        description_zh="API 监听的地址与日志级别。这些改动在重启前进行，不要在运行中修改。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_HOST",
                label="Bind address",
                kind="string",
                default="0.0.0.0",
                description="Interface the API listens on. 127.0.0.1 keeps it loopback-only.",
                placeholder="0.0.0.0",
                label_zh="绑定地址",
                description_zh="API 监听的网络接口。127.0.0.1 表示仅本机可访问。",
            ),
            SettingField(
                key="HINDSIGHT_API_LOG_LEVEL",
                label="Log level",
                kind="select",
                default="info",
                description="Verbosity of the API log the Logs tab shows.",
                options=("debug", "info", "warning", "error", "critical"),
                label_zh="日志级别",
                description_zh="日志页签所显示 API 日志的详细程度。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_VISION",
                label="Model reads images",
                kind="boolean",
                description="Unset lets the provider answer. Set it for a vision model behind a gateway Hindsight cannot identify.",
                label_zh="模型可读取图片",
                description_zh="未设置时由提供商判断。视觉模型位于 Hindsight 无法识别的网关之后时，需显式设置。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_CONNECT_TIMEOUT",
                label="LLM connect timeout (s)",
                kind="number",
                default="10",
                description="Ceiling on a single LLM connection attempt. 0 disables the cap.",
                placeholder="10",
                label_zh="LLM 连接超时（秒）",
                description_zh="单次 LLM 连接尝试的上限。0 表示不限制。",
            ),
            SettingField(
                key="HINDSIGHT_API_OPERATION_RETENTION_DAYS",
                label="Operation retention (days)",
                kind="number",
                default="0",
                description="Prune finished operation rows after this many days. 0 keeps them forever.",
                placeholder="0",
                label_zh="操作记录保留天数",
                description_zh="超过该天数的已完成操作记录会被清理。0 表示永久保留。",
            ),
        ),
    ),
    SettingGroup(
        id="llm",
        label="LLM",
        description="The model that extracts facts, consolidates, and answers reflect. Required — with none, storing memory fails.",
        label_zh="LLM",
        description_zh="负责事实抽取、记忆整合与 reflect 回答的模型。必需项：未配置时记忆写入会失败。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_LLM_PROVIDER",
                label="Provider",
                kind="select",
                description="Which backend serves the model. OAuth providers need no API key.",
                options=_PROVIDER_IDS,
                label_zh="提供商",
                description_zh="提供模型服务的后端。OAuth 类提供商无需 API 密钥。",
                option_labels=_PROVIDER_OPTION_LABELS,
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_API_KEY",
                label="API key",
                kind="password",
                description="Required by most providers; unused by OAuth and local ones. Clearing it removes the stored key.",
                label_zh="API 密钥",
                description_zh="多数提供商必需；OAuth 与本地提供商不使用。清空该字段会删除已保存的密钥。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_MODEL",
                label="Model",
                kind="string",
                description="Blank uses the provider's own default.",
                placeholder="provider default",
                label_zh="模型",
                description_zh="留空则使用提供商自身的默认模型。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_BASE_URL",
                label="Base URL",
                kind="string",
                description="Override for a gateway or self-hosted endpoint.",
                placeholder="https://api.openai.com/v1",
                label_zh="基础 URL",
                description_zh="用于网关或自建服务的覆盖地址。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_REASONING_EFFORT",
                label="Reasoning effort",
                kind="combo",
                description="Sent as-is for models that support it. 'none' stops a self-hosted reasoning model emitting thinking blocks.",
                options=("none", "low", "medium", "high", "xhigh"),
                label_zh="推理强度",
                description_zh="原样传给支持该参数的模型。'none' 可阻止自建推理模型输出思考块。",
                option_labels=(
                    OptionLabel("none", "none — omit the parameter", "none — 不传该参数"),
                    OptionLabel("low", "low", "低"),
                    OptionLabel("medium", "medium", "中"),
                    OptionLabel("high", "high", "高"),
                    OptionLabel("xhigh", "xhigh", "极高"),
                ),
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_TEMPERATURE",
                label="Temperature",
                kind="string",
                description="0.0-2.0, or 'none' to omit the parameter. Per-operation settings take precedence.",
                placeholder="none",
                label_zh="温度",
                description_zh="0.0-2.0，或 'none' 表示不传该参数。按操作单独设置的参数优先。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_MAX_CONCURRENT",
                label="Max concurrent calls",
                kind="number",
                default="2",
                description="In-flight LLM requests across the whole server.",
                placeholder="2",
                label_zh="最大并发调用数",
                description_zh="整个服务同时在途的 LLM 请求数。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_MAX_RETRIES",
                label="Max retries",
                kind="number",
                default="3",
                description="Retries after the first attempt on a retryable failure.",
                placeholder="3",
                label_zh="最大重试次数",
                description_zh="可重试失败时，首次尝试之后的重试次数。",
            ),
            SettingField(
                key="HINDSIGHT_API_LLM_STRICT_SCHEMA",
                label="Strict structured output",
                kind="boolean",
                default="false",
                description="Grammar-enforce JSON on schema-capable backends. Helps weaker self-hosted models.",
                label_zh="严格结构化输出",
                description_zh="在支持 schema 的后端上强制 JSON 语法。对能力较弱的自建模型有帮助。",
            ),
        ),
    ),
    SettingGroup(
        id="vision",
        label="Vision",
        description="Only retain chunks carrying an inline attachment use this model; text-only chunks stay on the LLM above.",
        label_zh="视觉",
        description_zh="只有携带内联附件的写入分块会使用该模型；纯文本分块仍走上方的 LLM。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_VLM_PROVIDER",
                label="Provider",
                kind="select",
                description="Unset sends attachments to the main LLM instead.",
                options=_PROVIDER_IDS,
                label_zh="提供商",
                description_zh="未设置时附件交给主 LLM 处理。",
            ),
            SettingField(
                key="HINDSIGHT_API_VLM_API_KEY",
                label="API key",
                kind="password",
                description="Only when the vision provider differs from the main one.",
                label_zh="API 密钥",
                description_zh="仅在视觉提供商与主提供商不同时需要。",
            ),
            SettingField(
                key="HINDSIGHT_API_VLM_MODEL",
                label="Model",
                kind="string",
                description="Model used for the vision slot.",
                placeholder="gemini-2.5-flash",
                label_zh="模型",
                description_zh="视觉槽位使用的模型。",
            ),
            SettingField(
                key="HINDSIGHT_API_VLM_BASE_URL",
                label="Base URL",
                kind="string",
                description="Override for a gateway or self-hosted endpoint.",
                label_zh="基础 URL",
                description_zh="用于网关或自建服务的覆盖地址。",
            ),
        ),
    ),
    SettingGroup(
        id="embeddings",
        label="Embeddings",
        description="Vectors behind semantic recall. 'local' runs in-process with no external service.",
        label_zh="向量嵌入",
        description_zh="语义召回所使用的向量。'local' 在进程内运行，不依赖外部服务。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_PROVIDER",
                label="Provider",
                kind="select",
                default="local",
                description="local and onnx run in-process; the rest need a service or credential.",
                options=_EMBEDDINGS_PROVIDERS,
                label_zh="提供商",
                description_zh="local 与 onnx 在进程内运行；其余需要外部服务或凭据。",
            ),
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL",
                label="Local model",
                kind="combo",
                default="qwen3-0.6b",
                description="A bundled GGUF preset, or any HuggingFace id / local .gguf path for the local provider.",
                placeholder="qwen3-0.6b",
                label_zh="本地模型",
                description_zh="内置 GGUF 预设，或本地提供商可用的任意 HuggingFace id / 本地 .gguf 路径。",
                options=("qwen3-0.6b", "bge-m3", "qwen3-4b"),
                option_labels=(
                    OptionLabel(
                        "qwen3-0.6b",
                        "Qwen3-Embedding-0.6B-Q8_0.gguf (default)",
                        "Qwen3-Embedding-0.6B-Q8_0.gguf（默认）",
                    ),
                    OptionLabel(
                        "bge-m3",
                        "bge-m3-Q8_0.gguf",
                        "bge-m3-Q8_0.gguf",
                    ),
                    OptionLabel(
                        "qwen3-4b",
                        "Qwen3-Embedding-4B-Q8_0.gguf",
                        "Qwen3-Embedding-4B-Q8_0.gguf",
                    ),
                ),
            ),
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_LOCAL_MAX_CONCURRENT",
                label="Local concurrency",
                kind="number",
                default="4",
                description="Threads running the local model at once. 1 is lowest memory on Windows.",
                placeholder="4",
                label_zh="本地并发数",
                description_zh="同时运行本地模型的线程数。Windows 上设为 1 内存占用最低。",
            ),
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
                label="OpenAI model",
                kind="combo",
                description="Used when the provider above is openai. A gateway may serve other ids.",
                placeholder="text-embedding-3-small",
                label_zh="OpenAI 模型",
                description_zh="上方提供商选择 openai 时使用。网关可提供其他模型 id。",
                options=("text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"),
                option_labels=(
                    OptionLabel(
                        "text-embedding-3-small",
                        "text-embedding-3-small — 1536 dims (default)",
                        "text-embedding-3-small — 1536 维（默认）",
                    ),
                    OptionLabel(
                        "text-embedding-3-large",
                        "text-embedding-3-large — 3072 dims",
                        "text-embedding-3-large — 3072 维",
                    ),
                    OptionLabel(
                        "text-embedding-ada-002",
                        "text-embedding-ada-002 — 1536 dims, legacy",
                        "text-embedding-ada-002 — 1536 维，旧版",
                    ),
                ),
            ),
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
                label="OpenAI key",
                kind="password",
                description="Embedding keys are per-provider; this one is for the openai provider.",
                label_zh="OpenAI 密钥",
                description_zh="嵌入密钥按提供商分别配置；该项用于 openai 提供商。",
            ),
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_TEI_URL",
                label="TEI URL",
                kind="string",
                description="Text Embeddings Inference endpoint, for the tei provider.",
                placeholder="http://localhost:8080",
                label_zh="TEI 地址",
                description_zh="Text Embeddings Inference 服务地址，用于 tei 提供商。",
            ),
            SettingField(
                key="HINDSIGHT_API_EMBEDDINGS_MAX_INPUT_TOKENS",
                label="Max input tokens",
                kind="number",
                default="8192",
                description="Cap per input before embedding. 0 sends text uncapped.",
                placeholder="8192",
                label_zh="最大输入 token 数",
                description_zh="嵌入前对单条输入的上限。0 表示不截断。",
            ),
        ),
    ),
    SettingGroup(
        id="reranker",
        label="Reranker",
        description="Reorder recall candidates. 'rrf' is a passthrough (no neural reranking); 'local' runs a cross-encoder in-process.",
        label_zh="重排",
        description_zh="对召回候选重新排序。'rrf' 为直通，不做神经重排；'local' 在进程内运行交叉编码器。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_RERANKER_PROVIDER",
                label="Provider",
                kind="select",
                default="rrf",
                description="rrf keeps fusion order and costs nothing.",
                options=_RERANKER_PROVIDERS,
                label_zh="提供商",
                description_zh="rrf 保持融合顺序，无额外开销。",
            ),
            SettingField(
                key="HINDSIGHT_API_RERANKER_LOCAL_MODEL",
                label="Local model",
                kind="combo",
                default="hindsight-ai/hs-rerank-1",
                description="A bundled GGUF preset, or any cross-encoder id for the local provider.",
                placeholder="hindsight-ai/hs-rerank-1",
                label_zh="本地模型",
                description_zh="内置 GGUF 预设，或本地提供商可用的任意交叉编码器 id。",
                options=("hindsight-ai/hs-rerank-1", "bge-reranker-v2-m3"),
                option_labels=(
                    OptionLabel(
                        "hindsight-ai/hs-rerank-1",
                        "bge-reranker-base-q8_0.gguf (default)",
                        "bge-reranker-base-q8_0.gguf（默认）",
                    ),
                    OptionLabel(
                        "bge-reranker-v2-m3",
                        "bge-reranker-v2-m3-Q8_0.gguf",
                        "bge-reranker-v2-m3-Q8_0.gguf",
                    ),
                ),
            ),
            SettingField(
                key="HINDSIGHT_API_RERANKER_TEI_URL",
                label="TEI URL",
                kind="string",
                description="Text Embeddings Inference endpoint, for the tei provider.",
                placeholder="http://localhost:8081",
                label_zh="TEI 地址",
                description_zh="Text Embeddings Inference 服务地址，用于 tei 提供商。",
            ),
            SettingField(
                key="HINDSIGHT_API_RERANKER_MAX_CANDIDATES",
                label="Max candidates",
                kind="number",
                default="300",
                description="Candidates one recall hands the reranker.",
                placeholder="300",
                label_zh="最大候选数",
                description_zh="单次召回交给重排器的候选数量。",
            ),
        ),
    ),
    SettingGroup(
        id="decision",
        label="Decision model",
        description="Typed judgments recall, reflect and consolidation use instead of a full LLM call. 'none' disables it.",
        label_zh="决策模型",
        description_zh="召回、思考与整合中用类型化判断替代完整 LLM 调用。'none' 表示停用。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_DECISION_MODEL_PROVIDER",
                label="Provider",
                kind="select",
                default="none",
                description="none leaves every judgment to the LLM above.",
                options=_DECISION_MODEL_PROVIDERS,
                label_zh="提供商",
                description_zh="none 表示所有判断都交给上方的 LLM。",
            ),
            SettingField(
                key="HINDSIGHT_API_DECISION_MODEL_API_KEY",
                label="API key",
                kind="password",
                description="Cloud providers only; a custom BASE_URL may need none.",
                label_zh="API 密钥",
                description_zh="仅云提供商需要；自建 BASE_URL 可能不需要。",
            ),
            SettingField(
                key="HINDSIGHT_API_DECISION_MODEL_MODEL",
                label="Model",
                kind="string",
                description="Blank uses the provider's default.",
                placeholder="jev-latest",
                label_zh="模型",
                description_zh="留空则使用提供商默认值。",
            ),
            SettingField(
                key="HINDSIGHT_API_DECISION_MODEL_BASE_URL",
                label="Base URL",
                kind="string",
                description="Point it at your own vLLM or compatible endpoint.",
                label_zh="基础 URL",
                description_zh="指向自建的 vLLM 或兼容端点。",
            ),
        ),
    ),
    SettingGroup(
        id="retain",
        label="Retain and recall",
        description="How much one ingest may carry, and how long a pass may run before it is abandoned.",
        label_zh="写入与召回",
        description_zh="单次写入可承载的数据量，以及一次处理在放弃前允许运行的时间。",
        fields=(
            SettingField(
                key="HINDSIGHT_API_RETAIN_CHUNK_SIZE",
                label="Chunk size",
                kind="number",
                description="Characters per chunk when splitting a long document. Blank uses the server default.",
                label_zh="分块大小",
                description_zh="拆分长文档时每块的字符数。留空使用服务端默认值。",
            ),
            SettingField(
                key="HINDSIGHT_API_RETAIN_WALL_TIMEOUT",
                label="Retain wall timeout (s)",
                kind="number",
                default="3600",
                description="Ceiling on one retain pass, including queueing.",
                placeholder="3600",
                label_zh="写入墙钟超时（秒）",
                description_zh="单次写入处理的上限，含排队时间。",
            ),
            SettingField(
                key="HINDSIGHT_API_CONSOLIDATION_WALL_TIMEOUT",
                label="Consolidation timeout (s)",
                kind="number",
                default="7200",
                description="Ceiling on one consolidation pass.",
                placeholder="7200",
                label_zh="整合超时（秒）",
                description_zh="单次整合处理的上限。",
            ),
        ),
    ),
)


# Sync lives on its own page (`/sync`), not in the local settings form: signing
# in needs the daemon running, while that form is meant to work with it stopped,
# and the two were sharing one save path. See ADR-012. The catalog below is the
# sync page's, and `save-sync-settings` owns exactly these keys.
SYNC_SETTING_GROUP = SettingGroup(
    id="sync",
    label="Multi-device sync",
    description="Background object-level sync across devices through a Hindsight relay.",
    label_zh="多端同步",
    description_zh="通过 Hindsight 中继在多台设备之间自动同步记忆对象。",
    fields=(
        SettingField(
            key="HINDSIGHT_SYNC_STATE_DIR",
            label="State directory",
            kind="string",
            description="Local private directory holding device identity and sync lock.",
            label_zh="状态目录",
            description_zh="存放设备凭据与同步锁的本地目录。",
        ),
        SettingField(
            key="HINDSIGHT_SYNC_AUTO_ENABLED",
            label="Automatic sync",
            kind="boolean",
            default="true",
            description="Run lightweight checks on startup, after local writes, and on interval.",
            label_zh="自动同步",
            description_zh="在启动、本地写入后和固定间隔自动检查并同步变更。",
        ),
        SettingField(
            key="HINDSIGHT_SYNC_INTERVAL_SECONDS",
            label="Check interval (s)",
            kind="number",
            default="15",
            description="Seconds between lightweight sync checks.",
            placeholder="15",
            label_zh="检查间隔（秒）",
            description_zh="两次轻量同步检查之间的间隔秒数。",
        ),
    ),
)

ALL_SETTING_GROUPS = SETTING_GROUPS + (SYNC_SETTING_GROUP,)


def field_index() -> dict[str, SettingField]:
    """Every field in the LOCAL catalog, keyed by env var name."""
    return {field.key: field for group in SETTING_GROUPS for field in group.fields}


def sync_field_index() -> dict[str, SettingField]:
    """The sync page's fields, keyed by env var name."""
    return {field.key: field for field in SYNC_SETTING_GROUP.fields}


def managed_keys() -> set[str]:
    """The env var names the grouped forms own, together.

    Each save path only rewrites its own subset (`field_index` or
    `sync_field_index`); every other key in the profile's .env is preserved
    as-is, which is what lets the forms and the raw editor coexist.
    """
    return set(field_index()) | set(sync_field_index())
