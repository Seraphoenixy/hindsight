"""HTTP routes for object-level sync status, triggers, conflict review/restore, and device management."""

from __future__ import annotations

import hmac
import os
from collections.abc import Callable
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, SecretStr

from ..config import get_config
from ..engine.aiohttp_session import per_phase_timeout
from ..engine.db_utils import acquire_with_retry
from ..engine.sync_journal import (
    ConflictSide,
    SyncConflictPage,
    SyncObjectConflictRecord,
    confirm_sync_conflict,
    get_object_state,
    get_sync_conflict,
    list_sync_conflicts,
)
from ..engine.sync_scheduler import SyncStatusSnapshot, default_sync_state_dir
from ..engine.sync_service import (
    RelayDeviceInfo,
    RelayDeviceProvisioned,
    RelayV3Client,
    SyncAuthError,
    SyncError,
    SyncExchangeResult,
    SyncManualChoiceRequired,
    SyncRateLimited,
    SyncVersionConflictError,
    load_device_identity,
    restore_sync_conflict_object,
    validate_sync_token,
)
from ..models import RequestContext
from .unknown_params import use_unknown_params_routes

PREFIX = "/v1/default/sync"


class TriggerSyncRequest(BaseModel):
    """Request body for triggering a manual or window-focus sync check."""

    prefer: ConflictSide | None = Field(default=None, description="Explicit winner when joining unjoined libraries")
    automatic: bool = Field(
        default=False, description="True for event-triggered background checks such as window focus"
    )


class ConfirmConflictRequest(BaseModel):
    """Request body to confirm review of an object conflict."""

    note: str | None = Field(default=None, description="Optional audit review note")
    by: str | None = Field(default=None, description="Reviewer name override")


class RestoreConflictRequest(BaseModel):
    """Request body to restore one side of a conflict with optimistic version checking."""

    side: ConflictSide = Field(description="Conflict side to apply: 'local' or 'remote'")
    expected_version: int = Field(description="Current local sync version; prevents overwriting newer edits")
    note: str | None = Field(default=None, description="Optional audit note")
    by: str | None = Field(default=None, description="Reviewer name override")


class SyncConflictDetailResponse(BaseModel):
    """Full conflict record enriched with current local object version for safe restore."""

    conflict: SyncObjectConflictRecord
    current_object_version: int = 0
    current_object_deleted: bool = False


class RegisterDeviceRequest(BaseModel):
    """Request body to register a named device credential on the relay."""

    name: str = Field(description="Human-readable device label")
    device_id: str | None = Field(default=None, description="Optional explicit device identifier")


class SyncDevicesResponse(BaseModel):
    """List of devices registered with the configured sync relay."""

    devices: list[RelayDeviceInfo]
    total: int
    current_device_id: str | None = None


class SyncConnectionRequest(BaseModel):
    relay_url: str = Field(max_length=2048)
    password: SecretStr


class SyncConnectionView(BaseModel):
    relay_url: str | None = None
    device_id: str | None = None


def _local_connection_headers(request: Request) -> dict[str, str]:
    if request.client is None:
        raise HTTPException(status_code=404)
    try:
        peer = ip_address(request.client.host)
        local = (getattr(peer, "ipv4_mapped", None) or peer).is_loopback
    except ValueError:
        local = False
    if not local:
        raise HTTPException(status_code=404)
    headers = {"Cache-Control": "no-store", "Vary": "Origin"}
    origin = request.headers.get("Origin")
    if origin is not None:
        try:
            parsed = urlsplit(origin)
            valid = (
                parsed.scheme in {"http", "https"}
                and parsed.hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
                and parsed.username is None
                and not (parsed.path or parsed.query or parsed.fragment)
            )
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(status_code=404)
        headers["Access-Control-Allow-Origin"] = origin
    return headers


def _require_local_ops(request: Request, response: Response) -> dict[str, str]:
    headers = _local_connection_headers(request)
    supplied = request.headers.get("X-Hindsight-Ops-Token", "")
    if not supplied:
        raise HTTPException(status_code=404, headers=headers)
    expected = os.getenv("HINDSIGHT_EMBED_OPS_TOKEN", "").strip()
    if not expected:
        try:
            expected = (Path.home() / ".hindsight" / "ops.token").read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            raise HTTPException(status_code=404, headers=headers) from None
    if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=404, headers=headers)
    response.headers.update(headers)
    return headers


def _resolve_relay_location(app_state_scheduler: object | None) -> tuple[str, str]:
    cfg = get_config()
    relay_url = getattr(cfg, "sync_relay_url", None) or os.getenv("HINDSIGHT_SYNC_RELAY_URL", "")
    state_dir = getattr(cfg, "sync_state_dir", None) or os.getenv("HINDSIGHT_SYNC_STATE_DIR", "")
    if app_state_scheduler is not None:
        relay_url = getattr(app_state_scheduler, "relay_url", "")
        if getattr(app_state_scheduler, "state_dir", None):
            state_dir = str(getattr(app_state_scheduler, "state_dir"))
    if not relay_url:
        raise HTTPException(status_code=400, detail="Sync relay URL is not configured")
    return relay_url, state_dir or str(default_sync_state_dir())


