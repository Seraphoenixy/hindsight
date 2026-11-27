"""Repair PostgreSQL's derived entity indexes after a batch of object sync writes."""

from collections.abc import Callable
from typing import Any


async def rebuild_entity_indexes(*, conn: Any, fq_table: Callable[[str], str], bank_id: str) -> None:
    """Rebuild source-posting counters and co-occurrences inside the apply transaction.

    Sync transfers canonical facts and postings, not these local indexes. Rebuild
    once per affected bank per batch, rather than once per imported fact. Entity
    display reads include inherited observations and derive their own live counts;
    these internal counters retain the source-posting semantics of retain writers.
    """
    entities = fq_table("entities")
    units = fq_table("memory_units")
    postings = fq_table("unit_entities")
    cooccurrences = fq_table("entity_cooccurrences")
    # Match retain's lock order. Sync already defers remote application while
    # background operations are active; row locks also serialize concurrent stats writes.
    await conn.fetch(f"SELECT id FROM {entities} WHERE bank_id = $1 ORDER BY id FOR UPDATE", bank_id)
    await conn.execute(
        f"""
        WITH stats AS (
            SELECT ue.entity_id, COUNT(*) AS n,
                   MIN(COALESCE(mu.occurred_start, mu.mentioned_at, mu.event_date, mu.created_at)) AS first_seen,
                   MAX(COALESCE(mu.occurred_start, mu.mentioned_at, mu.event_date, mu.created_at)) AS last_seen
            FROM {postings} ue JOIN {units} mu ON mu.id = ue.unit_id
            WHERE mu.bank_id = $1 GROUP BY ue.entity_id
        ), all_stats AS (
            SELECT e.id, COALESCE(s.n, 0) AS n, s.first_seen, s.last_seen
            FROM {entities} e LEFT JOIN stats s ON s.entity_id = e.id
            WHERE e.bank_id = $1
        )
        UPDATE {entities} e SET mention_count = s.n,
            first_seen = COALESCE(s.first_seen, e.first_seen),
            last_seen = COALESCE(s.last_seen, e.last_seen)
        FROM all_stats s WHERE e.id = s.id AND e.bank_id = $1
        """,
        bank_id,
    )
    await conn.execute(
        f"""DELETE FROM {cooccurrences}
        WHERE entity_id_1 IN (SELECT id FROM {entities} WHERE bank_id = $1)
          AND entity_id_2 IN (SELECT id FROM {entities} WHERE bank_id = $1)""",
        bank_id,
    )
    await conn.execute(
        f"""
        INSERT INTO {cooccurrences} (entity_id_1, entity_id_2, cooccurrence_count, last_cooccurred)
        SELECT a.entity_id, b.entity_id, COUNT(*),
               MAX(COALESCE(mu.occurred_start, mu.mentioned_at, mu.event_date, mu.created_at))
        FROM {postings} a JOIN {postings} b ON b.unit_id = a.unit_id AND a.entity_id < b.entity_id
        JOIN {units} mu ON mu.id = a.unit_id
        JOIN {entities} e1 ON e1.id = a.entity_id AND e1.bank_id = $1
        JOIN {entities} e2 ON e2.id = b.entity_id AND e2.bank_id = $1
        WHERE mu.bank_id = $1
        GROUP BY a.entity_id, b.entity_id ORDER BY a.entity_id, b.entity_id
        """,
        bank_id,
    )
