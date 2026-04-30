from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, ParamSpec, TypeVar

from starlette.datastructures import State, URLPath
from starlette.middleware import Middleware, _MiddlewareFactory
from starlette.middleware.errors import ServerErrorMiddleware
from starlette.middleware.exceptions import ExceptionMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import BaseRoute, Router
from starlette.types import ASGIApp, ExceptionHandler, Lifespan, Receive, Scope, Send

AppType = TypeVar("AppType", bound="Starlette")
P = ParamSpec("P")


class Starlette:
    """Creates an Starlette application."""

    def __init__(
        self: AppType,
        debug: bool = False,
        routes: Sequence[BaseRoute] | None = None,
        middleware: Sequence[Middleware] | None = None,
        exception_handlers: Mapping[Any, ExceptionHandler] | None = None,
        lifespan: Lifespan[AppType] | None = None,
    ) -> None:
        """Initializes the application.

        Parameters:
            debug: Boolean indicating if debug tracebacks should be returned on errors.
            routes: A list of routes to serve incoming HTTP and WebSocket requests.
            middleware: A list of middleware to run for every request. A starlette
                application will always automatically include two middleware classes.
                `ServerErrorMiddleware` is added as the very outermost middleware, to handle
                any uncaught errors occurring anywhere in the entire stack.
                `ExceptionMiddleware` is added as the very innermost middleware, to deal
                with handled exception cases occurring in the routing or endpoints.
            exception_handlers: A mapping of either integer status codes,
                or exception class types onto callables which handle the exceptions.
                Exception handler callables should be of the form
                `handler(request, exc) -> response` and may be either standard functions, or
                async functions.
            lifespan: A lifespan context function, which can be used to perform
                startup and shutdown tasks. This is a newer style that replaces the
                `on_startup` and `on_shutdown` handlers. Use one or the other, not both.
        """
        self.debug = debug
        self.state = State()
        self.router = Router(routes, lifespan=lifespan)
        self.exception_handlers = {} if exception_handlers is None else dict(exception_handlers)
        self.user_middleware = [] if middleware is None else list(middleware)
        self.middleware_stack: ASGIApp | None = None

    def build_middleware_stack(self) -> ASGIApp:
        debug = self.debug
        error_handler = None
        exception_handlers: dict[Any, ExceptionHandler] = {}

        for key, value in self.exception_handlers.items():
            if key in (500, Exception):
                error_handler = value
            else:
                exception_handlers[key] = value

        middleware = (
            [Middleware(ServerErrorMiddleware, handler=error_handler, debug=debug)]
            + self.user_middleware
            + [Middleware(ExceptionMiddleware, handlers=exception_handlers, debug=debug)]
        )

        app = self.router
        for cls, args, kwargs in reversed(middleware):
            app = cls(app, *args, **kwargs)
        return app

    @property
    def routes(self) -> list[BaseRoute]:
        return self.router.routes

    def url_path_for(self, name: str, /, **path_params: Any) -> URLPath:
        return self.router.url_path_for(name, **path_params)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope["app"] = self
        if self.middleware_stack is None:
            self.middleware_stack = self.build_middleware_stack()
        await self.middleware_stack(scope, receive, send)

    def mount(self, path: str, app: ASGIApp, name: str | None = None) -> None:
        self.router.mount(path, app=app, name=name)  # pragma: no cover

    def host(self, host: str, app: ASGIApp, name: str | None = None) -> None:
        self.router.host(host, app=app, name=name)  # pragma: no cover

    def add_middleware(self, middleware_class: _MiddlewareFactory[P], *args: P.args, **kwargs: P.kwargs) -> None:
        if self.middleware_stack is not None:  # pragma: no cover
            raise RuntimeError("Cannot add middleware after an application has started")
        self.user_middleware.insert(0, Middleware(middleware_class, *args, **kwargs))

    def add_exception_handler(
        self,
        exc_class_or_status_code: int | type[Exception],
        handler: ExceptionHandler,
    ) -> None:  # pragma: no cover
        self.exception_handlers[exc_class_or_status_code] = handler

    def add_route(
        self,
        path: str,
        route: Callable[[Request], Awaitable[Response] | Response],
        methods: list[str] | None = None,
        name: str | None = None,
        include_in_schema: bool = True,
    ) -> None:  # pragma: no cover
        self.router.add_route(path, route, methods=methods, name=name, include_in_schema=include_in_schema)
