"""Tests for the machine-readable operations surface (``hindsight-embed ops``).

This replaces the retired control-center suite. What those tests covered that
still exists is here: the service layer (config read/write, key masking, raw
``.env`` round-trips) and the settings catalog. What they covered that no longer
exists — the stdlib HTTP server, its token gate, tokenized URLs, static assets,
the browser SPA's independent-panel loading — is gone with the server.

The new surface has its own contract to hold: every command prints exactly one
JSON document, mutating commands read their request from stdin, and a domain
failure is reported in-band as ``{"ok": false}`` rather than as an exception.
"""

import io
import json
import sys

import pytest

from hindsight_embed.ops import auth, service
from hindsight_embed.ops import settings as settings_module
from hindsight_embed.ops.cli import main as ops_main


@pytest.fixture
def temp_hindsight_dir(tmp_path, monkeypatch):
    """Isolate ~/.hindsight into a temp HOME (matches test_profile_manager)."""
    from hindsight_embed.cli import set_cli_profile_override

    set_cli_profile_override(None)
    monkeypatch.delenv("HINDSIGHT_EMBED_PROFILE", raising=False)
    monkeypatch.delenv(auth.ENV_OPS_TOKEN, raising=False)
    temp_home = tmp_path / "home"
    temp_home.mkdir()
    monkeypatch.setenv("HOME", str(temp_home))
    monkeypatch.setenv("USERPROFILE", str(temp_home))
    (temp_home / ".hindsight").mkdir()
    return temp_home / ".hindsight"


@pytest.fixture
def stopped(monkeypatch):
    """Stub daemon/UI shutdown as succeeding; returns the profiles each was asked to stop."""
    from hindsight_embed import daemon_client

    calls: dict[str, list[str]] = {"daemon": [], "ui": []}

    def stop_daemon(profile=None):
        calls["daemon"].append(profile)
        return True

    def stop_ui(profile=None, ui_port=None):
        calls["ui"].append(profile)
        return True

    monkeypatch.setattr(daemon_client, "stop_daemon", stop_daemon)
    monkeypatch.setattr(daemon_client, "stop_ui", stop_ui)
    return calls


def run_ops(argv: list[str], stdin: str | None = None, monkeypatch=None) -> tuple[int, dict]:
    """Invoke ``ops`` in-process and return (exit code, decoded JSON document).

    stdout is captured through a StringIO so the test asserts on the same bytes a
    subprocess caller would read, not on an intermediate Python object.
    """
    out = io.StringIO()
    old_out = sys.stdout
    old_stdin = sys.stdin
    sys.stdout = out
    if stdin is not None:
        sys.stdin = io.StringIO(stdin)
    try:
        code = ops_main(argv)
    finally:
        sys.stdout = old_out
        sys.stdin = old_stdin
    return code, json.loads(out.getvalue())


