"""Low-level introspection utilities for [`typing`][] members.

The provided functions in this module check against both the [`typing`][] and [`typing_extensions`][]
variants, if they exists and are different.
"""
# ruff: noqa: UP006

import collections.abc
import contextlib
import re
import sys
import typing
import warnings
from textwrap import dedent
from types import FunctionType, GenericAlias
from typing import Any, Final

import typing_extensions
from typing_extensions import LiteralString, TypeAliasType, TypeIs, deprecated

__all__ = (
    'DEPRECATED_ALIASES',
    'NoneType',
    'is_annotated',
    'is_any',
    'is_classvar',
    'is_concatenate',
    'is_deprecated',
    'is_final',
    'is_forwardref',
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
)

_IS_PY310 = sys.version_info[:2] == (3, 10)


def _compile_identity_check_function(member: LiteralString, function_name: LiteralString) -> FunctionType:
    """Create a function checking that the function argument is the (unparameterized) typing `member`.

    The function will make sure to check against both the `typing` and `typing_extensions`
    variants as depending on the Python version, the `typing_extensions` variant might be different.
    For instance, on Python 3.9:

    ```pycon
    >>> from typing import Literal as t_Literal
    >>> from typing_extensions import Literal as te_Literal, get_origin

    >>> t_Literal is te_Literal
    False
    >>> get_origin(t_Literal[1])
    typing.Literal
    >>> get_origin(te_Literal[1])
    typing_extensions.Literal
    ```
    """
    in_typing = hasattr(typing, member)
    in_typing_extensions = hasattr(typing_extensions, member)

    if in_typing and in_typing_extensions:
        if getattr(typing, member) is getattr(typing_extensions, member):
            check_code = f'obj is typing.{member}'
        else:
            check_code = f'obj is typing.{member} or obj is typing_extensions.{member}'
    elif in_typing and not in_typing_extensions:
        check_code = f'obj is typing.{member}'
    elif not in_typing and in_typing_extensions:
        check_code = f'obj is typing_extensions.{member}'
    else:
        check_code = 'False'

    func_code = dedent(f"""
    def {function_name}(obj: Any, /) -> bool:
        return {check_code}
    """)

    locals_: dict[str, Any] = {}
    globals_: dict[str, Any] = {'Any': Any, 'typing': typing, 'typing_extensions': typing_extensions}
    exec(func_code, globals_, locals_)
    return locals_[function_name]


def _compile_isinstance_check_function(member: LiteralString, function_name: LiteralString) -> FunctionType:
    """Create a function checking that the function is an instance of the typing `member`.

    The function will make sure to check against both the `typing` and `typing_extensions`
    variants as depending on the Python version, the `typing_extensions` variant might be different.
    """
    in_typing = hasattr(typing, member)
    in_typing_extensions = hasattr(typing_extensions, member)

    if in_typing and in_typing_extensions:
        if getattr(typing, member) is getattr(typing_extensions, member):
            check_code = f'isinstance(obj, typing.{member})'
        else:
            check_code = f'isinstance(obj, (typing.{member}, typing_extensions.{member}))'
    elif in_typing and not in_typing_extensions:
        check_code = f'isinstance(obj, typing.{member})'
    elif not in_typing and in_typing_extensions:
        check_code = f'isinstance(obj, typing_extensions.{member})'
    else:
        check_code = 'False'

    func_code = dedent(f"""
    def {function_name}(obj: Any, /) -> 'TypeIs[{member}]':
        return {check_code}
    """)

    locals_: dict[str, Any] = {}
    globals_: dict[str, Any] = {'Any': Any, 'typing': typing, 'typing_extensions': typing_extensions}
    exec(func_code, globals_, locals_)
    return locals_[function_name]


if sys.version_info >= (3, 10):
    from types import NoneType
else:
    NoneType = type(None)

# Keep this ordered, as per `typing.__all__`:

is_annotated = _compile_identity_check_function('Annotated', 'is_annotated')
is_annotated.__doc__ = """
Return whether the argument is the [`Annotated`][typing.Annotated] [special form][].

```pycon
>>> is_annotated(Annotated)
True
>>> is_annotated(Annotated[int, ...])
False
```
"""

