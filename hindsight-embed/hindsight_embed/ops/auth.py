"""Access token for the local operations API.

The operations API is the merge target of the retired control center: the
control plane's own UI calls it, and that UI binds `0.0.0.0` by default, so a
route that writes the profile `.env` (which holds the LLM API key) and starts or
kills local processes cannot be reachable just because the page is reachable.

Two things therefore gate it, and both have to hold:

* the caller presents this token, and
* the caller reached the control plane over a loopback host name.

The token lives at ``~/.hindsight/ops.token`` and is created on demand with
owner-only permissions. It is NOT the legacy ``control.token``: a control center
from a previous install kept that file, and a deleted component must not leave
behind a credential that still opens the door.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

ENV_OPS_TOKEN = "HINDSIGHT_EMBED_OPS_TOKEN"


def token_file() -> Path:
    """Path of the persisted operations token, resolved against the live HOME."""
    return Path.home() / ".hindsight" / "ops.token"


def read_token() -> str | None:
    """Read the persisted token, or None when it has never been created."""
    path = token_file()
    if not path.exists():
        return None
    token = path.read_text(encoding="utf-8").strip()
    return token or None


def get_or_create_token() -> str:
    """Return the operations token, generating and persisting one if absent.

    ``HINDSIGHT_EMBED_OPS_TOKEN`` wins when set: a launcher that already knows
    the token (the embed CLI starting the control plane) hands it down instead of
    making the child read the file, so both sides agree even before either has
    touched the disk.
    """
    env_token = os.getenv(ENV_OPS_TOKEN, "").strip()
    if env_token:
        return env_token
    existing = read_token()
    if existing:
        return existing
    token = secrets.token_urlsafe(32)
    path = token_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    path.chmod(0o600)
    return token