# --------------------------------------------------------------------------
# service layer
# --------------------------------------------------------------------------
class TestService:
    def test_save_and_read_default_profile(self, temp_hindsight_dir):
        view = service.save_llm_config("", "openai", "sk-abcdef123456", "gpt-4o-mini", "")
        assert view.provider == "openai"
        assert view.model == "gpt-4o-mini"
        assert view.has_api_key
        assert view.api_key_masked and "sk-" in view.api_key_masked
        # round-trips through the "default" URL alias
        assert service.get_profile_config("default").provider == "openai"

    def test_env_file_has_no_alias_keys(self, temp_hindsight_dir):
        service.save_llm_config("", "openai", "sk-key1234567890", "m", "")
        raw = service._read_raw_env("")
        assert raw  # not empty
        assert all(not k.islower() for k in raw), f"alias keys leaked: {raw}"

    def test_api_key_unchanged_preserves_key(self, temp_hindsight_dir):
        service.save_llm_config("", "openai", "sk-original12345", "m", "")
        after = service.save_llm_config("", "openai", service.API_KEY_UNCHANGED, "", "")
        assert after.has_api_key, "key must survive an unchanged save"
        assert after.model is None, "empty model clears the override"

    def test_empty_api_key_clears_it(self, temp_hindsight_dir):
        service.save_llm_config("", "openai", "sk-original12345", "m", "")
        after = service.save_llm_config("", "openai", "", "m", "")
        assert not after.has_api_key

    def test_base_url_preserved_when_not_sent(self, temp_hindsight_dir):
        # base_url is no longer in the wizard; saving without it (None) must keep
        # an existing override, while "" still clears it.
        service.save_llm_config("w", "openai", "sk-key1234567890", "", "https://custom.example/v1")
        service.save_llm_config("w", "openai", service.API_KEY_UNCHANGED, "", None)
        assert service._read_raw_env("w")["HINDSIGHT_API_LLM_BASE_URL"] == "https://custom.example/v1"
        service.save_llm_config("w", "openai", service.API_KEY_UNCHANGED, "", "")
        assert "HINDSIGHT_API_LLM_BASE_URL" not in service._read_raw_env("w")

    def test_named_profile_write_creates_file(self, temp_hindsight_dir):
        service.save_llm_config("my-app", "deepseek", "sk-key1234567890", "m", "")
        assert (temp_hindsight_dir / "profiles" / "my-app.env").exists()

    def test_env_file_is_owner_only(self, temp_hindsight_dir):
        service.save_llm_config("", "openai", "sk-key1234567890", "m", "")
        path = temp_hindsight_dir / "embed"
        mode = path.stat().st_mode & 0o777
        # Windows has no POSIX mode bits; the chmod call is a no-op there.
        assert mode & 0o077 == 0 or sys.platform == "win32"

    def test_list_profiles_includes_coding_agent_fallback(self, temp_hindsight_dir):
        """An empty state still lists one operable row.

        The page has to offer something to configure on a machine that has never
        run the embed, and 'coding-agent' is the profile the coding-agents plugin
        creates, so it is the honest default rather than an invented one.
        """
        profiles = service.list_profiles()
        assert [p.name for p in profiles] == ["coding-agent"]

    def test_omitting_provider_keeps_the_stored_one(self, temp_hindsight_dir):
        service.save_llm_config("", "deepseek", "", "m", "")
        after = service.save_llm_config("", None, None, None, None)
        assert after.provider == "deepseek"

    def test_raw_env_roundtrip(self, temp_hindsight_dir):
        service.write_env_file("w", "HINDSIGHT_API_LLM_PROVIDER=groq\nPORT=1\n")
        view = service.read_env_file("w")
        assert view.content == "HINDSIGHT_API_LLM_PROVIDER=groq\nPORT=1\n"
        assert view.exists is True

    def test_raw_env_io_is_utf8_regardless_of_locale(self, temp_hindsight_dir, monkeypatch):
        # A profile name and a value can both be non-ASCII; the read/write path
        # must not depend on the process locale (Windows defaults to cp1252).
        monkeypatch.setenv("LANG", "C")
        service.write_env_file("测试", "HINDSIGHT_API_LLM_MODEL=模型\n")
        assert service.read_env_file("测试").content == "HINDSIGHT_API_LLM_MODEL=模型\n"

    def test_write_env_adds_trailing_newline(self, temp_hindsight_dir):
        service.write_env_file("", "A=1")
        assert service.read_env_file("").content.endswith("\n")

    def test_profile_paths_references(self, temp_hindsight_dir):
        paths = service.get_profile_paths("w")
        assert paths.name == "w"
        assert paths.daemon_url.startswith("http://localhost:")
        # 0.0.0.0 is not routable from a browser; the view rewrites it.
        assert "0.0.0.0" not in paths.ui_url

    def test_profile_paths_show_external_database(self, temp_hindsight_dir, monkeypatch):
        monkeypatch.setenv("HINDSIGHT_EMBED_API_DATABASE_URL", "postgresql://u:p@db:5432/x")
        paths = service.get_profile_paths("")
        assert paths.database_url == "postgresql://u:p@db:5432/x"
        assert paths.database_path is None

    def test_tail_log_missing_file(self, temp_hindsight_dir):
        view = service.tail_log("", lines=10)
        assert view.exists is False
        assert view.content == ""

    def test_tail_log_source_picks_daemon_or_ui(self, temp_hindsight_dir):
        paths = service.ProfileManager().resolve_profile_paths("")
        paths.log.parent.mkdir(parents=True, exist_ok=True)
        paths.log.write_text("daemon-line\n", encoding="utf-8")
        paths.ui_log.write_text("ui-line\n", encoding="utf-8")
        assert service.tail_log("", source="daemon").content == "daemon-line"
        assert service.tail_log("", source="ui").content == "ui-line"

    def test_tail_log_reads_utf8_regardless_of_locale(self, temp_hindsight_dir, monkeypatch):
        monkeypatch.setenv("LANG", "C")
        paths = service.ProfileManager().resolve_profile_paths("")
        paths.log.parent.mkdir(parents=True, exist_ok=True)
        paths.log.write_text("守护进程\n", encoding="utf-8")
        assert service.tail_log("").content == "守护进程"

    def test_delete_named_profile(self, temp_hindsight_dir, stopped):
        service.save_llm_config("gone", "openai", "sk-key1234567890", "m", "")
        result = service.delete_profile("gone")
        assert result.ok is True
        assert "gone" in stopped["daemon"] and "gone" in stopped["ui"]

    def test_delete_of_a_missing_profile_stops_nothing(self, temp_hindsight_dir, stopped):
        """A profile that does not exist has no processes to stop.

        Stopping first made the daemon manager hunt for a listener on a port that
        was never allocated, so the call logged "Could not find PID for port N"
        before reporting that the profile was simply absent — a plain answer that
        read like a failed cleanup.
        """
        result = service.delete_profile("never-existed")
        assert result.ok is False
        assert "does not exist" in result.message
        assert stopped["daemon"] == [], "nothing should be stopped for a missing profile"
        assert stopped["ui"] == []

    def test_delete_default_profile_refused(self, temp_hindsight_dir):
        result = service.delete_profile("")
        assert result.ok is False
        assert result.message_zh

    def test_config_exposes_ports(self, temp_hindsight_dir):
        view = service.get_profile_config("")
        assert view.api_port > 0
        assert view.ui_port == view.api_port + 10000
        assert view.ui_port_is_default is True

    def test_save_pins_ports(self, temp_hindsight_dir):
        view = service.save_llm_config("", None, None, None, None, api_port="9200", ui_port="19200")
        assert (view.api_port, view.ui_port) == (9200, 19200)
        assert view.ui_port_is_default is False

    def test_blank_ui_port_derives_from_api(self, temp_hindsight_dir):
        service.save_llm_config("", None, None, None, None, api_port="9200", ui_port="19200")
        view = service.save_llm_config("", None, None, None, None, api_port="9200", ui_port="")
        assert view.ui_port == 19200, "an empty ui_port removes the override and re-derives"

    def test_versions_default_to_none(self, temp_hindsight_dir):
        view = service.get_profile_config("")
        assert view.api_version is None
        assert view.cp_version is None

    def test_save_pins_versions(self, temp_hindsight_dir):
        view = service.save_llm_config("", None, None, None, None, None, None, "1.2.0", "1.2.1")
        assert (view.api_version, view.cp_version) == ("1.2.0", "1.2.1")

    def test_blank_version_removes_override(self, temp_hindsight_dir):
        service.save_llm_config("", None, None, None, None, None, None, "1.2.0", "1.2.1")
        view = service.save_llm_config("", None, None, None, None, None, None, "", "")
        assert (view.api_version, view.cp_version) == (None, None)

    def test_health_reports_down_when_no_daemon(self, temp_hindsight_dir, monkeypatch):
        monkeypatch.setattr(service, "_http_get", lambda url, timeout=2.0: None)
        view = service.health("")
        assert view.api_ok is False
        assert view.api_detail != ""
        assert view.api_port > 0

    def test_health_reports_healthy(self, temp_hindsight_dir, monkeypatch):
        class Resp:
            status_code = 200

            @staticmethod
            def json():
                return {"status": "healthy", "database": "connected"}

        monkeypatch.setattr(service, "_http_get", lambda url, timeout=2.0: Resp())
        view = service.health("")
        assert view.api_ok is True
        assert "healthy" in view.api_detail
        assert "数据库" in view.api_detail_zh

    def test_daemon_action_messages_are_bilingual(self, temp_hindsight_dir, monkeypatch):
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "is_daemon_running", lambda profile=None: False)
        result = service.daemon_status("")
        assert result.message and result.message_zh

    def test_delete_refusal_messages_are_bilingual(self, temp_hindsight_dir):
        result = service.delete_profile("")
        assert result.message and result.message_zh


