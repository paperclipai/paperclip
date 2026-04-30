"""
Errors, oh no!
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import attrs

from referencing._attrs import frozen

if TYPE_CHECKING:
    from referencing import Resource
    from referencing.typing import URI


@frozen
class NoSuchResource(KeyError):
    """
    The given URI is not present in a registry.

    Unlike most exceptions, this class *is* intended to be publicly
    instantiable and *is* part of the public API of the package.
    """

    ref: URI

    def __eq__(self, other: object) -> bool:
        if self.__class__ is not other.__class__:
            return NotImplemented
        return attrs.astuple(self) == attrs.astuple(other)

    def __hash__(self) -> int:
        return hash(attrs.astuple(self))


@frozen
class NoInternalID(Exception):
    """
    A resource has no internal ID, but one is needed.

    E.g. in modern JSON Schema drafts, this is the :kw:`$id` keyword.

    One might be needed if a resource was to-be added to a registry but no
    other URI is available, and the resource doesn't declare its canonical URI.
    """

    resource: Resource[Any]

    def __eq__(self, other: object) -> bool:
        if self.__class__ is not other.__class__:
            return NotImplemented
        return attrs.astuple(self) == attrs.astuple(other)

    def __hash__(self) -> int:
        return hash(attrs.astuple(self))


@frozen
class Unretrievable(KeyError):
    """
    The given URI is not present in a registry, and retrieving it failed.
    """

    ref: URI

    def __eq__(self, other: object) -> bool:
        if self.__class__ is not other.__class__:
            return NotImplemented
        return attrs.astuple(self) == attrs.astuple(other)

    def __hash__(self) -> int:
        return hash(attrs.astuple(self))


@frozen
class CannotDetermineSpecification(Exception):
    """
    Attempting to detect the appropriate `Specification` failed.

    This happens if no discernible information is found in the contents of the
    new resource which would help identify it.
    """

    contents: Any

    def __eq__(self, other: object) -> bool:
        if self.__class__ is not other.__class__:
            return NotImplemented
        return attrs.astuple(self) == attrs.astuple(other)

    def __hash__(self) -> int:
        return hash(attrs.astuple(self))


@attrs.frozen  # Because here we allow subclassing below.
class Unresolvable(Exception):
    """
    A reference was unresolvable.
    """

    ref: URI

    def __eq__(self, other: object) -> bool:
        if self.__class__ is not other.__class__:
            return NotImplemented
        return attrs.astuple(self) == attrs.astuple(other)

    def __hash__(self) -> int:
        return hash(attrs.astuple(self))


@frozen
class PointerToNowhere(Unresolvable):
    """
    A JSON Pointer leads to a part of a document that does not exist.
    """

    resource: Resource[Any]

    def __str__(self) -> str:
        msg = f"{self.ref!r} does not exist within {self.resource.contents!r}"
        if self.ref == "/":
            msg += (
                ". The pointer '/' is a valid JSON Pointer but it points to "
                "an empty string property ''. If you intended to point "
                "to the entire resource, you should use '#'."
            )
        return msg


@frozen
class NoSuchAnchor(Unresolvable):
    """
    An anchor does not exist within a particular resource.
    """

    resource: Resource[Any]
    anchor: str

    def __str__(self) -> str:
        return (
            f"{self.anchor!r} does not exist within {self.resource.contents!r}"
        )


@frozen
class InvalidAnchor(Unresolvable):
    """
    An anchor which could never exist in a resource was dereferenced.

    It is somehow syntactically invalid.
    """

    resource: Resource[Any]
    anchor: str

    def __str__(self) -> str:
        return (
            f"'#{self.anchor}' is not a valid anchor, neither as a "
            "plain name anchor nor as a JSON Pointer. You may have intended "
            f"to use '#/{self.anchor}', as the slash is required *before each "
            "segment* of a JSON pointer."
        )
