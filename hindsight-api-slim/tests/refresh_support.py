"""Deterministic vector backends for refresh plumbing tests, without optional ML."""

import pytest

from hindsight_api.engine.cross_encoder import RRFPassthroughCrossEncoder
from hindsight_api.engine.embeddings import Embeddings


class RefreshTestEmbeddings(Embeddings):
    @property
    def provider_name(self) -> str:
        return "refresh-test"

    @property
    def dimension(self) -> int:
        return 384

    async def initialize(self) -> None:
        pass

    async def encode(self, texts: list[str]) -> list[list[float]]:
        return [[1.0] + [0.0] * 383 for _ in texts]


@pytest.fixture(scope="session")
def embeddings() -> RefreshTestEmbeddings:
    return RefreshTestEmbeddings()


@pytest.fixture(scope="session")
def cross_encoder() -> RRFPassthroughCrossEncoder:
    return RRFPassthroughCrossEncoder()