# --------------------------------------------------------------------------
# settings catalog
# --------------------------------------------------------------------------
class TestSettingsCatalog:
    def test_catalog_is_well_formed(self):
        """Every group is non-empty, keys unique, selects carry their options."""
        keys = [f.key for g in settings_module.SETTING_GROUPS for f in g.fields]
        assert len(keys) == len(set(keys)), "duplicate key in the catalog"
        assert len(keys) >= 30, "the form should cover more than the old 7-field wizard"
        for group in settings_module.SETTING_GROUPS:
            assert group.fields, f"group {group.id} has no fields"
            assert group.label and group.description
            for field in group.fields:
                assert field.key.startswith("HINDSIGHT_")
                assert field.label and field.description
                if field.kind in ("select", "combo"):
                    assert field.options, f"{field.key} is a {field.kind} with no options"

    def test_every_label_has_a_chinese_counterpart(self):
        """Chinese is the default language, so a missing 中文 label is a blank UI.

        The check enumerates the whole catalog rather than the fields that happen
        to be translated: a field added later without ``label_zh`` fails here
        instead of rendering its English label among Chinese ones.
        """
        missing: list[str] = []
        for group in settings_module.SETTING_GROUPS:
            if not group.label_zh or not group.description_zh:
                missing.append(f"group {group.id}")
            for field in group.fields:
                if not field.label_zh or not field.description_zh:
                    missing.append(field.key)
        assert not missing, f"catalog entries without Chinese text: {missing}"

    def test_every_catalog_key_exists_in_the_template(self):
        """A key the daemon does not document is a typo waiting to confuse a user.

        The catalog promises "these are options the daemon knows"; the template is
        the daemon-side record of that. Resolved through the same loader the profile
        writer uses, so a missing/bundled-template problem fails here too.
        """
        from hindsight_embed.env_template import load_template

        text = load_template()
        assert text, "bundled env template not found"
        missing = [k for k in settings_module.field_index() if k not in text]
        assert not missing, f"catalog keys absent from the env template: {missing}"

    def test_combo_options_and_labels_line_up(self):
        """A combo offers each known value once, with a display name in both languages."""
        for group in settings_module.SETTING_GROUPS:
            for field in group.fields:
                if field.kind != "combo":
                    continue
                values = [o.value for o in field.option_labels]
                assert values == list(field.options), (
                    f"{field.key}: labels cover {values}, options are {list(field.options)}"
                )
                for option in field.option_labels:
                    assert option.label and option.label_zh, f"{field.key}/{option.value} lacks a label"

    def test_model_fields_offer_a_dropdown(self):
        """Model ids with a known set are picked, not typed."""
        fields = settings_module.field_index()
        for key in (
            "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL",
            "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
            "HINDSIGHT_API_RERANKER_LOCAL_MODEL",
            "HINDSIGHT_API_LLM_REASONING_EFFORT",
        ):
            assert fields[key].kind == "combo", f"{key} should offer a dropdown"
            assert fields[key].options, f"{key} has no known values to offer"

    def test_combo_accepts_a_value_outside_the_shipped_set(self, temp_hindsight_dir):
        """The dropdown lists what ships, but the daemon takes more."""
        service.save_settings(
            "",
            {
                "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL": "C:/models/custom-embed.gguf",
                "HINDSIGHT_API_LLM_REASONING_EFFORT": "max",
            },
        )
        env = service._read_raw_env("")
        assert env["HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL"] == "C:/models/custom-embed.gguf"
        assert env["HINDSIGHT_API_LLM_REASONING_EFFORT"] == "max"

    def test_closed_select_still_rejects_an_unknown_value(self, temp_hindsight_dir):
        with pytest.raises(ValueError, match="must be one of"):
            service.save_settings("", {"HINDSIGHT_API_EMBEDDINGS_PROVIDER": "not-a-provider"})


