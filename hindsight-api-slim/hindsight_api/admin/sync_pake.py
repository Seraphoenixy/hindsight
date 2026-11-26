"""Client-side SRP-6a enrollment and login for a Hindsight sync relay."""

import base64
import hashlib
import hmac
import secrets
import socket
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from filelock import FileLock

from ..engine.aiohttp_session import per_phase_timeout
from ..engine.sync_service import (
    DeviceIdentity,
    RelayDeviceProvisioned,
    RelayV3Client,
    SyncError,
    load_device_identity,
    save_device_identity,
    validate_relay_url,
    validate_sync_token,
)

PROTOCOL = "srp6a-sha256-3072-v1"
ITERATIONS = 600_000
USERNAME = b"hindsight-sync"
CONTEXT = b"\x00hindsight-sync:access:v1"
GROUP_BYTES = 384
GENERATOR = 5
# RFC 5054, Appendix A, 3072-bit group.
MODULUS = int(
    """
    FFFFFFFF FFFFFFFF C90FDAA2 2168C234 C4C6628B 80DC1CD1 29024E08
    8A67CC74 020BBEA6 3B139B22 514A0879 8E3404DD EF9519B3 CD3A431B
    302B0A6D F25F1437 4FE1356D 6D51C245 E485B576 625E7EC6 F44C42E9
    A637ED6B 0BFF5CB6 F406B7ED EE386BFB 5A899FA5 AE9F2411 7C4B1FE6
    49286651 ECE45B3D C2007CB8 A163BF05 98DA4836 1C55D39A 69163FA8
    FD24CF5F 83655D23 DCA3AD96 1C62F356 208552BB 9ED52907 7096966D
    670C354E 4ABC9804 F1746C08 CA18217C 32905E46 2E36CE3B E39E772C
    180E8603 9B2783A2 EC07A28F B5C55DF0 6F4C52C9 DE2BCBF6 95581718
    3995497C EA956AE5 15D22618 98FA0510 15728E5A 8AAAC42D AD33170D
    04507A33 A85521AB DF1CBA64 ECFB8504 58DBEF0A 8AEA7157 5D060C7D
    B3970F85 A6E1E4C7 ABF5AE8C DB0933D7 1E8C94E0 4A25619D CEE3D226
    1AD2EE6B F12FFA06 D98A0864 D8760273 3EC86A64 521F2B18 177B200C
    BBE11757 7A615D6C 770988C0 BAD946E2 08E24FA0 74E5AB31 43DB5BFC
    E0FD108E 4B82D120 A93AD2CA FFFFFFFF FFFFFFFF
    """.translate(str.maketrans("", "", " \n")),
    16,
)


def _hash(*parts: bytes) -> bytes:
    return hashlib.sha256(b"".join(parts)).digest()


def _integer(data: bytes) -> int:
    return int.from_bytes(data, "big")


def _minimal(value: int) -> bytes:
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


