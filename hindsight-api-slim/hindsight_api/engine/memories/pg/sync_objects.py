"""Store-owned SQL helpers for object-level sync (documents, facts, entities, links, observations)."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable
from typing import Any

from ...retain.bank_utils import _vector_index_clause
from ...sync_journal import (
    _ensure_optional_utc as _dt,
)
from ...sync_journal import (
    iso_utc as _iso,
)
from ...sync_journal import (
    parse_json_value as _parse_json,
)
from ...sync_journal import (
    vec_literal as _embedding_literal,
)
from .writes import delete_stale_observations

logger = logging.getLogger(__name__)


async def list_sync_document_keys(
    *, conn: Any, fq_table: Callable[[str], str], bank_id: str | None = None
) -> list[dict[str, str]]:
    """Return ``[{'bank_id': ..., 'object_id': ...}]`` for live documents (excluding pending)."""
    docs = fq_table("documents")
    where = "WHERE content_hash IS DISTINCT FROM '__pending__'"
    params: list[Any] = []
    if bank_id is not None:
        where += " AND bank_id = $1"
        params.append(bank_id)
    rows = await conn.fetch(
        f"SELECT bank_id, id FROM {docs} {where} ORDER BY bank_id, created_at, id",
        *params,
    )
    return [{"bank_id": r["bank_id"], "object_id": r["id"]} for r in rows]


async def list_sync_standalone_unit_keys(
    *, conn: Any, fq_table: Callable[[str], str], bank_id: str | None = None
) -> list[dict[str, str]]:
    """Return ``(bank_id, id)`` for non-observation units not owned by a document."""
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    where = "WHERE document_id IS NULL AND fact_type <> 'observation'"
    params: list[Any] = []
    if bank_id is not None:
        where += " AND bank_id = $1"
        params.append(bank_id)
    rows = await conn.fetch(
        f"""
        SELECT bank_id, id::text AS id FROM {mu} {where}
        UNION
        SELECT bank_id, id::text AS id FROM {arch} {where}
        ORDER BY bank_id, id
        """,
        *params,
    )
    return [{"bank_id": r["bank_id"], "object_id": r["id"]} for r in rows]


async def list_sync_observation_keys(
    *, conn: Any, fq_table: Callable[[str], str], bank_id: str | None = None
) -> list[dict[str, str]]:
    """Return ``(bank_id, id)`` for observation units."""
    mu = fq_table("memory_units")
    where = "WHERE fact_type = 'observation'"
    params: list[Any] = []
    if bank_id is not None:
        where += " AND bank_id = $1"
        params.append(bank_id)
    rows = await conn.fetch(
        f"SELECT bank_id, id::text AS id FROM {mu} {where} ORDER BY bank_id, created_at, id",
        *params,
    )
    return [{"bank_id": r["bank_id"], "object_id": r["id"]} for r in rows]


async def _export_units_details(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    bank_id: str,
    unit_rows: list[Any],
    archived: bool,
) -> list[dict[str, Any]]:
    if not unit_rows:
        return []
    ue = fq_table("unit_entities")
    ent = fq_table("entities")
    ml = fq_table("memory_links")
    unit_ids = [r["id"] for r in unit_rows]

    entity_map: dict[str, list[dict[str, Any]]] = {}
    if not archived:
        erows = await conn.fetch(
            f"""
            SELECT ue.unit_id::text AS unit_id, e.canonical_name, e.metadata, e.first_seen, e.last_seen
            FROM {ue} ue
            JOIN {ent} e ON e.id = ue.entity_id
            WHERE ue.unit_id = ANY($1::uuid[]) AND e.bank_id = $2
            ORDER BY ue.unit_id, e.canonical_name
            """,
            unit_ids,
            bank_id,
        )
        for er in erows:
            entity_map.setdefault(er["unit_id"], []).append(
                {
                    "canonical_name": er["canonical_name"],
                    "metadata": _parse_json(conn, er["metadata"]) or {},
                    "first_seen": _iso(er["first_seen"]),
                    "last_seen": _iso(er["last_seen"]),
                }
            )
    else:
        # Archived rows store entity UUIDs in `entity_ids` column; resolve canonical names.
        all_eids = sorted({eid for r in unit_rows for eid in (r["entity_ids"] or [])})
        by_eid: dict[str, dict[str, Any]] = {}
        if all_eids:
            erows = await conn.fetch(
                f"SELECT id::text AS id, canonical_name, metadata, first_seen, last_seen FROM {ent} "
                f"WHERE bank_id = $1 AND id = ANY($2::uuid[])",
                bank_id,
                all_eids,
            )
            by_eid = {
                er["id"]: {
                    "canonical_name": er["canonical_name"],
                    "metadata": _parse_json(conn, er["metadata"]) or {},
                    "first_seen": _iso(er["first_seen"]),
                    "last_seen": _iso(er["last_seen"]),
                }
                for er in erows
            }
        for r in unit_rows:
            uid_str = str(r["id"])
            entity_map[uid_str] = [by_eid[str(eid)] for eid in (r["entity_ids"] or []) if str(eid) in by_eid]

    causal_map: dict[str, list[dict[str, Any]]] = {}
    derived_links_map: dict[str, list[dict[str, Any]]] = {}
    if not archived:
        lrows = await conn.fetch(
            f"""
            SELECT from_unit_id::text AS from_id, to_unit_id::text AS to_id, link_type, weight
            FROM {ml}
            WHERE bank_id = $1
              AND from_unit_id = ANY($2::uuid[])
              AND link_type IN ('causes', 'caused_by', 'enables', 'prevents', 'temporal', 'semantic')
            ORDER BY from_unit_id, to_unit_id, link_type
            """,
            bank_id,
            unit_ids,
        )
        for lr in lrows:
            entry = {
                "to_unit_id": lr["to_id"],
                "link_type": lr["link_type"],
                "weight": float(lr["weight"]),
            }
            if lr["link_type"] in ("temporal", "semantic"):
                derived_links_map.setdefault(lr["from_id"], []).append(entry)
            else:
                causal_map.setdefault(lr["from_id"], []).append(entry)

    out: list[dict[str, Any]] = []
    for r in unit_rows:
        uid = str(r["id"])
        item: dict[str, Any] = {
            "id": uid,
            "bank_id": r["bank_id"],
            "document_id": r["document_id"],
            "chunk_id": r["chunk_id"],
            "text": r["text"],
            "context": r["context"],
            "event_date": _iso(r["event_date"]),
            "occurred_start": _iso(r["occurred_start"]),
            "occurred_end": _iso(r["occurred_end"]),
            "mentioned_at": _iso(r["mentioned_at"]),
            "fact_type": r["fact_type"],
            "metadata": _parse_json(conn, r["metadata"]) or {},
            "tags": list(r["tags"] or []),
            "observation_scopes": _parse_json(conn, r["observation_scopes"]),
            "text_signals": r["text_signals"],
            "attachment_ids": list(r["attachment_ids"] or []),
            "proof_count": int(r["proof_count"] or 1),
            "consolidated_at": _iso(r["consolidated_at"]),
            "consolidation_failed_at": _iso(r["consolidation_failed_at"]),
            "edited_at": _iso(r["edited_at"]),
            "created_at": _iso(r["created_at"]),
            "updated_at": _iso(r["updated_at"]),
            "entities": entity_map.get(uid, []),
            "archived": archived,
        }
        if not archived:
            item["embedding"] = _embedding_literal(r["embedding_text"])
            item["causal_links"] = causal_map.get(uid, [])
            item["links"] = derived_links_map.get(uid, [])
        else:
            item["invalidation_reason"] = r["invalidation_reason"]
            item["invalidated_at"] = _iso(r["invalidated_at"])
            item["causal_links"] = _parse_json(conn, r["causal_links"]) or []
            item["links"] = []
        out.append(item)
    return out


async def export_document_payload(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    document_id: str,
) -> dict[str, Any] | None:
    """Materialize a complete, portable document aggregate payload for sync."""
    docs = fq_table("documents")
    chunks_tbl = fq_table("chunks")
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    att_tbl = fq_non_store_table("attachments")
    fs_tbl = fq_non_store_table("file_storage")

    doc_row = await conn.fetchrow(
        f"""
        SELECT id, bank_id, original_text, content_hash, retain_params, tags,
               file_storage_key, file_original_name, file_content_type, created_at, updated_at
        FROM {docs}
        WHERE id = $1 AND bank_id = $2
        """,
        document_id,
        bank_id,
    )
    if doc_row is None or doc_row["content_hash"] == "__pending__":
        return None

    chunk_rows = await conn.fetch(
        f"""
        SELECT chunk_id, document_id, bank_id, chunk_text, chunk_index, content_hash, created_at
        FROM {chunks_tbl}
        WHERE document_id = $1 AND bank_id = $2
        ORDER BY chunk_index, chunk_id
        """,
        document_id,
        bank_id,
    )
    live_unit_rows = await conn.fetch(
        f"""
        SELECT id, bank_id, document_id, chunk_id, text, context, event_date,
               occurred_start, occurred_end, mentioned_at, fact_type, metadata,
               tags, observation_scopes, text_signals, attachment_ids, proof_count,
               embedding::text AS embedding_text, consolidated_at, consolidation_failed_at,
               edited_at, created_at, updated_at
        FROM {mu}
        WHERE document_id = $1 AND bank_id = $2 AND fact_type IN ('world', 'experience')
        ORDER BY created_at, id
        """,
        document_id,
        bank_id,
    )
    arch_unit_rows = await conn.fetch(
        f"""
        SELECT id, bank_id, document_id, chunk_id, text, context, event_date,
               occurred_start, occurred_end, mentioned_at, fact_type, metadata,
               tags, observation_scopes, text_signals, attachment_ids, proof_count,
               consolidated_at, consolidation_failed_at, edited_at, created_at, updated_at,
               entity_ids, invalidation_reason, invalidated_at, causal_links
        FROM {arch}
        WHERE document_id = $1 AND bank_id = $2
        ORDER BY created_at, id
        """,
        document_id,
        bank_id,
    )

    att_rows = await conn.fetch(
        f"""
        SELECT attachment_hash, short_id, media_type, byte_size, storage_key, kind, filename, created_at
        FROM {att_tbl}
        WHERE bank_id = $1 AND document_id = $2
        ORDER BY attachment_hash
        """,
        bank_id,
        document_id,
    )

    blob_refs: list[dict[str, Any]] = []
    if doc_row["file_storage_key"]:
        import hashlib

        blob_data = await conn.fetchval(
            f"SELECT data FROM {fs_tbl} WHERE storage_key = $1",
            doc_row["file_storage_key"],
        )
        if blob_data is not None:
            blob_bytes = bytes(blob_data)
            blob_refs.append(
                {
                    "role": "document_file",
                    "storage_key": doc_row["file_storage_key"],
                    "sha256": hashlib.sha256(blob_bytes).hexdigest(),
                    "byte_size": len(blob_bytes),
                }
            )
    for ar in att_rows:
        blob_refs.append(
            {
                "role": "attachment",
                "storage_key": ar["storage_key"],
                "sha256": ar["attachment_hash"],
                "byte_size": int(ar["byte_size"]),
            }
        )

    facts = await _export_units_details(
        conn=conn, fq_table=fq_table, bank_id=bank_id, unit_rows=live_unit_rows, archived=False
    )
    archived_facts = await _export_units_details(
        conn=conn, fq_table=fq_table, bank_id=bank_id, unit_rows=arch_unit_rows, archived=True
    )

    return {
        "id": doc_row["id"],
        "bank_id": doc_row["bank_id"],
        "original_text": doc_row["original_text"],
        "content_hash": doc_row["content_hash"],
        "retain_params": _parse_json(conn, doc_row["retain_params"]),
        "tags": list(doc_row["tags"] or []),
        "file_storage_key": doc_row["file_storage_key"],
        "file_original_name": doc_row["file_original_name"],
        "file_content_type": doc_row["file_content_type"],
        "created_at": _iso(doc_row["created_at"]),
        "updated_at": _iso(doc_row["updated_at"]),
        "chunks": [
            {
                "chunk_id": cr["chunk_id"],
                "chunk_index": int(cr["chunk_index"]),
                "chunk_text": cr["chunk_text"],
                "content_hash": cr["content_hash"],
                "created_at": _iso(cr["created_at"]),
            }
            for cr in chunk_rows
        ],
        "attachments": [
            {
                "attachment_hash": ar["attachment_hash"],
                "short_id": ar["short_id"],
                "media_type": ar["media_type"],
                "byte_size": int(ar["byte_size"]),
                "storage_key": ar["storage_key"],
                "kind": ar["kind"],
                "filename": ar["filename"],
                "created_at": _iso(ar["created_at"]),
            }
            for ar in att_rows
        ],
        "blobs": blob_refs,
        "facts": facts,
        "archived_facts": archived_facts,
    }


async def _ensure_bank_on_conn(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
) -> None:
    banks_tbl = fq_non_store_table("banks")
    existing = await conn.fetchval(f"SELECT bank_id FROM {banks_tbl} WHERE bank_id = $1", bank_id)
    if existing is not None:
        return
    internal_id = await conn.fetchval(
        f"INSERT INTO {banks_tbl} (bank_id) VALUES ($1) ON CONFLICT (bank_id) DO NOTHING RETURNING internal_id",
        bank_id,
    )
    if internal_id is not None:
        clause = _vector_index_clause()
        if clause is not None and ops is not None:
            from ...retain.bank_utils import _BANK_INDEX_FACT_TYPES

            await ops.create_bank_vector_indexes(
                conn,
                fq_table("memory_units"),
                bank_id,
                str(internal_id),
                clause,
                _BANK_INDEX_FACT_TYPES,
            )


async def _resolve_entities_on_conn(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    bank_id: str,
    entities: list[dict[str, Any]],
) -> dict[str, uuid.UUID]:
    """Resolve entity canonical names onto this replica's ``entities`` table without UUID clashes."""
    ent_tbl = fq_table("entities")
    resolved: dict[str, uuid.UUID] = {}
    for entity in entities:
        cname = str(entity["canonical_name"])
        key = cname.lower()
        if key in resolved:
            continue
        meta = json.dumps(entity.get("metadata") or {})
        first_seen = _dt(entity.get("first_seen")) or datetime.now(timezone.utc)
        last_seen = _dt(entity.get("last_seen")) or first_seen
        eid = await conn.fetchval(
            f"""
            INSERT INTO {ent_tbl} (canonical_name, bank_id, metadata, first_seen, last_seen, mention_count)
            VALUES ($1, $2, $3::jsonb, $4, $5, 1)
            ON CONFLICT (bank_id, LOWER(canonical_name)) DO UPDATE
            SET last_seen = GREATEST({ent_tbl}.last_seen, EXCLUDED.last_seen)
            RETURNING id
            """,
            cname,
            bank_id,
            meta,
            first_seen,
            last_seen,
        )
        resolved[key] = eid
    return resolved


