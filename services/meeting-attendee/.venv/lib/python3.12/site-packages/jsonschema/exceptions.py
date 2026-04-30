"""
Validation errors, and some surrounding helpers.
"""
from __future__ import annotations

from collections import defaultdict, deque
from pprint import pformat
from textwrap import dedent, indent
from typing import TYPE_CHECKING, Any, ClassVar
import heapq
import re
import warnings

from attrs import define
from referencing.exceptions import Unresolvable as _Unresolvable

from jsonschema import _utils

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, MutableMapping, Sequence

    from jsonschema import _types

WEAK_MATCHES: frozenset[str] = frozenset(["anyOf", "oneOf"])
STRONG_MATCHES: frozenset[str] = frozenset()

_JSON_PATH_COMPATIBLE_PROPERTY_PATTERN = re.compile("^[a-zA-Z][a-zA-Z0-9_]*$")

_unset = _utils.Unset()


def _pretty(thing: Any, prefix: str):
    """
    Format something for an error message as prettily as we currently can.
    """
    return indent(pformat(thing, width=72, sort_dicts=False), prefix).lstrip()


def __getattr__(name):
    if name == "RefResolutionError":
        warnings.warn(
            _RefResolutionError._DEPRECATION_MESSAGE,
            DeprecationWarning,
            stacklevel=2,
        )
        return _RefResolutionError
    raise AttributeError(f"module {__name__} has no attribute {name}")


class _Error(Exception):

    _word_for_schema_in_error_message: ClassVar[str]
    _word_for_instance_in_error_message: ClassVar[str]

    def __init__(
        self,
        message: str,
        validator: str = _unset,  # type: ignore[assignment]
        path: Iterable[str | int] = (),
        cause: Exception | None = None,
        context=(),
        validator_value: Any = _unset,
        instance: Any = _unset,
        schema: Mapping[str, Any] | bool = _unset,  # type: ignore[assignment]
        schema_path: Iterable[str | int] = (),
        parent: _Error | None = None,
        type_checker: _types.TypeChecker = _unset,  # type: ignore[assignment]
    ) -> None:
        super().__init__(
            message,
            validator,
            path,
            cause,
            context,
            validator_value,
            instance,
            schema,
            schema_path,
            parent,
        )
        self.message = message
        self.path = self.relative_path = deque(path)
        self.schema_path = self.relative_schema_path = deque(schema_path)
        self.context = list(context)
        self.cause = self.__cause__ = cause
        self.validator = validator
        self.validator_value = validator_value
        self.instance = instance
        self.schema = schema
        self.parent = parent
        self._type_checker = type_checker

        for error in context:
            error.parent = self

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}: {self.message!r}>"

    def __str__(self) -> str:
        essential_for_verbose = (
            self.validator, self.validator_value, self.instance, self.schema,
        )
        if any(m is _unset for m in essential_for_verbose):
            return self.message

        schema_path = _utils.format_as_index(
            container=self._word_for_schema_in_error_message,
            indices=list(self.relative_schema_path)[:-1],
        )
        instance_path = _utils.format_as_index(
            container=self._word_for_instance_in_error_message,
            indices=self.relative_path,
        )
        prefix = 16 * " "

        return dedent(
            f"""\
            {self.message}

            Failed validating {self.validator!r} in {schema_path}:
                {_pretty(self.schema, prefix=prefix)}

            On {instance_path}:
                {_pretty(self.instance, prefix=prefix)}
            """.rstrip(),
        )

    @classmethod
    def create_from(cls, other: _Error):
        return cls(**other._contents())

    @property
    def absolute_path(self) -> Sequence[str | int]:
        parent = self.parent
        if parent is None:
            return self.relative_path

        path = deque(self.relative_path)
        path.extendleft(reversed(parent.absolute_path))
        return path

    @property
    def absolute_schema_path(self) -> Sequence[str | int]:
        parent = self.parent
        if parent is None:
            return self.relative_schema_path

        path = deque(self.relative_schema_path)
        path.extendleft(reversed(parent.absolute_schema_path))
        return path

    @property
    def json_path(self) -> str:
        path = "$"
        for elem in self.absolute_path:
            if isinstance(elem, int):
                path += "[" + str(elem) + "]"
            elif _JSON_PATH_COMPATIBLE_PROPERTY_PATTERN.match(elem):
                path += "." + elem
            else:
                escaped_elem = elem.replace("\\", "\\\\").replace("'", r"\'")
                path += "['" + escaped_elem + "']"
        return path

    def _set(
        self,
        type_checker: _types.TypeChecker | None = None,
        **kwargs: Any,
    ) -> None:
        if type_checker is not None and self._type_checker is _unset:
            self._type_checker = type_checker

        for k, v in kwargs.items():
            if getattr(self, k) is _unset:
                setattr(self, k, v)

    def _contents(self):
        attrs = (
            "message", "cause", "context", "validator", "validator_value",
            "path", "schema_path", "instance", "schema", "parent",
        )
        return {attr: getattr(self, attr) for attr in attrs}

    def _matches_type(self) -> bool:
        try:
            # We ignore this as we want to simply crash if this happens
            expected = self.schema["type"]  # type: ignore[index]
        except (KeyError, TypeError):
            return False

        if isinstance(expected, str):
            return self._type_checker.is_type(self.instance, expected)

        return any(
            self._type_checker.is_type(self.instance, expected_type)
            for expected_type in expected
        )