def _encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _decode(value: Any, size: int, *, fixed: bool = True) -> bytes:
    if not isinstance(value, str) or len(value) > ((size + 2) // 3) * 4:
        raise SyncError("Invalid PAKE response")
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise SyncError("Invalid PAKE response") from exc
    if not raw or len(raw) > size or (fixed and len(raw) != size):
        raise SyncError("Invalid PAKE response")
    return raw


def _private_key(password: str, access_salt: bytes, srp_salt: bytes) -> int:
    if not 8 <= len(password) <= 256:
        raise ValueError("Use a master password between 8 and 256 characters")
    access_secret = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8") + CONTEXT, access_salt, ITERATIONS)
    return _integer(_hash(srp_salt, _hash(USERNAME, b":", access_secret)))


async def _request(
    client: RelayV3Client,
    path: str,
    *,
    payload: dict[str, str] | None = None,
    authenticated: bool = False,
    expected: int = 200,
) -> dict[str, Any]:
    headers = client._headers()
    if not authenticated:
        headers.pop("Authorization")
    method = "GET" if payload is None else "POST"
    async with client.session.request(
        method, f"{client.base_url}/v3/auth/{path}", json=payload, headers=headers, allow_redirects=False
    ) as response:
        await client._check_error(response)
        if response.status != expected:
            raise SyncError(f"Unexpected PAKE response (HTTP {response.status})")
        if expected == 204:
            return {}
        result = await response.json()
        if not isinstance(result, dict):
            raise SyncError("Invalid PAKE response")
        return result


async def initialize_pake(client: RelayV3Client, password: str) -> None:
    validate_sync_token(client.token)
    access_salt, srp_salt = secrets.token_bytes(16), secrets.token_bytes(16)
    private_key = _private_key(password, access_salt, srp_salt)
    verifier = pow(GENERATOR, private_key, MODULUS).to_bytes(GROUP_BYTES, "big")
    await _request(
        client,
        "initialize",
        payload={
            "protocol": PROTOCOL,
            "access_salt": _encode(access_salt),
            "srp_salt": _encode(srp_salt),
            "verifier": _encode(verifier),
        },
        authenticated=True,
        expected=204,
    )


async def login_pake(client: RelayV3Client, password: str, *, device_id: str, name: str) -> RelayDeviceProvisioned:
    config = await _request(client, "config")
    if config.get("protocol") != PROTOCOL or config.get("pbkdf2_iterations") != ITERATIONS:
        raise SyncError("Unsupported relay PAKE protocol")
    if config.get("initialized") is not True:
        raise SyncError("Relay master password is not initialized")
    salt = _decode(config.get("srp_salt"), 16)
    private_key = _private_key(password, _decode(config.get("access_salt"), 16), salt)
    secret = secrets.randbits(256) | (1 << 255)
    public = pow(GENERATOR, secret, MODULUS)
    padded_public = public.to_bytes(GROUP_BYTES, "big")
    challenge = await _request(client, "login/challenge", payload={"client_public": _encode(padded_public)})
    padded_server = _decode(challenge.get("server_public"), GROUP_BYTES)
    server_public = _integer(padded_server)
    if not 1 < server_public < MODULUS - 1:
        raise SyncError("Invalid SRP server public value")
    challenge_id = challenge.get("challenge_id")
    if not isinstance(challenge_id, str) or len(challenge_id) != 64:
        raise SyncError("Invalid PAKE challenge")

    n_bytes = _minimal(MODULUS)
    g_bytes = _minimal(GENERATOR)
    multiplier = _integer(_hash(n_bytes, GENERATOR.to_bytes(GROUP_BYTES, "big")))
    scrambling = _integer(_hash(padded_public, padded_server))
    base = (server_public - multiplier * pow(GENERATOR, private_key, MODULUS)) % MODULUS
    if not scrambling or base in {0, 1, MODULUS - 1}:
        raise SyncError("Invalid SRP challenge")
    shared = pow(base, secret + scrambling * private_key, MODULUS)
    key = _hash(_minimal(shared))
    group_hash = bytes(a ^ b for a, b in zip(_hash(n_bytes), _hash(g_bytes), strict=True))
    public_bytes = _minimal(public)
    client_proof = _hash(group_hash, _hash(USERNAME), salt, public_bytes, _minimal(server_public), key)

    result = await _request(
        client,
        "login/verify",
        payload={
            "challenge_id": challenge_id,
            "client_proof": _encode(client_proof),
            "device_id": device_id,
            "name": name,
        },
        authenticated=bool(client.token),
    )
    expected = _hash(public_bytes, client_proof.lstrip(b"\x00"), key)
    server_proof = _decode(result.get("server_proof"), 32, fixed=False).rjust(32, b"\x00")
    if not hmac.compare_digest(expected, server_proof):
        raise SyncError("Relay failed SRP server proof verification")
    device = RelayDeviceProvisioned.model_validate(result)
    if device.device_id != device_id or not device.active:
        raise SyncError("Relay returned the wrong device identity")
    validate_sync_token(device.token)
    return device


async def sign_in_device(
    server: str,
    password: str,
    state_dir: Path,
    *,
    name: str | None = None,
    select_relay: bool = False,
) -> DeviceIdentity:
    """Authenticate before atomically publishing the relay and its device credential."""
    url = validate_relay_url(server)
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with FileLock(str(state_dir / "client.lock"), timeout=0):
        previous = load_device_identity(state_dir)
        existing = previous if previous and previous.relay_url.rstrip("/") == url else None
        if previous is not None and existing is None and not select_relay:
            raise ValueError("This state directory is bound to another relay; use a different --state-dir")
        device_id = existing.device_id if existing else f"dev-{uuid.uuid4().hex}"
        token = existing.token if existing and existing.per_device_token else ""
        async with aiohttp.ClientSession(timeout=per_phase_timeout(30, connect=10)) as session:
            device = await login_pake(
                RelayV3Client(url, session, token=token),
                password,
                device_id=device_id,
                name=name or (existing.name if existing else socket.gethostname()) or device_id,
            )
        identity = DeviceIdentity(
            device_id=device.device_id,
            token=device.token,
            name=device.name,
            relay_url=url,
            per_device_token=True,
            created_at=existing.created_at if existing else datetime.now(timezone.utc),
            managed_relay=select_relay or bool(existing and existing.managed_relay),
        )
        save_device_identity(state_dir, identity)
        return identity
