"""Logic for interacting with type annotations, mostly extensions, shims and hacks to wrap Python's typing module."""

from __future__ import annotations

import collections.abc
import re
import sys
import types
import typing
from functools import partial
from inspect import Signature, signature
from typing import TYPE_CHECKING, Any, Callable, cast

import typing_extensions
from typing_extensions import deprecated, get_args, get_origin
from typing_inspection import typing_objects
from typing_inspection.introspection import is_union_origin

from pydantic.version import version_short

from ._namespace_utils import GlobalsNamespace, MappingNamespace, NsResolver, get_module_ns_of

if sys.version_info < (3, 10):
    NoneType = type(None)
    EllipsisType = type(Ellipsis)
else:
    from types import EllipsisType as EllipsisType
    from types import NoneType as NoneType

if sys.version_info >= (3, 14):
    import annotationlib

if TYPE_CHECKING:
    from pydantic import BaseModel
    from pydantic.fields import FieldInfo

# As per https://typing-extensions.readthedocs.io/en/latest/#runtime-use-of-types,
# always check for both `typing` and `typing_extensions` variants of a typing construct.
# (this is implemented differently than the suggested approach in the `typing_extensions`
# docs for performance).


_t_annotated = typing.Annotated
_te_annotated = typing_extensions.Annotated


def is_annotated(tp: Any, /) -> bool:
    """Return whether the provided argument is a `Annotated` special form.

    ```python {test="skip" lint="skip"}
    is_annotated(Annotated[int, ...])
    #> True
    ```
    """
    origin = get_origin(tp)
    return origin is _t_annotated or origin is _te_annotated


def annotated_type(tp: Any, /) -> Any | None:
    """Return the type of the `Annotated` special form, or `None`."""
    return tp.__origin__ if typing_objects.is_annotated(get_origin(tp)) else None


def unpack_type(tp: Any, /) -> Any | None:
    """Return the type wrapped by the `Unpack` special form, or `None`."""
    return get_args(tp)[0] if typing_objects.is_unpack(get_origin(tp)) else None


def is_hashable(tp: Any, /) -> bool:
    """Return whether the provided argument is the `Hashable` class.

    ```python {test="skip" lint="skip"}
    is_hashable(Hashable)
    #> True
    ```
    """
    # `get_origin` is documented as normalizing any typing-module aliases to `collections` classes,
    # hence the second check:
    return tp is collections.abc.Hashable or get_origin(tp) is collections.abc.Hashable


def is_callable(tp: Any, /) -> bool:
    """Return whether the provided argument is a `Callable`, parametrized or not.

    ```python {test="skip" lint="skip"}
    is_callable(Callable[[int], str])
    #> True
    is_callable(typing.Callable)
    #> True
    is_callable(collections.abc.Callable)
    #> True
    ```
    """
    # `get_origin` is documented as normalizing any typing-module aliases to `collections` classes,
    # hence the second check:
    return tp is collections.abc.Callable or get_origin(tp) is collections.abc.Callable


_classvar_re = re.compile(r'((\w+\.)?Annotated\[)?(\w+\.)?ClassVar\[')


def is_classvar_annotation(tp: Any, /) -> bool:
    """Return whether the provided argument represents a class variable annotation.

    Although not explicitly stated by the typing specification, `ClassVar` can be used
    inside `Annotated` and as such, this function checks for this specific scenario.

    Because this function is used to detect class variables before evaluating forward references
    (or because evaluation failed), we also implement a naive regex match implementation. This is
    required because class variables are inspected before fields are collected, so we try to be
    as accurate as possible.
    """
    if typing_objects.is_classvar(tp):
        return True

    origin = get_origin(tp)

    if typing_objects.is_classvar(origin):
        return True

    if typing_objects.is_annotated(origin):
        annotated_type = tp.__origin__
        if typing_objects.is_classvar(annotated_type) or typing_objects.is_classvar(get_origin(annotated_type)):
            return True

    str_ann: str | None = None
    if isinstance(tp, typing.ForwardRef):
        str_ann = tp.__forward_arg__
    if isinstance(tp, str):
        str_ann = tp

    if str_ann is not None and _classvar_re.match(str_ann):
        # stdlib dataclasses do something similar, although a bit more advanced
        # (see `dataclass._is_type`).
        return True

    return False