class TestSettingsService:
    def test_reads_current_values_and_marks_unset(self, temp_hindsight_dir):
        service.write_env_file("", "HINDSIGHT_API_LLM_PROVIDER=deepseek\n")
        view = service.get_settings("")
        fields = {f.key: f for g in view.groups for f in g.fields}
        assert fields["HINDSIGHT_API_LLM_PROVIDER"].value == "deepseek"
        assert fields["HINDSIGHT_API_LLM_PROVIDER"].is_set is True
        # Absent from the .env => daemon default, reported as unset with a placeholder default.
        assert fields["HINDSIGHT_API_LLM_MAX_CONCURRENT"].is_set is False
        assert fields["HINDSIGHT_API_LLM_MAX_CONCURRENT"].default == "2"

    def test_reports_a_missing_key_for_a_provider_that_needs_one(self, temp_hindsight_dir):
        service.write_env_file("", "HINDSIGHT_API_LLM_PROVIDER=deepseek\n")
        assert service.get_settings("").unset_required == ["HINDSIGHT_API_LLM_API_KEY"]
        # OAuth providers authenticate out of band, so they are not reported.
        service.write_env_file("", "HINDSIGHT_API_LLM_PROVIDER=chatgpt\n")
        assert service.get_settings("").unset_required == []

    def test_save_writes_values_and_preserves_foreign_keys(self, temp_hindsight_dir):
        service.write_env_file("", "CUSTOM_KEY=keep-me\n")
        service.save_settings("", {"HINDSIGHT_API_LLM_MODEL": "gpt-4o"})
        env = service._read_raw_env("")
        assert env["CUSTOM_KEY"] == "keep-me"
        assert env["HINDSIGHT_API_LLM_MODEL"] == "gpt-4o"

    def test_blank_value_removes_the_key(self, temp_hindsight_dir):
        service.write_env_file("", "HINDSIGHT_API_LLM_MODEL=gpt-4o\n")
        service.save_settings("", {"HINDSIGHT_API_LLM_MODEL": ""})
        assert "HINDSIGHT_API_LLM_MODEL" not in service._read_raw_env("")

    def test_rejects_unknown_keys(self, temp_hindsight_dir):
        with pytest.raises(ValueError, match="unknown setting"):
            service.save_settings("", {"NOT_A_SETTING": "x"})

    def test_rejects_bad_values_per_field_kind(self, temp_hindsight_dir):
        with pytest.raises(ValueError, match="must be a number"):
            service.save_settings("", {"HINDSIGHT_API_LLM_MAX_CONCURRENT": "lots"})
        with pytest.raises(ValueError, match="must be true or false"):
            service.save_settings("", {"HINDSIGHT_API_LLM_STRICT_SCHEMA": "yes"})

    def test_boolean_is_normalised(self, temp_hindsight_dir):
        service.save_settings("", {"HINDSIGHT_API_LLM_STRICT_SCHEMA": "TRUE"})
        assert service._read_raw_env("")["HINDSIGHT_API_LLM_STRICT_SCHEMA"] == "true"

    def test_settings_and_raw_editor_share_one_file(self, temp_hindsight_dir):
        service.save_settings("", {"HINDSIGHT_API_LLM_MODEL": "gpt-4o"})
        service.write_env_file("", service.read_env_file("").content + "ADDED=1\n")
        env = service._read_raw_env("")
        assert env["HINDSIGHT_API_LLM_MODEL"] == "gpt-4o"
        assert env["ADDED"] == "1"


