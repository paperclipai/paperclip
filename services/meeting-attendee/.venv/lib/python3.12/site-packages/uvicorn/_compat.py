from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

__all__ = ["asyncio_run", "iscoroutinefunction"]

if sys.version_info >= (3, 14):
    from inspect import iscoroutinefunction
else:
    from asyncio import iscoroutinefunction

_T = TypeVar("_T")

if sys.version_info >= (3, 12):
    asyncio_run = asyncio.run
elif sys.version_info >= (3, 11):

    def asyncio_run(
        main: Coroutine[Any, Any, _T],
        *,
        debug: bool = False,
        loop_factory: Callable[[], asyncio.AbstractEventLoop] | None = None,
    ) -> _T:
        # asyncio.run from Python 3.12
        # https://docs.python.org/3/license.html#psf-license
        with asyncio.Runner(debug=debug, loop_factory=loop_factory) as runner:
            return runner.run(main)

else:
    # modified version of asyncio.run from Python 3.10 to add loop_factory kwarg
    # https://docs.python.org/3/license.html#psf-license
    def asyncio_run(
        main: Coroutine[Any, Any, _T],
        *,
        debug: bool = False,
        loop_factory: Callable[[], asyncio.AbstractEventLoop] | None = None,
    ) -> _T:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise RuntimeError("asyncio.run() cannot be called from a running event loop")

        if not asyncio.iscoroutine(main):
            raise ValueError(f"a coroutine was expected, got {main!r}")

        if loop_factory is None:
            loop = asyncio.new_event_loop()
        else:
            loop = loop_factory()
        try:
            if loop_factory is None:
                asyncio.set_event_loop(loop)
            if debug is not None:
                loop.set_debug(debug)
            return loop.run_until_complete(main)
        finally:
            try:
                _cancel_all_tasks(loop)
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.run_until_complete(loop.shutdown_default_executor())
            finally:
                if loop_factory is None:
                    asyncio.set_event_loop(None)
                loop.close()

    def _cancel_all_tasks(loop: asyncio.AbstractEventLoop) -> None:
        to_cancel = asyncio.all_tasks(loop)
        if not to_cancel:
            return

        for task in to_cancel:
            task.cancel()

        loop.run_until_complete(asyncio.gather(*to_cancel, return_exceptions=True))

        for task in to_cancel:
            if task.cancelled():
                continue
            if task.exception() is not None:
                loop.call_exception_handler(
                    {
                        "message": "unhandled exception during asyncio.run() shutdown",
                        "exception": task.exception(),
                        "task": task,
                    }
                )