_t_final = typing.Final
_te_final = typing_extensions.Final


# TODO implement `is_finalvar_annotation` as Final can be wrapped with other special forms:
def is_finalvar(tp: Any, /) -> bool:
    """Return whether the provided argument is a `Final` special form, parametrized or not.

    ```python {test="skip" lint="skip"}
    is_finalvar(Final[int])
    #> True
    is_finalvar(Final)
    #> True
    """
    # Final is not necessarily parametrized:
    if tp is _t_final or tp is _te_final:
        return True
    origin = get_origin(tp)
    return origin is _t_final or origin is _te_final


_NONE_TYPES: tuple[Any, ...] = (None, NoneType, typing.Literal[None], typing_extensions.Literal[None])


def is_none_type(tp: Any, /) -> bool:
    """Return whether the argument represents the `None` type as part of an annotation.

    ```python {test="skip" lint="skip"}
    is_none_type(None)
    #> True
    is_none_type(NoneType)
    #> True
    is_none_type(Literal[None])
    #> True
    is_none_type(type[None])
    #> False
    """
    return tp in _NONE_TYPES


def is_namedtuple(tp: Any, /) -> bool:
    """Return whether the provided argument is a named tuple class.

    The class can be created using `typing.NamedTuple` or `collections.namedtuple`.
    Parametrized generic classes are *not* assumed to be named tuples.
    """
    from ._utils import lenient_issubclass  # circ. import

    return lenient_issubclass(tp, tuple) and hasattr(tp, '_fields')


# TODO In 2.12, delete this export. It is currently defined only to not break
# pydantic-settings which relies on it:
origin_is_union = is_union_origin


def is_generic_alias(tp: Any, /) -> bool:
    return isinstance(tp, (types.GenericAlias, typing._GenericAlias))  # pyright: ignore[reportAttributeAccessIssue]


# TODO: Ideally, we should avoid relying on the private `typing` constructs:

if sys.version_info < (3, 10):
    WithArgsTypes: tuple[Any, ...] = (typing._GenericAlias, types.GenericAlias)  # pyright: ignore[reportAttributeAccessIssue]
else:
    WithArgsTypes: tuple[Any, ...] = (typing._GenericAlias, types.GenericAlias, types.UnionType)  # pyright: ignore[reportAttributeAccessIssue]


# Similarly, we shouldn't rely on this `_Final` class, which is even more private than `_GenericAlias`:
typing_base: Any = typing._Final  # pyright: ignore[reportAttributeAccessIssue]


### Annotation evaluations functions:


