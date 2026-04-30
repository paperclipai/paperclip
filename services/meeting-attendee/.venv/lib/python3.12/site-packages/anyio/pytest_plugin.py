from __future__ import annotations

import dataclasses
import socket
import sys
from collections.abc import Callable, Generator, Iterator
from contextlib import ExitStack, contextmanager
from inspect import isasyncgenfunction, iscoroutinefunction, ismethod
from typing import Any, cast

import pytest
from _pytest.fixtures import FuncFixtureInfo, SubRequest
from _pytest.outcomes import Exit
from _pytest.python import CallSpec2
from _pytest.scope import Scope

from . import get_available_backends
from ._core._eventloop import (
    current_async_library,
    get_async_backend,
    reset_current_async_library,
    set_current_async_library,
)
from ._core._exceptions import iterate_exceptions
from .abc import TestRunner

if sys.version_info < (3, 11):
    from exceptiongroup import ExceptionGroup

_current_runner: TestRunner | None = None
_runner_stack: ExitStack | None = None
_runner_leases = 0


def extract_backend_and_options(backend: object) -> tuple[str, dict[str, Any]]:
    if isinstance(backend, str):
        return backend, {}
    elif isinstance(backend, tuple) and len(backend) == 2:
        if isinstance(backend[0], str) and isinstance(backend[1], dict):
            return cast(tuple[str, dict[str, Any]], backend)

    raise TypeError("anyio_backend must be either a string or tuple of (string, dict)")


@contextmanager
def get_runner(
    backend_name: str, backend_options: dict[str, Any]
) -> Iterator[TestRunner]:
    global _current_runner, _runner_leases, _runner_stack
    if _current_runner is None:
        asynclib = get_async_backend(backend_name)
        _runner_stack = ExitStack()
        if current_async_library() is None:
            # Since we're in control of the event loop, we can cache the name of the
            # async library
            token = set_current_async_library(backend_name)
            _runner_stack.callback(reset_current_async_library, token)

        backend_options = backend_options or {}
        _current_runner = _runner_stack.enter_context(
            asynclib.create_test_runner(backend_options)
        )

    _runner_leases += 1
    try:
        yield _current_runner
    finally:
        _runner_leases -= 1
        if not _runner_leases:
            assert _runner_stack is not None
            _runner_stack.close()
            _runner_stack = _current_runner = None


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addini(
        "anyio_mode",
        default="strict",
        help='AnyIO plugin mode (either "strict" or "auto")',
    )


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "anyio: mark the (coroutine function) test to be run asynchronously via anyio.",
    )
    if (
        config.getini("anyio_mode") == "auto"
        and config.pluginmanager.has_plugin("asyncio")
        and config.getini("asyncio_mode") == "auto"
    ):
        config.issue_config_time_warning(
            pytest.PytestConfigWarning(
                "AnyIO auto mode has been enabled together with pytest-asyncio auto "
                "mode. This may cause unexpected behavior."
            ),
            1,
        )


@pytest.hookimpl(hookwrapper=True)
def pytest_fixture_setup(fixturedef: Any, request: Any) -> Generator[Any]:
    def wrapper(anyio_backend: Any, request: SubRequest, **kwargs: Any) -> Any:
        # Rebind any fixture methods to the request instance
        if (
            request.instance
            and ismethod(func)
            and type(func.__self__) is type(request.instance)
        ):
            local_func = func.__func__.__get__(request.instance)
        else:
            local_func = func

        backend_name, backend_options = extract_backend_and_options(anyio_backend)
        if has_backend_arg:
            kwargs["anyio_backend"] = anyio_backend

        if has_request_arg:
            kwargs["request"] = request

        with get_runner(backend_name, backend_options) as runner:
            if isasyncgenfunction(local_func):
                yield from runner.run_asyncgen_fixture(local_func, kwargs)
            else:
                yield runner.run_fixture(local_func, kwargs)

    # Only apply this to coroutine functions and async generator functions in requests
    # that involve the anyio_backend fixture
    func = fixturedef.func
    if isasyncgenfunction(func) or iscoroutinefunction(func):
        if "anyio_backend" in request.fixturenames:
            fixturedef.func = wrapper
            original_argname = fixturedef.argnames

            if not (has_backend_arg := "anyio_backend" in fixturedef.argnames):
                fixturedef.argnames += ("anyio_backend",)

            if not (has_request_arg := "request" in fixturedef.argnames):
                fixturedef.argnames += ("request",)

            try:
                return (yield)
            finally:
                fixturedef.func = func
                fixturedef.argnames = original_argname

    return (yield)


@pytest.hookimpl(tryfirst=True)
def pytest_pycollect_makeitem(
    collector: pytest.Module | pytest.Class, name: str, obj: object
) -> None:
    if collector.istestfunction(obj, name):
        inner_func = obj.hypothesis.inner_test if hasattr(obj, "hypothesis") else obj
        if iscoroutinefunction(inner_func):
            anyio_auto_mode = collector.config.getini("anyio_mode") == "auto"
            marker = collector.get_closest_marker("anyio")
            own_markers = getattr(obj, "pytestmark", ())
            if (
                anyio_auto_mode
                or marker
                or any(marker.name == "anyio" for marker in own_markers)
            ):
                pytest.mark.usefixtures("anyio_backend")(obj)


