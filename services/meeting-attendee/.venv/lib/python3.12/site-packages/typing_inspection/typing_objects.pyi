# Stub file generated using:
# `stubgen --inspect-mode --include-docstrings -m typing_inspection.typing_objects`
# (manual edits need to be applied).
"""Low-level introspection utilities for [`typing`][] members.

The provided functions in this module check against both the [`typing`][] and [`typing_extensions`][]
variants, if they exists and are different.
"""

import sys
from typing import Any, Final, ForwardRef, NewType, TypeVar

from typing_extensions import ParamSpec, ParamSpecArgs, ParamSpecKwargs, TypeAliasType, TypeIs, TypeVarTuple, deprecated

__all__ = [
    'DEPRECATED_ALIASES',
    'NoneType',
    'is_annotated',
    'is_any',
    'is_classvar',
    'is_concatenate',
    'is_deprecated',
    'is_final',
    'is_generic',
    'is_literal',
    'is_literalstring',
    'is_namedtuple',
    'is_never',
    'is_newtype',
    'is_nodefault',
    'is_noextraitems',
    'is_noreturn',
    'is_notrequired',
    'is_paramspec',
    'is_paramspecargs',
    'is_paramspeckwargs',
    'is_readonly',
    'is_required',
    'is_self',
    'is_typealias',
    'is_typealiastype',
    'is_typeguard',
    'is_typeis',
    'is_typevar',
    'is_typevartuple',
    'is_union',
    'is_unpack',
]

if sys.version_info >= (3, 10):
    from types import NoneType
else:
    NoneType = type(None)

def is_annotated(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Annotated`][typing.Annotated] [special form][].

    ```pycon
    >>> is_annotated(Annotated)
    True
    >>> is_annotated(Annotated[int, ...])
    False
    ```
    """

def is_any(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Any`][typing.Any] [special form][].

    ```pycon
    >>> is_any(Any)
    True
    ```
    """

def is_classvar(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`ClassVar`][typing.ClassVar] [type qualifier][].

    ```pycon
    >>> is_classvar(ClassVar)
    True
    >>> is_classvar(ClassVar[int])
    >>> False
    ```
    """

def is_concatenate(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Concatenate`][typing.Concatenate] [special form][].

    ```pycon
    >>> is_concatenate(Concatenate)
    True
    >>> is_concatenate(Concatenate[int, P])
    False
    ```
    """

def is_final(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Final`][typing.Final] [type qualifier][].

    ```pycon
    >>> is_final(Final)
    True
    >>> is_final(Final[int])
    False
    ```
    """

def is_forwardref(obj: Any, /) -> TypeIs[ForwardRef]:
    """
    Return whether the argument is an instance of [`ForwardRef`][typing.ForwardRef].

    ```pycon
    >>> is_forwardref(ForwardRef('T'))
    True
    ```
    """

def is_generic(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Generic`][typing.Generic] [special form][].

    ```pycon
    >>> is_generic(Generic)
    True
    >>> is_generic(Generic[T])
    False
    ```
    """

def is_literal(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Literal`][typing.Literal] [special form][].

    ```pycon
    >>> is_literal(Literal)
    True
    >>> is_literal(Literal["a"])
    False
    ```
    """

def is_paramspec(obj: Any, /) -> TypeIs[ParamSpec]:
    """
    Return whether the argument is an instance of [`ParamSpec`][typing.ParamSpec].

    ```pycon
    >>> P = ParamSpec('P')
    >>> is_paramspec(P)
    True
    ```
    """

def is_typevar(obj: Any, /) -> TypeIs[TypeVar]:
    """
    Return whether the argument is an instance of [`TypeVar`][typing.TypeVar].

    ```pycon
    >>> T = TypeVar('T')
    >>> is_typevar(T)
    True
    ```
    """

def is_typevartuple(obj: Any, /) -> TypeIs[TypeVarTuple]:
    """
    Return whether the argument is an instance of [`TypeVarTuple`][typing.TypeVarTuple].

    ```pycon
    >>> Ts = TypeVarTuple('Ts')
    >>> is_typevartuple(Ts)
    True
    ```
    """

def is_union(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Union`][typing.Union] [special form][].

    This function can also be used to check for the [`Optional`][typing.Optional] [special form][],
    as at runtime, `Optional[int]` is equivalent to `Union[int, None]`.

    ```pycon
    >>> is_union(Union)
    True
    >>> is_union(Union[int, str])
    False
    ```

    !!! warning
        This does not check for unions using the [new syntax][types-union] (e.g. `int | str`).
    """

def is_namedtuple(obj: Any, /) -> bool:
    """Return whether the argument is a named tuple type.

    This includes [`NamedTuple`][typing.NamedTuple] subclasses and classes created from the
    [`collections.namedtuple`][] factory function.

    ```pycon
    >>> class User(NamedTuple):
    ...     name: str
    ...
    >>> is_namedtuple(User)
    True
    >>> City = collections.namedtuple('City', [])
    >>> is_namedtuple(City)
    True
    >>> is_namedtuple(NamedTuple)
    False
    ```
    """

def is_literalstring(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`LiteralString`][typing.LiteralString] [special form][].

    ```pycon
    >>> is_literalstring(LiteralString)
    True
    ```
    """

