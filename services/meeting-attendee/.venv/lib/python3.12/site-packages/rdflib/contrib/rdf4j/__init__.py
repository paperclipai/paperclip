from importlib.util import find_spec

has_httpx = find_spec("httpx") is not None

if has_httpx:
    from .client import RDF4JClient

    __all__ = ["RDF4JClient", "has_httpx"]
else:
    __all__ = ["has_httpx"]