class ValidationError(_Error):
    """
    An instance was invalid under a provided schema.
    """

    _word_for_schema_in_error_message = "schema"
    _word_for_instance_in_error_message = "instance"


class SchemaError(_Error):
    """
    A schema was invalid under its corresponding metaschema.
    """

    _word_for_schema_in_error_message = "metaschema"
    _word_for_instance_in_error_message = "schema"


@define(slots=False)
class _RefResolutionError(Exception):  # noqa: PLW1641
    """
    A ref could not be resolved.
    """

    _DEPRECATION_MESSAGE = (
        "jsonschema.exceptions.RefResolutionError is deprecated as of version "
        "4.18.0. If you wish to catch potential reference resolution errors, "
        "directly catch referencing.exceptions.Unresolvable."
    )

    _cause: Exception

    def __eq__(self, other):
        if self.__class__ is not other.__class__:
            return NotImplemented  # pragma: no cover -- uncovered but deprecated  # noqa: E501
        return self._cause == other._cause

    def __str__(self) -> str:
        return str(self._cause)


class _WrappedReferencingError(_RefResolutionError, _Unresolvable):  # pragma: no cover -- partially uncovered but to be removed  # noqa: E501
    def __init__(self, cause: _Unresolvable):
        object.__setattr__(self, "_wrapped", cause)

    def __eq__(self, other):
        if other.__class__ is self.__class__:
            return self._wrapped == other._wrapped
        elif other.__class__ is self._wrapped.__class__:
            return self._wrapped == other
        return NotImplemented

    def __getattr__(self, attr):
        return getattr(self._wrapped, attr)

    def __hash__(self):
        return hash(self._wrapped)

    def __repr__(self):
        return f"<WrappedReferencingError {self._wrapped!r}>"

    def __str__(self):
        return f"{self._wrapped.__class__.__name__}: {self._wrapped}"


class UndefinedTypeCheck(Exception):
    """
    A type checker was asked to check a type it did not have registered.
    """

    def __init__(self, type: str) -> None:
        self.type = type

    def __str__(self) -> str:
        return f"Type {self.type!r} is unknown to this type checker"


class UnknownType(Exception):
    """
    A validator was asked to validate an instance against an unknown type.
    """

    def __init__(self, type, instance, schema):
        self.type = type
        self.instance = instance
        self.schema = schema

    def __str__(self):
        prefix = 16 * " "

        return dedent(
            f"""\
            Unknown type {self.type!r} for validator with schema:
                {_pretty(self.schema, prefix=prefix)}

            While checking instance:
                {_pretty(self.instance, prefix=prefix)}
            """.rstrip(),
        )


class FormatError(Exception):
    """
    Validating a format failed.
    """

    def __init__(self, message, cause=None):
        super().__init__(message, cause)
        self.message = message
        self.cause = self.__cause__ = cause

    def __str__(self):
        return self.message


