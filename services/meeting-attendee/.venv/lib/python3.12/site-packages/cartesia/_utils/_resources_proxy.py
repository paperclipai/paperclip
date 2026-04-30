from __future__ import annotations

from typing import Any
from typing_extensions import override

from ._proxy import LazyProxy


class ResourcesProxy(LazyProxy[Any]):
    """A proxy for the `cartesia.resources` module.

    This is used so that we can lazily import `cartesia.resources` only when
    needed *and* so that users can just import `cartesia` and reference `cartesia.resources`
    """

    @override
    def __load__(self) -> Any:
        import importlib

        mod = importlib.import_module("cartesia.resources")
        return mod


resources = ResourcesProxy().__as_proxied__()