def parent_frame_namespace(*, parent_depth: int = 2, force: bool = False) -> dict[str, Any] | None:
    """Fetch the local namespace of the parent frame where this function is called.

    Using this function is mostly useful to resolve forward annotations pointing to members defined in a local namespace,
    such as assignments inside a function. Using the standard library tools, it is currently not possible to resolve
    such annotations:

    ```python {lint="skip" test="skip"}
    from typing import get_type_hints

    def func() -> None:
        Alias = int

        class C:
            a: 'Alias'

        # Raises a `NameError: 'Alias' is not defined`
        get_type_hints(C)
    ```

    Pydantic uses this function when a Pydantic model is being defined to fetch the parent frame locals. However,
    this only allows us to fetch the parent frame namespace and not other parents (e.g. a model defined in a function,
    itself defined in another function). Inspecting the next outer frames (using `f_back`) is not reliable enough
    (see https://discuss.python.org/t/20659).

    Because this function is mostly used to better resolve forward annotations, nothing is returned if the parent frame's
    code object is defined at the module level. In this case, the locals of the frame will be the same as the module
    globals where the class is defined (see `_namespace_utils.get_module_ns_of`). However, if you still want to fetch
    the module globals (e.g. when rebuilding a model, where the frame where the rebuild call is performed might contain
    members that you want to use for forward annotations evaluation), you can use the `force` parameter.

    Args:
        parent_depth: The depth at which to get the frame. Defaults to 2, meaning the parent frame where this function
            is called will be used.
        force: Whether to always return the frame locals, even if the frame's code object is defined at the module level.

    Returns:
        The locals of the namespace, or `None` if it was skipped as per the described logic.
    """
    frame = sys._getframe(parent_depth)

    if frame.f_code.co_name.startswith('<generic parameters of'):
        # As `parent_frame_namespace` is mostly called in `ModelMetaclass.__new__`,
        # the parent frame can be the annotation scope if the PEP 695 generic syntax is used.
        # (see https://docs.python.org/3/reference/executionmodel.html#annotation-scopes,
        # https://docs.python.org/3/reference/compound_stmts.html#generic-classes).
        # In this case, the code name is set to `<generic parameters of MyClass>`,
        # and we need to skip this frame as it is irrelevant.
        frame = cast(types.FrameType, frame.f_back)  # guaranteed to not be `None`

    # note, we don't copy frame.f_locals here (or during the last return call), because we don't expect the namespace to be
    # modified down the line if this becomes a problem, we could implement some sort of frozen mapping structure to enforce this.
    if force:
        return frame.f_locals

    # If either of the following conditions are true, the class is defined at the top module level.
    # To better understand why we need both of these checks, see
    # https://github.com/pydantic/pydantic/pull/10113#discussion_r1714981531.
    if frame.f_back is None or frame.f_code.co_name == '<module>':
        return None

    return frame.f_locals


def _type_convert(arg: Any) -> Any:
    """Convert `None` to `NoneType` and strings to `ForwardRef` instances.

    This is a backport of the private `typing._type_convert` function. When
    evaluating a type, `ForwardRef._evaluate` ends up being called, and is
    responsible for making this conversion. However, we still have to apply
    it for the first argument passed to our type evaluation functions, similarly
    to the `typing.get_type_hints` function.
    """
    if arg is None:
        return NoneType
    if isinstance(arg, str):
        # Like `typing.get_type_hints`, assume the arg can be in any context,
        # hence the proper `is_argument` and `is_class` args:
        return _make_forward_ref(arg, is_argument=False, is_class=True)
    return arg


def safe_get_annotations(obj: Any) -> dict[str, Any]:
    """Get the annotations for the provided object, accounting for potential deferred forward references.

    Starting with Python 3.14, accessing the `__annotations__` attribute might raise a `NameError` if
    a referenced symbol isn't defined yet. In this case, we return the annotation in the *forward ref*
    format.
    """
    if sys.version_info >= (3, 14):
        return annotationlib.get_annotations(obj, format=annotationlib.Format.FORWARDREF)
    else:
        # TODO just do getattr(obj, '__annotations__', {}) when dropping support for Python 3.9:
        if isinstance(obj, type):
            return obj.__dict__.get('__annotations__', {})
        else:
            return getattr(obj, '__annotations__', {})


