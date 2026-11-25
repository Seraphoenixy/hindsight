"""Verify that server-side Antigravity calls cannot re-enter the retention hooks."""

from pathlib import Path

from hindsight_api.config import PROVIDER_DEFAULT_MODELS
from hindsight_api.provider_auth import requires_api_key


def test_antigravity_uses_cli_auth_and_the_coding_agent_hooks_honor_the_opt_out():
    assert "antigravity" in PROVIDER_DEFAULT_MODELS
    assert not requires_api_key("antigravity")
    root = Path(__file__).resolve().parents[2]
    core = root / "hindsight-integrations" / "coding-agents" / "src" / "core"
    for name in ("hook.ts", "retain-hook.ts", "session-start.ts"):
        assert "if (process.env.HINDSIGHT_DISABLE_HOOKS) return" in (core / name).read_text(encoding="utf-8")