def is_never(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Never`][typing.Never] [special form][].

    ```pycon
    >>> is_never(Never)
    True
    ```
    """

def is_newtype(obj: Any, /) -> TypeIs[NewType]:
    """
    Return whether the argument is a [`NewType`][typing.NewType].

    ```pycon
    >>> UserId = NewType("UserId", int)
    >>> is_newtype(UserId)
    True
    ```
    """

def is_nodefault(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`NoDefault`][typing.NoDefault] sentinel object.

    ```pycon
    >>> is_nodefault(NoDefault)
    True
    ```
    """

def is_noextraitems(obj: Any, /) -> bool:
    """
    Return whether the argument is the `NoExtraItems` sentinel object.

    ```pycon
    >>> is_noextraitems(NoExtraItems)
    True
    ```
    """

def is_noreturn(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`NoReturn`][typing.NoReturn] [special form][].

    ```pycon
    >>> is_noreturn(NoReturn)
    True
    >>> is_noreturn(Never)
    False
    ```
    """

def is_notrequired(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`NotRequired`][typing.NotRequired] [special form][].

    ```pycon
    >>> is_notrequired(NotRequired)
    True
    ```
    """

def is_paramspecargs(obj: Any, /) -> TypeIs[ParamSpecArgs]:
    """
    Return whether the argument is an instance of [`ParamSpecArgs`][typing.ParamSpecArgs].

    ```pycon
    >>> P = ParamSpec('P')
    >>> is_paramspecargs(P.args)
    True
    ```
    """

def is_paramspeckwargs(obj: Any, /) -> TypeIs[ParamSpecKwargs]:
    """
    Return whether the argument is an instance of [`ParamSpecKwargs`][typing.ParamSpecKwargs].

    ```pycon
    >>> P = ParamSpec('P')
    >>> is_paramspeckwargs(P.kwargs)
    True
    ```
    """

def is_readonly(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`ReadOnly`][typing.ReadOnly] [special form][].

    ```pycon
    >>> is_readonly(ReadOnly)
    True
    ```
    """

def is_required(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Required`][typing.Required] [special form][].

    ```pycon
    >>> is_required(Required)
    True
    ```
    """

def is_self(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Self`][typing.Self] [special form][].

    ```pycon
    >>> is_self(Self)
    True
    ```
    """

def is_typealias(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`TypeAlias`][typing.TypeAlias] [special form][].

    ```pycon
    >>> is_typealias(TypeAlias)
    True
    ```
    """

def is_typeguard(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`TypeGuard`][typing.TypeGuard] [special form][].

    ```pycon
    >>> is_typeguard(TypeGuard)
    True
    ```
    """

def is_typeis(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`TypeIs`][typing.TypeIs] [special form][].

    ```pycon
    >>> is_typeis(TypeIs)
    True
    ```
    """

def is_typealiastype(obj: Any, /) -> TypeIs[TypeAliasType]:
    """
    Return whether the argument is a [`TypeAliasType`][typing.TypeAliasType] instance.

    ```pycon
    >>> type MyInt = int
    >>> is_typealiastype(MyInt)
    True
    >>> MyStr = TypeAliasType("MyStr", str)
    >>> is_typealiastype(MyStr):
    True
    >>> type MyList[T] = list[T]
    >>> is_typealiastype(MyList[int])
    False
    ```
    """

def is_unpack(obj: Any, /) -> bool:
    """
    Return whether the argument is the [`Unpack`][typing.Unpack] [special form][].

    ```pycon
    >>> is_unpack(Unpack)
    True
    >>> is_unpack(Unpack[Ts])
    False
    ```
    """

def is_deprecated(obj: Any, /) -> TypeIs[deprecated]:
    """
    Return whether the argument is a [`deprecated`][warnings.deprecated] instance.

    This also includes the [`typing_extensions` backport][typing_extensions.deprecated].

    ```pycon
    >>> is_deprecated(warnings.deprecated('message'))
    True
    >>> is_deprecated(typing_extensions.deprecated('deprecated'))
    True
    ```
    """

DEPRECATED_ALIASES: Final[dict[Any, type[Any]]]
"""A mapping between the deprecated typing aliases to their replacement, as per [PEP 585](https://peps.python.org/pep-0585/)."""