# --------------------------------------------------------------------------
# providers
# --------------------------------------------------------------------------
class TestProviders:
    def test_catalog_has_common_providers(self):
        ids = [p.id for p in service.settings.providers.PROVIDER_CATALOG]
        for expected in ("openai", "anthropic", "gemini", "ollama", "llamacpp", "chatgpt", "none"):
            assert expected in ids, f"provider catalog lost {expected}"

    def test_every_provider_has_a_chinese_label(self):
        missing = [p.id for p in service.settings.providers.PROVIDER_CATALOG if not p.label_zh]
        assert not missing, f"providers without a Chinese label: {missing}"


# --------------------------------------------------------------------------
# access token
# --------------------------------------------------------------------------
class TestAuth:
    def test_token_is_generated_and_stable(self, temp_hindsight_dir):
        first = auth.get_or_create_token()
        assert first
        assert auth.get_or_create_token() == first
        assert auth.read_token() == first

    def test_token_file_is_owner_only(self, temp_hindsight_dir):
        auth.get_or_create_token()
        path = auth.token_file()
        assert path.exists()
        assert path.stat().st_mode & 0o077 == 0 or sys.platform == "win32"

    def test_env_token_wins_over_the_file(self, temp_hindsight_dir, monkeypatch):
        """A launcher that already holds a token hands it down, so parent and child
        agree without either having written the file yet."""
        monkeypatch.setenv(auth.ENV_OPS_TOKEN, "handed-down")
        assert auth.get_or_create_token() == "handed-down"

    def test_legacy_control_token_is_ignored(self, temp_hindsight_dir):
        """A retired control center left ``control.token`` behind. It must not
        authenticate anything: the component that issued it no longer exists."""
        (temp_hindsight_dir / "control.token").write_text("legacy", encoding="utf-8")
        assert auth.read_token() is None
        assert auth.get_or_create_token() != "legacy"


