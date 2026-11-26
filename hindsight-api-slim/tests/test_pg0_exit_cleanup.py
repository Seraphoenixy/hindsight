"""pg0 cleanup must still work after Python has shut down its thread pools."""

import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hindsight_api.pg0 import EmbeddedPostgres


def test_exit_cleanup_stops_pg0_after_executor_shutdown() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import atexit
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from hindsight_api import main
from hindsight_api.pg0 import EmbeddedPostgres

pg = EmbeddedPostgres()
pg._pg0 = SimpleNamespace(stop=lambda: print('PG0_STOPPED'))
main._memory = SimpleNamespace(_pg0=pg)
atexit.register(main._cleanup)
with ThreadPoolExecutor() as executor:
    executor.submit(lambda: None).result()
""",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "PG0_STOPPED" in result.stdout, result.stdout
    assert "Error stopping pg0" not in result.stdout
    assert "cannot schedule new futures" not in result.stderr


@pytest.mark.parametrize("already_stopped", [False, True])
async def test_async_stop_uses_the_same_stop_operation(already_stopped: bool) -> None:
    stop = Mock(side_effect=RuntimeError("Instance not running") if already_stopped else None)
    pg = EmbeddedPostgres()
    pg._pg0 = SimpleNamespace(stop=stop)
    await pg.stop()
    stop.assert_called_once()


def test_sync_stop_preserves_actionable_errors() -> None:
    pg = EmbeddedPostgres()
    pg._pg0 = SimpleNamespace(stop=Mock(side_effect=RuntimeError("permission denied")))
    with pytest.raises(RuntimeError, match="Failed to stop PostgreSQL: permission denied"):
        pg.stop_sync()
