"""Canonical object payload codec, dependency ordering, and blob transport helpers for v3 sync."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

from ..schema_context import get_current_schema
from .memories import sql_memories
from .schema import fq_table_explicit


def _resolve_schema(schema: str | None) -> str:
    return schema or get_current_schema()


from .storage.base import FileStorage
from .storage.postgresql import PostgreSQLFileStorage
from .sync_journal import (
    APPLY_ORDER,
)
from .sync_journal import (
    _ensure_optional_utc as _dt,
)
from .sync_journal import (
    iso_utc as _iso,
)
from .sync_journal import (
    parse_json_value as _parse_json,
)
from .sync_journal import (
    vec_literal as _vec_literal,
)

logger = logging.getLogger(__name__)


class SyncObjectKey(BaseModel):
    """Canonical identity of a synced database object."""

    object_type: str
    bank_id: str = ""
    object_id: str


class SyncBlobRef(BaseModel):
    """Content-addressed binary blob referenced by a synced object payload."""

    role: str
    storage_key: str
    sha256: str
    byte_size: int = 0


def working_rule_record_to_payload(record: Any) -> dict[str, Any]:
    """Serialize a ``WorkingRuleRecord`` into its canonical sync payload."""
    return {
        "id": str(record.id),
        "scope": str(getattr(record, "scope", "global")),
        "project_id": getattr(record, "project_id", None),
        "content": record.content,
        "importance": str(record.importance),
        "pinned": bool(getattr(record, "pinned", False)),
        "branches": list(getattr(record, "branches", None) or []),
        "is_archived": bool(record.is_archived),
        "archived_at": _iso(record.archived_at),
        "archive_reason": record.archive_reason,
        "created_at": _iso(record.created_at),
        "updated_at": _iso(record.updated_at),
    }


# ---------------------------------------------------------------------------
# working_rule
# ---------------------------------------------------------------------------


async def _list_working_rule_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("working_rules", schema)
    rows = await conn.fetch(f"SELECT id::text AS id FROM {tbl} ORDER BY created_at, id")
    return [SyncObjectKey(object_type="working_rule", bank_id="", object_id=r["id"]) for r in rows]


async def _export_working_rule(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    del bank_id
    tbl = fq_table_explicit("working_rules", schema)
    row = await conn.fetchrow(
        f"""
        SELECT id::text AS id, scope, project_id, content, importance, pinned, branches,
               is_archived, archived_at, archive_reason, created_at, updated_at
        FROM {tbl}
        WHERE id = $1
        """,
        uuid.UUID(object_id),
    )
    if row is None:
        return None
    return {
        "id": row["id"],
        "scope": row["scope"],
        "project_id": row["project_id"],
        "content": row["content"],
        "importance": row["importance"],
        "pinned": bool(row["pinned"]),
        "branches": list(row["branches"] or []),
        "is_archived": bool(row["is_archived"]),
        "archived_at": _iso(row["archived_at"]),
        "archive_reason": row["archive_reason"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def _apply_working_rule(
    conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]
) -> None:
    del bank_id
    tbl = fq_table_explicit("working_rules", schema)
    now = datetime.now(timezone.utc)
    await conn.execute(
        f"""
        INSERT INTO {tbl} (
            id, scope, project_id, content, importance, pinned, branches,
            is_archived, archived_at, archive_reason, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
            scope = EXCLUDED.scope,
            project_id = EXCLUDED.project_id,
            content = EXCLUDED.content,
            importance = EXCLUDED.importance,
            pinned = EXCLUDED.pinned,
            branches = EXCLUDED.branches,
            is_archived = EXCLUDED.is_archived,
            archived_at = EXCLUDED.archived_at,
            archive_reason = EXCLUDED.archive_reason,
            updated_at = EXCLUDED.updated_at
        """,
        uuid.UUID(object_id),
        payload.get("scope", "global"),
        payload.get("project_id"),
        payload["content"],
        payload.get("importance", "normal"),
        bool(payload.get("pinned", False)),
        list(payload.get("branches") or []),
        bool(payload.get("is_archived", False)),
        _dt(payload.get("archived_at")),
        payload.get("archive_reason"),
        _dt(payload.get("created_at")) or now,
        _dt(payload.get("updated_at")) or now,
    )


async def _delete_working_rule(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    del bank_id
    tbl = fq_table_explicit("working_rules", schema)
    await conn.execute(f"DELETE FROM {tbl} WHERE id = $1", uuid.UUID(object_id))


# ---------------------------------------------------------------------------
# bank (+ bank_aliases)
# ---------------------------------------------------------------------------


async def _list_bank_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("banks", schema)
    rows = await conn.fetch(f"SELECT bank_id FROM {tbl} ORDER BY bank_id")
    return [SyncObjectKey(object_type="bank", bank_id=r["bank_id"], object_id=r["bank_id"]) for r in rows]


async def _export_bank(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    del object_id
    banks_tbl = fq_table_explicit("banks", schema)
    aliases_tbl = fq_table_explicit("bank_aliases", schema)
    row = await conn.fetchrow(
        f"""
        SELECT bank_id, name, disposition, mission, config, kind, mission_changed_at, created_at, updated_at
        FROM {banks_tbl}
        WHERE bank_id = $1
        """,
        bank_id,
    )
    if row is None:
        return None
    arows = await conn.fetch(
        f"SELECT alias, is_primary, created_at FROM {aliases_tbl} WHERE bank_id = $1 ORDER BY alias",
        bank_id,
    )
    return {
        "bank_id": row["bank_id"],
        "name": row["name"],
        "disposition": _parse_json(conn, row["disposition"]) or {"skepticism": 3, "literalism": 3, "empathy": 3},
        "mission": row["mission"],
        "config": _parse_json(conn, row["config"]) or {},
        "kind": row["kind"] or "memory",
        "mission_changed_at": _iso(row["mission_changed_at"]),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "aliases": [
            {
                "alias": ar["alias"],
                "is_primary": bool(ar["is_primary"]),
                "created_at": _iso(ar["created_at"]),
            }
            for ar in arows
        ],
    }


async def _apply_bank(conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]) -> None:
    del object_id
    # Reuse store bank creation first so per-bank vector indexes are provisioned if new.
    await sql_memories().sync_apply_bank_stub(conn=conn, schema=schema, bank_id=bank_id)
    banks_tbl = fq_table_explicit("banks", schema)
    aliases_tbl = fq_table_explicit("bank_aliases", schema)
    now = datetime.now(timezone.utc)
    await conn.execute(
        f"""
        UPDATE {banks_tbl}
        SET name = $2,
            disposition = $3::jsonb,
            mission = $4,
            config = $5::jsonb,
            kind = $6,
            mission_changed_at = $7,
            updated_at = $8
        WHERE bank_id = $1
        """,
        bank_id,
        payload.get("name"),
        json.dumps(payload.get("disposition") or {"skepticism": 3, "literalism": 3, "empathy": 3}),
        payload.get("mission"),
        json.dumps(payload.get("config") or {}),
        payload.get("kind", "memory"),
        _dt(payload.get("mission_changed_at")),
        _dt(payload.get("updated_at")) or now,
    )
    await conn.execute(f"DELETE FROM {aliases_tbl} WHERE bank_id = $1", bank_id)
    for alias in payload.get("aliases") or []:
        await conn.execute(
            f"""
            INSERT INTO {aliases_tbl} (alias, bank_id, is_primary, created_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (alias) DO UPDATE SET
                bank_id = EXCLUDED.bank_id,
                is_primary = EXCLUDED.is_primary
            """,
            alias["alias"],
            bank_id,
            bool(alias.get("is_primary", False)),
            _dt(alias.get("created_at")) or now,
        )


async def _delete_bank(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    del object_id
    await sql_memories().sync_delete_bank_cascade(conn=conn, schema=schema, bank_id=bank_id)


# ---------------------------------------------------------------------------
# directive
# ---------------------------------------------------------------------------


async def _list_directive_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("directives", schema)
    rows = await conn.fetch(f"SELECT bank_id, id::text AS id FROM {tbl} ORDER BY bank_id, created_at, id")
    return [SyncObjectKey(object_type="directive", bank_id=r["bank_id"], object_id=r["id"]) for r in rows]


async def _export_directive(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    tbl = fq_table_explicit("directives", schema)
    row = await conn.fetchrow(
        f"""
        SELECT id::text AS id, bank_id, name, content, priority, is_active, tags, created_at, updated_at
        FROM {tbl}
        WHERE bank_id = $1 AND id = $2
        """,
        bank_id,
        uuid.UUID(object_id),
    )
    if row is None:
        return None
    return {
        "id": row["id"],
        "bank_id": row["bank_id"],
        "name": row["name"],
        "content": row["content"],
        "priority": int(row["priority"]),
        "is_active": bool(row["is_active"]),
        "tags": list(row["tags"] or []),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def _apply_directive(
    conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]
) -> None:
    await sql_memories().sync_apply_bank_stub(conn=conn, schema=schema, bank_id=bank_id)
    tbl = fq_table_explicit("directives", schema)
    now = datetime.now(timezone.utc)
    await conn.execute(
        f"""
        INSERT INTO {tbl} (id, bank_id, name, content, priority, is_active, tags, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            content = EXCLUDED.content,
            priority = EXCLUDED.priority,
            is_active = EXCLUDED.is_active,
            tags = EXCLUDED.tags,
            updated_at = EXCLUDED.updated_at
        """,
        uuid.UUID(object_id),
        bank_id,
        payload["name"],
        payload["content"],
        int(payload.get("priority", 0)),
        bool(payload.get("is_active", True)),
        list(payload.get("tags") or []),
        _dt(payload.get("created_at")) or now,
        _dt(payload.get("updated_at")) or now,
    )


async def _delete_directive(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    tbl = fq_table_explicit("directives", schema)
    await conn.execute(f"DELETE FROM {tbl} WHERE bank_id = $1 AND id = $2", bank_id, uuid.UUID(object_id))


# ---------------------------------------------------------------------------
# mental_model (+ mental_model_history)
# ---------------------------------------------------------------------------


async def _list_mental_model_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("mental_models", schema)
    rows = await conn.fetch(f"SELECT bank_id, id FROM {tbl} ORDER BY bank_id, created_at, id")
    return [SyncObjectKey(object_type="mental_model", bank_id=r["bank_id"], object_id=r["id"]) for r in rows]


async def _export_mental_model(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    mm_tbl = fq_table_explicit("mental_models", schema)
    hist_tbl = fq_table_explicit("mental_model_history", schema)
    row = await conn.fetchrow(
        f"""
        SELECT id, bank_id, name, source_query, content, tags, max_tokens, trigger,
               reflect_response, last_refreshed_source_query, structured_content,
               subtype, description, links, last_refreshed_at, created_at,
               last_updated, last_memory_seen_at, last_refresh_failed_at, last_full_refreshed_at,
               embedding::text AS embedding_text
        FROM {mm_tbl}
        WHERE bank_id = $1 AND id = $2
        """,
        bank_id,
        object_id,
    )
    if row is None:
        return None
    hrows = await conn.fetch(
        f"""
        SELECT content, changed_at
        FROM {hist_tbl}
        WHERE bank_id = $1 AND mental_model_id = $2
        ORDER BY changed_at ASC, id ASC
        """,
        bank_id,
        object_id,
    )
    return {
        "id": row["id"],
        "bank_id": row["bank_id"],
        "name": row["name"],
        "source_query": row["source_query"],
        "content": row["content"],
        "tags": list(row["tags"] or []),
        "max_tokens": int(row["max_tokens"]),
        "trigger": _parse_json(conn, row["trigger"]) or {},
        "reflect_response": _parse_json(conn, row["reflect_response"]),
        "last_refreshed_source_query": row["last_refreshed_source_query"],
        "structured_content": _parse_json(conn, row["structured_content"]),
        "subtype": row["subtype"],
        "description": row["description"],
        "links": list(row["links"] or []) if row["links"] is not None else None,
        "embedding": _vec_literal(row["embedding_text"]),
        "last_refreshed_at": _iso(row["last_refreshed_at"]),
        "created_at": _iso(row["created_at"]),
        "last_updated": _iso(row["last_updated"]),
        "last_memory_seen_at": _iso(row["last_memory_seen_at"]),
        "last_refresh_failed_at": _iso(row["last_refresh_failed_at"]),
        "last_full_refreshed_at": _iso(row["last_full_refreshed_at"]),
        "history": [
            {"content": _parse_json(conn, hr["content"]) or {}, "changed_at": _iso(hr["changed_at"])} for hr in hrows
        ],
    }


async def _apply_mental_model(
    conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]
) -> None:
    await sql_memories().sync_apply_bank_stub(conn=conn, schema=schema, bank_id=bank_id)
    mm_tbl = fq_table_explicit("mental_models", schema)
    hist_tbl = fq_table_explicit("mental_model_history", schema)
    now = datetime.now(timezone.utc)
    await conn.execute(
        f"""
        INSERT INTO {mm_tbl} (
            id, bank_id, name, source_query, content, tags, max_tokens, trigger,
            reflect_response, last_refreshed_source_query, structured_content,
            subtype, description, links, embedding,
            last_refreshed_at, created_at, last_updated,
            last_memory_seen_at, last_refresh_failed_at, last_full_refreshed_at
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
            $9::jsonb, $10, $11::jsonb,
            $12, $13, $14, $15::vector,
            $16, $17, $18,
            $19, $20, $21
        )
        ON CONFLICT (id, bank_id) DO UPDATE SET
            name = EXCLUDED.name,
            source_query = EXCLUDED.source_query,
            content = EXCLUDED.content,
            tags = EXCLUDED.tags,
            max_tokens = EXCLUDED.max_tokens,
            trigger = EXCLUDED.trigger,
            reflect_response = EXCLUDED.reflect_response,
            last_refreshed_source_query = EXCLUDED.last_refreshed_source_query,
            structured_content = EXCLUDED.structured_content,
            subtype = EXCLUDED.subtype,
            description = EXCLUDED.description,
            links = EXCLUDED.links,
            embedding = EXCLUDED.embedding,
            last_refreshed_at = EXCLUDED.last_refreshed_at,
            last_updated = EXCLUDED.last_updated,
            last_memory_seen_at = EXCLUDED.last_memory_seen_at,
            last_refresh_failed_at = EXCLUDED.last_refresh_failed_at,
            last_full_refreshed_at = EXCLUDED.last_full_refreshed_at
        """,
        object_id,
        bank_id,
        payload["name"],
        payload.get("source_query", ""),
        payload.get("content", ""),
        list(payload.get("tags") or []),
        int(payload.get("max_tokens", 2048)),
        json.dumps(payload.get("trigger") or {"refresh_after_consolidation": False}),
        json.dumps(payload["reflect_response"]) if payload.get("reflect_response") is not None else None,
        payload.get("last_refreshed_source_query"),
        json.dumps(payload["structured_content"]) if payload.get("structured_content") is not None else None,
        payload.get("subtype", "pinned"),
        payload.get("description", " "),
        list(payload["links"]) if payload.get("links") is not None else None,
        _vec_literal(payload.get("embedding")),
        _dt(payload.get("last_refreshed_at")) or now,
        _dt(payload.get("created_at")) or now,
        _dt(payload.get("last_updated")),
        _dt(payload.get("last_memory_seen_at")),
        _dt(payload.get("last_refresh_failed_at")),
        _dt(payload.get("last_full_refreshed_at")),
    )
    await conn.execute(f"DELETE FROM {hist_tbl} WHERE bank_id = $1 AND mental_model_id = $2", bank_id, object_id)
    for hr in payload.get("history") or []:
        await conn.execute(
            f"""
            INSERT INTO {hist_tbl} (mental_model_id, bank_id, content, changed_at)
            VALUES ($1, $2, $3::jsonb, $4)
            """,
            object_id,
            bank_id,
            json.dumps(hr.get("content") or {}),
            _dt(hr.get("changed_at")) or now,
        )


async def _delete_mental_model(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    mm_tbl = fq_table_explicit("mental_models", schema)
    await conn.execute(f"DELETE FROM {mm_tbl} WHERE bank_id = $1 AND id = $2", bank_id, object_id)


# ---------------------------------------------------------------------------
# knowledge_page (parent-first order for parent_id FK)
# ---------------------------------------------------------------------------


async def _list_knowledge_page_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("knowledge_pages", schema)
    rows = await conn.fetch(f"SELECT bank_id, id, parent_id FROM {tbl} ORDER BY bank_id, sort_order, created_at, id")
    by_key = {(r["bank_id"], r["id"]): r for r in rows}
    ordered: list[SyncObjectKey] = []
    emitted: set[tuple[str, str]] = set()

    def _visit(key: tuple[str, str], stack: set[tuple[str, str]]) -> None:
        if key in emitted or key in stack:
            return
        row = by_key.get(key)
        if row is None:
            return
        stack.add(key)
        if row["parent_id"]:
            _visit((row["bank_id"], row["parent_id"]), stack)
        emitted.add(key)
        ordered.append(SyncObjectKey(object_type="knowledge_page", bank_id=row["bank_id"], object_id=row["id"]))

    for r in rows:
        _visit((r["bank_id"], r["id"]), set())
    return ordered


async def _export_knowledge_page(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    tbl = fq_table_explicit("knowledge_pages", schema)
    row = await conn.fetchrow(
        f"""
        SELECT id, bank_id, parent_id, kind, name, mental_model_id, sort_order, managed, created_at, updated_at
        FROM {tbl}
        WHERE bank_id = $1 AND id = $2
        """,
        bank_id,
        object_id,
    )
    if row is None:
        return None
    return {
        "id": row["id"],
        "bank_id": row["bank_id"],
        "parent_id": row["parent_id"],
        "kind": row["kind"],
        "name": row["name"],
        "mental_model_id": row["mental_model_id"],
        "sort_order": int(row["sort_order"]),
        "managed": bool(row["managed"]),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def _apply_knowledge_page(
    conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]
) -> None:
    await sql_memories().sync_apply_bank_stub(conn=conn, schema=schema, bank_id=bank_id)
    tbl = fq_table_explicit("knowledge_pages", schema)
    now = datetime.now(timezone.utc)
    stored_id = await conn.fetchval(
        f"""
        INSERT INTO {tbl} AS existing_page (
            id, bank_id, parent_id, kind, name, mental_model_id, sort_order, managed, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        -- Page ids are globally unique; the table has no (bank_id, id) constraint.
        -- A colliding id from another bank must not overwrite its existing page.
        ON CONFLICT (id) DO UPDATE SET
            parent_id = EXCLUDED.parent_id,
            kind = EXCLUDED.kind,
            name = EXCLUDED.name,
            mental_model_id = EXCLUDED.mental_model_id,
            sort_order = EXCLUDED.sort_order,
            managed = EXCLUDED.managed,
            updated_at = EXCLUDED.updated_at
        WHERE existing_page.bank_id = EXCLUDED.bank_id
        RETURNING id
        """,
        object_id,
        bank_id,
        payload.get("parent_id"),
        payload["kind"],
        payload["name"],
        payload.get("mental_model_id"),
        int(payload.get("sort_order", 0)),
        bool(payload.get("managed", False)),
        _dt(payload.get("created_at")) or now,
        _dt(payload.get("updated_at")) or now,
    )
    if stored_id is None:
        raise ValueError("Cannot sync a knowledge page whose id belongs to another bank")


async def _delete_knowledge_page(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    tbl = fq_table_explicit("knowledge_pages", schema)
    await conn.execute(f"DELETE FROM {tbl} WHERE bank_id = $1 AND id = $2", bank_id, object_id)


# ---------------------------------------------------------------------------
# kb_document (+ kb_passages + kb_passage_vectors)
# ---------------------------------------------------------------------------


async def _list_kb_document_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("kb_documents", schema)
    rows = await conn.fetch(f"SELECT bank_id, document_id FROM {tbl} ORDER BY bank_id, created_at, document_id")
    return [SyncObjectKey(object_type="kb_document", bank_id=r["bank_id"], object_id=r["document_id"]) for r in rows]


async def _export_kb_document(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    doc_tbl = fq_table_explicit("kb_documents", schema)
    pas_tbl = fq_table_explicit("kb_passages", schema)
    vec_tbl = fq_table_explicit("kb_passage_vectors", schema)
    resolved = _resolve_schema(schema)
    fs_tbl = fq_table_explicit("file_storage", resolved)
    row = await conn.fetchrow(
        f"""
        SELECT bank_id, document_id, filename, content_type, media_type, size_bytes,
               storage_key, content_hash, status, error, passage_count, tags,
               source_document_id, content_tokens, created_at, updated_at
        FROM {doc_tbl}
        WHERE bank_id = $1 AND document_id = $2
        """,
        bank_id,
        object_id,
    )
    if row is None:
        return None
    prows = await conn.fetch(
        f"""
        SELECT idx, modality, text, page, start_ms, end_ms, media_key, embedding::text AS embedding_text
        FROM {pas_tbl}
        WHERE bank_id = $1 AND document_id = $2
        ORDER BY idx
        """,
        bank_id,
        object_id,
    )
    vrows = await conn.fetch(
        f"""
        SELECT idx, role, n, embedding::text AS embedding_text
        FROM {vec_tbl}
        WHERE bank_id = $1 AND document_id = $2
        ORDER BY idx, role, n
        """,
        bank_id,
        object_id,
    )
    blobs: list[dict[str, Any]] = []
    if row["storage_key"]:
        data = await conn.fetchval(f"SELECT data FROM {fs_tbl} WHERE storage_key = $1", row["storage_key"])
        if data is not None:
            raw = bytes(data)
            blobs.append(
                {
                    "role": "kb_document",
                    "storage_key": row["storage_key"],
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "byte_size": len(raw),
                }
            )
    return {
        "bank_id": row["bank_id"],
        "document_id": row["document_id"],
        "filename": row["filename"],
        "content_type": row["content_type"],
        "media_type": row["media_type"],
        "size_bytes": int(row["size_bytes"]),
        "storage_key": row["storage_key"],
        "content_hash": row["content_hash"],
        "status": row["status"],
        "error": row["error"],
        "passage_count": int(row["passage_count"]),
        "tags": list(row["tags"] or []),
        "source_document_id": row["source_document_id"],
        "content_tokens": int(row["content_tokens"]),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "blobs": blobs,
        "passages": [
            {
                "idx": int(pr["idx"]),
                "modality": pr["modality"],
                "text": pr["text"],
                "page": pr["page"],
                "start_ms": pr["start_ms"],
                "end_ms": pr["end_ms"],
                "media_key": pr["media_key"],
                "embedding": _vec_literal(pr["embedding_text"]),
            }
            for pr in prows
        ],
        "vectors": [
            {
                "idx": int(vr["idx"]),
                "role": vr["role"],
                "n": int(vr["n"]),
                "embedding": _vec_literal(vr["embedding_text"]),
            }
            for vr in vrows
        ],
    }


async def _apply_kb_document(
    conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]
) -> None:
    await sql_memories().sync_apply_bank_stub(conn=conn, schema=schema, bank_id=bank_id)
    doc_tbl = fq_table_explicit("kb_documents", schema)
    pas_tbl = fq_table_explicit("kb_passages", schema)
    vec_tbl = fq_table_explicit("kb_passage_vectors", schema)
    now = datetime.now(timezone.utc)
    await conn.execute(f"DELETE FROM {vec_tbl} WHERE bank_id = $1 AND document_id = $2", bank_id, object_id)
    await conn.execute(f"DELETE FROM {pas_tbl} WHERE bank_id = $1 AND document_id = $2", bank_id, object_id)
    await conn.execute(
        f"""
        INSERT INTO {doc_tbl} (
            bank_id, document_id, filename, content_type, media_type, size_bytes,
            storage_key, content_hash, status, error, passage_count, tags,
            source_document_id, content_tokens, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (bank_id, document_id) DO UPDATE SET
            filename = EXCLUDED.filename,
            content_type = EXCLUDED.content_type,
            media_type = EXCLUDED.media_type,
            size_bytes = EXCLUDED.size_bytes,
            storage_key = EXCLUDED.storage_key,
            content_hash = EXCLUDED.content_hash,
            status = EXCLUDED.status,
            error = EXCLUDED.error,
            passage_count = EXCLUDED.passage_count,
            tags = EXCLUDED.tags,
            source_document_id = EXCLUDED.source_document_id,
            content_tokens = EXCLUDED.content_tokens,
            updated_at = EXCLUDED.updated_at
        """,
        bank_id,
        object_id,
        payload.get("filename"),
        payload.get("content_type", "text"),
        payload.get("media_type", "text/plain"),
        int(payload.get("size_bytes", 0)),
        payload.get("storage_key"),
        payload.get("content_hash", ""),
        payload.get("status", "ready"),
        payload.get("error"),
        int(payload.get("passage_count", 0)),
        list(payload.get("tags") or []),
        payload.get("source_document_id"),
        int(payload.get("content_tokens", 0)),
        _dt(payload.get("created_at")) or now,
        _dt(payload.get("updated_at")) or now,
    )
    for pr in payload.get("passages") or []:
        await conn.execute(
            f"""
            INSERT INTO {pas_tbl} (bank_id, document_id, idx, modality, text, page, start_ms, end_ms, media_key, embedding)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
            """,
            bank_id,
            object_id,
            int(pr["idx"]),
            pr["modality"],
            pr.get("text"),
            pr.get("page"),
            pr.get("start_ms"),
            pr.get("end_ms"),
            pr.get("media_key"),
            _vec_literal(pr["embedding"]),
        )
    for vr in payload.get("vectors") or []:
        await conn.execute(
            f"""
            INSERT INTO {vec_tbl} (bank_id, document_id, idx, role, n, embedding)
            VALUES ($1, $2, $3, $4, $5, $6::vector)
            """,
            bank_id,
            object_id,
            int(vr["idx"]),
            vr["role"],
            int(vr["n"]),
            _vec_literal(vr["embedding"]),
        )


async def _delete_kb_document(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    doc_tbl = fq_table_explicit("kb_documents", schema)
    await conn.execute(f"DELETE FROM {doc_tbl} WHERE bank_id = $1 AND document_id = $2", bank_id, object_id)


# ---------------------------------------------------------------------------
# webhook
# ---------------------------------------------------------------------------


async def _list_webhook_keys(conn: Any, schema: str | None) -> list[SyncObjectKey]:
    tbl = fq_table_explicit("webhooks", schema)
    rows = await conn.fetch(
        f"SELECT COALESCE(bank_id, '') AS bank_id, id::text AS id FROM {tbl} ORDER BY created_at, id"
    )
    return [SyncObjectKey(object_type="webhook", bank_id=r["bank_id"], object_id=r["id"]) for r in rows]


async def _export_webhook(conn: Any, schema: str | None, bank_id: str, object_id: str) -> dict[str, Any] | None:
    del bank_id
    tbl = fq_table_explicit("webhooks", schema)
    row = await conn.fetchrow(
        f"""
        SELECT id::text AS id, COALESCE(bank_id, '') AS bank_id, url, secret, event_types,
               enabled, http_config, created_at, updated_at
        FROM {tbl}
        WHERE id = $1
        """,
        uuid.UUID(object_id),
    )
    if row is None:
        return None
    return {
        "id": row["id"],
        "bank_id": row["bank_id"],
        "url": row["url"],
        "secret": row["secret"],
        "event_types": list(row["event_types"] or []),
        "enabled": bool(row["enabled"]),
        "http_config": _parse_json(conn, row["http_config"]) or {},
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def _apply_webhook(conn: Any, schema: str | None, bank_id: str, object_id: str, payload: dict[str, Any]) -> None:
    eff_bank = payload.get("bank_id") if payload.get("bank_id") is not None else bank_id
    if eff_bank:
        await sql_memories().sync_apply_bank_stub(conn=conn, schema=schema, bank_id=eff_bank)
    tbl = fq_table_explicit("webhooks", schema)
    now = datetime.now(timezone.utc)
    await conn.execute(
        f"""
        INSERT INTO {tbl} (id, bank_id, url, secret, event_types, enabled, http_config, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
            bank_id = EXCLUDED.bank_id,
            url = EXCLUDED.url,
            secret = EXCLUDED.secret,
            event_types = EXCLUDED.event_types,
            enabled = EXCLUDED.enabled,
            http_config = EXCLUDED.http_config,
            updated_at = EXCLUDED.updated_at
        """,
        uuid.UUID(object_id),
        eff_bank or None,
        payload["url"],
        payload.get("secret"),
        list(payload.get("event_types") or []),
        bool(payload.get("enabled", True)),
        json.dumps(payload.get("http_config") or {}),
        _dt(payload.get("created_at")) or now,
        _dt(payload.get("updated_at")) or now,
    )


async def _delete_webhook(conn: Any, schema: str | None, bank_id: str, object_id: str) -> None:
    del bank_id
    tbl = fq_table_explicit("webhooks", schema)
    await conn.execute(f"DELETE FROM {tbl} WHERE id = $1", uuid.UUID(object_id))


# ---------------------------------------------------------------------------
# Unified dispatch across all 10 object types
# ---------------------------------------------------------------------------


async def _list_document_keys(conn: Any, schema: str) -> list[SyncObjectKey]:
    return [
        SyncObjectKey(object_type="document", bank_id=r["bank_id"], object_id=r["object_id"])
        for r in await sql_memories().sync_list_document_keys(conn=conn, schema=schema)
    ]


async def _list_memory_unit_keys(conn: Any, schema: str) -> list[SyncObjectKey]:
    return [
        SyncObjectKey(object_type="memory_unit", bank_id=r["bank_id"], object_id=r["object_id"])
        for r in await sql_memories().sync_list_standalone_unit_keys(conn=conn, schema=schema)
    ]


async def _list_observation_keys(conn: Any, schema: str) -> list[SyncObjectKey]:
    return [
        SyncObjectKey(object_type="observation", bank_id=r["bank_id"], object_id=r["object_id"])
        for r in await sql_memories().sync_list_observation_keys(conn=conn, schema=schema)
    ]


async def _export_document(conn: Any, schema: str, bank_id: str, object_id: str) -> dict[str, Any] | None:
    return await sql_memories().sync_export_document(conn=conn, schema=schema, bank_id=bank_id, document_id=object_id)


async def _apply_document(conn: Any, schema: str, bank_id: str, object_id: str, payload: dict[str, Any]) -> None:
    await sql_memories().sync_apply_document(
        conn=conn, schema=schema, bank_id=bank_id, document_id=object_id, payload=payload
    )


async def _delete_document(conn: Any, schema: str, bank_id: str, object_id: str) -> None:
    await sql_memories().sync_delete_document(conn=conn, schema=schema, bank_id=bank_id, document_id=object_id)


async def _export_memory_unit(conn: Any, schema: str, bank_id: str, object_id: str) -> dict[str, Any] | None:
    return await sql_memories().sync_export_memory_unit(conn=conn, schema=schema, bank_id=bank_id, unit_id=object_id)


async def _apply_memory_unit(conn: Any, schema: str, bank_id: str, object_id: str, payload: dict[str, Any]) -> None:
    await sql_memories().sync_apply_memory_unit(
        conn=conn, schema=schema, bank_id=bank_id, unit_id=object_id, payload=payload
    )


async def _delete_memory_unit(conn: Any, schema: str, bank_id: str, object_id: str) -> None:
    await sql_memories().sync_delete_memory_unit(conn=conn, schema=schema, bank_id=bank_id, unit_id=object_id)


async def _export_observation(conn: Any, schema: str, bank_id: str, object_id: str) -> dict[str, Any] | None:
    return await sql_memories().sync_export_observation(
        conn=conn, schema=schema, bank_id=bank_id, observation_id=object_id
    )


async def _apply_observation(conn: Any, schema: str, bank_id: str, object_id: str, payload: dict[str, Any]) -> None:
    await sql_memories().sync_apply_observation(
        conn=conn, schema=schema, bank_id=bank_id, observation_id=object_id, payload=payload
    )


async def _delete_observation(conn: Any, schema: str, bank_id: str, object_id: str) -> None:
    await sql_memories().sync_delete_observation(conn=conn, schema=schema, bank_id=bank_id, observation_id=object_id)


_CODEC_TABLE = {
    "working_rule": (_list_working_rule_keys, _export_working_rule, _apply_working_rule, _delete_working_rule),
    "bank": (_list_bank_keys, _export_bank, _apply_bank, _delete_bank),
    "directive": (_list_directive_keys, _export_directive, _apply_directive, _delete_directive),
    "document": (_list_document_keys, _export_document, _apply_document, _delete_document),
    "memory_unit": (_list_memory_unit_keys, _export_memory_unit, _apply_memory_unit, _delete_memory_unit),
    "observation": (_list_observation_keys, _export_observation, _apply_observation, _delete_observation),
    "mental_model": (_list_mental_model_keys, _export_mental_model, _apply_mental_model, _delete_mental_model),
    "knowledge_page": (
        _list_knowledge_page_keys,
        _export_knowledge_page,
        _apply_knowledge_page,
        _delete_knowledge_page,
    ),
    "kb_document": (_list_kb_document_keys, _export_kb_document, _apply_kb_document, _delete_kb_document),
    "webhook": (_list_webhook_keys, _export_webhook, _apply_webhook, _delete_webhook),
}


async def list_all_object_keys(conn: Any, schema: str | None = None) -> list[SyncObjectKey]:
    """Enumerate all currently persisted synced objects in dependency order."""
    resolved = _resolve_schema(schema)
    keys: list[SyncObjectKey] = []
    for object_type in sorted(_CODEC_TABLE, key=lambda t: APPLY_ORDER.get(t, 999)):
        lister, _, _, _ = _CODEC_TABLE[object_type]
        keys.extend(await lister(conn, resolved))
    return keys


async def list_bank_object_keys(
    conn: Any, bank_id: str, *, include_bank: bool = False, schema: str | None = None
) -> list[SyncObjectKey]:
    """Enumerate all currently persisted objects owned by ``bank_id``."""
    keys: list[SyncObjectKey] = []
    for key in await list_all_object_keys(conn, schema=schema):
        if key.bank_id != bank_id:
            continue
        if key.object_type == "bank" and not include_bank:
            continue
        keys.append(key)
    return keys


async def export_object_payload(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    schema: str | None = None,
) -> dict[str, Any] | None:
    """Export one live object payload in canonical JSON-compatible dict form, or None if missing."""
    entry = _CODEC_TABLE.get(object_type)
    if entry is None:
        raise ValueError(f"Unsupported sync object_type: {object_type!r}")
    _, exporter, _, _ = entry
    return await exporter(conn, _resolve_schema(schema), bank_id, object_id)


async def apply_object_payload(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    payload: dict[str, Any],
    schema: str | None = None,
) -> None:
    """Apply an upsert/restore object payload idempotently inside the caller's transaction."""
    entry = _CODEC_TABLE.get(object_type)
    if entry is None:
        raise ValueError(f"Unsupported sync object_type: {object_type!r}")
    _, _, applier, _ = entry
    await applier(conn, _resolve_schema(schema), bank_id, object_id, payload)


async def delete_object_payload(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    schema: str | None = None,
) -> None:
    """Delete one object cleanly inside the caller's transaction."""
    entry = _CODEC_TABLE.get(object_type)
    if entry is None:
        raise ValueError(f"Unsupported sync object_type: {object_type!r}")
    _, _, _, deleter = entry
    await deleter(conn, _resolve_schema(schema), bank_id, object_id)


def order_changes_for_apply(items: list[Any]) -> list[Any]:
    """Sort incoming change objects or dicts in strict dependency order."""

    def _key(item: Any) -> tuple[int, int, str, str]:
        obj_type = item.object_type if hasattr(item, "object_type") else item["object_type"]
        payload = item.payload if hasattr(item, "payload") else item.get("payload")
        op = item.op if hasattr(item, "op") else item["op"]
        obj_id = item.object_id if hasattr(item, "object_id") else item["object_id"]
        bank_id = item.bank_id if hasattr(item, "bank_id") else item.get("bank_id", "")
        # Deletes apply reverse dependency order after upserts? Actually deletes of documents/banks
        # happen cleanly regardless, while parent knowledge_page before child knowledge_page uses parent_id presence.
        is_child_page = (
            1 if (obj_type == "knowledge_page" and isinstance(payload, dict) and payload.get("parent_id")) else 0
        )
        type_rank = APPLY_ORDER.get(obj_type, 999)
        if op == "delete" and obj_type in ("knowledge_page", "mental_model", "observation", "document", "bank"):
            type_rank = 1000 - type_rank
        return (type_rank, is_child_page, bank_id, obj_id)

    return sorted(items, key=_key)


def extract_blob_refs(payload: dict[str, Any] | None) -> list[SyncBlobRef]:
    """Return every content-addressed binary blob referenced by an object payload."""
    if not payload or not isinstance(payload, dict):
        return []
    raw_blobs = payload.get("blobs")
    if not isinstance(raw_blobs, list):
        return []
    refs: list[SyncBlobRef] = []
    for entry in raw_blobs:
        if isinstance(entry, dict) and entry.get("storage_key") and entry.get("sha256"):
            refs.append(
                SyncBlobRef(
                    role=str(entry.get("role", "attachment")),
                    storage_key=str(entry["storage_key"]),
                    sha256=str(entry["sha256"]),
                    byte_size=int(entry.get("byte_size") or 0),
                )
            )
    return refs


async def read_blob_bytes(
    conn: Any,
    storage_key: str,
    *,
    schema: str | None = None,
    file_storage: FileStorage | None = None,
) -> bytes | None:
    """Read raw blob bytes from configured FileStorage or PostgreSQL ``file_storage``."""
    resolved = _resolve_schema(schema)
    fs_tbl = fq_table_explicit("file_storage", resolved)
    data = await conn.fetchval(f"SELECT data FROM {fs_tbl} WHERE storage_key = $1", storage_key)
    if data is not None:
        raw = bytes(data)
        if file_storage is None:
            pg_fs = PostgreSQLFileStorage(pool_getter=lambda: None, schema=resolved)
            stored = await pg_fs._probe(conn, storage_key)
            if stored is not None and stored.manifest is not None:
                parts: list[bytes] = []
                for i in range(stored.manifest.chunks):
                    chunk = await conn.fetchval(
                        f"SELECT data FROM {fs_tbl} WHERE storage_key = $1",
                        f"{storage_key}#chunk={i:06d}",
                    )
                    if chunk is None:
                        return None
                    parts.append(bytes(chunk))
                return b"".join(parts)
        return raw
    if file_storage is not None and not isinstance(file_storage, PostgreSQLFileStorage):
        try:
            return await file_storage.retrieve(storage_key)
        except Exception:
            return None
    return None


async def write_blob_bytes(
    conn: Any,
    storage_key: str,
    data: bytes,
    *,
    expected_sha256: str,
    schema: str | None = None,
    file_storage: FileStorage | None = None,
) -> None:
    """Verify SHA-256 integrity and write binary blob into ``file_storage`` (and external FileStorage if active)."""
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != expected_sha256:
        raise ValueError(
            f"Blob integrity check failed for {storage_key!r}: expected sha256={expected_sha256}, got {actual_sha}"
        )
    resolved = _resolve_schema(schema)
    fs_tbl = fq_table_explicit("file_storage", resolved)
    await conn.execute(
        f"""
        INSERT INTO {fs_tbl} (storage_key, data)
        VALUES ($1, $2)
        ON CONFLICT (storage_key) DO UPDATE SET data = EXCLUDED.data
        """,
        storage_key,
        data,
    )
    if file_storage is not None and not isinstance(file_storage, PostgreSQLFileStorage):
        await file_storage.store(data, storage_key)
