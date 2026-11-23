"""Provider model discovery for the Settings form."""

import io
import json
import sys

import pytest

from hindsight_embed.ops import models, service
from hindsight_embed.ops.cli import main as ops_main


@pytest.fixture
def temp_home(tmp_path, monkeypatch):
    from hindsight_embed.cli import set_cli_profile_override

    set_cli_profile_override(None)
    monkeypatch.delenv("HINDSIGHT_EMBED_PROFILE", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    (home / ".hindsight").mkdir()
    return home


def test_openai_compatible_models_use_the_unsaved_base_and_key(monkeypatch):
    seen = {}

    def fake_request(url, headers, *, what):
        seen.update(url=url, headers=headers, what=what)
        return {"data": [{"id": "z-model"}, {"id": "a-model"}, {"id": "a-model"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = models.list_models("openai", "sk-test", "https://gateway.example/v1")

    assert seen["url"] == "https://gateway.example/v1/models"
    assert seen["headers"]["Authorization"] == "Bearer sk-test"
    assert result.models == ["a-model", "z-model"]
    assert result.base_url == "https://gateway.example/v1"


def test_anthropic_uses_its_own_headers_and_model_shape(monkeypatch):
    seen = {}

    def fake_request(url, headers, *, what):
        seen.update(url=url, headers=headers, what=what)
        return {"data": [{"id": "claude-a"}, {"id": "claude-b"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = models.list_models("anthropic", "sk-ant", "")

    assert seen["url"] == "https://api.anthropic.com/v1/models?limit=1000"
    assert seen["headers"]["x-api-key"] == "sk-ant"
    assert seen["headers"]["anthropic-version"] == "2023-06-01"
    assert result.models == ["claude-a", "claude-b"]
    assert result.base_url == "https://api.anthropic.com"


def test_gemini_lists_only_generate_content_models(monkeypatch):
    seen = {}

    def fake_request(url, headers, *, what):
        seen.update(url=url, headers=headers)
        return {
            "models": [
                {"name": "models/gemini-z", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/text-embedding-1", "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/gemini-a"},
            ]
        }

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = models.list_models("gemini", "gem-key", "")
    assert seen["url"] == "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
    assert seen["headers"]["x-goog-api-key"] == "gem-key"
    assert result.models == ["gemini-a", "gemini-z"]


def test_ollama_reads_its_native_tags_route(monkeypatch):
    seen = {}

    def fake_request(url, headers, *, what):
        seen["url"] = url
        return {"models": [{"name": "llama3.2:latest"}, {"name": "qwen3:8b"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = models.list_models("ollama", "", "")
    assert seen["url"] == "http://localhost:11434/api/tags"
    assert result.models == ["llama3.2:latest", "qwen3:8b"]


def test_ollama_uses_the_tags_route_for_a_remote_host(monkeypatch):
    seen = {}

    def fake_request(url, headers, *, what):
        seen["url"] = url
        return {"models": [{"name": "remote-model"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = models.list_models("ollama", "", "http://gpu-box.local:11434")
    assert seen["url"] == "http://gpu-box.local:11434/api/tags"
    assert result.models == ["remote-model"]


def test_ollama_falls_back_to_the_openai_route_when_tags_is_absent(monkeypatch):
    seen = []

    def fake_request(url, headers, *, what):
        seen.append(url)
        if url.endswith("/api/tags"):
            raise models._HttpError("Ollama model list returned HTTP 404.", 404)
        return {"data": [{"id": "proxied-model"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = models.list_models("ollama", "sk-proxy", "http://proxy.local:8000/v1")
    assert seen == ["http://proxy.local:8000/api/tags", "http://proxy.local:8000/v1/models"]
    assert result.models == ["proxied-model"]


def test_llamacpp_needs_a_base_url_before_asking(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("must not call the network without a Base URL")

    monkeypatch.setattr(models, "_request_json", fail_if_called)

    with pytest.raises(ValueError, match="Set the Base URL"):
        models.list_models("llamacpp", "", "")


def test_a_provider_without_model_discovery_says_what_to_do():
    with pytest.raises(ValueError, match="does not use a model"):
        models.list_models("none", "", "")
    with pytest.raises(ValueError, match="OAuth credentials"):
        models.list_models("chatgpt", "", "")


def test_missing_provider_is_rejected_before_any_request():
    with pytest.raises(ValueError, match="Choose a provider"):
        models.list_models("", "", "")


def test_rejected_credentials_produce_a_readable_error():
    with pytest.raises(ValueError, match="rejected the credentials"):
        models._raise_for_status(401, b'{"error":"invalid key"}', "OpenAI model list")


def test_service_uses_saved_values_when_the_form_sends_none(temp_home, monkeypatch):
    service.write_env_file(
        "",
        "HINDSIGHT_API_LLM_PROVIDER=openai\n"
        "HINDSIGHT_API_LLM_API_KEY=sk-saved\n"
        "HINDSIGHT_API_LLM_BASE_URL=https://saved.example/v1\n",
    )
    seen = {}

    def fake_request(url, headers, *, what):
        seen.update(url=url, headers=headers)
        return {"data": [{"id": "saved-model"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)

    result = service.list_models("")
    assert seen["url"] == "https://saved.example/v1/models"
    assert seen["headers"]["Authorization"] == "Bearer sk-saved"
    assert result.models == ["saved-model"]


def test_ops_models_reads_its_request_from_stdin(temp_home, monkeypatch):
    def fake_request(url, headers, *, what):
        return {"data": [{"id": "model-from-api"}]}

    monkeypatch.setattr(models, "_request_json", fake_request)
    out = io.StringIO()
    old_out, old_in = sys.stdout, sys.stdin
    sys.stdout = out
    sys.stdin = io.StringIO(
        json.dumps({"provider": "openai", "api_key": "sk-form", "base_url": "https://form.example/v1"})
    )
    try:
        code = ops_main(["models"])
    finally:
        sys.stdout, sys.stdin = old_out, old_in

    assert code == 0
    doc = json.loads(out.getvalue())
    assert doc["provider"] == "openai"
    assert doc["models"] == ["model-from-api"]