def get_model_type_hints(
    model_class: type[BaseModel],
    *,
    ns_resolver: NsResolver | None = None,
) -> dict[str, tuple[Any, bool]]:
    """Collect annotations from a Pydantic model class, including those from parent classes.

    Args:
        model_class: The Pydantic model class to inspect.
        ns_resolver: A namespace resolver instance to use. Defaults to an empty instance.

    Returns:
        A dictionary mapping annotation names to a two-tuple: the first element is the evaluated
        type or the original annotation if a `NameError` occurred, the second element is a boolean
        indicating if whether the evaluation succeeded.
    """
    hints: dict[str, Any] | dict[str, tuple[Any, bool]] = {}
    ns_resolver = ns_resolver or NsResolver()

    for base in reversed(model_class.__mro__[:-1]):
        # For Python 3.14, we could also use `Format.VALUE` and pass the globals/locals
        # from the ns_resolver, but we want to be able to know which specific field failed
        # to evaluate:
        ann = safe_get_annotations(base)

        if not ann:
            continue

        with ns_resolver.push(base):
            base_model_fields: dict[str, FieldInfo] | None = base.__dict__.get('__pydantic_fields__')

            for name, value in ann.items():
                if name.startswith('_'):
                    globalns, localns = ns_resolver.types_namespace

                    # For private attributes, we only need the annotation to detect the `ClassVar` special form.
                    # For this reason, we still try to evaluate it, but we also catch any possible exception (on
                    # top of the `NameError`s caught in `try_eval_type`) that could happen so that users are free
                    # to use any kind of forward annotation for private fields (e.g. circular imports, new typing
                    # syntax, etc).
                    try:
                        hints[name] = try_eval_type(value, globalns, localns)
                    except Exception:
                        hints[name] = (value, False)
                else:
                    if base_model_fields is not None and name in base_model_fields:
                        # Avoid unnecessarily evaluating annotations from parent models, as we'll end up
                        # copying the `FieldInfo` instance from it anyway if we need to.
                        # We use the `annotation` attribute here, but in reality could put anything here,
                        # As we are guaranteed to not make use of it:
                        hints[name] = (base_model_fields[name].annotation, True)
                    else:
                        globalns, localns = ns_resolver.types_namespace

                        hints[name] = try_eval_type(value, globalns, localns)

    return hints


def get_cls_type_hints(
    obj: type[Any],
    *,
    ns_resolver: NsResolver | None = None,
) -> dict[str, Any]:
    """Collect annotations from a class, including those from parent classes.

    Args:
        obj: The class to inspect.
        ns_resolver: A namespace resolver instance to use. Defaults to an empty instance.
    """
    hints: dict[str, Any] = {}
    ns_resolver = ns_resolver or NsResolver()

    for base in reversed(obj.__mro__):
        # For Python 3.14, we could also use `Format.VALUE` and pass the globals/locals
        # from the ns_resolver, but we want to be able to know which specific field failed
        # to evaluate:
        ann = safe_get_annotations(base)

        if not ann:
            continue

        with ns_resolver.push(base):
            globalns, localns = ns_resolver.types_namespace
            for name, value in ann.items():
                hints[name] = eval_type(value, globalns, localns)
    return hints


def try_eval_type(
    value: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
) -> tuple[Any, bool]:
    """Try evaluating the annotation using the provided namespaces.

    Args:
        value: The value to evaluate. If `None`, it will be replaced by `type[None]`. If an instance
            of `str`, it will be converted to a `ForwardRef`.
        localns: The global namespace to use during annotation evaluation.
        globalns: The local namespace to use during annotation evaluation.

    Returns:
        A two-tuple containing the possibly evaluated type and a boolean indicating
            whether the evaluation succeeded or not.
    """
    value = _type_convert(value)

    try:
        return eval_type_backport(value, globalns, localns), True
    except NameError:
        return value, False


def eval_type(
    value: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
) -> Any:
    """Evaluate the annotation using the provided namespaces.

    Args:
        value: The value to evaluate. If `None`, it will be replaced by `type[None]`. If an instance
            of `str`, it will be converted to a `ForwardRef`.
        localns: The global namespace to use during annotation evaluation.
        globalns: The local namespace to use during annotation evaluation.
    """
    value = _type_convert(value)
    return eval_type_backport(value, globalns, localns)


@deprecated(
    '`eval_type_lenient` is deprecated, use `try_eval_type` instead.',
    category=None,
)
def eval_type_lenient(
    value: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
) -> Any:
    ev, _ = try_eval_type(value, globalns, localns)
    return ev


