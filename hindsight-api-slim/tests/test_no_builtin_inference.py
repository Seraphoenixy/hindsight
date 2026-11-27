"""Unit tests verifying managed llama.cpp local inference and Qwen3-0.6B embeddings."""

import pytest

from hindsight_api.config import (
    DEFAULT_EMBEDDINGS_LOCAL_MODEL,
    DEFAULT_EMBEDDINGS_PROVIDER,
    DEFAULT_RERANKER_LOCAL_MODEL,
    DEFAULT_RERANKER_PROVIDER,
    PROVIDER_DEFAULT_MODELS,
    clear_config_cache,
)
from hindsight_api.engine.cross_encoder import (
    LlamaCppCrossEncoder,
    RRFPassthroughCrossEncoder,
    create_cross_encoder_from_env,
)
from hindsight_api.engine.embeddings import (
    LlamaCppEmbeddings,
    OpenAIEmbeddings,
    create_embeddings_from_env,
)
from hindsight_api.engine.llama_server import get_embedding_preset_dimension, resolve_preset
from hindsight_api.engine.llm_wrapper import LLMProvider
from hindsight_api.engine.providers.llamacpp_llm import LlamaCppLLM


def test_defaults_match_upstream_local_experience():
    assert DEFAULT_EMBEDDINGS_PROVIDER == "local"
    assert DEFAULT_EMBEDDINGS_LOCAL_MODEL == "qwen3-0.6b"
    assert DEFAULT_RERANKER_PROVIDER == "rrf"
    assert DEFAULT_RERANKER_LOCAL_MODEL == "hindsight-ai/hs-rerank-1"
    assert PROVIDER_DEFAULT_MODELS["llamacpp"] == "gemma-4-e2b-it"


def test_openai_embeddings_allows_local_base_url_without_api_key(monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
    monkeypatch.setenv("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "openai")
    monkeypatch.setenv("HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL", "http://127.0.0.1:8080/v1")
    monkeypatch.delenv("HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("HINDSIGHT_API_LLM_API_KEY", raising=False)
    clear_config_cache()
    try:
        emb = create_embeddings_from_env()
        assert isinstance(emb, OpenAIEmbeddings)
    finally:
        clear_config_cache()


@pytest.mark.parametrize("provider", ["local", "llamacpp"])
def test_local_embeddings_uses_managed_llamacpp(monkeypatch, provider):
    monkeypatch.setenv("HINDSIGHT_API_EMBEDDINGS_PROVIDER", provider)
    clear_config_cache()
    try:
        emb = create_embeddings_from_env()
        assert isinstance(emb, LlamaCppEmbeddings)
        assert emb.dimension == 1024
    finally:
        clear_config_cache()


@pytest.mark.parametrize("model_name", ["qwen3-0.6b", "Qwen/Qwen3-Embedding-0.6B"])
def test_qwen3_06b_embedding_preset(monkeypatch, model_name):
    preset = resolve_preset(model_name)
    assert preset is not None
    assert preset.mode == "embedding"
    assert preset.filename == "Qwen3-Embedding-0.6B-Q8_0.gguf"
    assert get_embedding_preset_dimension(model_name) == 1024

    monkeypatch.setenv("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "local")
    monkeypatch.setenv("HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL", model_name)
    clear_config_cache()
    try:
        emb = create_embeddings_from_env()
        assert isinstance(emb, LlamaCppEmbeddings)
        assert emb.dimension == 1024
    finally:
        clear_config_cache()


def test_onnx_embeddings_provider_rejected(monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "onnx")
    clear_config_cache()
    try:
        with pytest.raises(ValueError, match="removed in this private build"):
            create_embeddings_from_env()
    finally:
        clear_config_cache()


@pytest.mark.parametrize("provider", ["rrf", "none"])
def test_reranker_supports_rrf_and_none_passthrough(monkeypatch, provider):
    monkeypatch.setenv("HINDSIGHT_API_RERANKER_PROVIDER", provider)
    clear_config_cache()
    try:
        reranker = create_cross_encoder_from_env()
        assert isinstance(reranker, RRFPassthroughCrossEncoder)
    finally:
        clear_config_cache()


@pytest.mark.parametrize("provider", ["local", "llamacpp"])
def test_local_reranker_uses_managed_llamacpp(monkeypatch, provider):
    monkeypatch.setenv("HINDSIGHT_API_RERANKER_PROVIDER", provider)
    clear_config_cache()
    try:
        reranker = create_cross_encoder_from_env()
        assert isinstance(reranker, LlamaCppCrossEncoder)
    finally:
        clear_config_cache()


@pytest.mark.parametrize("provider", ["onnx", "flashrank", "jina-mlx"])
def test_removed_reranker_providers_rejected(monkeypatch, provider):
    monkeypatch.setenv("HINDSIGHT_API_RERANKER_PROVIDER", provider)
    clear_config_cache()
    try:
        with pytest.raises(ValueError, match="removed in this private build"):
            create_cross_encoder_from_env()
    finally:
        clear_config_cache()


def test_llamacpp_llm_provider_creates_managed_provider():
    llm = LLMProvider(provider="llamacpp", api_key="", base_url="", model="gemma-4-e2b-it")
    assert isinstance(llm._provider_impl, LlamaCppLLM)