is_any = _compile_identity_check_function('Any', 'is_any')
is_any.__doc__ = """
Return whether the argument is the [`Any`][typing.Any] [special form][].

```pycon
>>> is_any(Any)
True
```
"""

is_classvar = _compile_identity_check_function('ClassVar', 'is_classvar')
is_classvar.__doc__ = """
Return whether the argument is the [`ClassVar`][typing.ClassVar] [type qualifier][].

```pycon
>>> is_classvar(ClassVar)
True
>>> is_classvar(ClassVar[int])
>>> False
```
"""

is_concatenate = _compile_identity_check_function('Concatenate', 'is_concatenate')
is_concatenate.__doc__ = """
Return whether the argument is the [`Concatenate`][typing.Concatenate] [special form][].

```pycon
>>> is_concatenate(Concatenate)
True
>>> is_concatenate(Concatenate[int, P])
False
```
"""

is_final = _compile_identity_check_function('Final', 'is_final')
is_final.__doc__ = """
Return whether the argument is the [`Final`][typing.Final] [type qualifier][].

```pycon
>>> is_final(Final)
True
>>> is_final(Final[int])
False
```
"""


# Unlikely to have a different version in `typing-extensions`, but keep it consistent.
# Also note that starting in 3.14, this is an alias to `annotationlib.ForwardRef`, but
# accessing it from `typing` doesn't seem to be deprecated.
is_forwardref = _compile_isinstance_check_function('ForwardRef', 'is_forwardref')
is_forwardref.__doc__ = """
Return whether the argument is an instance of [`ForwardRef`][typing.ForwardRef].

```pycon
>>> is_forwardref(ForwardRef('T'))
True
```
"""


is_generic = _compile_identity_check_function('Generic', 'is_generic')
is_generic.__doc__ = """
Return whether the argument is the [`Generic`][typing.Generic] [special form][].

```pycon
>>> is_generic(Generic)
True
>>> is_generic(Generic[T])
False
```
"""

is_literal = _compile_identity_check_function('Literal', 'is_literal')
is_literal.__doc__ = """
Return whether the argument is the [`Literal`][typing.Literal] [special form][].

```pycon
>>> is_literal(Literal)
True
>>> is_literal(Literal["a"])
False
```
"""


# `get_origin(Optional[int]) is Union`, so `is_optional()` isn't implemented.

is_paramspec = _compile_isinstance_check_function('ParamSpec', 'is_paramspec')
is_paramspec.__doc__ = """
Return whether the argument is an instance of [`ParamSpec`][typing.ParamSpec].

```pycon
>>> P = ParamSpec('P')
>>> is_paramspec(P)
True
```
"""

# Protocol?

is_typevar = _compile_isinstance_check_function('TypeVar', 'is_typevar')
is_typevar.__doc__ = """
Return whether the argument is an instance of [`TypeVar`][typing.TypeVar].

```pycon
>>> T = TypeVar('T')
>>> is_typevar(T)
True
```
"""

is_typevartuple = _compile_isinstance_check_function('TypeVarTuple', 'is_typevartuple')
is_typevartuple.__doc__ = """
Return whether the argument is an instance of [`TypeVarTuple`][typing.TypeVarTuple].

```pycon
>>> Ts = TypeVarTuple('Ts')
>>> is_typevartuple(Ts)
True
```
"""

is_union = _compile_identity_check_function('Union', 'is_union')
is_union.__doc__ = """
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
    return isinstance(obj, type) and issubclass(obj, tuple) and hasattr(obj, '_fields')  # pyright: ignore[reportUnknownArgumentType]


# TypedDict?

# BinaryIO? IO? TextIO?

is_literalstring = _compile_identity_check_function('LiteralString', 'is_literalstring')
is_literalstring.__doc__ = """
Return whether the argument is the [`LiteralString`][typing.LiteralString] [special form][].

```pycon
>>> is_literalstring(LiteralString)
True
```
"""

is_never = _compile_identity_check_function('Never', 'is_never')
is_never.__doc__ = """
Return whether the argument is the [`Never`][typing.Never] [special form][].

```pycon
>>> is_never(Never)
True
```
"""

if sys.version_info >= (3, 10):
    is_newtype = _compile_isinstance_check_function('NewType', 'is_newtype')
else:  # On Python 3.10, `NewType` is a function.

    def is_newtype(obj: Any, /) -> bool:
        return hasattr(obj, '__supertype__')


is_newtype.__doc__ = """
Return whether the argument is a [`NewType`][typing.NewType].