async def _insert_synced_links(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    bank_id: str,
    from_uid: uuid.UUID,
    links: list[dict[str, Any]],
) -> None:
    if not links:
        return
    mu = fq_table("memory_units")
    ml = fq_table("memory_links")
    for link in links:
        to_uid = uuid.UUID(str(link["to_unit_id"]))
        exists_to = await conn.fetchval(f"SELECT 1 FROM {mu} WHERE id = $1 AND bank_id = $2", to_uid, bank_id)
        if not exists_to:
            continue
        ltype = link["link_type"]
        weight = float(link.get("weight", 1.0))
        await conn.execute(
            f"""
            INSERT INTO {ml} (from_unit_id, to_unit_id, link_type, bank_id, weight)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            """,
            from_uid,
            to_uid,
            ltype,
            bank_id,
            weight,
        )
        if ltype in ("temporal", "semantic"):
            # Symmetric derived edges: ensure reverse edge lands even if the peer unit
            # was applied earlier in the batch before `from_uid` existed.
            await conn.execute(
                f"""
                INSERT INTO {ml} (from_unit_id, to_unit_id, link_type, bank_id, weight)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT DO NOTHING
                """,
                to_uid,
                from_uid,
                ltype,
                bank_id,
                weight,
            )


async def _apply_unit_facts(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    bank_id: str,
    document_id: str | None,
    facts: list[dict[str, Any]],
    archived_facts: list[dict[str, Any]],
) -> list[str]:
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    ue = fq_table("unit_entities")

    all_entities = [e for f in [*facts, *archived_facts] for e in (f.get("entities") or [])]
    entity_ids_by_lower = await _resolve_entities_on_conn(
        conn=conn, fq_table=fq_table, bank_id=bank_id, entities=all_entities
    )

    from ....config import get_config
    from ...db.ops_postgresql import pg_search_vector_expr

    sv_expr = pg_search_vector_expr(get_config(), text_col="$3", context_col="$4", signals_col="$15")
    sv_col = ", search_vector" if sv_expr is not None else ""
    sv_val = f", {sv_expr}" if sv_expr is not None else ""
    sv_upd = ", search_vector = EXCLUDED.search_vector" if sv_expr is not None else ""

    written_ids: list[str] = []
    for fact in facts:
        uid = uuid.UUID(str(fact["id"]))
        written_ids.append(str(uid))
        emb = _embedding_literal(fact.get("embedding"))
        await conn.execute(
            f"""
            INSERT INTO {mu} (
                id, bank_id, text, context, event_date, occurred_start, occurred_end,
                mentioned_at, fact_type, metadata, document_id, chunk_id, tags,
                observation_scopes, text_signals, attachment_ids, proof_count,
                embedding, consolidated_at, consolidation_failed_at, edited_at,
                created_at, updated_at{sv_col}
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13,
                $14::jsonb, $15, $16, $17, $18::vector, $19, $20, $21, $22, $23{sv_val}
            )
            ON CONFLICT (id) DO UPDATE SET
                text = EXCLUDED.text,
                context = EXCLUDED.context,
                event_date = EXCLUDED.event_date,
                occurred_start = EXCLUDED.occurred_start,
                occurred_end = EXCLUDED.occurred_end,
                mentioned_at = EXCLUDED.mentioned_at,
                fact_type = EXCLUDED.fact_type,
                metadata = EXCLUDED.metadata,
                document_id = EXCLUDED.document_id,
                chunk_id = EXCLUDED.chunk_id,
                tags = EXCLUDED.tags,
                observation_scopes = EXCLUDED.observation_scopes,
                text_signals = EXCLUDED.text_signals,
                attachment_ids = EXCLUDED.attachment_ids,
                proof_count = EXCLUDED.proof_count,
                embedding = EXCLUDED.embedding,
                consolidated_at = EXCLUDED.consolidated_at,
                consolidation_failed_at = EXCLUDED.consolidation_failed_at,
                edited_at = EXCLUDED.edited_at,
                updated_at = EXCLUDED.updated_at{sv_upd}
            """,
            uid,
            bank_id,
            fact["text"],
            fact.get("context"),
            _dt(fact.get("event_date")) or datetime.now(timezone.utc),
            _dt(fact.get("occurred_start")),
            _dt(fact.get("occurred_end")),
            _dt(fact.get("mentioned_at")),
            fact.get("fact_type", "world"),
            json.dumps(fact.get("metadata") or {}),
            document_id,
            fact.get("chunk_id"),
            list(fact.get("tags") or []),
            json.dumps(fact["observation_scopes"]) if fact.get("observation_scopes") is not None else None,
            fact.get("text_signals"),
            list(fact.get("attachment_ids") or []),
            int(fact.get("proof_count") or 1),
            emb,
            _dt(fact.get("consolidated_at")),
            _dt(fact.get("consolidation_failed_at")),
            _dt(fact.get("edited_at")),
            _dt(fact.get("created_at")) or datetime.now(timezone.utc),
            _dt(fact.get("updated_at")) or datetime.now(timezone.utc),
        )
        for ent in fact.get("entities") or []:
            eid = entity_ids_by_lower.get(str(ent["canonical_name"]).lower())
            if eid is not None:
                await conn.execute(
                    f"INSERT INTO {ue} (unit_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    uid,
                    eid,
                )
        await _insert_synced_links(
            conn=conn,
            fq_table=fq_table,
            bank_id=bank_id,
            from_uid=uid,
            links=[*(fact.get("causal_links") or []), *(fact.get("links") or [])],
        )

    for af in archived_facts:
        uid = uuid.UUID(str(af["id"]))
        written_ids.append(str(uid))
        eids = [
            entity_ids_by_lower[str(ent["canonical_name"]).lower()]
            for ent in (af.get("entities") or [])
            if str(ent["canonical_name"]).lower() in entity_ids_by_lower
        ]
        await conn.execute(
            f"""
            INSERT INTO {arch} (
                id, bank_id, text, context, event_date, occurred_start, occurred_end,
                mentioned_at, fact_type, metadata, document_id, chunk_id, tags,
                observation_scopes, text_signals, attachment_ids, proof_count,
                consolidated_at, consolidation_failed_at, edited_at, created_at, updated_at,
                entity_ids, invalidation_reason, invalidated_at, causal_links
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13,
                $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22,
                $23::uuid[], $24, $25, $26::jsonb
            )
            ON CONFLICT (id) DO UPDATE SET
                text = EXCLUDED.text,
                context = EXCLUDED.context,
                invalidation_reason = EXCLUDED.invalidation_reason,
                invalidated_at = EXCLUDED.invalidated_at,
                entity_ids = EXCLUDED.entity_ids,
                causal_links = EXCLUDED.causal_links,
                updated_at = EXCLUDED.updated_at
            """,
            uid,
            bank_id,
            af["text"],
            af.get("context"),
            _dt(af.get("event_date")) or datetime.now(timezone.utc),
            _dt(af.get("occurred_start")),
            _dt(af.get("occurred_end")),
            _dt(af.get("mentioned_at")),
            af.get("fact_type", "world"),
            json.dumps(af.get("metadata") or {}),
            document_id,
            af.get("chunk_id"),
            list(af.get("tags") or []),
            json.dumps(af["observation_scopes"]) if af.get("observation_scopes") is not None else None,
            af.get("text_signals"),
            list(af.get("attachment_ids") or []),
            int(af.get("proof_count") or 1),
            _dt(af.get("consolidated_at")),
            _dt(af.get("consolidation_failed_at")),
            _dt(af.get("edited_at")),
            _dt(af.get("created_at")) or datetime.now(timezone.utc),
            _dt(af.get("updated_at")) or datetime.now(timezone.utc),
            eids,
            af.get("invalidation_reason"),
            _dt(af.get("invalidated_at")) or datetime.now(timezone.utc),
            json.dumps(af.get("causal_links") or []),
        )

    return written_ids


