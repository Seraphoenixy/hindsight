"""Object-level v3 synchronization engine, checkpointing, conflict capture, and relay client."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import socket
import tempfile
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import aiohttp
from filelock import FileLock
from pydantic import BaseModel, Field

from .aiohttp_session import HINDSIGHT_USER_AGENT, per_phase_timeout
from .db_utils import acquire_with_retry
from .schema import fq_table_explicit
from .storage.base import FileStorage
from .sync_journal import (
    ConflictSide,
    SyncChangeEntry,
    SyncCursorRecord,
    SyncObjectConflictRecord,
    SyncObjectStateRecord,
    compute_content_hash,
    fetch_pending_changes,
    get_local_high_water,
    get_object_state,
    get_sync_conflict,
    get_sync_cursor,
    has_active_async_operations,
    insert_sync_conflict,
    mark_object_synced,
    mark_sync_applying,
    mark_sync_conflict_applied,
    mark_sync_conflict_restored,
    mark_sync_tx_managed,
    record_sync_change,
    upsert_sync_cursor,
)
from .sync_objects_codec import (
    apply_object_payload,
    delete_object_payload,
    export_object_payload,
    extract_blob_refs,
    list_all_object_keys,
    order_changes_for_apply,
    read_blob_bytes,
    write_blob_bytes,
)

logger = logging.getLogger(__name__)

V3_STATUS_PATH = "/v3/status"
V3_BOOTSTRAP_PATH = "/v3/bootstrap"
V3_CHANGES_PATH = "/v3/changes"
V3_BASELINE_PATH = "/v3/baseline"
V3_BLOBS_MISSING_PATH = "/v3/blobs/missing"
V3_BLOBS_PREFIX = "/v3/blobs/"
V3_DEVICES_PATH = "/v3/devices"

DEFAULT_MAX_BLOB_BYTES = 512 * 1024 * 1024
DEFAULT_BATCH_MAX_ITEMS = 100
DEFAULT_BATCH_MAX_BYTES = 4 * 1024 * 1024


class SyncError(RuntimeError):
    """Base error for object-level sync operations."""


class SyncAuthError(SyncError):
    """Authentication or device revocation error returned by the relay."""

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class SyncRateLimited(SyncError):
    def __init__(self, retry_after: str) -> None:
        super().__init__("Sync relay rate limited the request (429)")
        try:
            self.retry_seconds = max(0, int(retry_after))
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(retry_after)
                self.retry_seconds = max(0, int((retry_at - datetime.now(timezone.utc)).total_seconds()))
            except (ValueError, TypeError, OverflowError):
                self.retry_seconds = 0


class SyncManualChoiceRequired(SyncError):
    """Raised when unjoined non-empty libraries require an explicit --prefer choice."""


class SyncVersionConflictError(SyncError):
    """Raised when optimistic version check fails on conflict restore."""


class DeviceIdentity(BaseModel):
    """Locally persisted sync device identifier and per-device credential."""

    device_id: str
    token: str
    name: str
    relay_url: str
    per_device_token: bool = False
    created_at: datetime
    managed_relay: bool = False


class RelayDeviceInfo(BaseModel):
    """Relay device entry returned by the relay device registry."""

    device_id: str
    name: str
    created_at: str
    rotated_at: str | None = None
    revoked_at: str | None = None
    last_seen_at: str | None = None
    active: bool = True


class RelayDeviceProvisioned(BaseModel):
    """Newly issued or rotated device credential (token is returned once)."""

    device_id: str
    name: str
    token: str
    created_at: str | None = None
    rotated_at: str | None = None
    active: bool = True


class RelayStatusInfo(BaseModel):
    """Lightweight or detailed status from ``HEAD/GET /v3/status``."""

    protocol: int = 3
    initialized: bool = False
    epoch: str = ""
    relay_version: int = 0
    last_seq: int = 0
    active_objects: int = 0
    tombstones: int = 0


class RelayChangeItem(BaseModel):
    """One ordered change entry received from ``GET /v3/changes``."""

    seq: int
    object_type: str
    bank_id: str = ""
    object_id: str
    op: str
    relay_version: int
    base_relay_version: int = 0
    content_hash: str = ""
    deleted: bool = False
    payload: dict[str, Any] | None = None
    origin_device_id: str = ""
    updated_at: str = ""


class RelayAcceptedItem(BaseModel):
    """Server confirmation for an uploaded object change."""

    client_seq: int
    object_type: str
    bank_id: str = ""
    object_id: str
    seq: int
    relay_version: int
    content_hash: str
    deleted: bool = False


class RelayPushConflict(BaseModel):
    """Server-detected divergence when pushing against an outdated object version."""

    client_seq: int
    object_type: str
    bank_id: str = ""
    object_id: str
    local_version: int
    base_relay_version: int
    relay_version: int
    relay_op: str
    relay_content_hash: str
    relay_deleted: bool = False
    relay_payload: dict[str, Any] | None = None
    relay_device_id: str = ""
    relay_seq: int = 0


class RelayPushResult(BaseModel):
    """Response from ``POST /v3/changes`` or ``POST /v3/bootstrap``."""

    epoch: str
    relay_version: int
    last_seq: int
    accepted: list[RelayAcceptedItem] = Field(default_factory=list)
    conflicts: list[RelayPushConflict] = Field(default_factory=list)
    duplicate_batch: bool = False
    initialized_by_self: bool = False


class RelayPullPage(BaseModel):
    """Paginated response from ``GET /v3/changes``."""

    epoch: str
    relay_version: int
    last_seq: int
    reset_required: bool = False
    next_seq: int = 0
    has_more: bool = False
    changes: list[RelayChangeItem] = Field(default_factory=list)


class RelayBaselinePage(BaseModel):
    """Paginated object snapshot returned by ``GET /v3/baseline``."""

    epoch: str
    relay_version: int
    last_seq: int
    total: int
    offset: int
    limit: int
    items: list[RelayChangeItem] = Field(default_factory=list)


class SyncExchangeResult(BaseModel):
    """Outcome summary returned by one v3 sync cycle or status check."""

    status: Literal["idle", "synced", "deferred", "needs_prefer", "auth_error", "error"]
    message: str
    device_id: str = ""
    relay_version: int = 0
    last_seq: int = 0
    out_seq: int = 0
    in_seq: int = 0
    pushed_count: int = 0
    pulled_count: int = 0
    conflicts_created: int = 0
    upload_bytes: int = 0
    download_bytes: int = 0
    blobs_uploaded: int = 0
    blobs_downloaded: int = 0
    local_objects_scanned: int = 0
    db_writes: int = 0
    auth_status: str = "ok"


def validate_relay_url(server_url: str) -> str:
    """Validate that the relay URL uses HTTPS (or HTTP only on loopback) without query/credentials."""
    url = urlsplit(server_url)
    loopback = url.hostname in {"127.0.0.1", "::1", "localhost"}
    if (
        not url.hostname
        or url.scheme not in ({"http", "https"} if loopback else {"https"})
        or url.username is not None
        or url.query
        or url.fragment
    ):
        raise ValueError("Use an HTTPS sync relay URL, or HTTP on loopback, without credentials, query or fragment")
    return server_url.rstrip("/")


def validate_sync_token(token: str) -> str:
    """Validate printable ASCII bearer token format."""
    if len(token) < 32 or not token.isascii() or any(not char.isprintable() or char.isspace() for char in token):
        raise ValueError("Set HINDSIGHT_SYNC_TOKEN to a relay token of at least 32 printable ASCII characters")
    return token


def validate_schema_name(schema: str) -> str:
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9]{0,62}", schema):
        raise ValueError("Sync requires a standard PostgreSQL schema identifier")
    return schema


def compute_replica_id(relay_url: str, database_url: str, schema: str) -> str:
    """Stable identifier for one local `(relay_url, db, schema)` pairing."""
    return hashlib.sha256("\0".join((relay_url.rstrip("/"), database_url, schema)).encode("utf-8")).hexdigest()


def _atomic_write_private(path: Path, content: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, prefix=".tmp-") as tmp:
        tmp_path = Path(tmp.name)
        try:
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp.close()
            tmp_path.replace(path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        finally:
            tmp.close()
            tmp_path.unlink(missing_ok=True)


def load_device_identity(state_dir: Path, relay_url: str | None = None) -> DeviceIdentity | None:
    """Load the locally saved identity, optionally requiring a matching relay."""
    dev_path = state_dir / "device.json"
    if not dev_path.is_file():
        return None
    identity = DeviceIdentity.model_validate_json(dev_path.read_bytes())
    if relay_url is not None and identity.relay_url.rstrip("/") != relay_url.rstrip("/"):
        return None
    return identity


def save_device_identity(state_dir: Path, identity: DeviceIdentity) -> None:
    """Persist per-device ID and token atomically with restricted file mode."""
    _atomic_write_private(state_dir / "device.json", identity.model_dump_json(indent=2).encode("utf-8"))


class RelayV3Client:
    """Async HTTP client for Hindsight Sync Relay v3 + device management endpoints."""

    def __init__(
        self,
        base_url: str,
        session: aiohttp.ClientSession,
        *,
        token: str,
        device_id: str = "",
        max_bytes: int = DEFAULT_MAX_BLOB_BYTES,
    ) -> None:
        self.base_url = validate_relay_url(base_url)
        self.session = session
        self.token = token
        self.device_id = device_id
        self.max_bytes = max_bytes
        self.upload_bytes = 0
        self.download_bytes = 0

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": HINDSIGHT_USER_AGENT,
        }
        if self.device_id:
            headers["X-Hindsight-Device-Id"] = self.device_id
        if extra:
            headers.update(extra)
        return headers

    async def _check_error(self, resp: aiohttp.ClientResponse) -> None:
        if resp.status == 401:
            raise SyncAuthError("Relay rejected sync credential (401 Unauthorized)", status_code=401)
        if resp.status == 403:
            text = await resp.text()
            raise SyncAuthError(text.strip() or "Device credential revoked (403 Forbidden)", status_code=403)
        if resp.status == 429:
            raise SyncRateLimited(resp.headers.get("Retry-After", ""))
        if resp.status >= 400:
            text = await resp.text()
            raise SyncError(f"Relay returned HTTP {resp.status}: {text.strip()}")

    async def head_status(self) -> RelayStatusInfo:
        async with self.session.head(
            self.base_url + V3_STATUS_PATH, headers=self._headers(), allow_redirects=False
        ) as resp:
            await self._check_error(resp)
            epoch = resp.headers.get("X-Hindsight-Relay-Epoch", "")
            rver = int(resp.headers.get("X-Hindsight-Relay-Version", "0") or 0)
            lseq = int(resp.headers.get("X-Hindsight-Last-Seq", "0") or 0)
            return RelayStatusInfo(
                protocol=3,
                initialized=bool(epoch),
                epoch=epoch,
                relay_version=rver,
                last_seq=lseq,
            )

    async def get_status(self) -> RelayStatusInfo:
        async with self.session.get(
            self.base_url + V3_STATUS_PATH, headers=self._headers(), allow_redirects=False
        ) as resp:
            await self._check_error(resp)
            raw = await resp.read()
            self.download_bytes += len(raw)
            return RelayStatusInfo.model_validate_json(raw)

    async def bootstrap(self, *, device_id: str, client_batch_id: str, items: list[dict[str, Any]]) -> RelayPushResult:
        body = json.dumps(
            {"device_id": device_id, "client_batch_id": client_batch_id, "items": items},
            ensure_ascii=False,
            default=str,
        ).encode("utf-8")
        self.upload_bytes += len(body)
        headers = {"Content-Type": "application/json"}
        async with self.session.post(
            self.base_url + V3_BOOTSTRAP_PATH,
            data=body,
            headers=self._headers(headers),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            raw = await resp.read()
            self.download_bytes += len(raw)
            return RelayPushResult.model_validate_json(raw)

    async def push_changes(
        self,
        *,
        device_id: str,
        client_batch_id: str,
        expected_epoch: str,
        items: list[dict[str, Any]],
    ) -> RelayPushResult:
        body = json.dumps(
            {
                "device_id": device_id,
                "client_batch_id": client_batch_id,
                "expected_epoch": expected_epoch,
                "items": items,
            },
            ensure_ascii=False,
            default=str,
        ).encode("utf-8")
        self.upload_bytes += len(body)
        async with self.session.post(
            self.base_url + V3_CHANGES_PATH,
            data=body,
            headers=self._headers({"Content-Type": "application/json"}),
            allow_redirects=False,
        ) as resp:
            if resp.status == 409:
                raise SyncEpochResetError("Relay epoch changed; baseline resync required")
            await self._check_error(resp)
            raw = await resp.read()
            self.download_bytes += len(raw)
            return RelayPushResult.model_validate_json(raw)

    async def pull_changes(self, *, after_seq: int, limit: int, max_bytes: int, epoch: str) -> RelayPullPage:
        params = {
            "after_seq": str(after_seq),
            "limit": str(limit),
            "max_bytes": str(max_bytes),
            "epoch": epoch,
        }
        async with self.session.get(
            self.base_url + V3_CHANGES_PATH,
            params=params,
            headers=self._headers(),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            raw = await resp.read()
            self.download_bytes += len(raw)
            return RelayPullPage.model_validate_json(raw)

    async def pull_baseline(
        self, *, offset: int = 0, limit: int = 200, epoch: str | None = None, last_seq: int = 0
    ) -> RelayBaselinePage:
        params = {"offset": str(offset), "limit": str(limit)}
        if epoch is not None:
            params.update(epoch=epoch, last_seq=str(last_seq))
        async with self.session.get(
            self.base_url + V3_BASELINE_PATH,
            params=params,
            headers=self._headers(),
            allow_redirects=False,
        ) as resp:
            if resp.status == 409:
                raise SyncError("Relay baseline changed while downloading. Retry from the first page")
            await self._check_error(resp)
            raw = await resp.read()
            self.download_bytes += len(raw)
            return RelayBaselinePage.model_validate_json(raw)

    async def missing_blobs(self, hashes: list[str]) -> list[str]:
        if not hashes:
            return []
        body = json.dumps({"hashes": sorted(set(hashes))}).encode("utf-8")
        self.upload_bytes += len(body)
        async with self.session.post(
            self.base_url + V3_BLOBS_MISSING_PATH,
            data=body,
            headers=self._headers({"Content-Type": "application/json"}),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            raw = await resp.read()
            self.download_bytes += len(raw)
            parsed = json.loads(raw)
            return list(parsed.get("missing") or [])

    async def upload_blob(self, sha256_hex: str, data: bytes) -> None:
        if len(data) > self.max_bytes:
            raise ValueError(f"Blob {sha256_hex} exceeds max sync size {self.max_bytes}")
        actual = hashlib.sha256(data).hexdigest()
        if actual != sha256_hex:
            raise ValueError(f"Local blob {sha256_hex} SHA-256 mismatch: got {actual}")
        self.upload_bytes += len(data)
        async with self.session.put(
            f"{self.base_url}{V3_BLOBS_PREFIX}{sha256_hex}",
            data=data,
            headers=self._headers({"Content-Type": "application/octet-stream"}),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)

    async def download_blob(self, sha256_hex: str) -> bytes:
        async with self.session.get(
            f"{self.base_url}{V3_BLOBS_PREFIX}{sha256_hex}",
            headers=self._headers(),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            data = await resp.read()
        self.download_bytes += len(data)
        if len(data) > self.max_bytes:
            raise ValueError(f"Downloaded blob {sha256_hex} exceeds max sync size")
        actual = hashlib.sha256(data).hexdigest()
        if actual != sha256_hex:
            raise ValueError(f"Downloaded blob {sha256_hex} SHA-256 mismatch: got {actual}")
        return data

    async def register_device(self, *, name: str, device_id: str | None = None) -> RelayDeviceProvisioned:
        payload: dict[str, Any] = {"name": name}
        if device_id:
            payload["device_id"] = device_id
        body = json.dumps(payload).encode("utf-8")
        async with self.session.post(
            self.base_url + V3_DEVICES_PATH,
            data=body,
            headers=self._headers({"Content-Type": "application/json"}),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            return RelayDeviceProvisioned.model_validate_json(await resp.read())

    async def list_devices(self) -> list[RelayDeviceInfo]:
        async with self.session.get(
            self.base_url + V3_DEVICES_PATH, headers=self._headers(), allow_redirects=False
        ) as resp:
            await self._check_error(resp)
            parsed = json.loads(await resp.read())
            return [RelayDeviceInfo.model_validate(item) for item in (parsed.get("devices") or [])]

    async def rotate_device(self, device_id: str) -> RelayDeviceProvisioned:
        async with self.session.post(
            f"{self.base_url}{V3_DEVICES_PATH}/{device_id}/rotate",
            headers=self._headers(),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            return RelayDeviceProvisioned.model_validate_json(await resp.read())

    async def revoke_device(self, device_id: str) -> RelayDeviceInfo:
        async with self.session.post(
            f"{self.base_url}{V3_DEVICES_PATH}/{device_id}/revoke",
            headers=self._headers(),
            allow_redirects=False,
        ) as resp:
            await self._check_error(resp)
            return RelayDeviceInfo.model_validate_json(await resp.read())


class SyncEpochResetError(SyncError):
    """Relay epoch diverged (e.g. cursor expired or relay recreated); rebaseline needed."""


async def ensure_device_identity(
    state_dir: Path,
    relay_url: str,
    admin_or_device_token: str,
    session: aiohttp.ClientSession,
) -> DeviceIdentity:
    """Return persisted ``DeviceIdentity`` or provision/persist one deterministically."""
    normalized_url = validate_relay_url(relay_url)
    existing = load_device_identity(state_dir)
    if existing is not None:
        if existing.relay_url.rstrip("/") == normalized_url:
            return existing
        if existing.managed_relay:
            raise SyncAuthError("The local sync configuration now points to a different relay", status_code=401)
    if not admin_or_device_token:
        raise SyncAuthError("Sign in with hindsight-admin sync-device login before syncing", status_code=401)
    validate_sync_token(admin_or_device_token)

    # Provision a per-device credential when caller has an admin token; otherwise persist
    # the supplied token alongside a fresh stable device_id (for pre-provisioned device tokens).
    dev_id = f"dev-{uuid.uuid4().hex[:12]}"
    host_name = socket.gethostname() or dev_id
    probe_client = RelayV3Client(normalized_url, session, token=admin_or_device_token, device_id=dev_id)
    now = datetime.now(timezone.utc)
    if not admin_or_device_token.startswith("hds_"):
        try:
            provisioned = await probe_client.register_device(name=host_name, device_id=dev_id)
            identity = DeviceIdentity(
                device_id=provisioned.device_id,
                token=provisioned.token,
                name=provisioned.name,
                relay_url=normalized_url,
                per_device_token=True,
                created_at=now,
            )
            save_device_identity(state_dir, identity)
            return identity
        except SyncAuthError as exc:
            if exc.status_code != 403:
                raise
    identity = DeviceIdentity(
        device_id=dev_id,
        token=admin_or_device_token,
        name=host_name,
        relay_url=normalized_url,
        per_device_token=admin_or_device_token.startswith("hds_"),
        created_at=now,
    )
    save_device_identity(state_dir, identity)
    return identity


async def _ensure_blobs_for_items(
    conn: Any,
    client: RelayV3Client,
    items: list[RelayChangeItem],
    *,
    schema: str,
    file_storage: FileStorage | None = None,
) -> tuple[dict[str, tuple[str, bytes]], int]:
    """Download and verify all binary blobs referenced by an incoming change batch."""
    downloaded: dict[str, tuple[str, bytes]] = {}
    count = 0
    for item in items:
        if item.deleted or item.op == "delete" or item.payload is None:
            continue
        for ref in extract_blob_refs(item.payload):
            if ref.sha256 in downloaded:
                continue
            existing = await read_blob_bytes(conn, ref.storage_key, schema=schema, file_storage=file_storage)
            if existing is not None and hashlib.sha256(existing).hexdigest() == ref.sha256:
                continue
            blob_bytes = await client.download_blob(ref.sha256)
            downloaded[ref.sha256] = (ref.storage_key, blob_bytes)
            count += 1
    return downloaded, count


async def _apply_incoming_item(
    conn: Any,
    item: RelayChangeItem,
    *,
    schema: str,
    device_id: str,
    auto_resolve: ConflictSide | None,
    automatic: bool,
    prefer: ConflictSide | None,
    blobs: dict[str, tuple[str, bytes]],
    file_storage: FileStorage | None = None,
    preserve_unit_ids: set[str] | None = None,
) -> tuple[int, int]:
    """Apply one incoming item with causal conflict detection. Returns ``(db_writes, conflicts_created)``."""
    state: SyncObjectStateRecord | None = await get_object_state(
        conn,
        object_type=item.object_type,
        bank_id=item.bank_id,
        object_id=item.object_id,
        schema=schema,
        for_update=True,
    )
    is_remote_delete = item.deleted or item.op == "delete"

    # Self-echo when already cleanly synced at this exact version/hash.
    if (
        state is not None
        and not state.dirty
        and item.origin_device_id == device_id
        and state.base_relay_version >= item.relay_version
    ):
        return 0, 0

    # No-op idempotent state.
    if state is not None and state.deleted == is_remote_delete and state.content_hash == item.content_hash:
        await mark_object_synced(
            conn,
            object_type=item.object_type,
            bank_id=item.bank_id,
            object_id=item.object_id,
            relay_version=item.relay_version,
            content_hash=item.content_hash,
            deleted=is_remote_delete,
            payload=item.payload,
            origin_device_id=item.origin_device_id,
            expected_last_seq=state.last_seq,
            schema=schema,
        )
        return 1, 0

    # Older historical upsert from before a local tombstone must never resurrect deletion.
    if state is not None and state.deleted and not is_remote_delete and item.op != "restore":
        if not state.dirty and item.relay_version <= state.base_relay_version:
            return 0, 0

    # Causal conflict check: both sides diverged from common base!
    local_diverged = state is not None and state.dirty and item.origin_device_id != device_id
    if local_diverged and state is not None:
        decision: ConflictSide | None = prefer if prefer is not None else auto_resolve
        if decision is None:
            raise SyncManualChoiceRequired(
                f"Conflict on {item.object_type} {item.object_id} without auto-resolution; specify --prefer local|remote"
            )
        local_payload = (
            None
            if state.deleted
            else await export_object_payload(
                conn,
                object_type=item.object_type,
                bank_id=item.bank_id,
                object_id=item.object_id,
                schema=schema,
            )
        )
        conflict_rec = await insert_sync_conflict(
            conn,
            object_type=item.object_type,
            bank_id=item.bank_id,
            object_id=item.object_id,
            resolution=decision,
            automatic=automatic and prefer is None,
            base_version=state.base_relay_version,
            local_version=state.version,
            remote_version=item.relay_version,
            local_device_id=state.origin_device_id or device_id,
            remote_device_id=item.origin_device_id or "remote",
            local_content_hash=state.content_hash,
            remote_content_hash=item.content_hash,
            local_payload=local_payload,
            remote_payload=None if is_remote_delete else item.payload,
            schema=schema,
        )

        if decision == "remote":
            await _write_item_to_db(
                conn, item, schema=schema, blobs=blobs, file_storage=file_storage, preserve_unit_ids=preserve_unit_ids
            )
            await mark_object_synced(
                conn,
                object_type=item.object_type,
                bank_id=item.bank_id,
                object_id=item.object_id,
                relay_version=item.relay_version,
                content_hash=item.content_hash,
                deleted=is_remote_delete,
                payload=None if is_remote_delete else item.payload,
                origin_device_id=item.origin_device_id,
                expected_last_seq=state.last_seq,
                schema=schema,
            )
            await mark_sync_conflict_applied(conn, conflict_rec.id, applied_version=item.relay_version, schema=schema)
            return 2, 1
        else:
            # Local wins: rebase local change onto remote's version so next push cleanly advances relay!
            state_tbl = fq_table_explicit("sync_object_state", schema)
            await conn.execute(
                f"""
                UPDATE {state_tbl}
                SET base_relay_version = $4, updated_at = now()
                WHERE object_type = $1 AND bank_id = $2 AND object_id = $3
                """,
                item.object_type,
                item.bank_id,
                item.object_id,
                item.relay_version,
            )
            rebased = await record_sync_change(
                conn,
                object_type=item.object_type,
                bank_id=item.bank_id,
                object_id=item.object_id,
                op="delete" if state.deleted else "upsert",
                payload=local_payload,
                origin_device_id=device_id,
                schema=schema,
            )
            await mark_sync_conflict_applied(
                conn, conflict_rec.id, applied_version=rebased.version if rebased else state.version, schema=schema
            )
            return 1, 1

    # Non-conflicting apply.
    await _write_item_to_db(
        conn, item, schema=schema, blobs=blobs, file_storage=file_storage, preserve_unit_ids=preserve_unit_ids
    )
    await mark_object_synced(
        conn,
        object_type=item.object_type,
        bank_id=item.bank_id,
        object_id=item.object_id,
        relay_version=item.relay_version,
        content_hash=item.content_hash,
        deleted=is_remote_delete,
        payload=None if is_remote_delete else item.payload,
        origin_device_id=item.origin_device_id,
        expected_last_seq=state.last_seq if state is not None else None,
        schema=schema,
    )
    return 1, 0


_ENTITY_INDEX_OBJECT_TYPES = frozenset({"document", "memory_unit", "observation"})


async def _rebuild_entity_indexes(conn: Any, *, schema: str | None, bank_ids: set[str]) -> None:
    """One derived-index rebuild per bank per apply batch, never per object."""
    from ..schema_context import get_current_schema
    from .memories import sql_memories

    for bank_id in sorted(bank_ids):
        await sql_memories().sync_rebuild_entity_indexes(
            conn=conn, schema=schema or get_current_schema(), bank_id=bank_id
        )


async def _write_item_to_db(
    conn: Any,
    item: RelayChangeItem,
    *,
    schema: str,
    blobs: dict[str, tuple[str, bytes]],
    file_storage: FileStorage | None = None,
    preserve_unit_ids: set[str] | None = None,
) -> None:
    if item.deleted or item.op == "delete" or item.payload is None:
        await delete_object_payload(
            conn,
            object_type=item.object_type,
            bank_id=item.bank_id,
            object_id=item.object_id,
            schema=schema,
            preserve_unit_ids=preserve_unit_ids,
        )
        return
    for ref in extract_blob_refs(item.payload):
        if ref.sha256 in blobs:
            key, data = blobs[ref.sha256]
            await write_blob_bytes(
                conn, key, data, expected_sha256=ref.sha256, schema=schema, file_storage=file_storage
            )
    await apply_object_payload(
        conn,
        object_type=item.object_type,
        bank_id=item.bank_id,
        object_id=item.object_id,
        payload=item.payload,
        schema=schema,
    )


async def _ensure_local_objects_indexed(conn: Any, *, schema: str, origin_device_id: str) -> int:
    """Ensure every live object in PostgreSQL has a baseline entry in ``sync_object_state``/``sync_change_log``.

    Needed on first upgrade from pre-v3 databases whose rows predate sync triggers.
    """
    keys = await list_all_object_keys(conn, schema=schema)
    state_tbl = fq_table_explicit("sync_object_state", schema)
    existing_rows = await conn.fetch(f"SELECT object_type, bank_id, object_id FROM {state_tbl}")
    existing = {(r["object_type"], r["bank_id"], r["object_id"]) for r in existing_rows}
    created = 0
    for key in keys:
        if (key.object_type, key.bank_id, key.object_id) in existing:
            continue
        payload = await export_object_payload(
            conn,
            object_type=key.object_type,
            bank_id=key.bank_id,
            object_id=key.object_id,
            schema=schema,
        )
        if payload is None:
            continue
        await record_sync_change(
            conn,
            object_type=key.object_type,
            bank_id=key.bank_id,
            object_id=key.object_id,
            op="upsert",
            payload=payload,
            origin_device_id=origin_device_id,
            schema=schema,
        )
        created += 1
    return created


async def synchronize_v3(
    *,
    database_url: str,
    schema: str,
    relay_url: str,
    token: str,
    state_dir: Path,
    prefer: ConflictSide | None = None,
    auto_resolve: bool = True,
    automatic: bool = False,
    check_only: bool = False,
    batch_max_items: int = DEFAULT_BATCH_MAX_ITEMS,
    batch_max_bytes: int = DEFAULT_BATCH_MAX_BYTES,
    max_snapshot_bytes: int = DEFAULT_MAX_BLOB_BYTES,
    file_storage: FileStorage | None = None,
    pool: Any = None,
    process_lock: asyncio.Lock | None = None,
) -> SyncExchangeResult:
    """Execute one object-level v3 synchronization check and incremental exchange.

    Shared by both ``hindsight-admin sync`` CLI and the 15s daemon auto-sync loop.
    Never scans the full database or transfers memory bodies on unchanged ticks.
    """
    relay_url = validate_relay_url(relay_url)
    schema = validate_schema_name(schema)
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    async def _run_locked() -> SyncExchangeResult:
        with FileLock(str(state_dir / "client.lock"), timeout=0):
            return await _synchronize_v3_inner(
                database_url=database_url,
                schema=schema,
                relay_url=relay_url,
                token=token,
                state_dir=state_dir,
                prefer=prefer,
                auto_resolve=auto_resolve,
                automatic=automatic,
                check_only=check_only,
                batch_max_items=batch_max_items,
                batch_max_bytes=batch_max_bytes,
                max_snapshot_bytes=max_snapshot_bytes,
                file_storage=file_storage,
                pool=pool,
            )

    if process_lock is not None:
        async with process_lock:
            return await _run_locked()
    return await _run_locked()


async def _bootstrap_seed(
    conn: Any, client: RelayV3Client, schema: str, file_storage: FileStorage | None
) -> list[dict[str, Any]]:
    entries = await fetch_pending_changes(conn, after_seq=0, limit=1, schema=schema)
    if not entries:
        return []
    entry = entries[0]
    payload = entry.payload
    if payload is None and entry.op != "delete":
        payload = await export_object_payload(
            conn, object_type=entry.object_type, bank_id=entry.bank_id, object_id=entry.object_id, schema=schema
        )
    if payload is not None:
        refs = extract_blob_refs(payload)
        missing = set(await client.missing_blobs([ref.sha256 for ref in refs]))
        for ref in refs:
            if ref.sha256 not in missing:
                continue
            data = await read_blob_bytes(conn, ref.storage_key, schema=schema, file_storage=file_storage)
            if data is None:
                raise SyncError(f"Missing local sync blob: {ref.storage_key}")
            await client.upload_blob(ref.sha256, data)
            missing.discard(ref.sha256)
    return [
        {
            "client_seq": entry.seq,
            "object_type": entry.object_type,
            "bank_id": entry.bank_id,
            "object_id": entry.object_id,
            "op": entry.op,
            "local_version": entry.version,
            "base_relay_version": 0,
            "content_hash": compute_content_hash(payload, deleted=entry.op == "delete"),
            "payload": payload,
        }
    ]


async def _synchronize_v3_inner(
    *,
    database_url: str,
    schema: str,
    relay_url: str,
    token: str,
    state_dir: Path,
    prefer: ConflictSide | None,
    auto_resolve: bool,
    automatic: bool,
    check_only: bool,
    batch_max_items: int,
    batch_max_bytes: int,
    max_snapshot_bytes: int,
    file_storage: FileStorage | None,
    pool: Any,
) -> SyncExchangeResult:
    from ..pg0 import resolve_database_url

    db_url = await resolve_database_url(database_url)
    replica_id = compute_replica_id(relay_url, db_url, schema)
    auto_side: ConflictSide | None = "remote" if auto_resolve else None
    pushed_count = 0
    pulled_count = 0
    conflicts_created = 0
    blobs_uploaded = 0
    blobs_downloaded = 0
    scanned = 0
    db_writes = 0
    now = datetime.now(timezone.utc)

    async with aiohttp.ClientSession(timeout=per_phase_timeout(60, connect=10)) as session:
        identity = await ensure_device_identity(state_dir, relay_url, token, session)
        client = RelayV3Client(
            relay_url,
            session,
            token=identity.token,
            device_id=identity.device_id,
            max_bytes=max_snapshot_bytes,
        )

        # Acquire DB connection / pool helper
        import asyncpg

        conn = None
        pool_cm = None
        if pool is not None:
            pool_cm = acquire_with_retry(pool)
            conn = await pool_cm.__aenter__()
        else:
            conn = await asyncpg.connect(db_url)

        try:
            cursor = await get_sync_cursor(conn, replica_id, schema=schema)
            local_hwm = await get_local_high_water(conn, schema=schema)
            try:
                head = await client.head_status()
            except SyncAuthError as exc:
                auth_state = "revoked" if exc.status_code == 403 else "unauthorized"
                if cursor is not None:
                    await upsert_sync_cursor(
                        conn,
                        cursor.model_copy(
                            update={"auth_status": auth_state, "last_error": str(exc), "updated_at": now}
                        ),
                        schema=schema,
                    )
                return SyncExchangeResult(
                    status="auth_error",
                    message=str(exc),
                    device_id=identity.device_id,
                    auth_status=auth_state,
                    out_seq=cursor.out_seq if cursor else 0,
                    in_seq=cursor.in_seq if cursor else 0,
                )

            # Fast O(1) short-circuit when relay epoch/seq and local HWM are unchanged.
            if (
                cursor is not None
                and cursor.joined
                and cursor.relay_epoch == head.epoch
                and head.last_seq <= cursor.in_seq
                and local_hwm <= cursor.out_seq
                and prefer is None
            ):
                if cursor.auth_status != "ok" or cursor.last_error is not None:
                    await upsert_sync_cursor(
                        conn,
                        cursor.model_copy(update={"auth_status": "ok", "last_error": None, "updated_at": now}),
                        schema=schema,
                    )
                return SyncExchangeResult(
                    status="idle",
                    message="Already synchronized",
                    device_id=identity.device_id,
                    relay_version=head.relay_version,
                    last_seq=head.last_seq,
                    out_seq=cursor.out_seq,
                    in_seq=cursor.in_seq,
                    upload_bytes=client.upload_bytes,
                    download_bytes=client.download_bytes,
                )

            if check_only:
                return SyncExchangeResult(
                    status="idle",
                    message="Changes pending",
                    device_id=identity.device_id,
                    relay_version=head.relay_version,
                    last_seq=head.last_seq,
                    out_seq=cursor.out_seq if cursor else 0,
                    in_seq=cursor.in_seq if cursor else 0,
                    upload_bytes=client.upload_bytes,
                    download_bytes=client.download_bytes,
                )

            initializing = False
            if not head.initialized:
                async with conn.transaction():
                    await mark_sync_tx_managed(conn)
                    scanned += await _ensure_local_objects_indexed(
                        conn, schema=schema, origin_device_id=identity.device_id
                    )
                # Publish a seed with the epoch so another device cannot join
                # a transient empty baseline while the rest is being uploaded.
                seed = await _bootstrap_seed(conn, client, schema, file_storage)
                batch_id = hashlib.sha256(f"boot:{identity.device_id}".encode()).hexdigest()[:32]
                boot = await client.bootstrap(device_id=identity.device_id, client_batch_id=batch_id, items=seed)
                if not boot.initialized_by_self:
                    raise SyncError("Another device initialized the relay. Retry sync to join its baseline")
                async with conn.transaction():
                    cursor = await upsert_sync_cursor(
                        conn,
                        SyncCursorRecord(
                            replica_id=replica_id,
                            relay_url=relay_url,
                            schema_name=schema,
                            device_id=identity.device_id,
                            relay_epoch=boot.epoch,
                            in_seq=boot.last_seq,
                            out_seq=0,
                            joined=True,
                            updated_at=now,
                        ),
                        schema=schema,
                    )
                    for accepted in boot.accepted:
                        await mark_object_synced(
                            conn,
                            object_type=accepted.object_type,
                            bank_id=accepted.bank_id,
                            object_id=accepted.object_id,
                            relay_version=accepted.relay_version,
                            content_hash=accepted.content_hash,
                            deleted=accepted.deleted,
                            payload=None,
                            origin_device_id=identity.device_id,
                            expected_last_seq=accepted.client_seq,
                            schema=schema,
                        )
                        pushed_count += 1
                head = RelayStatusInfo(
                    initialized=True, epoch=boot.epoch, last_seq=boot.last_seq, relay_version=boot.relay_version
                )
                initializing = True

            # Check initial manual choice guard when an unjoined device already holds local objects.
            if cursor is None or not cursor.joined:
                local_keys = await list_all_object_keys(conn, schema=schema)
                if local_keys and head.last_seq > 0 and automatic and prefer is None:
                    msg = (
                        "Automatic initial sync paused: both this replica and the relay contain existing "
                        "data. Run 'hindsight-admin sync --prefer local|remote' once to join safely."
                    )
                    await upsert_sync_cursor(
                        conn,
                        SyncCursorRecord(
                            replica_id=replica_id,
                            relay_url=relay_url,
                            schema_name=schema,
                            device_id=identity.device_id,
                            relay_epoch=head.epoch,
                            out_seq=0,
                            in_seq=0,
                            joined=False,
                            auth_status="needs_prefer",
                            last_error=msg,
                            updated_at=now,
                        ),
                        schema=schema,
                    )
                    return SyncExchangeResult(
                        status="needs_prefer",
                        message=msg,
                        device_id=identity.device_id,
                        relay_version=head.relay_version,
                        last_seq=head.last_seq,
                        auth_status="needs_prefer",
                        local_objects_scanned=len(local_keys),
                        upload_bytes=client.upload_bytes,
                        download_bytes=client.download_bytes,
                    )
                if cursor is None:
                    async with conn.transaction():
                        await mark_sync_tx_managed(conn)
                        scanned += await _ensure_local_objects_indexed(
                            conn, schema=schema, origin_device_id=identity.device_id
                        )
                    cursor = SyncCursorRecord(
                        replica_id=replica_id,
                        relay_url=relay_url,
                        schema_name=schema,
                        device_id=identity.device_id,
                        relay_epoch=head.epoch,
                        out_seq=0,
                        in_seq=0,
                        joined=prefer is not None or len(local_keys) == 0,
                        auth_status="ok",
                        updated_at=now,
                    )
                    if not cursor.joined and local_keys and head.last_seq > 0:
                        raise SyncManualChoiceRequired(
                            "Both local library and relay have independent objects; pass --prefer local or --prefer remote"
                        )

            # Defer applying remote writes while active background async operations are running.
            if head.last_seq > cursor.in_seq and await has_active_async_operations(conn, schema=schema):
                return SyncExchangeResult(
                    status="deferred",
                    message="Deferred remote apply until active async operations finish",
                    device_id=identity.device_id,
                    relay_version=head.relay_version,
                    last_seq=head.last_seq,
                    out_seq=cursor.out_seq,
                    in_seq=cursor.in_seq,
                    upload_bytes=client.upload_bytes,
                    download_bytes=client.download_bytes,
                )

            # 1. Pull remote changes incrementally (or rebaseline if cursor expired / epoch changed).
            while cursor.in_seq < head.last_seq or cursor.relay_epoch != head.epoch:
                pull_page = await client.pull_changes(
                    after_seq=cursor.in_seq,
                    limit=batch_max_items,
                    max_bytes=batch_max_bytes,
                    epoch=cursor.relay_epoch,
                )
                if pull_page.reset_required or (cursor.relay_epoch and pull_page.epoch != cursor.relay_epoch):
                    p_cnt, c_cnt, dl_blobs, w_cnt, new_seq = await _apply_rebaseline(
                        conn,
                        client,
                        schema=schema,
                        device_id=identity.device_id,
                        auto_resolve=auto_side,
                        automatic=automatic,
                        prefer=prefer,
                        batch_max_items=batch_max_items,
                        file_storage=file_storage,
                    )
                    pulled_count += p_cnt
                    conflicts_created += c_cnt
                    blobs_downloaded += dl_blobs
                    db_writes += w_cnt
                    cursor = cursor.model_copy(
                        update={
                            "relay_epoch": pull_page.epoch,
                            "in_seq": new_seq,
                            "joined": True,
                            "updated_at": datetime.now(timezone.utc),
                        }
                    )
                    await upsert_sync_cursor(conn, cursor, schema=schema)
                    head = await client.head_status()
                    break

                if not pull_page.changes:
                    cursor = cursor.model_copy(
                        update={
                            "relay_epoch": pull_page.epoch,
                            "in_seq": pull_page.next_seq,
                            "joined": True,
                            "updated_at": datetime.now(timezone.utc),
                        }
                    )
                    await upsert_sync_cursor(conn, cursor, schema=schema)
                    if not pull_page.has_more:
                        break
                    continue

                blobs, dl_blobs = await _ensure_blobs_for_items(
                    conn, client, pull_page.changes, schema=schema, file_storage=file_storage
                )
                blobs_downloaded += dl_blobs
                ordered = order_changes_for_apply(pull_page.changes)

                async with conn.transaction():
                    await mark_sync_applying(conn)
                    surviving_unit_ids = {
                        it.object_id
                        for it in ordered
                        if it.object_type == "memory_unit" and not (it.deleted or it.op == "delete")
                    }
                    entity_banks: set[str] = set()
                    for item in ordered:
                        w_cnt, c_cnt = await _apply_incoming_item(
                            conn,
                            item,
                            schema=schema,
                            device_id=identity.device_id,
                            auto_resolve=auto_side,
                            automatic=automatic,
                            prefer=prefer,
                            blobs=blobs,
                            file_storage=file_storage,
                            preserve_unit_ids=surviving_unit_ids,
                        )
                        db_writes += w_cnt
                        conflicts_created += c_cnt
                        pulled_count += 1
                        if w_cnt and item.object_type in _ENTITY_INDEX_OBJECT_TYPES:
                            entity_banks.add(item.bank_id)
                    await _rebuild_entity_indexes(conn, schema=schema, bank_ids=entity_banks)
                    cursor = cursor.model_copy(
                        update={
                            "relay_epoch": pull_page.epoch,
                            "in_seq": pull_page.next_seq,
                            "joined": True,
                            "auth_status": "ok",
                            "last_error": None,
                            "updated_at": datetime.now(timezone.utc),
                        }
                    )
                    await upsert_sync_cursor(conn, cursor, schema=schema)

                head = await client.head_status()
                if not pull_page.has_more:
                    break

            # 2. Push remaining local dirty changes in bounded batches.
            local_hwm = await get_local_high_water(conn, schema=schema)
            if local_hwm > cursor.out_seq:
                pending = await fetch_pending_changes(conn, after_seq=cursor.out_seq, limit=10000, schema=schema)
                # Keep the latest change per object in order.
                coalesced: dict[tuple[str, str, str], SyncChangeEntry] = {}
                highest_seen_seq = cursor.out_seq
                for entry in pending:
                    coalesced[(entry.object_type, entry.bank_id, entry.object_id)] = entry
                    highest_seen_seq = max(highest_seen_seq, entry.seq)

                push_candidates: list[tuple[SyncChangeEntry, dict[str, Any] | None, int]] = []
                for entry in coalesced.values():
                    st = await get_object_state(
                        conn,
                        object_type=entry.object_type,
                        bank_id=entry.bank_id,
                        object_id=entry.object_id,
                        schema=schema,
                    )
                    if st is None or not st.dirty or st.last_seq != entry.seq:
                        continue
                    payload = entry.payload
                    if payload is None and not st.deleted:
                        payload = await export_object_payload(
                            conn,
                            object_type=entry.object_type,
                            bank_id=entry.bank_id,
                            object_id=entry.object_id,
                            schema=schema,
                        )
                    chash = compute_content_hash(payload, deleted=st.deleted)
                    serialized_size = len(json.dumps(payload, default=str).encode("utf-8")) if payload else 64
                    wire = {
                        "client_seq": st.last_seq,
                        "object_type": entry.object_type,
                        "bank_id": entry.bank_id,
                        "object_id": entry.object_id,
                        "op": "delete" if st.deleted else entry.op,
                        "local_version": st.version,
                        "base_relay_version": st.base_relay_version,
                        "content_hash": chash,
                        "payload": payload if not st.deleted else None,
                    }
                    push_candidates.append((entry, wire, serialized_size))

                if not push_candidates:
                    cursor = await upsert_sync_cursor(
                        conn,
                        cursor.model_copy(
                            update={
                                "out_seq": max(cursor.out_seq, highest_seen_seq),
                                "last_synced_at": datetime.now(timezone.utc),
                                "auth_status": "ok",
                                "last_error": None,
                                "updated_at": datetime.now(timezone.utc),
                            }
                        ),
                        schema=schema,
                    )
                else:
                    # Split into byte- and count-bounded batches.
                    batches: list[list[tuple[SyncChangeEntry, dict[str, Any]]]] = []
                    cur_batch: list[tuple[SyncChangeEntry, dict[str, Any]]] = []
                    cur_bytes = 0
                    for entry, wire, size in push_candidates:
                        assert wire is not None
                        if cur_batch and (len(cur_batch) >= batch_max_items or cur_bytes + size > batch_max_bytes):
                            batches.append(cur_batch)
                            cur_batch = []
                            cur_bytes = 0
                        cur_batch.append((entry, wire))
                        cur_bytes += size
                    if cur_batch:
                        batches.append(cur_batch)

                    for batch in batches:
                        blob_refs: list[tuple[str, str]] = []
                        for _, wire in batch:
                            for ref in extract_blob_refs(wire.get("payload")):
                                blob_refs.append((ref.sha256, ref.storage_key))
                        if blob_refs:
                            missing_hashes = set(await client.missing_blobs([sha for sha, _ in blob_refs]))
                            for sha, skey in blob_refs:
                                if sha not in missing_hashes:
                                    continue
                                raw = await read_blob_bytes(conn, skey, schema=schema, file_storage=file_storage)
                                if raw is not None:
                                    await client.upload_blob(sha, raw)
                                    missing_hashes.discard(sha)
                                    blobs_uploaded += 1

                        wire_items = [w for _, w in batch]
                        seq_span = ":".join(str(w["client_seq"]) for w in wire_items)
                        batch_id = hashlib.sha256(f"{identity.device_id}:{seq_span}".encode()).hexdigest()[:32]
                        push_res = await client.push_changes(
                            device_id=identity.device_id,
                            client_batch_id=batch_id,
                            expected_epoch=cursor.relay_epoch or head.epoch,
                            items=wire_items,
                        )
                        async with conn.transaction():
                            await mark_sync_applying(conn)
                            for acc in push_res.accepted:
                                await mark_object_synced(
                                    conn,
                                    object_type=acc.object_type,
                                    bank_id=acc.bank_id,
                                    object_id=acc.object_id,
                                    relay_version=acc.relay_version,
                                    content_hash=acc.content_hash,
                                    deleted=acc.deleted,
                                    payload=None,
                                    origin_device_id=identity.device_id,
                                    expected_last_seq=acc.client_seq,
                                    schema=schema,
                                )
                                pushed_count += 1
                                db_writes += 1
                            # Any race conflict detected at push time resolves through the exact same
                            # SyncObjectConflictRecord flow.
                            entity_banks = set()
                            for conf in push_res.conflicts:
                                remote_equiv = RelayChangeItem(
                                    seq=conf.relay_seq,
                                    object_type=conf.object_type,
                                    bank_id=conf.bank_id,
                                    object_id=conf.object_id,
                                    op=conf.relay_op,
                                    relay_version=conf.relay_version,
                                    content_hash=conf.relay_content_hash,
                                    deleted=conf.relay_deleted,
                                    payload=conf.relay_payload,
                                    origin_device_id=conf.relay_device_id,
                                )
                                blobs, dl_b = await _ensure_blobs_for_items(
                                    conn, client, [remote_equiv], schema=schema, file_storage=file_storage
                                )
                                blobs_downloaded += dl_b
                                w_c, c_c = await _apply_incoming_item(
                                    conn,
                                    remote_equiv,
                                    schema=schema,
                                    device_id=identity.device_id,
                                    auto_resolve=auto_side,
                                    automatic=automatic,
                                    prefer=prefer,
                                    blobs=blobs,
                                    file_storage=file_storage,
                                )
                                db_writes += w_c
                                conflicts_created += c_c
                                if w_c and remote_equiv.object_type in _ENTITY_INDEX_OBJECT_TYPES:
                                    entity_banks.add(remote_equiv.bank_id)
                            await _rebuild_entity_indexes(conn, schema=schema, bank_ids=entity_banks)

                            # Advance in_seq only if no concurrent foreign edits sit below last_seq.
                            next_in_seq = (
                                push_res.last_seq
                                if push_res.last_seq == cursor.in_seq + len(push_res.accepted)
                                else cursor.in_seq
                            )
                            cursor = await upsert_sync_cursor(
                                conn,
                                cursor.model_copy(
                                    update={
                                        "relay_epoch": push_res.epoch,
                                        "in_seq": next_in_seq,
                                        "joined": True,
                                        "last_synced_at": datetime.now(timezone.utc),
                                        "auth_status": "ok",
                                        "last_error": None,
                                        "updated_at": datetime.now(timezone.utc),
                                    }
                                ),
                                schema=schema,
                            )
                        head = RelayStatusInfo(
                            protocol=3,
                            initialized=True,
                            epoch=push_res.epoch,
                            relay_version=push_res.relay_version,
                            last_seq=push_res.last_seq,
                        )

                    cursor = await upsert_sync_cursor(
                        conn, cursor.model_copy(update={"out_seq": highest_seen_seq}), schema=schema
                    )

            cursor = await upsert_sync_cursor(
                conn,
                cursor.model_copy(
                    update={
                        "joined": True,
                        "last_synced_at": datetime.now(timezone.utc),
                        "auth_status": "ok",
                        "last_error": None,
                        "updated_at": datetime.now(timezone.utc),
                    }
                ),
                schema=schema,
            )
            return SyncExchangeResult(
                status="synced" if (initializing or pushed_count or pulled_count or conflicts_created) else "idle",
                message=(
                    f"Synchronized: pushed {pushed_count}, pulled {pulled_count}, conflicts {conflicts_created}"
                    if (pushed_count or pulled_count or conflicts_created)
                    else "Already synchronized"
                ),
                device_id=identity.device_id,
                relay_version=head.relay_version,
                last_seq=head.last_seq,
                out_seq=cursor.out_seq,
                in_seq=cursor.in_seq,
                pushed_count=pushed_count,
                pulled_count=pulled_count,
                conflicts_created=conflicts_created,
                blobs_uploaded=blobs_uploaded,
                blobs_downloaded=blobs_downloaded,
                upload_bytes=client.upload_bytes,
                download_bytes=client.download_bytes,
                local_objects_scanned=scanned,
                db_writes=db_writes,
            )
        finally:
            if pool_cm is not None:
                await pool_cm.__aexit__(None, None, None)
            elif conn is not None:
                await conn.close()


async def _apply_rebaseline(
    conn: Any,
    client: RelayV3Client,
    *,
    schema: str,
    device_id: str,
    auto_resolve: ConflictSide | None,
    automatic: bool,
    prefer: ConflictSide | None,
    batch_max_items: int,
    file_storage: FileStorage | None,
) -> tuple[int, int, int, int, int]:
    """Rebuild checkpoint cleanly from ``GET /v3/baseline`` when cursor expires or epoch changes."""
    all_items: list[RelayChangeItem] = []
    offset = 0
    last_seq = 0
    epoch = None
    while True:
        page = await client.pull_baseline(offset=offset, limit=batch_max_items, epoch=epoch, last_seq=last_seq)
        if epoch is not None and (page.epoch != epoch or page.last_seq != last_seq):
            raise SyncError("Relay baseline changed while downloading. Retry from the first page")
        all_items.extend(page.items)
        epoch = page.epoch
        last_seq = page.last_seq
        offset += len(page.items)
        if offset >= page.total or not page.items:
            break

    blobs, dl_blobs = await _ensure_blobs_for_items(conn, client, all_items, schema=schema, file_storage=file_storage)
    ordered = order_changes_for_apply(all_items)
    pulled = 0
    conflicts = 0
    writes = 0
    async with conn.transaction():
        await mark_sync_applying(conn)
        entity_banks: set[str] = set()
        for item in ordered:
            w_c, c_c = await _apply_incoming_item(
                conn,
                item,
                schema=schema,
                device_id=device_id,
                auto_resolve=auto_resolve,
                automatic=automatic,
                prefer=prefer,
                blobs=blobs,
                file_storage=file_storage,
            )
            writes += w_c
            conflicts += c_c
            pulled += 1
            if w_c and item.object_type in _ENTITY_INDEX_OBJECT_TYPES:
                entity_banks.add(item.bank_id)
        await _rebuild_entity_indexes(conn, schema=schema, bank_ids=entity_banks)
    return pulled, conflicts, dl_blobs, writes, last_seq


async def restore_sync_conflict_object(
    conn: Any,
    *,
    conflict_id: str,
    side: ConflictSide,
    expected_version: int,
    note: str | None = None,
    by: str | None = None,
    device_id: str | None = None,
    schema: str | None = None,
) -> SyncObjectConflictRecord:
    """Restore one side of a recorded object conflict, checking ``expected_version`` to prevent lost edits.

    Applies the chosen side inside the transaction and emits a new change-log entry so
    all other replicas receive the restoration on the next sync cycle.
    """
    async with conn.transaction():
        conflict = await get_sync_conflict(conn, conflict_id, schema=schema)
        if conflict is None:
            raise ValueError(f"Sync conflict {conflict_id!r} was not found")

        state = await get_object_state(
            conn,
            object_type=conflict.object_type,
            bank_id=conflict.bank_id,
            object_id=conflict.object_id,
            schema=schema,
            for_update=True,
        )
        current_version = state.version if state is not None else 0
        if current_version != expected_version:
            raise SyncVersionConflictError(
                f"Cannot restore conflict {conflict_id}: object version is {current_version}, "
                f"expected {expected_version} (newer edits exist)"
            )

        chosen_payload = conflict.local_payload if side == "local" else conflict.remote_payload
        await mark_sync_tx_managed(conn)
        if chosen_payload is None:
            await delete_object_payload(
                conn,
                object_type=conflict.object_type,
                bank_id=conflict.bank_id,
                object_id=conflict.object_id,
                schema=schema,
            )
            recorded = await record_sync_change(
                conn,
                object_type=conflict.object_type,
                bank_id=conflict.bank_id,
                object_id=conflict.object_id,
                op="delete",
                payload=None,
                origin_device_id=device_id,
                schema=schema,
            )
        else:
            await apply_object_payload(
                conn,
                object_type=conflict.object_type,
                bank_id=conflict.bank_id,
                object_id=conflict.object_id,
                payload=chosen_payload,
                schema=schema,
            )
            op_kind: Literal["upsert", "restore"] = "restore" if (state and state.deleted) else "upsert"
            recorded = await record_sync_change(
                conn,
                object_type=conflict.object_type,
                bank_id=conflict.bank_id,
                object_id=conflict.object_id,
                op=op_kind,
                payload=chosen_payload,
                origin_device_id=device_id,
                schema=schema,
            )

        if conflict.object_type in _ENTITY_INDEX_OBJECT_TYPES:
            await _rebuild_entity_indexes(conn, schema=schema, bank_ids={conflict.bank_id})
        restored_ver = recorded.version if recorded is not None else current_version + 1
        updated = await mark_sync_conflict_restored(
            conn,
            conflict_id,
            side=side,
            restored_version=restored_ver,
            note=note,
            by=by,
            schema=schema,
        )
        assert updated is not None
        return updated


__all__ = [
    "DEFAULT_BATCH_MAX_BYTES",
    "DEFAULT_BATCH_MAX_ITEMS",
    "DEFAULT_MAX_BLOB_BYTES",
    "DeviceIdentity",
    "RelayBaselinePage",
    "RelayChangeItem",
    "RelayDeviceInfo",
    "RelayDeviceProvisioned",
    "RelayPullPage",
    "RelayPushConflict",
    "RelayPushResult",
    "RelayStatusInfo",
    "RelayV3Client",
    "SyncAuthError",
    "SyncEpochResetError",
    "SyncError",
    "SyncExchangeResult",
    "SyncManualChoiceRequired",
    "SyncVersionConflictError",
    "compute_replica_id",
    "ensure_device_identity",
    "load_device_identity",
    "restore_sync_conflict_object",
    "save_device_identity",
    "synchronize_v3",
    "validate_relay_url",
    "validate_schema_name",
    "validate_sync_token",
]