```pycon
>>> UserId = NewType("UserId", int)
>>> is_newtype(UserId)
True
```
"""

is_nodefault = _compile_identity_check_function('NoDefault', 'is_nodefault')
is_nodefault.__doc__ = """
Return whether the argument is the [`NoDefault`][typing.NoDefault] sentinel object.

```pycon
>>> is_nodefault(NoDefault)
True
```
"""

is_noextraitems = _compile_identity_check_function('NoExtraItems', 'is_noextraitems')
is_noextraitems.__doc__ = """
Return whether the argument is the `NoExtraItems` sentinel object.

```pycon
>>> is_noextraitems(NoExtraItems)
True
```
"""

is_noreturn = _compile_identity_check_function('NoReturn', 'is_noreturn')
is_noreturn.__doc__ = """
Return whether the argument is the [`NoReturn`][typing.NoReturn] [special form][].

```pycon
>>> is_noreturn(NoReturn)
True
>>> is_noreturn(Never)
False
```
"""

is_notrequired = _compile_identity_check_function('NotRequired', 'is_notrequired')
is_notrequired.__doc__ = """
Return whether the argument is the [`NotRequired`][typing.NotRequired] [special form][].

```pycon
>>> is_notrequired(NotRequired)
True
```
"""

is_paramspecargs = _compile_isinstance_check_function('ParamSpecArgs', 'is_paramspecargs')
is_paramspecargs.__doc__ = """
Return whether the argument is an instance of [`ParamSpecArgs`][typing.ParamSpecArgs].

```pycon
>>> P = ParamSpec('P')
>>> is_paramspecargs(P.args)
True
```
"""

is_paramspeckwargs = _compile_isinstance_check_function('ParamSpecKwargs', 'is_paramspeckwargs')
is_paramspeckwargs.__doc__ = """
Return whether the argument is an instance of [`ParamSpecKwargs`][typing.ParamSpecKwargs].

```pycon
>>> P = ParamSpec('P')
>>> is_paramspeckwargs(P.kwargs)
True
```
"""

is_readonly = _compile_identity_check_function('ReadOnly', 'is_readonly')
is_readonly.__doc__ = """
Return whether the argument is the [`ReadOnly`][typing.ReadOnly] [special form][].

```pycon
>>> is_readonly(ReadOnly)
True
```
"""

is_required = _compile_identity_check_function('Required', 'is_required')
is_required.__doc__ = """
Return whether the argument is the [`Required`][typing.Required] [special form][].

```pycon
>>> is_required(Required)
True
```
"""

is_self = _compile_identity_check_function('Self', 'is_self')
is_self.__doc__ = """
Return whether the argument is the [`Self`][typing.Self] [special form][].

```pycon
>>> is_self(Self)
True
```
"""

# TYPE_CHECKING?

is_typealias = _compile_identity_check_function('TypeAlias', 'is_typealias')
is_typealias.__doc__ = """
Return whether the argument is the [`TypeAlias`][typing.TypeAlias] [special form][].

```pycon
>>> is_typealias(TypeAlias)
True
```
"""

is_typeguard = _compile_identity_check_function('TypeGuard', 'is_typeguard')
is_typeguard.__doc__ = """
Return whether the argument is the [`TypeGuard`][typing.TypeGuard] [special form][].

```pycon
>>> is_typeguard(TypeGuard)
True
```
"""

is_typeis = _compile_identity_check_function('TypeIs', 'is_typeis')
is_typeis.__doc__ = """
Return whether the argument is the [`TypeIs`][typing.TypeIs] [special form][].

```pycon
>>> is_typeis(TypeIs)
True
```
"""

_is_typealiastype_inner = _compile_isinstance_check_function('TypeAliasType', '_is_typealiastype_inner')


if _IS_PY310:
    # Parameterized PEP 695 type aliases are instances of `types.GenericAlias` in typing_extensions>=4.13.0.
    # On Python 3.10, with `Alias[int]` being such an instance of `GenericAlias`,
    # `isinstance(Alias[int], TypeAliasType)` returns `True`.
    # See https://github.com/python/cpython/issues/89828.
    def is_typealiastype(obj: Any, /) -> 'TypeIs[TypeAliasType]':
        return type(obj) is not GenericAlias and _is_typealiastype_inner(obj)
else:
    is_typealiastype = _compile_isinstance_check_function('TypeAliasType', 'is_typealiastype')

is_typealiastype.__doc__ = """
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

