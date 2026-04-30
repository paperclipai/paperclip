from __future__ import annotations

import asyncio
from collections.abc import Callable


def auto_loop_factory(use_subprocess: bool = False) -> Callable[[], asyncio.AbstractEventLoop]:
    try:
        import uvloop  # noqa
    except ImportError:  # pragma: no cover
        from uvicorn.loops.asyncio import asyncio_loop_factory as loop_factory

        return loop_factory(use_subprocess=use_subprocess)
    else:  # pragma: no cover
        from uvicorn.loops.uvloop import uvloop_loop_factory

        return uvloop_loop_factory(use_subprocess=use_subprocess)
