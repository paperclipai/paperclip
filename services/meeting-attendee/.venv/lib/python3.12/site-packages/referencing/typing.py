"""
Type-annotation related support for the referencing library.
"""

from __future__ import annotations

from collections.abc import Mapping as Mapping
from typing import TYPE_CHECKING, Any, Protocol

try:
    from typing_extensions import TypeVar
except ImportError:  # pragma: no cover
    from typing import TypeVar

if TYPE_CHECKING:
    from referencing._core import Resolved, Resolver, Resource

#: A URI which identifies a `Resource`.
URI = str

#: The type of documents within a registry.
D = TypeVar("D", default=Any)


class Retrieve(Protocol[D]):
    """
    A retrieval callable, usable within a `Registry` for resource retrieval.

    Does not make assumptions about where the resource might be coming from.
    """

    def __call__(self, uri: URI) -> Resource[D]:
        """
        Retrieve the resource with the given URI.

        Raise `referencing.exceptions.NoSuchResource` if you wish to indicate
        the retriever cannot lookup the given URI.
        """
        ...


class Anchor(Protocol[D]):
    """
    An anchor within a `Resource`.

    Beyond "simple" anchors, some specifications like JSON Schema's 2020
    version have dynamic anchors.
    """

    @property
    def name(self) -> str:
        """
        Return the name of this anchor.
        """
        ...

    def resolve(self, resolver: Resolver[D]) -> Resolved[D]:
        """
        Return the resource for this anchor.
        """
        ...