# --------------------------------------------------------------------------
# JSON command surface
# --------------------------------------------------------------------------
class TestOpsCommands:
    def test_profiles_prints_one_json_document(self, temp_hindsight_dir):
        code, doc = run_ops(["profiles"])
        assert code == 0
        assert [p["name"] for p in doc["profiles"]] == ["coding-agent"]

    def test_settings_roundtrip_through_stdin(self, temp_hindsight_dir):
        code, doc = run_ops(["save-settings"], stdin='{"values":{"HINDSIGHT_API_LLM_PROVIDER":"groq"}}')
        assert code == 0
        assert doc["name"] == ""
        groups = {g["id"]: g for g in doc["groups"]}
        provider = next(f for g in groups.values() for f in g["fields"] if f["key"] == "HINDSIGHT_API_LLM_PROVIDER")
        assert provider["value"] == "groq"

    def test_settings_payload_carries_both_languages(self, temp_hindsight_dir):
        _, doc = run_ops(["settings"])
        group = doc["groups"][0]
        assert group["label"] and group["label_zh"]
        field = group["fields"][0]
        assert field["label"] and field["label_zh"]
        assert field["description"] and field["description_zh"]

    def test_config_masks_the_api_key(self, temp_hindsight_dir):
        service.save_llm_config("", "openai", "sk-secret-value-123", "gpt-4o", "")
        code, doc = run_ops(["config"])
        assert code == 0
        assert doc["api_key_masked"] != "sk-secret-value-123"
        assert "secret-value" not in doc["api_key_masked"]
        assert doc["has_api_key"] is True

    def test_env_returns_the_raw_file_verbatim(self, temp_hindsight_dir):
        """The raw editor needs the real bytes — including the API key.

        This is a local, single-user surface behind a token, and masking here
        would make the editor unable to preserve a key it must round-trip.
        """
        service.write_env_file("", "HINDSIGHT_API_LLM_API_KEY=sk-raw\n")
        code, doc = run_ops(["env"])
        assert code == 0
        assert "sk-raw" in doc["content"]

    def test_write_env_reads_content_from_stdin(self, temp_hindsight_dir):
        code, doc = run_ops(["write-env"], stdin='{"content":"A=1"}')
        assert code == 0
        assert doc["content"] == "A=1\n"

    def test_save_settings_rejects_invalid_values_in_band(self, temp_hindsight_dir):
        """A rejected write is a domain failure the page must display, so it keeps
        exit code 2 (usage/value error) but still answers with JSON."""
        code, doc = run_ops(["save-settings"], stdin='{"values":{"HINDSIGHT_API_LLM_STRICT_SCHEMA":"maybe"}}')
        assert code == 2
        assert "must be true or false" in doc["error"]

    def test_rejects_a_non_object_body(self, temp_hindsight_dir):
        """A request document that is not an object is a caller error (exit 2),
        not an internal failure, so a launcher can tell the two apart."""
        code, doc = run_ops(["save-settings"], stdin="[1,2]")
        assert code == 2
        assert "JSON object" in doc["error"]

    def test_unknown_command_is_a_usage_error(self, temp_hindsight_dir):
        code, doc = run_ops(["nonsense"])
        assert code == 2
        assert "error" in doc

    def test_profile_flag_selects_the_profile(self, temp_hindsight_dir):
        service.save_llm_config("other", "groq", "", "", "")
        code, doc = run_ops(["config", "--profile", "other"])
        assert code == 0
        assert doc["name"] == "other"
        assert doc["provider"] == "groq"

    def test_logs_respects_lines_and_source(self, temp_hindsight_dir):
        paths = service.ProfileManager().resolve_profile_paths("")
        paths.log.parent.mkdir(parents=True, exist_ok=True)
        paths.log.write_text("\n".join(f"line{i}" for i in range(10)), encoding="utf-8")
        code, doc = run_ops(["logs", "-n", "3"])
        assert code == 0
        assert doc["content"].splitlines() == ["line7", "line8", "line9"]

    def test_health_reports_the_daemon_port(self, temp_hindsight_dir, monkeypatch):
        monkeypatch.setattr(service, "_http_get", lambda url, timeout=2.0: None)
        code, doc = run_ops(["health"])
        assert code == 0
        assert doc["api_ok"] is False
        assert isinstance(doc["api_port"], int)

    def test_delete_profile_over_the_command_surface(self, temp_hindsight_dir, stopped):
        service.save_llm_config("gone", "openai", "", "", "")
        code, doc = run_ops(["delete-profile", "-p", "gone"])
        assert code == 0
        assert doc["ok"] is True

    def test_delete_of_the_default_profile_is_reported_not_raised(self, temp_hindsight_dir):
        code, doc = run_ops(["delete-profile"])
        assert code == 0, "a refused delete is a domain result, not a crash"
        assert doc["ok"] is False
        assert doc["message_zh"]

    def test_daemon_start_is_reported_as_a_result(self, temp_hindsight_dir, monkeypatch):
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "ensure_daemon_running", lambda *a, **k: True)
        monkeypatch.setattr(daemon_client, "is_daemon_running", lambda profile=None: True)
        code, doc = run_ops(["daemon-start"])
        assert code == 0
        assert doc["running"] is True
        assert doc["ok"] is True

    def test_failed_daemon_stop_is_reported_as_a_result(self, temp_hindsight_dir, monkeypatch):
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "stop_daemon", lambda profile=None: False)
        code, doc = run_ops(["daemon-stop"])
        assert code == 0, "a failed stop is a result the page displays, not a crash"
        assert doc["ok"] is False
        assert doc["running"] is True, "a daemon that refused to stop is still there"

    def test_token_command_creates_and_returns_the_token(self, temp_hindsight_dir):
        code, doc = run_ops(["token"])
        assert code == 0
        assert doc["token"]
        assert auth.read_token() == doc["token"]

    def test_ui_status_does_not_start_or_stop_anything(self, temp_hindsight_dir, monkeypatch):
        """The control plane cannot drive its own lifecycle.

        The page asking is served by the process that would be killed, so these
        operations belong to launchers (``hindsight-embed ui start``) and the
        command surface only reports.
        """
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "is_ui_running", lambda profile=None, ui_port=None: True)
        calls: list[str] = []
        monkeypatch.setattr(daemon_client, "start_ui", lambda *a, **k: calls.append("start"))
        monkeypatch.setattr(daemon_client, "stop_ui", lambda *a, **k: calls.append("stop"))
        code, doc = run_ops(["ui-status"])
        assert code == 0
        assert doc["running"] is True
        assert calls == []