is_unpack = _compile_identity_check_function('Unpack', 'is_unpack')
is_unpack.__doc__ = """
Return whether the argument is the [`Unpack`][typing.Unpack] [special form][].

```pycon
>>> is_unpack(Unpack)
True
>>> is_unpack(Unpack[Ts])
False
```
"""


if sys.version_info >= (3, 13):

    def is_deprecated(obj: Any, /) -> 'TypeIs[deprecated]':
        return isinstance(obj, (warnings.deprecated, typing_extensions.deprecated))

else:

    def is_deprecated(obj: Any, /) -> 'TypeIs[deprecated]':
        return isinstance(obj, typing_extensions.deprecated)


is_deprecated.__doc__ = """
Return whether the argument is a [`deprecated`][warnings.deprecated] instance.

This also includes the [`typing_extensions` backport][typing_extensions.deprecated].

```pycon
>>> is_deprecated(warnings.deprecated('message'))
True
>>> is_deprecated(typing_extensions.deprecated('message'))
True
```
"""


# Aliases defined in the `typing` module using `typing._SpecialGenericAlias` (itself aliased as `alias()`):
DEPRECATED_ALIASES: Final[dict[Any, type[Any]]] = {
    typing.Hashable: collections.abc.Hashable,
    typing.Awaitable: collections.abc.Awaitable,
    typing.Coroutine: collections.abc.Coroutine,
    typing.AsyncIterable: collections.abc.AsyncIterable,
    typing.AsyncIterator: collections.abc.AsyncIterator,
    typing.Iterable: collections.abc.Iterable,
    typing.Iterator: collections.abc.Iterator,
    typing.Reversible: collections.abc.Reversible,
    typing.Sized: collections.abc.Sized,
    typing.Container: collections.abc.Container,
    typing.Collection: collections.abc.Collection,
    # type ignore reason: https://github.com/python/typeshed/issues/6257:
    typing.Callable: collections.abc.Callable,  # pyright: ignore[reportAssignmentType, reportUnknownMemberType]
    typing.AbstractSet: collections.abc.Set,
    typing.MutableSet: collections.abc.MutableSet,
    typing.Mapping: collections.abc.Mapping,
    typing.MutableMapping: collections.abc.MutableMapping,
    typing.Sequence: collections.abc.Sequence,
    typing.MutableSequence: collections.abc.MutableSequence,
    typing.Tuple: tuple,
    typing.List: list,
    typing.Deque: collections.deque,
    typing.Set: set,
    typing.FrozenSet: frozenset,
    typing.MappingView: collections.abc.MappingView,
    typing.KeysView: collections.abc.KeysView,
    typing.ItemsView: collections.abc.ItemsView,
    typing.ValuesView: collections.abc.ValuesView,
    typing.Dict: dict,
    typing.DefaultDict: collections.defaultdict,
    typing.OrderedDict: collections.OrderedDict,
    typing.Counter: collections.Counter,
    typing.ChainMap: collections.ChainMap,
    typing.Generator: collections.abc.Generator,
    typing.AsyncGenerator: collections.abc.AsyncGenerator,
    typing.Type: type,
    # Defined in `typing.__getattr__`:
    typing.Pattern: re.Pattern,
    typing.Match: re.Match,
    typing.ContextManager: contextlib.AbstractContextManager,
    typing.AsyncContextManager: contextlib.AbstractAsyncContextManager,
    # Skipped: `ByteString` (deprecated, removed in 3.14)
}
"""A mapping between the deprecated typing aliases to their replacement, as per [PEP 585](https://peps.python.org/pep-0585/)."""


# Add the `typing_extensions` aliases:
for alias, target in list(DEPRECATED_ALIASES.items()):
    # Use `alias.__name__` when we drop support for Python 3.9
    if (te_alias := getattr(typing_extensions, alias._name, None)) is not None:
        DEPRECATED_ALIASES[te_alias] = target