def _relay_admin_token(request: Request) -> str:
    # Tenant authentication grants access to the local API. Relay administration
    # separately proves possession of the credential verified by the relay.
    try:
        return validate_sync_token(request.headers.get("X-Hindsight-Sync-Admin-Token", ""))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="An explicit sync relay administrator token is required") from exc


def build_router(get_request_context: Callable[..., RequestContext]) -> APIRouter:
    """Create the FastAPI router for ``/v1/default/sync`` endpoints."""
    router = APIRouter(prefix=PREFIX, tags=["Sync"])
    use_unknown_params_routes(router)

    @router.options("/connection", include_in_schema=False)
    async def preflight_sync_connection(request: Request) -> Response:
        headers = _local_connection_headers(request)
        headers["Access-Control-Allow-Methods"] = "GET, POST"
        headers["Access-Control-Allow-Headers"] = "Content-Type, X-Hindsight-Ops-Token"
        return Response(status_code=204, headers=headers)

    @router.get("/connection", response_model=SyncConnectionView, include_in_schema=False)
    async def get_sync_connection(
        request: Request, headers: dict[str, str] = Depends(_require_local_ops)
    ) -> SyncConnectionView:
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        if scheduler is None:
            raise HTTPException(status_code=409, detail="Sync is unavailable on this daemon", headers=headers)
        relay_url = scheduler.relay_url
        identity = load_device_identity(scheduler.state_dir, relay_url) if relay_url else None
        return SyncConnectionView(relay_url=relay_url or None, device_id=identity.device_id if identity else None)

    @router.post("/connection", response_model=SyncConnectionView, include_in_schema=False)
    async def set_sync_connection(
        request: Request, body: SyncConnectionRequest, headers: dict[str, str] = Depends(_require_local_ops)
    ) -> SyncConnectionView:
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        if scheduler is None:
            raise HTTPException(status_code=409, detail="Sync is unavailable on this daemon", headers=headers)
        try:
            identity = await scheduler.sign_in(body.relay_url.strip(), body.password.get_secret_value())
        except SyncAuthError as exc:
            message = (
                "Relay rejected the master password"
                if exc.status_code == 401
                else "Device credential was revoked by the relay"
            )
            raise HTTPException(status_code=exc.status_code, detail=message, headers=headers) from exc
        except SyncRateLimited as exc:
            raise HTTPException(
                status_code=429, detail="Too many login attempts. Try again later.", headers=headers
            ) from exc
        except (SyncError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc), headers=headers) from exc
        except aiohttp.ClientError as exc:
            raise HTTPException(status_code=502, detail="Unable to connect to the sync relay", headers=headers) from exc
        except TimeoutError as exc:
            raise HTTPException(
                status_code=503, detail="Relay login timed out or sync is busy. Try again.", headers=headers
            ) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail="Unable to save the sync device credential", headers=headers
            ) from exc
        return SyncConnectionView(relay_url=identity.relay_url, device_id=identity.device_id)

    @router.get("/status", response_model=SyncStatusSnapshot)
    async def get_sync_status(
        request: Request,
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncStatusSnapshot:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        if scheduler is not None:
            return await scheduler.get_status()

        cfg = get_config()
        relay_url = getattr(cfg, "sync_relay_url", None) or os.getenv("HINDSIGHT_SYNC_RELAY_URL")
        return SyncStatusSnapshot(
            configured=bool(relay_url),
            auto_enabled=bool(getattr(cfg, "sync_auto_enabled", True)),
            running=False,
            syncing=False,
            interval_seconds=float(getattr(cfg, "sync_interval_seconds", 15.0)),
            relay_url=relay_url,
            auth_status="ok" if relay_url else "unconfigured",
        )

    @router.post("/trigger", response_model=SyncExchangeResult)
    async def trigger_sync(
        request: Request,
        body: TriggerSyncRequest,
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncExchangeResult:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        if scheduler is None or not scheduler.relay_url:
            raise HTTPException(status_code=400, detail="Sync relay is not configured on this daemon")
        try:
            return await scheduler.trigger_sync(prefer=body.prefer, automatic=body.automatic)
        except SyncManualChoiceRequired as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except SyncAuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except (SyncError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/conflicts", response_model=SyncConflictPage)
    async def list_conflicts(
        request: Request,
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        unconfirmed_only: bool = Query(default=False),
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncConflictPage:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        backend = await memory._get_backend()
        async with acquire_with_retry(backend) as conn:
            return await list_sync_conflicts(conn, limit=limit, offset=offset, unconfirmed_only=unconfirmed_only)

    @router.get("/conflicts/{conflict_id}", response_model=SyncConflictDetailResponse)
    async def get_conflict_detail(
        request: Request,
        conflict_id: str,
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncConflictDetailResponse:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        backend = await memory._get_backend()
        async with acquire_with_retry(backend) as conn:
            rec = await get_sync_conflict(conn, conflict_id)
            if rec is None:
                raise HTTPException(status_code=404, detail=f"Conflict '{conflict_id}' not found")
            st = await get_object_state(conn, object_type=rec.object_type, bank_id=rec.bank_id, object_id=rec.object_id)
            return SyncConflictDetailResponse(
                conflict=rec,
                current_object_version=st.version if st is not None else 0,
                current_object_deleted=st.deleted if st is not None else False,
            )

    @router.post("/conflicts/{conflict_id}/confirm", response_model=SyncObjectConflictRecord)
    async def confirm_conflict(
        request: Request,
        conflict_id: str,
        body: ConfirmConflictRequest,
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncObjectConflictRecord:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        backend = await memory._get_backend()
        async with acquire_with_retry(backend) as conn:
            rec = await confirm_sync_conflict(conn, conflict_id, note=body.note, by=body.by)
            if rec is None:
                raise HTTPException(status_code=404, detail=f"Conflict '{conflict_id}' not found")
            return rec

    @router.post("/conflicts/{conflict_id}/restore", response_model=SyncObjectConflictRecord)
    async def restore_conflict(
        request: Request,
        conflict_id: str,
        body: RestoreConflictRequest,
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncObjectConflictRecord:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        dev_id = None
        if scheduler is not None:
            st = await scheduler.get_status()
            dev_id = st.device_id
        backend = await memory._get_backend()
        try:
            async with acquire_with_retry(backend) as conn:
                updated = await restore_sync_conflict_object(
                    conn,
                    conflict_id=conflict_id,
                    side=body.side,
                    expected_version=body.expected_version,
                    note=body.note,
                    by=body.by,
                    device_id=dev_id,
                )
        except SyncVersionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        memory.notify_sync_local_write()
        return updated

    @router.get("/devices", response_model=SyncDevicesResponse)
    async def list_devices(
        request: Request,
        request_context: RequestContext = Depends(get_request_context),
    ) -> SyncDevicesResponse:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        relay_url, state_dir = _resolve_relay_location(scheduler)
        token = _relay_admin_token(request)
        current_dev = None
        try:
            async with aiohttp.ClientSession(timeout=per_phase_timeout(20, connect=5)) as session:
                ident = load_device_identity(Path(state_dir), relay_url)
                current_dev = ident.device_id if ident is not None else None
                client = RelayV3Client(relay_url, session, token=token)
                devices = await client.list_devices()
                return SyncDevicesResponse(devices=devices, total=len(devices), current_device_id=current_dev)
        except SyncAuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except (SyncError, ValueError, aiohttp.ClientError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/devices", response_model=RelayDeviceProvisioned)
    async def register_device(
        request: Request,
        body: RegisterDeviceRequest,
        request_context: RequestContext = Depends(get_request_context),
    ) -> RelayDeviceProvisioned:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        relay_url, _ = _resolve_relay_location(scheduler)
        token = _relay_admin_token(request)
        try:
            async with aiohttp.ClientSession(timeout=per_phase_timeout(20, connect=5)) as session:
                client = RelayV3Client(relay_url, session, token=token)
                return await client.register_device(name=body.name, device_id=body.device_id)
        except SyncAuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except (SyncError, ValueError, aiohttp.ClientError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/devices/{device_id}/rotate", response_model=RelayDeviceProvisioned)
    async def rotate_device(
        request: Request,
        device_id: str,
        request_context: RequestContext = Depends(get_request_context),
    ) -> RelayDeviceProvisioned:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        relay_url, _ = _resolve_relay_location(scheduler)
        token = _relay_admin_token(request)
        try:
            async with aiohttp.ClientSession(timeout=per_phase_timeout(20, connect=5)) as session:
                client = RelayV3Client(relay_url, session, token=token)
                return await client.rotate_device(device_id)
        except SyncAuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except (SyncError, ValueError, aiohttp.ClientError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/devices/{device_id}/revoke", response_model=RelayDeviceInfo)
    async def revoke_device(
        request: Request,
        device_id: str,
        request_context: RequestContext = Depends(get_request_context),
    ) -> RelayDeviceInfo:
        memory = request.app.state.memory
        await memory._authenticate_tenant(request_context)
        scheduler = getattr(request.app.state, "sync_scheduler", None)
        relay_url, _ = _resolve_relay_location(scheduler)
        token = _relay_admin_token(request)
        try:
            async with aiohttp.ClientSession(timeout=per_phase_timeout(20, connect=5)) as session:
                client = RelayV3Client(relay_url, session, token=token)
                return await client.revoke_device(device_id)
        except SyncAuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except (SyncError, ValueError, aiohttp.ClientError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return router
