"""Bounded evidence batches for direct incremental page edits."""

from pydantic import BaseModel

from .reflect.tokenization import count_prompt_tokens


class DeltaFact(BaseModel):
    """Evidence shape shared with the existing structured edit prompt."""

    id: str
    text: str
    type: str
    context: str | None = None


def batch_delta_facts(facts: list[DeltaFact], *, max_memories: int, max_tokens: int = 4096) -> list[list[DeltaFact]]:
    """Keep complete facts; never silently truncate evidence then advance past it.

    Directives accompany every batch. A single oversized fact is processed alone
    rather than cut in half. The prompt builder must fit that complete batch.
    """
    directives = [f for f in facts if f.type == "directives"]
    batches: list[list[DeltaFact]] = []
    batch: list[DeltaFact] = []
    tokens = 0
    for fact in facts:
        if fact.type == "directives":
            continue
        size = count_prompt_tokens(f"- [{fact.type}:{fact.id}] {fact.text}")
        if batch and (len(batch) >= max_memories or tokens + size > max_tokens):
            batches.append([*batch, *directives])
            batch, tokens = [], 0
        batch.append(fact)
        tokens += size
    if batch:
        batches.append([*batch, *directives])
    return batches
