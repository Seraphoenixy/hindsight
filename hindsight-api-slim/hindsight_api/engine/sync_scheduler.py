"""Automatic background sync scheduler and concurrency coordinator."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel

from .sync_journal import ConflictSide, SyncCursorRecord, get_local_high_water, get_sync_cursor
from .sync_service import (
    DEFAULT_BATCH_MAX_BYTES,
    DEFAULT_BATCH_MAX_ITEMS,
    DEFAULT_MAX_BLOB_BYTES,
    DeviceIdentity,
    SyncAuthError,
    SyncExchangeResult,
    SyncRateLimited,
    compute_replica_id,
    load_device_identity,
    synchronize_v3,
    validate_relay_url,
)

if TYPE_CHECKING:
    from .memory_engine import MemoryEngine

logger = logging.getLogger(__name__)


class SyncStatusSnapshot(BaseModel):
    """Current synchronization state exposed to CLI and Control Plane."""

    configured: bool
    auto_enabled: bool
    running: bool
    syncing: bool
    interval_seconds: float
    relay_url: str | None = None
    device_id: str | None = None
    auth_status: str = "unconfigured"
    out_seq: int = 0
    in_seq: int = 0
    local_high_water: int = 0
    relay_version: int = 0
    joined: bool = False
    last_error: str | None = None
    last_checked_at: datetime | None = None
    last_synced_at: datetime | None = None
    last_status: str | None = None
    last_message: str | None = None


def default_sync_state_dir() -> Path:
    xdg = Path(
        (Path.home() / ".local" / "share") if not (env := __import__("os").environ.get("XDG_DATA_HOME")) else Path(env)
    )
    return xdg / "hindsight-sync-client"


class SyncScheduler:
    """Lifecycle-managed periodic + event-triggered object sync coordinator."""

    def __init__(
        self,
        *,
        memory: MemoryEngine,
        relay_url: str,
        token: str,
        state_dir: Path,
        schema: str,
        interval_seconds: float = 15.0,
        auto_enabled: bool = True,
        auto_resolve: bool = True,
        batch_max_items: int = DEFAULT_BATCH_MAX_ITEMS,
        batch_max_bytes: int = DEFAULT_BATCH_MAX_BYTES,
        max_snapshot_bytes: int = DEFAULT_MAX_BLOB_BYTES,
    ) -> None:
        self._memory = memory
        self._fallback_relay_url = relay_url.rstrip("/")
        self._fallback_token = token
        self._relay_url = self._fallback_relay_url
        self._state_dir = state_dir
        self._schema = schema
        self._interval_seconds = max(1.0, float(interval_seconds))
        self._auto_enabled = auto_enabled
        self._auto_resolve = auto_resolve
        self._batch_max_items = batch_max_items
        self._batch_max_bytes = batch_max_bytes
        self._max_snapshot_bytes = max_snapshot_bytes

        self._lock = asyncio.Lock()
        self._wakeup = asyncio.Event()
        self._stop_requested = False
        self._dirty_hint = False
        self._syncing = False
        self._task: asyncio.Task[None] | None = None

        self._last_result: SyncExchangeResult | None = None
        self._last_error: str | None = None
        self._last_checked_at: datetime | None = None
        self._auth_status: str = "ok" if self._relay_url else "unconfigured"
        self._auth_failed_token: str | None = None
        self._retry_at = 0.0

        self._refresh_connection()
        self._memory.register_sync_write_listener(self.notify_local_write)

    @property
    def lock(self) -> asyncio.Lock:
        return self._lock

    @property
    def relay_url(self) -> str:
        if not self._lock.locked():
            self._refresh_connection()
        return self._relay_url

    @property
    def token(self) -> str:
        return self._fallback_token if self._relay_url == self._fallback_relay_url else ""

    @property
    def state_dir(self) -> Path:
        return self._state_dir

    @property
    def schema_name(self) -> str:
        return self._schema

    def _set_connection(self, relay_url: str) -> None:
        self._relay_url = relay_url
        self._auth_status = "ok"
        self._auth_failed_token = None
        self._last_result = None
        self._last_error = None
        self._last_checked_at = None
        self._retry_at = 0.0

    def _refresh_connection(self) -> None:
        try:
            identity = load_device_identity(self._state_dir)
            if identity and identity.managed_relay:
                relay_url = validate_relay_url(identity.relay_url)
                if relay_url != self._relay_url:
                    self._set_connection(relay_url)
        except (OSError, ValueError):
            # The sync cycle reports unreadable local credentials when a URL is configured.
            pass

    async def sign_in(self, relay_url: str, password: str) -> DeviceIdentity:
        from ..admin.sync_pake import sign_in_device

        async with self._lock:
            identity = await sign_in_device(relay_url, password, self._state_dir, select_relay=True)
            self._set_connection(identity.relay_url)
            self.notify_local_write()
            return identity

    def start(self) -> None:
        """Start the background loop and immediately run an initial check."""
        if not self._auto_enabled or self._task is not None:
            return
        self._stop_requested = False
        self._wakeup.set()
        self._task = asyncio.create_task(self._loop(), name="hindsight-sync-scheduler")
        logger.info("Auto-sync scheduler started (interval=%.1fs)", self._interval_seconds)

    async def stop(self) -> None:
        """Stop periodic scheduling cleanly and wait for any in-flight cycle."""
        self._stop_requested = True
        self._wakeup.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=15.0)
            except asyncio.TimeoutError:
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
            finally:
                self._task = None
        logger.info("Auto-sync scheduler stopped")

    def notify_local_write(self) -> None:
        """Schedule an early check after a local database write commits."""
        if self._stop_requested or not self._relay_url:
            return
        self._dirty_hint = True
        self._wakeup.set()

    async def trigger_sync(
        self,
        *,
        prefer: ConflictSide | None = None,
        automatic: bool = False,
        check_only: bool = False,
    ) -> SyncExchangeResult:
        """Run one sync cycle sharing the coordinator lock (coalesces redundant wakeups)."""
        if automatic and self._lock.locked() and self._auto_enabled and not self._stop_requested:
            self.notify_local_write()
            return SyncExchangeResult(status="deferred", message="Sync check queued")
        return await self._run_once(prefer=prefer, automatic=automatic, check_only=check_only)

    async def _loop(self) -> None:
        while not self._stop_requested:
            self._wakeup.clear()
            self._dirty_hint = False
            try:
                await self._run_once(automatic=True)
            except Exception as exc:
                self._last_error = str(exc)
                logger.warning("Background sync cycle failed (will retry): %s", exc)
            if self._stop_requested:
                break
            # If another write happened while a cycle ran, wake right away; otherwise sleep interval.
            if self._dirty_hint:
                continue
            try:
                await asyncio.wait_for(self._wakeup.wait(), timeout=self._interval_seconds)
            except asyncio.TimeoutError:
                continue

    async def _run_once(
        self,
        *,
        prefer: ConflictSide | None = None,
        automatic: bool = False,
        check_only: bool = False,
    ) -> SyncExchangeResult:
        async with self._lock:
            self._refresh_connection()
            if not self._relay_url:
                return SyncExchangeResult(
                    status="idle", message="Sync relay is not configured", auth_status="unconfigured"
                )
            if automatic and (not self._auto_enabled or self._stop_requested):
                return SyncExchangeResult(status="idle", message="Automatic sync is disabled")
            if automatic and asyncio.get_running_loop().time() < self._retry_at:
                return SyncExchangeResult(status="deferred", message="Waiting for the relay retry window")
            if automatic and self._auth_status in {"revoked", "unauthorized"}:
                if self._auth_failed_token == self._current_credential():
                    return SyncExchangeResult(
                        status="auth_error",
                        message=self._last_error or "Sync authorization needs attention",
                        auth_status=self._auth_status,
                    )
            self._syncing = True
            self._last_checked_at = datetime.now(timezone.utc)
            try:
                db_url = getattr(self._memory, "db_url", None) or getattr(self._memory, "_db_url", None) or ""
                if not db_url and self._memory._backend is not None:
                    db_url = str(getattr(self._memory._backend, "db_url", ""))
                res = await synchronize_v3(
                    database_url=db_url or "postgresql://localhost/hindsight",
                    schema=self._schema,
                    relay_url=self._relay_url,
                    token=self.token,
                    state_dir=self._state_dir,
                    prefer=prefer,
                    auto_resolve=self._auto_resolve,
                    automatic=automatic,
                    check_only=check_only,
                    batch_max_items=self._batch_max_items,
                    batch_max_bytes=self._batch_max_bytes,
                    max_snapshot_bytes=self._max_snapshot_bytes,
                    file_storage=getattr(self._memory, "_file_storage", None),
                    pool=self._memory._pool,
                )
                self._last_result = res
                self._auth_status = res.auth_status
                self._auth_failed_token = self._current_credential() if res.status == "auth_error" else None
                self._last_error = res.message if res.status in ("auth_error", "error", "needs_prefer") else None
                return res
            except SyncAuthError as exc:
                self._auth_status = "revoked" if exc.status_code == 403 else "unauthorized"
                self._auth_failed_token = self._current_credential()
                self._last_error = str(exc)
                res = SyncExchangeResult(
                    status="auth_error",
                    message=str(exc),
                    auth_status=self._auth_status,
                )
                self._last_result = res
                return res
            except SyncRateLimited as exc:
                self._retry_at = asyncio.get_running_loop().time() + exc.retry_seconds
                self._last_error = str(exc)
                self._last_result = SyncExchangeResult(status="deferred", message=str(exc))
                return self._last_result
            except Exception as exc:
                self._last_error = str(exc)
                res = SyncExchangeResult(status="error", message=str(exc), auth_status=self._auth_status)
                self._last_result = res
                if not automatic:
                    raise
                return res
            finally:
                self._syncing = False

    def _current_credential(self) -> str:
        try:
            identity = load_device_identity(self._state_dir, self._relay_url)
        except (ValueError, OSError):
            identity = None
        return identity.token if identity is not None else self.token

    async def get_status(self) -> SyncStatusSnapshot:
        """Return live cursor, local HWM, auth state, and last cycle status."""
        relay_url = self.relay_url
        dev_id: str | None = None
        try:
            ident = load_device_identity(self._state_dir, relay_url) if relay_url else None
            if ident is not None:
                dev_id = ident.device_id
        except Exception:
            pass

        cursor: SyncCursorRecord | None = None
        local_hwm = 0
        backend = getattr(self._memory, "_backend", None)
        if backend is not None and relay_url:
            from .db_utils import acquire_with_retry

            db_url = (
                getattr(self._memory, "db_url", None)
                or getattr(self._memory, "_db_url", None)
                or str(getattr(backend, "db_url", ""))
            )
            if db_url:
                from ..pg0 import resolve_database_url

                db_url = await resolve_database_url(db_url)
            replica_id = compute_replica_id(relay_url, db_url, self._schema)
            async with acquire_with_retry(backend) as conn:
                local_hwm = await get_local_high_water(conn, schema=self._schema)
                cursor = await get_sync_cursor(conn, replica_id, schema=self._schema)

        last_res = self._last_result
        return SyncStatusSnapshot(
            configured=bool(relay_url),
            auto_enabled=self._auto_enabled,
            running=self._task is not None and not self._task.done(),
            syncing=self._syncing,
            interval_seconds=self._interval_seconds,
            relay_url=relay_url or None,
            device_id=dev_id or (cursor.device_id if cursor else None) or None,
            auth_status=cursor.auth_status if cursor is not None else self._auth_status,
            out_seq=cursor.out_seq if cursor is not None else (last_res.out_seq if last_res else 0),
            in_seq=cursor.in_seq if cursor is not None else (last_res.in_seq if last_res else 0),
            local_high_water=local_hwm,
            relay_version=last_res.relay_version if last_res is not None else 0,
            joined=cursor.joined if cursor is not None else False,
            last_error=(cursor.last_error if cursor and cursor.last_error else self._last_error),
            last_checked_at=self._last_checked_at,
            last_synced_at=cursor.last_synced_at if cursor is not None else None,
            last_status=last_res.status if last_res is not None else None,
            last_message=last_res.message if last_res is not None else None,
        )


__all__ = ["SyncScheduler", "SyncStatusSnapshot", "default_sync_state_dir"]