def pytest_collection_finish(session: pytest.Session) -> None:
    for i, item in reversed(list(enumerate(session.items))):
        if (
            isinstance(item, pytest.Function)
            and iscoroutinefunction(item.function)
            and item.get_closest_marker("anyio") is not None
            and "anyio_backend" not in item.fixturenames
        ):
            new_items = []
            try:
                cs_fields = {f.name for f in dataclasses.fields(CallSpec2)}
            except TypeError:
                cs_fields = set()

            for param_index, backend in enumerate(get_available_backends()):
                if "_arg2scope" in cs_fields:  # pytest >= 8
                    callspec = CallSpec2(
                        params={"anyio_backend": backend},
                        indices={"anyio_backend": param_index},
                        _arg2scope={"anyio_backend": Scope.Module},
                        _idlist=[backend],
                        marks=[],
                    )
                else:  # pytest 7.x
                    callspec = CallSpec2(  # type: ignore[call-arg]
                        funcargs={},
                        params={"anyio_backend": backend},
                        indices={"anyio_backend": param_index},
                        arg2scope={"anyio_backend": Scope.Module},
                        idlist=[backend],
                        marks=[],
                    )

                fi = item._fixtureinfo
                new_names_closure = list(fi.names_closure)
                if "anyio_backend" not in new_names_closure:
                    new_names_closure.append("anyio_backend")

                new_fixtureinfo = FuncFixtureInfo(
                    argnames=fi.argnames,
                    initialnames=fi.initialnames,
                    names_closure=new_names_closure,
                    name2fixturedefs=fi.name2fixturedefs,
                )
                new_item = pytest.Function.from_parent(
                    item.parent,
                    name=f"{item.originalname}[{backend}]",
                    callspec=callspec,
                    callobj=item.obj,
                    fixtureinfo=new_fixtureinfo,
                    keywords=item.keywords,
                    originalname=item.originalname,
                )
                new_items.append(new_item)

            session.items[i : i + 1] = new_items


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: Any) -> bool | None:
    def run_with_hypothesis(**kwargs: Any) -> None:
        with get_runner(backend_name, backend_options) as runner:
            runner.run_test(original_func, kwargs)

    backend = pyfuncitem.funcargs.get("anyio_backend")
    if backend:
        backend_name, backend_options = extract_backend_and_options(backend)

        if hasattr(pyfuncitem.obj, "hypothesis"):
            # Wrap the inner test function unless it's already wrapped
            original_func = pyfuncitem.obj.hypothesis.inner_test
            if original_func.__qualname__ != run_with_hypothesis.__qualname__:
                if iscoroutinefunction(original_func):
                    pyfuncitem.obj.hypothesis.inner_test = run_with_hypothesis

            return None

        if iscoroutinefunction(pyfuncitem.obj):
            funcargs = pyfuncitem.funcargs
            testargs = {arg: funcargs[arg] for arg in pyfuncitem._fixtureinfo.argnames}
            with get_runner(backend_name, backend_options) as runner:
                try:
                    runner.run_test(pyfuncitem.obj, testargs)
                except ExceptionGroup as excgrp:
                    for exc in iterate_exceptions(excgrp):
                        if isinstance(exc, (Exit, KeyboardInterrupt, SystemExit)):
                            raise exc from excgrp

                    raise

            return True

    return None


@pytest.fixture(scope="module", params=get_available_backends())
def anyio_backend(request: Any) -> Any:
    return request.param


@pytest.fixture
def anyio_backend_name(anyio_backend: Any) -> str:
    if isinstance(anyio_backend, str):
        return anyio_backend
    else:
        return anyio_backend[0]


@pytest.fixture
def anyio_backend_options(anyio_backend: Any) -> dict[str, Any]:
    if isinstance(anyio_backend, str):
        return {}
    else:
        return anyio_backend[1]


class FreePortFactory:
    """
    Manages port generation based on specified socket kind, ensuring no duplicate
    ports are generated.

    This class provides functionality for generating available free ports on the
    system. It is initialized with a specific socket kind and can generate ports
    for given address families while avoiding reuse of previously generated ports.

    Users should not instantiate this class directly, but use the
    ``free_tcp_port_factory`` and ``free_udp_port_factory`` fixtures instead. For simple
    uses cases, ``free_tcp_port`` and ``free_udp_port`` can be used instead.
    """

    def __init__(self, kind: socket.SocketKind) -> None:
        self._kind = kind
        self._generated = set[int]()

    @property
    def kind(self) -> socket.SocketKind:
        """
        The type of socket connection (e.g., :data:`~socket.SOCK_STREAM` or
        :data:`~socket.SOCK_DGRAM`) used to bind for checking port availability

        """
        return self._kind

    def __call__(self, family: socket.AddressFamily | None = None) -> int:
        """
        Return an unbound port for the given address family.

        :param family: if omitted, both IPv4 and IPv6 addresses will be tried
        :return: a port number

        """
        if family is not None:
            families = [family]
        else:
            families = [socket.AF_INET]
            if socket.has_ipv6:
                families.append(socket.AF_INET6)

        while True:
            port = 0
            with ExitStack() as stack:
                for family in families:
                    sock = stack.enter_context(socket.socket(family, self._kind))
                    addr = "::1" if family == socket.AF_INET6 else "127.0.0.1"
                    try:
                        sock.bind((addr, port))
                    except OSError:
                        break

                    if not port:
                        port = sock.getsockname()[1]
                else:
                    if port not in self._generated:
                        self._generated.add(port)
                        return port


@pytest.fixture(scope="session")
def free_tcp_port_factory() -> FreePortFactory:
    return FreePortFactory(socket.SOCK_STREAM)


@pytest.fixture(scope="session")
def free_udp_port_factory() -> FreePortFactory:
    return FreePortFactory(socket.SOCK_DGRAM)


@pytest.fixture
def free_tcp_port(free_tcp_port_factory: Callable[[], int]) -> int:
    return free_tcp_port_factory()


@pytest.fixture
def free_udp_port(free_udp_port_factory: Callable[[], int]) -> int:
    return free_udp_port_factory()