def eval_type_backport(
    value: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
    type_params: tuple[Any, ...] | None = None,
) -> Any:
    """An enhanced version of `typing._eval_type` which will fall back to using the `eval_type_backport`
    package if it's installed to let older Python versions use newer typing constructs.

    Specifically, this transforms `X | Y` into `typing.Union[X, Y]` and `list[X]` into `typing.List[X]`
    (as well as all the types made generic in PEP 585) if the original syntax is not supported in the
    current Python version.

    This function will also display a helpful error if the value passed fails to evaluate.
    """
    try:
        return _eval_type_backport(value, globalns, localns, type_params)
    except TypeError as e:
        if 'Unable to evaluate type annotation' in str(e):
            raise

        # If it is a `TypeError` and value isn't a `ForwardRef`, it would have failed during annotation definition.
        # Thus we assert here for type checking purposes:
        assert isinstance(value, typing.ForwardRef)

        message = f'Unable to evaluate type annotation {value.__forward_arg__!r}.'
        if sys.version_info >= (3, 11):
            e.add_note(message)
            raise
        else:
            raise TypeError(message) from e
    except RecursionError as e:
        # TODO ideally recursion errors should be checked in `eval_type` above, but `eval_type_backport`
        # is used directly in some places.
        message = (
            "If you made use of an implicit recursive type alias (e.g. `MyType = list['MyType']), "
            'consider using PEP 695 type aliases instead. For more details, refer to the documentation: '
            f'https://docs.pydantic.dev/{version_short()}/concepts/types/#named-recursive-types'
        )
        if sys.version_info >= (3, 11):
            e.add_note(message)
            raise
        else:
            raise RecursionError(f'{e.args[0]}\n{message}')


def _eval_type_backport(
    value: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
    type_params: tuple[Any, ...] | None = None,
) -> Any:
    try:
        return _eval_type(value, globalns, localns, type_params)
    except TypeError as e:
        if not (isinstance(value, typing.ForwardRef) and is_backport_fixable_error(e)):
            raise

        try:
            from eval_type_backport import eval_type_backport
        except ImportError:
            raise TypeError(
                f'Unable to evaluate type annotation {value.__forward_arg__!r}. If you are making use '
                'of the new typing syntax (unions using `|` since Python 3.10 or builtins subscripting '
                'since Python 3.9), you should either replace the use of new syntax with the existing '
                '`typing` constructs or install the `eval_type_backport` package.'
            ) from e

        return eval_type_backport(
            value,
            globalns,
            localns,  # pyright: ignore[reportArgumentType], waiting on a new `eval_type_backport` release.
            try_default=False,
        )


def _eval_type(
    value: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
    type_params: tuple[Any, ...] | None = None,
) -> Any:
    if sys.version_info >= (3, 14):
        # Starting in 3.14, `_eval_type()` does *not* apply `_type_convert()`
        # anymore. This means the `None` -> `type(None)` conversion does not apply:
        evaluated = typing._eval_type(  # type: ignore
            value,
            globalns,
            localns,
            type_params=type_params,
            # This is relevant when evaluating types from `TypedDict` classes, where string annotations
            # are automatically converted to `ForwardRef` instances with a module set. In this case,
            # Our `globalns` is irrelevant and we need to indicate `typing._eval_type()` that it should
            # infer it from the `ForwardRef.__forward_module__` attribute instead (`typing.get_type_hints()`
            # does the same). Note that this would probably be unnecessary if we properly iterated over the
            # `__orig_bases__` for TypedDicts in `get_cls_type_hints()`:
            prefer_fwd_module=True,
        )
        if evaluated is None:
            evaluated = type(None)
        return evaluated
    elif sys.version_info >= (3, 13):
        return typing._eval_type(  # type: ignore
            value, globalns, localns, type_params=type_params
        )
    else:
        return typing._eval_type(  # type: ignore
            value, globalns, localns
        )