class ErrorTree:
    """
    ErrorTrees make it easier to check which validations failed.
    """

    _instance = _unset

    def __init__(self, errors: Iterable[ValidationError] = ()):
        self.errors: MutableMapping[str, ValidationError] = {}
        self._contents: Mapping[str, ErrorTree] = defaultdict(self.__class__)

        for error in errors:
            container = self
            for element in error.path:
                container = container[element]
            container.errors[error.validator] = error

            container._instance = error.instance

    def __contains__(self, index: str | int):
        """
        Check whether ``instance[index]`` has any errors.
        """
        return index in self._contents

    def __getitem__(self, index):
        """
        Retrieve the child tree one level down at the given ``index``.

        If the index is not in the instance that this tree corresponds
        to and is not known by this tree, whatever error would be raised
        by ``instance.__getitem__`` will be propagated (usually this is
        some subclass of `LookupError`.
        """
        if self._instance is not _unset and index not in self:
            self._instance[index]
        return self._contents[index]

    def __setitem__(self, index: str | int, value: ErrorTree):
        """
        Add an error to the tree at the given ``index``.

        .. deprecated:: v4.20.0

            Setting items on an `ErrorTree` is deprecated without replacement.
            To populate a tree, provide all of its sub-errors when you
            construct the tree.
        """
        warnings.warn(
            "ErrorTree.__setitem__ is deprecated without replacement.",
            DeprecationWarning,
            stacklevel=2,
        )
        self._contents[index] = value  # type: ignore[index]

    def __iter__(self):
        """
        Iterate (non-recursively) over the indices in the instance with errors.
        """
        return iter(self._contents)

    def __len__(self):
        """
        Return the `total_errors`.
        """
        return self.total_errors

    def __repr__(self):
        total = len(self)
        errors = "error" if total == 1 else "errors"
        return f"<{self.__class__.__name__} ({total} total {errors})>"

    @property
    def total_errors(self):
        """
        The total number of errors in the entire tree, including children.
        """
        child_errors = sum(len(tree) for _, tree in self._contents.items())
        return len(self.errors) + child_errors


def by_relevance(weak=WEAK_MATCHES, strong=STRONG_MATCHES):
    """
    Create a key function that can be used to sort errors by relevance.

    Arguments:
        weak (set):
            a collection of validation keywords to consider to be
            "weak".  If there are two errors at the same level of the
            instance and one is in the set of weak validation keywords,
            the other error will take priority. By default, :kw:`anyOf`
            and :kw:`oneOf` are considered weak keywords and will be
            superseded by other same-level validation errors.

        strong (set):
            a collection of validation keywords to consider to be
            "strong"

    """

    def relevance(error):
        validator = error.validator
        return (                        # prefer errors which are ...
            -len(error.path),           # 'deeper' and thereby more specific
            error.path,                 # earlier (for sibling errors)
            validator not in weak,      # for a non-low-priority keyword
            validator in strong,        # for a high priority keyword
            not error._matches_type(),  # at least match the instance's type
        )                               # otherwise we'll treat them the same

    return relevance


relevance = by_relevance()
"""
A key function (e.g. to use with `sorted`) which sorts errors by relevance.

Example:

.. code:: python

    sorted(validator.iter_errors(12), key=jsonschema.exceptions.relevance)
"""


def best_match(errors, key=relevance):
    """
    Try to find an error that appears to be the best match among given errors.

    In general, errors that are higher up in the instance (i.e. for which
    `ValidationError.path` is shorter) are considered better matches,
    since they indicate "more" is wrong with the instance.

    If the resulting match is either :kw:`oneOf` or :kw:`anyOf`, the
    *opposite* assumption is made -- i.e. the deepest error is picked,
    since these keywords only need to match once, and any other errors
    may not be relevant.

    Arguments:
        errors (collections.abc.Iterable):

            the errors to select from. Do not provide a mixture of
            errors from different validation attempts (i.e. from
            different instances or schemas), since it won't produce
            sensical output.

        key (collections.abc.Callable):

            the key to use when sorting errors. See `relevance` and
            transitively `by_relevance` for more details (the default is
            to sort with the defaults of that function). Changing the
            default is only useful if you want to change the function
            that rates errors but still want the error context descent
            done by this function.

    Returns:
        the best matching error, or ``None`` if the iterable was empty

    .. note::

        This function is a heuristic. Its return value may change for a given
        set of inputs from version to version if better heuristics are added.

    """
    best = max(errors, key=key, default=None)
    if best is None:
        return

    while best.context:
        # Calculate the minimum via nsmallest, because we don't recurse if
        # all nested errors have the same relevance (i.e. if min == max == all)
        smallest = heapq.nsmallest(2, best.context, key=key)
        if len(smallest) == 2 and key(smallest[0]) == key(smallest[1]):  # noqa: PLR2004
            return best
        best = smallest[0]
    return best
