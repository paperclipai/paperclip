from __future__ import annotations

import asyncio
from collections.abc import Callable

import uvloop


def uvloop_loop_factory(use_subprocess: bool = False) -> Callable[[], asyncio.AbstractEventLoop]:
    return uvloop.new_event_loop