def is_backport_fixable_error(e: TypeError) -> bool:
    msg = str(e)

    return sys.version_info < (3, 10) and msg.startswith('unsupported operand type(s) for |: ')


def signature_no_eval(f: Callable[..., Any]) -> Signature:
    """Get the signature of a callable without evaluating any annotations."""
    if sys.version_info >= (3, 14):
        from annotationlib import Format

        return signature(f, annotation_format=Format.FORWARDREF)
    else:
        return signature(f)


def get_function_type_hints(
    function: Callable[..., Any],
    *,
    include_keys: set[str] | None = None,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
) -> dict[str, Any]:
    """Return type hints for a function.

    This is similar to the `typing.get_type_hints` function, with a few differences:
    - Support `functools.partial` by using the underlying `func` attribute.
    - Do not wrap type annotation of a parameter with `Optional` if it has a default value of `None`
      (related bug: https://github.com/python/cpython/issues/90353, only fixed in 3.11+).
    """
    if isinstance(function, partial):
        annotations = safe_get_annotations(function.func)
    else:
        annotations = safe_get_annotations(function)

    if globalns is None:
        globalns = get_module_ns_of(function)
    type_params: tuple[Any, ...] | None = None
    if localns is None:
        # If localns was specified, it is assumed to already contain type params. This is because
        # Pydantic has more advanced logic to do so (see `_namespace_utils.ns_for_function`).
        type_params = getattr(function, '__type_params__', ())

    type_hints = {}
    for name, value in annotations.items():
        if include_keys is not None and name not in include_keys:
            continue
        if value is None:
            value = NoneType
        elif isinstance(value, str):
            value = _make_forward_ref(value)

        type_hints[name] = eval_type_backport(value, globalns, localns, type_params)

    return type_hints


# TODO use typing.ForwardRef directly when we stop supporting 3.9:
if sys.version_info < (3, 9, 8) or (3, 10) <= sys.version_info < (3, 10, 1):

    def _make_forward_ref(
        arg: Any,
        is_argument: bool = True,
        *,
        is_class: bool = False,
    ) -> typing.ForwardRef:
        """Wrapper for ForwardRef that accounts for the `is_class` argument missing in older versions.
        The `module` argument is omitted as it breaks <3.9.8, =3.10.0 and isn't used in the calls below.

        See https://github.com/python/cpython/pull/28560 for some background.
        The backport happened on 3.9.8, see:
        https://github.com/pydantic/pydantic/discussions/6244#discussioncomment-6275458,
        and on 3.10.1 for the 3.10 branch, see:
        https://github.com/pydantic/pydantic/issues/6912

        Implemented as EAFP with memory.
        """
        return typing.ForwardRef(arg, is_argument)  # pyright: ignore[reportCallIssue]

else:
    _make_forward_ref = typing.ForwardRef  # pyright: ignore[reportAssignmentType]


if sys.version_info >= (3, 10):
    get_type_hints = typing.get_type_hints

