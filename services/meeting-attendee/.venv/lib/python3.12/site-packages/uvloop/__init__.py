import asyncio as __asyncio
import typing as _typing
import sys as _sys
import warnings as _warnings

from . import includes as __includes  # NOQA
from .loop import Loop as __BaseLoop  # NOQA
from ._version import __version__  # NOQA


__all__: _typing.Tuple[str, ...] = ('new_event_loop', 'run')
_AbstractEventLoop = __asyncio.AbstractEventLoop


_T = _typing.TypeVar("_T")


class Loop(__BaseLoop, _AbstractEventLoop):  # type: ignore[misc]
    pass


def new_event_loop() -> Loop:
    """Return a new event loop."""
    return Loop()


if _typing.TYPE_CHECKING:
    def run(
        main: _typing.Coroutine[_typing.Any, _typing.Any, _T],
        *,
        loop_factory: _typing.Optional[
            _typing.Callable[[], Loop]
        ] = new_event_loop,
        debug: _typing.Optional[bool]=None,
    ) -> _T:
        """The preferred way of running a coroutine with uvloop."""
else:
    def run(main, *, loop_factory=new_event_loop, debug=None, **run_kwargs):
        """The preferred way of running a coroutine with uvloop."""

        async def wrapper():
            # If `loop_factory` is provided we want it to return
            # either uvloop.Loop or a subtype of it, assuming the user
            # is using `uvloop.run()` intentionally.
            loop = __asyncio._get_running_loop()
            if not isinstance(loop, Loop):
                raise TypeError('uvloop.run() uses a non-uvloop event loop')
            return await main

        vi = _sys.version_info[:2]

        if vi <= (3, 10):
            # Copied from python/cpython

            if __asyncio._get_running_loop() is not None:
                raise RuntimeError(
                    "asyncio.run() cannot be called from a running event loop")

            if not __asyncio.iscoroutine(main):
                raise ValueError(
                    "a coroutine was expected, got {!r}".format(main)
                )

            loop = loop_factory()
            try:
                __asyncio.set_event_loop(loop)
                if debug is not None:
                    loop.set_debug(debug)
                return loop.run_until_complete(wrapper())
            finally:
                try:
                    _cancel_all_tasks(loop)
                    loop.run_until_complete(loop.shutdown_asyncgens())
                    if hasattr(loop, 'shutdown_default_executor'):
                        loop.run_until_complete(
                            loop.shutdown_default_executor()
                        )
                finally:
                    __asyncio.set_event_loop(None)
                    loop.close()

        elif vi == (3, 11):
            if __asyncio._get_running_loop() is not None:
                raise RuntimeError(
                    "asyncio.run() cannot be called from a running event loop")

            with __asyncio.Runner(
                loop_factory=loop_factory,
                debug=debug,
                **run_kwargs
            ) as runner:
                return runner.run(wrapper())

        else:
            assert vi >= (3, 12)
            return __asyncio.run(
                wrapper(),
                loop_factory=loop_factory,
                debug=debug,
                **run_kwargs
            )


def _cancel_all_tasks(loop: _AbstractEventLoop) -> None:
    # Copied from python/cpython

    to_cancel = __asyncio.all_tasks(loop)
    if not to_cancel:
        return

    for task in to_cancel:
        task.cancel()

    loop.run_until_complete(
        __asyncio.gather(*to_cancel, return_exceptions=True)
    )

    for task in to_cancel:
        if task.cancelled():
            continue
        if task.exception() is not None:
            loop.call_exception_handler({
                'message': 'unhandled exception during asyncio.run() shutdown',
                'exception': task.exception(),
                'task': task,
            })


_deprecated_names = ('install', 'EventLoopPolicy')


if _sys.version_info[:2] < (3, 16):
    __all__ += _deprecated_names


def __getattr__(name: str) -> _typing.Any:
    if name not in _deprecated_names:
        raise AttributeError(f"module 'uvloop' has no attribute '{name}'")
    elif _sys.version_info[:2] >= (3, 16):
        raise AttributeError(
            f"module 'uvloop' has no attribute '{name}' "
            f"(it was removed in Python 3.16, use uvloop.run() instead)"
        )

    import threading

    def install() -> None:
        """A helper function to install uvloop policy.

        This function is deprecated and will be removed in Python 3.16.
        Use `uvloop.run()` instead.
        """
        if _sys.version_info[:2] >= (3, 12):
            _warnings.warn(
                'uvloop.install() is deprecated in favor of uvloop.run() '
                'starting with Python 3.12.',
                DeprecationWarning,
                stacklevel=1,
            )
        __asyncio.set_event_loop_policy(EventLoopPolicy())

    class EventLoopPolicy(
        # This is to avoid a mypy error about AbstractEventLoopPolicy
        getattr(__asyncio, 'AbstractEventLoopPolicy')  # type: ignore[misc]
    ):
        """Event loop policy for uvloop.

        This class is deprecated and will be removed in Python 3.16.
        Use `uvloop.run()` instead.

        >>> import asyncio
        >>> import uvloop
        >>> asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
        >>> asyncio.get_event_loop()
        <uvloop.Loop running=False closed=False debug=False>
        """

        def _loop_factory(self) -> Loop:
            return new_event_loop()

        if _typing.TYPE_CHECKING:
            # EventLoopPolicy doesn't implement these, but since they are
            # marked as abstract in typeshed, we have to put them in so mypy
            # thinks the base methods are overridden. This is the same approach
            # taken for the Windows event loop policy classes in typeshed.
            def get_child_watcher(self) -> _typing.NoReturn:
                ...

            def set_child_watcher(
                self, watcher: _typing.Any
            ) -> _typing.NoReturn:
                ...

        class _Local(threading.local):
            _loop: _typing.Optional[_AbstractEventLoop] = None

        def __init__(self) -> None:
            self._local = self._Local()

        def get_event_loop(self) -> _AbstractEventLoop:
            """Get the event loop for the current context.

            Returns an instance of EventLoop or raises an exception.
            """
            if self._local._loop is None:
                raise RuntimeError(
                    'There is no current event loop in thread %r.'
                    % threading.current_thread().name
                )

            return self._local._loop

        def set_event_loop(
            self, loop: _typing.Optional[_AbstractEventLoop]
        ) -> None:
            """Set the event loop."""
            if loop is not None and not isinstance(loop, _AbstractEventLoop):
                raise TypeError(
                    f"loop must be an instance of AbstractEventLoop or None, "
                    f"not '{type(loop).__name__}'"
                )
            self._local._loop = loop

        def new_event_loop(self) -> Loop:
            """Create a new event loop.

            You must call set_event_loop() to make this the current event loop.
            """
            return self._loop_factory()

    globals()['install'] = install
    globals()['EventLoopPolicy'] = EventLoopPolicy
    return globals()[name]