class TestLaunchUi:
    """`launch_ui` is the launcher path (`configure --web`, `ui start`), not a route.

    It starts the UI and only observes the daemon: `/local` is the page where a
    profile is configured and where its daemon is started, so it must open against
    a stopped daemon. The observed state is reported so the caller can say the
    empty bank list is a missing backend, not an empty product.
    """

    def test_does_not_start_the_daemon(self, temp_hindsight_dir, monkeypatch):
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "is_daemon_running", lambda *a, **k: False)
        monkeypatch.setattr(
            daemon_client,
            "ensure_daemon_running",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("launch_ui must not start the daemon")),
        )
        monkeypatch.setattr(daemon_client, "start_ui", lambda *a, **k: True)
        monkeypatch.setattr(daemon_client, "is_ui_running", lambda profile=None, ui_port=None: True)

        result = service.launch_ui("")
        assert result.daemon_ok is False
        assert result.ui.running is True, "the page that fixes the profile must still open"

    def test_reports_an_already_running_daemon(self, temp_hindsight_dir, monkeypatch):
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "is_daemon_running", lambda *a, **k: True)
        monkeypatch.setattr(
            daemon_client,
            "ensure_daemon_running",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("launch_ui must not start the daemon")),
        )
        monkeypatch.setattr(daemon_client, "start_ui", lambda *a, **k: True)
        monkeypatch.setattr(daemon_client, "is_ui_running", lambda profile=None, ui_port=None: True)

        result = service.launch_ui("")
        assert result.daemon_ok is True
        assert result.ui.running is True

    def test_a_failed_ui_is_reported_even_when_the_daemon_is_running(self, temp_hindsight_dir, monkeypatch):
        from hindsight_embed import daemon_client

        monkeypatch.setattr(daemon_client, "is_daemon_running", lambda *a, **k: True)
        monkeypatch.setattr(daemon_client, "start_ui", lambda *a, **k: False)
        monkeypatch.setattr(daemon_client, "is_ui_running", lambda profile=None, ui_port=None: False)

        result = service.launch_ui("")
        assert result.daemon_ok is True
        assert result.ui.running is False
