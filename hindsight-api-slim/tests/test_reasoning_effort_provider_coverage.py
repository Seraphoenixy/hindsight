"""Providers without reasoning control report a configured but unused reasoning effort."""

import logging


class TestProvidersWithoutReasoningControlSaySo:
    """These providers cannot act on the setting; they must not swallow it in silence."""

    def test_gemini_warns(self, caplog):
        from hindsight_api.engine.providers.gemini_llm import GeminiLLM

        with caplog.at_level(logging.WARNING):
            GeminiLLM(provider="gemini", api_key="k", base_url="", model="gemini-2.5-flash", reasoning_effort="high")
        assert any("reasoning_effort" in r.message and "ignored" in r.message for r in caplog.records)

    def test_anthropic_warns(self, caplog):
        from hindsight_api.engine.providers.anthropic_llm import AnthropicLLM

        with caplog.at_level(logging.WARNING):
            AnthropicLLM(
                provider="anthropic",
                api_key="k",
                base_url="",
                model="claude-sonnet-4-20250514",
                reasoning_effort="high",
            )
        assert any("reasoning_effort" in r.message and "ignored" in r.message for r in caplog.records)

    def test_nothing_is_logged_when_nothing_was_configured(self, caplog):
        # Intention: the warning marks a *discarded operator setting*, not a default.
        # Expected: silence when the operator configured nothing.
        from hindsight_api.engine.providers.gemini_llm import GeminiLLM

        with caplog.at_level(logging.WARNING):
            GeminiLLM(provider="gemini", api_key="k", base_url="", model="gemini-2.5-flash", reasoning_effort=None)
        assert not [r for r in caplog.records if "reasoning_effort" in r.message]