async def apply_document_payload(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    document_id: str,
    payload: dict[str, Any],
) -> None:
    """Atomically replace/upsert a synced document aggregate in dependency order."""
    await _ensure_bank_on_conn(
        conn=conn,
        ops=ops,
        fq_table=fq_table,
        fq_non_store_table=fq_non_store_table,
        bank_id=bank_id,
    )
    docs = fq_table("documents")
    chunks_tbl = fq_table("chunks")
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    att_tbl = fq_non_store_table("attachments")

    # Clean up prior version of this document in lock-safe order before writing new state.
    old_units = await conn.fetch(
        f"SELECT id::text AS id FROM {mu} WHERE document_id = $1 AND bank_id = $2",
        document_id,
        bank_id,
    )
    old_unit_ids = [r["id"] for r in old_units]
    if old_unit_ids:
        incoming_live_fact_ids = {str(f["id"]) for f in (payload.get("facts") or [])}
        removed_unit_ids = [uid for uid in old_unit_ids if uid not in incoming_live_fact_ids]
        if removed_unit_ids:
            await delete_stale_observations(
                conn=conn, ops=ops, fq_table=fq_table, bank_id=bank_id, fact_ids=removed_unit_ids
            )
        if ops is not None:
            await ops.delete_unit_links(conn, fq_table("memory_links"), bank_id, old_unit_ids)
        await conn.execute(f"DELETE FROM {mu} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)
    await conn.execute(f"DELETE FROM {arch} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)
    await conn.execute(f"DELETE FROM {chunks_tbl} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)
    await conn.execute(f"DELETE FROM {att_tbl} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)

    await conn.execute(
        f"""
        INSERT INTO {docs} (
            id, bank_id, original_text, content_hash, retain_params, tags,
            file_storage_key, file_original_name, file_content_type, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id, bank_id) DO UPDATE SET
            original_text = EXCLUDED.original_text,
            content_hash = EXCLUDED.content_hash,
            retain_params = EXCLUDED.retain_params,
            tags = EXCLUDED.tags,
            file_storage_key = EXCLUDED.file_storage_key,
            file_original_name = EXCLUDED.file_original_name,
            file_content_type = EXCLUDED.file_content_type,
            updated_at = EXCLUDED.updated_at
        """,
        document_id,
        bank_id,
        payload.get("original_text"),
        payload.get("content_hash"),
        json.dumps(payload["retain_params"]) if payload.get("retain_params") is not None else None,
        list(payload.get("tags") or []),
        payload.get("file_storage_key"),
        payload.get("file_original_name"),
        payload.get("file_content_type"),
        _dt(payload.get("created_at")) or datetime.now(timezone.utc),
        _dt(payload.get("updated_at")) or datetime.now(timezone.utc),
    )

    for chunk in payload.get("chunks") or []:
        await conn.execute(
            f"""
            INSERT INTO {chunks_tbl} (chunk_id, document_id, bank_id, chunk_text, chunk_index, content_hash, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (chunk_id) DO UPDATE SET
                chunk_text = EXCLUDED.chunk_text,
                chunk_index = EXCLUDED.chunk_index,
                content_hash = EXCLUDED.content_hash
            """,
            chunk["chunk_id"],
            document_id,
            bank_id,
            chunk["chunk_text"],
            int(chunk["chunk_index"]),
            chunk.get("content_hash"),
            _dt(chunk.get("created_at")) or datetime.now(timezone.utc),
        )

    for att in payload.get("attachments") or []:
        await conn.execute(
            f"""
            INSERT INTO {att_tbl} (
                bank_id, document_id, attachment_hash, short_id, media_type, byte_size, storage_key, kind, filename, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (bank_id, document_id, attachment_hash) DO UPDATE SET
                short_id = EXCLUDED.short_id,
                media_type = EXCLUDED.media_type,
                byte_size = EXCLUDED.byte_size,
                storage_key = EXCLUDED.storage_key,
                kind = EXCLUDED.kind,
                filename = EXCLUDED.filename
            """,
            bank_id,
            document_id,
            att["attachment_hash"],
            att["short_id"],
            att["media_type"],
            int(att["byte_size"]),
            att["storage_key"],
            att.get("kind", "attachment"),
            att.get("filename"),
            _dt(att.get("created_at")) or datetime.now(timezone.utc),
        )

    await _apply_unit_facts(
        conn=conn,
        ops=ops,
        fq_table=fq_table,
        bank_id=bank_id,
        document_id=document_id,
        facts=list(payload.get("facts") or []),
        archived_facts=list(payload.get("archived_facts") or []),
    )


async def delete_document_payload(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    document_id: str,
    preserve_unit_ids: set[str] | None = None,
) -> None:
    """Delete a synced document and its dependent chunks, facts, and attachment edges."""
    docs = fq_table("documents")
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    att_tbl = fq_non_store_table("attachments")

    old_units = await conn.fetch(
        f"SELECT id::text AS id FROM {mu} WHERE document_id = $1 AND bank_id = $2",
        document_id,
        bank_id,
    )
    old_unit_ids = [r["id"] for r in old_units]
    if old_unit_ids:
        preserved = preserve_unit_ids or set()
        stale_fact_ids = [uid for uid in old_unit_ids if uid not in preserved]
        if stale_fact_ids:
            await delete_stale_observations(
                conn=conn, ops=ops, fq_table=fq_table, bank_id=bank_id, fact_ids=stale_fact_ids
            )
        if ops is not None:
            await ops.delete_unit_links(conn, fq_table("memory_links"), bank_id, old_unit_ids)
        await conn.execute(f"DELETE FROM {mu} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)
    await conn.execute(f"DELETE FROM {arch} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)
    await conn.execute(f"DELETE FROM {att_tbl} WHERE document_id = $1 AND bank_id = $2", document_id, bank_id)
    await conn.execute(f"DELETE FROM {docs} WHERE id = $1 AND bank_id = $2", document_id, bank_id)


async def export_standalone_unit_payload(
    *, conn: Any, fq_table: Callable[[str], str], bank_id: str, unit_id: str
) -> dict[str, Any] | None:
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    uid = uuid.UUID(unit_id)
    live_rows = await conn.fetch(
        f"""
        SELECT id, bank_id, document_id, chunk_id, text, context, event_date,
               occurred_start, occurred_end, mentioned_at, fact_type, metadata,
               tags, observation_scopes, text_signals, attachment_ids, proof_count,
               embedding::text AS embedding_text, consolidated_at, consolidation_failed_at,
               edited_at, created_at, updated_at
        FROM {mu}
        WHERE id = $1 AND bank_id = $2
        """,
        uid,
        bank_id,
    )
    if live_rows:
        details = await _export_units_details(
            conn=conn, fq_table=fq_table, bank_id=bank_id, unit_rows=live_rows, archived=False
        )
        return details[0]
    arch_rows = await conn.fetch(
        f"""
        SELECT id, bank_id, document_id, chunk_id, text, context, event_date,
               occurred_start, occurred_end, mentioned_at, fact_type, metadata,
               tags, observation_scopes, text_signals, attachment_ids, proof_count,
               consolidated_at, consolidation_failed_at, edited_at, created_at, updated_at,
               entity_ids, invalidation_reason, invalidated_at, causal_links
        FROM {arch}
        WHERE id = $1 AND bank_id = $2
        """,
        uid,
        bank_id,
    )
    if arch_rows:
        details = await _export_units_details(
            conn=conn, fq_table=fq_table, bank_id=bank_id, unit_rows=arch_rows, archived=True
        )
        return details[0]
    return None


async def apply_standalone_unit_payload(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    unit_id: str,
    payload: dict[str, Any],
) -> None:
    await _ensure_bank_on_conn(
        conn=conn,
        ops=ops,
        fq_table=fq_table,
        fq_non_store_table=fq_non_store_table,
        bank_id=bank_id,
    )
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    uid = uuid.UUID(unit_id)
    if payload.get("archived"):
        await delete_stale_observations(conn=conn, ops=ops, fq_table=fq_table, bank_id=bank_id, fact_ids=[unit_id])
        if ops is not None:
            await ops.delete_unit_links(conn, fq_table("memory_links"), bank_id, [unit_id])
        await conn.execute(f"DELETE FROM {mu} WHERE id = $1 AND bank_id = $2", uid, bank_id)
        await _apply_unit_facts(
            conn=conn,
            ops=ops,
            fq_table=fq_table,
            bank_id=bank_id,
            document_id=payload.get("document_id"),
            facts=[],
            archived_facts=[payload],
        )
    else:
        await conn.execute(f"DELETE FROM {arch} WHERE id = $1 AND bank_id = $2", uid, bank_id)
        await _apply_unit_facts(
            conn=conn,
            ops=ops,
            fq_table=fq_table,
            bank_id=bank_id,
            document_id=payload.get("document_id"),
            facts=[payload],
            archived_facts=[],
        )


async def delete_standalone_unit_payload(
    *, conn: Any, ops: Any, fq_table: Callable[[str], str], bank_id: str, unit_id: str
) -> None:
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    uid = uuid.UUID(unit_id)
    await delete_stale_observations(conn=conn, ops=ops, fq_table=fq_table, bank_id=bank_id, fact_ids=[unit_id])
    if ops is not None:
        await ops.delete_unit_links(conn, fq_table("memory_links"), bank_id, [unit_id])
    await conn.execute(f"DELETE FROM {mu} WHERE id = $1 AND bank_id = $2", uid, bank_id)
    await conn.execute(f"DELETE FROM {arch} WHERE id = $1 AND bank_id = $2", uid, bank_id)


async def export_observation_payload(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    observation_id: str,
) -> dict[str, Any] | None:
    mu = fq_table("memory_units")
    hist_tbl = fq_non_store_table("observation_history")
    uid = uuid.UUID(observation_id)
    row = await conn.fetchrow(
        f"""
        SELECT id, bank_id, text, tags, observation_scopes, proof_count,
               source_memory_ids, event_date, occurred_start, occurred_end,
               mentioned_at, embedding::text AS embedding_text, created_at, updated_at
        FROM {mu}
        WHERE id = $1 AND bank_id = $2 AND fact_type = 'observation'
        """,
        uid,
        bank_id,
    )
    if row is None:
        return None
    hrows = await conn.fetch(
        f"""
        SELECT content, changed_at
        FROM {hist_tbl}
        WHERE observation_id = $1 AND bank_id = $2
        ORDER BY changed_at ASC, id ASC
        """,
        uid,
        bank_id,
    )
    lrows = await conn.fetch(
        f"""
        SELECT to_unit_id::text AS to_id, link_type, weight
        FROM {fq_table("memory_links")}
        WHERE bank_id = $1 AND from_unit_id = $2 AND link_type IN ('temporal', 'semantic')
        ORDER BY to_unit_id, link_type
        """,
        bank_id,
        uid,
    )
    return {
        "id": str(row["id"]),
        "bank_id": row["bank_id"],
        "text": row["text"],
        "tags": list(row["tags"] or []),
        "observation_scopes": _parse_json(conn, row["observation_scopes"]),
        "proof_count": int(row["proof_count"] or 1),
        "source_memory_ids": [str(sid) for sid in (row["source_memory_ids"] or [])],
        "event_date": _iso(row["event_date"]),
        "occurred_start": _iso(row["occurred_start"]),
        "occurred_end": _iso(row["occurred_end"]),
        "mentioned_at": _iso(row["mentioned_at"]),
        "embedding": _embedding_literal(row["embedding_text"]),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "history": [
            {"content": _parse_json(conn, hr["content"]), "changed_at": _iso(hr["changed_at"])} for hr in hrows
        ],
        "links": [
            {"to_unit_id": lr["to_id"], "link_type": lr["link_type"], "weight": float(lr["weight"])} for lr in lrows
        ],
    }


async def apply_observation_payload(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    observation_id: str,
    payload: dict[str, Any],
) -> None:
    await _ensure_bank_on_conn(
        conn=conn,
        ops=ops,
        fq_table=fq_table,
        fq_non_store_table=fq_non_store_table,
        bank_id=bank_id,
    )
    mu = fq_table("memory_units")
    hist_tbl = fq_non_store_table("observation_history")
    uid = uuid.UUID(observation_id)
    src_ids = [uuid.UUID(str(s)) for s in (payload.get("source_memory_ids") or [])]

    from ....config import get_config
    from .consolidation import observation_search_vector_expr

    sv_expr = observation_search_vector_expr("$3") if get_config().text_search_extension == "vchord" else None
    sv_col = ", search_vector" if sv_expr is not None else ""
    sv_val = f", {sv_expr}" if sv_expr is not None else ""
    sv_upd = ", search_vector = EXCLUDED.search_vector" if sv_expr is not None else ""

    await conn.execute(
        f"""
        INSERT INTO {mu} (
            id, bank_id, text, fact_type, tags, observation_scopes, proof_count,
            source_memory_ids, event_date, occurred_start, occurred_end,
            mentioned_at, embedding, created_at, updated_at{sv_col}
        )
        VALUES (
            $1, $2, $3, 'observation', $4, $5::jsonb, $6,
            $7::uuid[], $8, $9, $10, $11, $12::vector, $13, $14{sv_val}
        )
        ON CONFLICT (id) DO UPDATE SET
            text = EXCLUDED.text,
            tags = EXCLUDED.tags,
            observation_scopes = EXCLUDED.observation_scopes,
            proof_count = EXCLUDED.proof_count,
            source_memory_ids = EXCLUDED.source_memory_ids,
            event_date = EXCLUDED.event_date,
            occurred_start = EXCLUDED.occurred_start,
            occurred_end = EXCLUDED.occurred_end,
            mentioned_at = EXCLUDED.mentioned_at,
            embedding = EXCLUDED.embedding,
            updated_at = EXCLUDED.updated_at{sv_upd}
        """,
        uid,
        bank_id,
        payload["text"],
        list(payload.get("tags") or []),
        json.dumps(payload["observation_scopes"]) if payload.get("observation_scopes") is not None else None,
        int(payload.get("proof_count") or len(src_ids) or 1),
        src_ids,
        _dt(payload.get("event_date")) or datetime.now(timezone.utc),
        _dt(payload.get("occurred_start")),
        _dt(payload.get("occurred_end")),
        _dt(payload.get("mentioned_at")),
        _embedding_literal(payload.get("embedding")),
        _dt(payload.get("created_at")) or datetime.now(timezone.utc),
        _dt(payload.get("updated_at")) or datetime.now(timezone.utc),
    )

    await conn.execute(
        f"DELETE FROM {hist_tbl} WHERE observation_id = $1 AND bank_id = $2",
        uid,
        bank_id,
    )
    for hist in payload.get("history") or []:
        await conn.execute(
            f"""
            INSERT INTO {hist_tbl} (observation_id, bank_id, content, changed_at)
            VALUES ($1, $2, $3::jsonb, $4)
            """,
            uid,
            bank_id,
            json.dumps(hist.get("content") or {}),
            _dt(hist.get("changed_at")) or datetime.now(timezone.utc),
        )
    await _insert_synced_links(
        conn=conn,
        fq_table=fq_table,
        bank_id=bank_id,
        from_uid=uid,
        links=list(payload.get("links") or []),
    )


async def delete_observation_payload(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
    observation_id: str,
) -> None:
    mu = fq_table("memory_units")
    hist_tbl = fq_non_store_table("observation_history")
    uid = uuid.UUID(observation_id)
    await conn.execute(f"DELETE FROM {hist_tbl} WHERE observation_id = $1 AND bank_id = $2", uid, bank_id)
    await conn.execute(
        f"DELETE FROM {mu} WHERE id = $1 AND bank_id = $2 AND fact_type = 'observation'",
        uid,
        bank_id,
    )


async def apply_bank_stub(
    *,
    conn: Any,
    ops: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
) -> None:
    """Ensure a ``banks`` row and its vector indexes exist inside ``conn``'s transaction."""
    await _ensure_bank_on_conn(
        conn=conn,
        ops=ops,
        fq_table=fq_table,
        fq_non_store_table=fq_non_store_table,
        bank_id=bank_id,
    )


async def delete_bank_cascade(
    *,
    conn: Any,
    fq_table: Callable[[str], str],
    fq_non_store_table: Callable[[str], str],
    bank_id: str,
) -> None:
    """Delete an entire bank's store rows and bank profile row cleanly in dependency order."""
    ml = fq_table("memory_links")
    ue = fq_table("unit_entities")
    co = fq_table("entity_cooccurrences")
    ent = fq_table("entities")
    mu = fq_table("memory_units")
    arch = fq_table("invalidated_memory_units")
    chunks_tbl = fq_table("chunks")
    docs = fq_table("documents")
    att_tbl = fq_non_store_table("attachments")
    banks_tbl = fq_non_store_table("banks")

    await conn.execute(f"DELETE FROM {ml} WHERE bank_id = $1", bank_id)
    await conn.execute(
        f"DELETE FROM {ue} WHERE unit_id IN (SELECT id FROM {mu} WHERE bank_id = $1)",
        bank_id,
    )
    await conn.execute(
        f"DELETE FROM {co} WHERE entity_id_1 IN (SELECT id FROM {ent} WHERE bank_id = $1)",
        bank_id,
    )
    await conn.execute(f"DELETE FROM {mu} WHERE bank_id = $1", bank_id)
    await conn.execute(f"DELETE FROM {arch} WHERE bank_id = $1", bank_id)
    await conn.execute(f"DELETE FROM {chunks_tbl} WHERE bank_id = $1", bank_id)
    await conn.execute(f"DELETE FROM {ent} WHERE bank_id = $1", bank_id)
    await conn.execute(f"DELETE FROM {att_tbl} WHERE bank_id = $1", bank_id)
    await conn.execute(f"DELETE FROM {docs} WHERE bank_id = $1", bank_id)
    await conn.execute(f"DELETE FROM {banks_tbl} WHERE bank_id = $1", bank_id)
