from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from os import PathLike
from typing import TYPE_CHECKING, Any, overload

from starlette.background import BackgroundTask
from starlette.datastructures import URL
from starlette.requests import Request
from starlette.responses import HTMLResponse
from starlette.types import Receive, Scope, Send

try:
    import jinja2

    # @contextfunction was renamed to @pass_context in Jinja 3.0, and was removed in 3.1
    # hence we try to get pass_context (most installs will be >=3.1)
    # and fall back to contextfunction,
    # adding a type ignore for mypy to let us access an attribute that may not exist
    if TYPE_CHECKING:
        pass_context = jinja2.pass_context
    else:
        if hasattr(jinja2, "pass_context"):
            pass_context = jinja2.pass_context
        else:  # pragma: no cover
            pass_context = jinja2.contextfunction  # type: ignore[attr-defined]
except ImportError as _import_error:  # pragma: no cover
    raise ImportError("jinja2 must be installed to use Jinja2Templates") from _import_error


class _TemplateResponse(HTMLResponse):
    def __init__(
        self,
        template: Any,
        context: dict[str, Any],
        status_code: int = 200,
        headers: Mapping[str, str] | None = None,
        media_type: str | None = None,
        background: BackgroundTask | None = None,
    ):
        self.template = template
        self.context = context
        content = template.render(context)
        super().__init__(content, status_code, headers, media_type, background)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        request = self.context.get("request", {})
        extensions = request.get("extensions", {})
        if "http.response.debug" in extensions:  # pragma: no branch
            await send({"type": "http.response.debug", "info": {"template": self.template, "context": self.context}})
        await super().__call__(scope, receive, send)


class Jinja2Templates:
    """Jinja2 template renderer.

    Example:
        ```python
        from starlette.templating import Jinja2Templates

        templates = Jinja2Templates(directory="templates")

        async def homepage(request: Request) -> Response:
            return templates.TemplateResponse(request, "index.html")
        ```
    """

    @overload
    def __init__(
        self,
        directory: str | PathLike[str] | Sequence[str | PathLike[str]],
        *,
        context_processors: list[Callable[[Request], dict[str, Any]]] | None = None,
    ) -> None: ...

    @overload
    def __init__(
        self,
        *,
        env: jinja2.Environment,
        context_processors: list[Callable[[Request], dict[str, Any]]] | None = None,
    ) -> None: ...

    def __init__(
        self,
        directory: str | PathLike[str] | Sequence[str | PathLike[str]] | None = None,
        *,
        context_processors: list[Callable[[Request], dict[str, Any]]] | None = None,
        env: jinja2.Environment | None = None,
    ) -> None:
        assert bool(directory) ^ bool(env), "either 'directory' or 'env' arguments must be passed"
        self.context_processors = context_processors or []
        if directory is not None:
            loader = jinja2.FileSystemLoader(directory)
            self.env = jinja2.Environment(loader=loader, autoescape=jinja2.select_autoescape())
        elif env is not None:  # pragma: no branch
            self.env = env

        self._setup_env_defaults(self.env)

    def _setup_env_defaults(self, env: jinja2.Environment) -> None:
        @pass_context
        def url_for(
            context: dict[str, Any],
            name: str,
            /,
            **path_params: Any,
        ) -> URL:
            request: Request = context["request"]
            return request.url_for(name, **path_params)

        env.globals.setdefault("url_for", url_for)

    def get_template(self, name: str) -> jinja2.Template:
        return self.env.get_template(name)

    def TemplateResponse(
        self,
        request: Request,
        name: str,
        context: dict[str, Any] | None = None,
        status_code: int = 200,
        headers: Mapping[str, str] | None = None,
        media_type: str | None = None,
        background: BackgroundTask | None = None,
    ) -> _TemplateResponse:
        """
        Render a template and return an HTML response.

        Args:
            request: The incoming request instance.
            name: The template file name to render.
            context: Variables to pass to the template.
            status_code: HTTP status code for the response.
            headers: Additional headers to include in the response.
            media_type: Media type for the response.
            background: Background task to run after response is sent.

        Returns:
            An HTML response with the rendered template content.
        """
        context = context or {}

        context.setdefault("request", request)
        for context_processor in self.context_processors:
            context.update(context_processor(request))

        template = self.get_template(name)
        return _TemplateResponse(
            template,
            context,
            status_code=status_code,
            headers=headers,
            media_type=media_type,
            background=background,
        )
