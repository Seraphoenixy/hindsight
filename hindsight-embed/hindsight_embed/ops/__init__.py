"""Hindsight embed operations backend.

The Python side of the local management surface: profile configuration, the
grouped settings catalog, and the daemon lifecycle. It owns the implementation;
the browser UI is the control plane's, and it reaches this module through
``hindsight-embed ops`` (see :mod:`hindsight_embed.ops.cli`), which answers one
JSON document per invocation.

Keeping the implementation here rather than in the UI is deliberate. The
lifecycle code in :mod:`hindsight_embed.daemon_embed_manager` carries
platform-specific behaviour (Windows kernel queries for the owning PID of a
port, the detached-process flag combination, the profile file lock) that has no
Node equivalent and whose regressions are only reproducible on real Windows
hosts. The UI must not own a second copy of it.

This package used to be ``control_center`` and shipped its own stdlib HTTP
server plus a Preact SPA on port 7878. Both are gone: one management UI, one
port, one place to configure the local stack.

Import the submodules directly (``from .ops import service``,
``from .ops import cli``). This module deliberately re-exports nothing: a
package-level alias for every name only creates a second spelling of each import
and a place for the two to drift.
"""