else:
    """
    For older versions of python, we have a custom implementation of `get_type_hints` which is a close as possible to
    the implementation in CPython 3.10.8.
    """

    @typing.no_type_check
    def get_type_hints(  # noqa: C901
        obj: Any,
        globalns: dict[str, Any] | None = None,
        localns: dict[str, Any] | None = None,
        include_extras: bool = False,
    ) -> dict[str, Any]:  # pragma: no cover
        """Taken verbatim from python 3.10.8 unchanged, except:
        * type annotations of the function definition above.
        * prefixing `typing.` where appropriate
        * Use `_make_forward_ref` instead of `typing.ForwardRef` to handle the `is_class` argument.

        https://github.com/python/cpython/blob/aaaf5174241496afca7ce4d4584570190ff972fe/Lib/typing.py#L1773-L1875

        DO NOT CHANGE THIS METHOD UNLESS ABSOLUTELY NECESSARY.
        ======================================================

        Return type hints for an object.

        This is often the same as obj.__annotations__, but it handles
        forward references encoded as string literals, adds Optional[t] if a
        default value equal to None is set and recursively replaces all
        'Annotated[T, ...]' with 'T' (unless 'include_extras=True').

        The argument may be a module, class, method, or function. The annotations
        are returned as a dictionary. For classes, annotations include also
        inherited members.

        TypeError is raised if the argument is not of a type that can contain
        annotations, and an empty dictionary is returned if no annotations are
        present.

        BEWARE -- the behavior of globalns and localns is counterintuitive
        (unless you are familiar with how eval() and exec() work).  The
        search order is locals first, then globals.

        - If no dict arguments are passed, an attempt is made to use the
          globals from obj (or the respective module's globals for classes),
          and these are also used as the locals.  If the object does not appear
          to have globals, an empty dictionary is used.  For classes, the search
          order is globals first then locals.

        - If one dict argument is passed, it is used for both globals and
          locals.

        - If two dict arguments are passed, they specify globals and
          locals, respectively.
        """
        if getattr(obj, '__no_type_check__', None):
            return {}
        # Classes require a special treatment.
        if isinstance(obj, type):
            hints = {}
            for base in reversed(obj.__mro__):
                if globalns is None:
                    base_globals = getattr(sys.modules.get(base.__module__, None), '__dict__', {})
                else:
                    base_globals = globalns
                ann = base.__dict__.get('__annotations__', {})
                if isinstance(ann, types.GetSetDescriptorType):
                    ann = {}
                base_locals = dict(vars(base)) if localns is None else localns
                if localns is None and globalns is None:
                    # This is surprising, but required.  Before Python 3.10,
                    # get_type_hints only evaluated the globalns of
                    # a class.  To maintain backwards compatibility, we reverse
                    # the globalns and localns order so that eval() looks into
                    # *base_globals* first rather than *base_locals*.
                    # This only affects ForwardRefs.
                    base_globals, base_locals = base_locals, base_globals
                for name, value in ann.items():
                    if value is None:
                        value = type(None)
                    if isinstance(value, str):
                        value = _make_forward_ref(value, is_argument=False, is_class=True)

                    value = eval_type_backport(value, base_globals, base_locals)
                    hints[name] = value
            if not include_extras and hasattr(typing, '_strip_annotations'):
                return {
                    k: typing._strip_annotations(t)  # type: ignore
                    for k, t in hints.items()
                }
            else:
                return hints

        if globalns is None:
            if isinstance(obj, types.ModuleType):
                globalns = obj.__dict__
            else:
                nsobj = obj
                # Find globalns for the unwrapped object.
                while hasattr(nsobj, '__wrapped__'):
                    nsobj = nsobj.__wrapped__
                globalns = getattr(nsobj, '__globals__', {})
            if localns is None:
                localns = globalns
        elif localns is None:
            localns = globalns
        hints = getattr(obj, '__annotations__', None)
        if hints is None:
            # Return empty annotations for something that _could_ have them.
            if isinstance(obj, typing._allowed_types):  # type: ignore
                return {}
            else:
                raise TypeError(f'{obj!r} is not a module, class, method, or function.')
        defaults = typing._get_defaults(obj)  # type: ignore
        hints = dict(hints)
        for name, value in hints.items():
            if value is None:
                value = type(None)
            if isinstance(value, str):
                # class-level forward refs were handled above, this must be either
                # a module-level annotation or a function argument annotation

                value = _make_forward_ref(
                    value,
                    is_argument=not isinstance(obj, types.ModuleType),
                    is_class=False,
                )
            value = eval_type_backport(value, globalns, localns)
            if name in defaults and defaults[name] is None:
                value = typing.Optional[value]
            hints[name] = value
        return hints if include_extras else {k: typing._strip_annotations(t) for k, t in hints.items()}  # type: ignore
