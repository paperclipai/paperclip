"""Logic related to validators applied to models etc. via the `@field_validator` and `@model_validator` decorators."""

from __future__ import annotations as _annotations

import types
from collections import deque
from collections.abc import Iterable
from copy import copy
from dataclasses import dataclass, field
from functools import cached_property, partial, partialmethod
from inspect import Parameter, Signature, isdatadescriptor, ismethoddescriptor
from itertools import islice
from typing import TYPE_CHECKING, Any, Callable, ClassVar, Generic, Literal, TypeVar, Union

from pydantic_core import PydanticUndefined, PydanticUndefinedType, core_schema
from typing_extensions import Self, TypeAlias, is_typeddict

from ..errors import PydanticUserError
from ._core_utils import get_type_ref
from ._internal_dataclass import slots_true
from ._namespace_utils import GlobalsNamespace, MappingNamespace
from ._typing_extra import get_function_type_hints, signature_no_eval
from ._utils import can_be_positional

if TYPE_CHECKING:
    from ..fields import ComputedFieldInfo
    from ..functional_validators import FieldValidatorModes
    from ._config import ConfigWrapper


@dataclass(**slots_true)
class ValidatorDecoratorInfo:
    """A container for data from `@validator` so that we can access it
    while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@validator'.
        fields: A tuple of field names the validator should be called on.
        mode: The proposed validator mode.
        each_item: For complex objects (sets, lists etc.) whether to validate individual
            elements rather than the whole object.
        always: Whether this method and other validators should be called even if the value is missing.
        check_fields: Whether to check that the fields actually exist on the model.
    """

    decorator_repr: ClassVar[str] = '@validator'

    fields: tuple[str, ...]
    mode: Literal['before', 'after']
    each_item: bool
    always: bool
    check_fields: bool | None


@dataclass(**slots_true)
class FieldValidatorDecoratorInfo:
    """A container for data from `@field_validator` so that we can access it
    while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@field_validator'.
        fields: A tuple of field names the validator should be called on.
        mode: The proposed validator mode.
        check_fields: Whether to check that the fields actually exist on the model.
        json_schema_input_type: The input type of the function. This is only used to generate
            the appropriate JSON Schema (in validation mode) and can only specified
            when `mode` is either `'before'`, `'plain'` or `'wrap'`.
    """

    decorator_repr: ClassVar[str] = '@field_validator'

    fields: tuple[str, ...]
    mode: FieldValidatorModes
    check_fields: bool | None
    json_schema_input_type: Any


@dataclass(**slots_true)
class RootValidatorDecoratorInfo:
    """A container for data from `@root_validator` so that we can access it
    while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@root_validator'.
        mode: The proposed validator mode.
    """

    decorator_repr: ClassVar[str] = '@root_validator'
    mode: Literal['before', 'after']


@dataclass(**slots_true)
class FieldSerializerDecoratorInfo:
    """A container for data from `@field_serializer` so that we can access it
    while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@field_serializer'.
        fields: A tuple of field names the serializer should be called on.
        mode: The proposed serializer mode.
        return_type: The type of the serializer's return value.
        when_used: The serialization condition. Accepts a string with values `'always'`, `'unless-none'`, `'json'`,
            and `'json-unless-none'`.
        check_fields: Whether to check that the fields actually exist on the model.
    """

    decorator_repr: ClassVar[str] = '@field_serializer'
    fields: tuple[str, ...]
    mode: Literal['plain', 'wrap']
    return_type: Any
    when_used: core_schema.WhenUsed
    check_fields: bool | None


@dataclass(**slots_true)
class ModelSerializerDecoratorInfo:
    """A container for data from `@model_serializer` so that we can access it
    while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@model_serializer'.
        mode: The proposed serializer mode.
        return_type: The type of the serializer's return value.
        when_used: The serialization condition. Accepts a string with values `'always'`, `'unless-none'`, `'json'`,
            and `'json-unless-none'`.
    """

    decorator_repr: ClassVar[str] = '@model_serializer'
    mode: Literal['plain', 'wrap']
    return_type: Any
    when_used: core_schema.WhenUsed


@dataclass(**slots_true)
class ModelValidatorDecoratorInfo:
    """A container for data from `@model_validator` so that we can access it
    while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@model_validator'.
        mode: The proposed serializer mode.
    """

    decorator_repr: ClassVar[str] = '@model_validator'
    mode: Literal['wrap', 'before', 'after']


DecoratorInfo: TypeAlias = """Union[
    ValidatorDecoratorInfo,
    FieldValidatorDecoratorInfo,
    RootValidatorDecoratorInfo,
    FieldSerializerDecoratorInfo,
    ModelSerializerDecoratorInfo,
    ModelValidatorDecoratorInfo,
    ComputedFieldInfo,
]"""

ReturnType = TypeVar('ReturnType')
DecoratedType: TypeAlias = (
    'Union[classmethod[Any, Any, ReturnType], staticmethod[Any, ReturnType], Callable[..., ReturnType], property]'
)


@dataclass  # can't use slots here since we set attributes on `__post_init__`
class PydanticDescriptorProxy(Generic[ReturnType]):
    """Wrap a classmethod, staticmethod, property or unbound function
    and act as a descriptor that allows us to detect decorated items
    from the class' attributes.

    This class' __get__ returns the wrapped item's __get__ result,
    which makes it transparent for classmethods and staticmethods.

    Attributes:
        wrapped: The decorator that has to be wrapped.
        decorator_info: The decorator info.
        shim: A wrapper function to wrap V1 style function.
    """

    wrapped: DecoratedType[ReturnType]
    decorator_info: DecoratorInfo
    shim: Callable[[Callable[..., Any]], Callable[..., Any]] | None = None

    def __post_init__(self):
        for attr in 'setter', 'deleter':
            if hasattr(self.wrapped, attr):
                f = partial(self._call_wrapped_attr, name=attr)
                setattr(self, attr, f)

    def _call_wrapped_attr(self, func: Callable[[Any], None], *, name: str) -> PydanticDescriptorProxy[ReturnType]:
        self.wrapped = getattr(self.wrapped, name)(func)
        if isinstance(self.wrapped, property):
            # update ComputedFieldInfo.wrapped_property
            from ..fields import ComputedFieldInfo

            if isinstance(self.decorator_info, ComputedFieldInfo):
                self.decorator_info.wrapped_property = self.wrapped
        return self

    def __get__(self, obj: object | None, obj_type: type[object] | None = None) -> PydanticDescriptorProxy[ReturnType]:
        try:
            return self.wrapped.__get__(obj, obj_type)  # pyright: ignore[reportReturnType]
        except AttributeError:
            # not a descriptor, e.g. a partial object
            return self.wrapped  # type: ignore[return-value]

    def __set_name__(self, instance: Any, name: str) -> None:
        if hasattr(self.wrapped, '__set_name__'):
            self.wrapped.__set_name__(instance, name)  # pyright: ignore[reportFunctionMemberAccess]

    def __getattr__(self, name: str, /) -> Any:
        """Forward checks for __isabstractmethod__ and such."""
        return getattr(self.wrapped, name)


DecoratorInfoType = TypeVar('DecoratorInfoType', bound=DecoratorInfo)


@dataclass(**slots_true)
class Decorator(Generic[DecoratorInfoType]):
    """A generic container class to join together the decorator metadata
    (metadata from decorator itself, which we have when the
    decorator is called but not when we are building the core-schema)
    and the bound function (which we have after the class itself is created).

    Attributes:
        cls_ref: The class ref.
        cls_var_name: The decorated function name.
        func: The decorated function.
        shim: A wrapper function to wrap V1 style function.
        info: The decorator info.
    """

    cls_ref: str
    cls_var_name: str
    func: Callable[..., Any]
    shim: Callable[[Any], Any] | None
    info: DecoratorInfoType

    @staticmethod
    def build(
        cls_: Any,
        *,
        cls_var_name: str,
        shim: Callable[[Any], Any] | None,
        info: DecoratorInfoType,
    ) -> Decorator[DecoratorInfoType]:
        """Build a new decorator.

        Args:
            cls_: The class.
            cls_var_name: The decorated function name.
            shim: A wrapper function to wrap V1 style function.
            info: The decorator info.

        Returns:
            The new decorator instance.
        """
        func = get_attribute_from_bases(cls_, cls_var_name)
        if shim is not None:
            func = shim(func)
        func = unwrap_wrapped_function(func, unwrap_partial=False)
        if not callable(func):
            # TODO most likely this branch can be removed when we drop support for Python 3.12:
            # This branch will get hit for classmethod properties
            attribute = get_attribute_from_base_dicts(cls_, cls_var_name)  # prevents the binding call to `__get__`
            if isinstance(attribute, PydanticDescriptorProxy):
                func = unwrap_wrapped_function(attribute.wrapped)
        return Decorator(
            cls_ref=get_type_ref(cls_),
            cls_var_name=cls_var_name,
            func=func,
            shim=shim,
            info=info,
        )

    def bind_to_cls(self, cls: Any) -> Decorator[DecoratorInfoType]:
        """Bind the decorator to a class.

        Args:
            cls: the class.

        Returns:
            The new decorator instance.
        """
        return self.build(
            cls,
            cls_var_name=self.cls_var_name,
            shim=self.shim,
            info=copy(self.info),
        )


def get_bases(tp: type[Any]) -> tuple[type[Any], ...]:
    """Get the base classes of a class or typeddict.

    Args:
        tp: The type or class to get the bases.

    Returns:
        The base classes.
    """
    if is_typeddict(tp):
        return tp.__orig_bases__  # type: ignore
    try:
        return tp.__bases__
    except AttributeError:
        return ()


def mro(tp: type[Any]) -> tuple[type[Any], ...]:
    """Calculate the Method Resolution Order of bases using the C3 algorithm.

    See https://www.python.org/download/releases/2.3/mro/
    """
    # try to use the existing mro, for performance mainly
    # but also because it helps verify the implementation below
    if not is_typeddict(tp):
        try:
            return tp.__mro__
        except AttributeError:
            # GenericAlias and some other cases
            pass

    bases = get_bases(tp)
    return (tp,) + mro_for_bases(bases)


def mro_for_bases(bases: tuple[type[Any], ...]) -> tuple[type[Any], ...]:
    def merge_seqs(seqs: list[deque[type[Any]]]) -> Iterable[type[Any]]:
        while True:
            non_empty = [seq for seq in seqs if seq]
            if not non_empty:
                # Nothing left to process, we're done.
                return
            candidate: type[Any] | None = None
            for seq in non_empty:  # Find merge candidates among seq heads.
                candidate = seq[0]
                not_head = [s for s in non_empty if candidate in islice(s, 1, None)]
                if not_head:
                    # Reject the candidate.
                    candidate = None
                else:
                    break
            if not candidate:
                raise TypeError('Inconsistent hierarchy, no C3 MRO is possible')
            yield candidate
            for seq in non_empty:
                # Remove candidate.
                if seq[0] == candidate:
                    seq.popleft()

    seqs = [deque(mro(base)) for base in bases] + [deque(bases)]
    return tuple(merge_seqs(seqs))


_sentinel = object()


def get_attribute_from_bases(tp: type[Any] | tuple[type[Any], ...], name: str) -> Any:
    """Get the attribute from the next class in the MRO that has it,
    aiming to simulate calling the method on the actual class.

    The reason for iterating over the mro instead of just getting
    the attribute (which would do that for us) is to support TypedDict,
    which lacks a real __mro__, but can have a virtual one constructed
    from its bases (as done here).

    Args:
        tp: The type or class to search for the attribute. If a tuple, this is treated as a set of base classes.
        name: The name of the attribute to retrieve.

    Returns:
        Any: The attribute value, if found.

    Raises:
        AttributeError: If the attribute is not found in any class in the MRO.
    """
    if isinstance(tp, tuple):
        for base in mro_for_bases(tp):
            attribute = base.__dict__.get(name, _sentinel)
            if attribute is not _sentinel:
                attribute_get = getattr(attribute, '__get__', None)
                if attribute_get is not None:
                    return attribute_get(None, tp)
                return attribute
        raise AttributeError(f'{name} not found in {tp}')
    else:
        try:
            return getattr(tp, name)
        except AttributeError:
            return get_attribute_from_bases(mro(tp), name)


def get_attribute_from_base_dicts(tp: type[Any], name: str) -> Any:
    """Get an attribute out of the `__dict__` following the MRO.
    This prevents the call to `__get__` on the descriptor, and allows
    us to get the original function for classmethod properties.

    Args:
        tp: The type or class to search for the attribute.
        name: The name of the attribute to retrieve.

    Returns:
        Any: The attribute value, if found.

    Raises:
        KeyError: If the attribute is not found in any class's `__dict__` in the MRO.
    """
    for base in reversed(mro(tp)):
        if name in base.__dict__:
            return base.__dict__[name]
    return tp.__dict__[name]  # raise the error


@dataclass(**slots_true)
class DecoratorInfos:
    """Mapping of name in the class namespace to decorator info.

    note that the name in the class namespace is the function or attribute name
    not the field name!
    """

    validators: dict[str, Decorator[ValidatorDecoratorInfo]] = field(default_factory=dict)
    field_validators: dict[str, Decorator[FieldValidatorDecoratorInfo]] = field(default_factory=dict)
    root_validators: dict[str, Decorator[RootValidatorDecoratorInfo]] = field(default_factory=dict)
    field_serializers: dict[str, Decorator[FieldSerializerDecoratorInfo]] = field(default_factory=dict)
    model_serializers: dict[str, Decorator[ModelSerializerDecoratorInfo]] = field(default_factory=dict)
    model_validators: dict[str, Decorator[ModelValidatorDecoratorInfo]] = field(default_factory=dict)
    computed_fields: dict[str, Decorator[ComputedFieldInfo]] = field(default_factory=dict)

    @classmethod
    def build(
        cls,
        typ: type[Any],
        # Default to `True` for backwards compatibility:
        replace_wrapped_methods: bool = True,
    ) -> Self:
        """Build a `DecoratorInfos` instance for the given model, dataclass or `TypedDict` type.

        Decorators from parent classes are included, including "bare" classes (e.g. if `typ`
        is a Pydantic model, non Pydantic parent model classes are also taken into account).
        The collection of the decorators happens by respecting the MRO.

        If one of the bases has an `__pydantic_decorators__` attribute set, it is assumed to be
        a `DecoratorInfos` instance and is used as-is. The `__pydantic_decorators__` attribute
        is *not* being set on the provided `typ`.

        Args:
            typ: The model, dataclass or `TypedDict` type to use when building the `DecoratorInfos` instance.
            replace_wrapped_methods: Whether to replace the decorator's wrapped methods on `typ`.
                This is useful e.g. for field validators which are initially class methods. This should
                only be set to `True` if `typ` is a Pydantic model or dataclass (otherwise this results
                in mutations of classes Pydantic doesn't "own").
        """
        # reminder: dicts are ordered and replacement does not alter the order
        res = cls()
        # Iterate over the bases, without the actual `typ`.
        # `1:-1` because we don't need to include `object`/`TypedDict`:
        for base in reversed(mro(typ)[1:-1]):
            existing: DecoratorInfos | None = base.__dict__.get('__pydantic_decorators__')
            if existing is None:
                existing, _ = _decorator_infos_for_class(base, collect_to_replace=False)
            res.validators.update({k: v.bind_to_cls(typ) for k, v in existing.validators.items()})
            res.field_validators.update({k: v.bind_to_cls(typ) for k, v in existing.field_validators.items()})
            res.root_validators.update({k: v.bind_to_cls(typ) for k, v in existing.root_validators.items()})
            res.field_serializers.update({k: v.bind_to_cls(typ) for k, v in existing.field_serializers.items()})
            res.model_serializers.update({k: v.bind_to_cls(typ) for k, v in existing.model_serializers.items()})
            res.model_validators.update({k: v.bind_to_cls(typ) for k, v in existing.model_validators.items()})
            res.computed_fields.update({k: v.bind_to_cls(typ) for k, v in existing.computed_fields.items()})

        decorator_infos, to_replace = _decorator_infos_for_class(typ, collect_to_replace=True)

        res.validators.update(decorator_infos.validators)
        res.field_validators.update(decorator_infos.field_validators)
        res.root_validators.update(decorator_infos.root_validators)
        res.field_serializers.update(decorator_infos.field_serializers)
        res.model_serializers.update(decorator_infos.model_serializers)
        res.model_validators.update(decorator_infos.model_validators)
        res.computed_fields.update(decorator_infos.computed_fields)

        if replace_wrapped_methods and to_replace:
            for name, value in to_replace:
                setattr(typ, name, value)

        res._validate()
        return res

    def _validate(self) -> None:
        seen: set[str] = set()
        for field_ser in self.field_serializers.values():
            for f_name in field_ser.info.fields:
                if f_name in seen:
                    raise PydanticUserError(
                        f'Multiple field serializer functions were defined for field {f_name!r}, this is not allowed.',
                        code='multiple-field-serializers',
                    )
                seen.add(f_name)

    def update_from_config(self, config_wrapper: ConfigWrapper) -> None:
        """Update the decorator infos from the configuration of the class they are attached to."""
        for name, computed_field_dec in self.computed_fields.items():
            computed_field_dec.info._update_from_config(config_wrapper, name)


def _decorator_infos_for_class(
    typ: type[Any],
    *,
    collect_to_replace: bool,
) -> tuple[DecoratorInfos, list[tuple[str, Any]]]:
    """Collect a `DecoratorInfos` for class, without looking into bases."""
    res = DecoratorInfos()
    to_replace: list[tuple[str, Any]] = []

    for var_name, var_value in vars(typ).items():
        if isinstance(var_value, PydanticDescriptorProxy):
            info = var_value.decorator_info
            if isinstance(info, ValidatorDecoratorInfo):
                res.validators[var_name] = Decorator.build(typ, cls_var_name=var_name, shim=var_value.shim, info=info)
            elif isinstance(info, FieldValidatorDecoratorInfo):
                res.field_validators[var_name] = Decorator.build(
                    typ, cls_var_name=var_name, shim=var_value.shim, info=info
                )
            elif isinstance(info, RootValidatorDecoratorInfo):
                res.root_validators[var_name] = Decorator.build(
                    typ, cls_var_name=var_name, shim=var_value.shim, info=info
                )
            elif isinstance(info, FieldSerializerDecoratorInfo):
                res.field_serializers[var_name] = Decorator.build(
                    typ, cls_var_name=var_name, shim=var_value.shim, info=info
                )
            elif isinstance(info, ModelValidatorDecoratorInfo):
                res.model_validators[var_name] = Decorator.build(
                    typ, cls_var_name=var_name, shim=var_value.shim, info=info
                )
            elif isinstance(info, ModelSerializerDecoratorInfo):
                res.model_serializers[var_name] = Decorator.build(
                    typ, cls_var_name=var_name, shim=var_value.shim, info=info
                )
            else:
                from ..fields import ComputedFieldInfo

                isinstance(var_value, ComputedFieldInfo)
                res.computed_fields[var_name] = Decorator.build(typ, cls_var_name=var_name, shim=None, info=info)
            if collect_to_replace:
                to_replace.append((var_name, var_value.wrapped))

    return res, to_replace


def inspect_validator(
    validator: Callable[..., Any], *, mode: FieldValidatorModes, type: Literal['field', 'model']
) -> bool:
    """Look at a field or model validator function and determine whether it takes an info argument.

    An error is raised if the function has an invalid signature.

    Args:
        validator: The validator function to inspect.
        mode: The proposed validator mode.
        type: The type of validator, either 'field' or 'model'.

    Returns:
        Whether the validator takes an info argument.
    """
    try:
        sig = signature_no_eval(validator)
    except (ValueError, TypeError):
        # `inspect.signature` might not be able to infer a signature, e.g. with C objects.
        # In this case, we assume no info argument is present:
        return False
    n_positional = count_positional_required_params(sig)
    if mode == 'wrap':
        if n_positional == 3:
            return True
        elif n_positional == 2:
            return False
    else:
        assert mode in {'before', 'after', 'plain'}, f"invalid mode: {mode!r}, expected 'before', 'after' or 'plain"
        if n_positional == 2:
            return True
        elif n_positional == 1:
            return False

    raise PydanticUserError(
        f'Unrecognized {type} validator function signature for {validator} with `mode={mode}`: {sig}',
        code='validator-signature',
    )


def inspect_field_serializer(serializer: Callable[..., Any], mode: Literal['plain', 'wrap']) -> tuple[bool, bool]:
    """Look at a field serializer function and determine if it is a field serializer,
    and whether it takes an info argument.

    An error is raised if the function has an invalid signature.

    Args:
        serializer: The serializer function to inspect.
        mode: The serializer mode, either 'plain' or 'wrap'.

    Returns:
        Tuple of (is_field_serializer, info_arg).
    """
    try:
        sig = signature_no_eval(serializer)
    except (ValueError, TypeError):
        # `inspect.signature` might not be able to infer a signature, e.g. with C objects.
        # In this case, we assume no info argument is present and this is not a method:
        return (False, False)

    first = next(iter(sig.parameters.values()), None)
    is_field_serializer = first is not None and first.name == 'self'

    n_positional = count_positional_required_params(sig)
    if is_field_serializer:
        # -1 to correct for self parameter
        info_arg = _serializer_info_arg(mode, n_positional - 1)
    else:
        info_arg = _serializer_info_arg(mode, n_positional)

    if info_arg is None:
        raise PydanticUserError(
            f'Unrecognized field_serializer function signature for {serializer} with `mode={mode}`:{sig}',
            code='field-serializer-signature',
        )

    return is_field_serializer, info_arg


def inspect_annotated_serializer(serializer: Callable[..., Any], mode: Literal['plain', 'wrap']) -> bool:
    """Look at a serializer function used via `Annotated` and determine whether it takes an info argument.

    An error is raised if the function has an invalid signature.

    Args:
        serializer: The serializer function to check.
        mode: The serializer mode, either 'plain' or 'wrap'.

    Returns:
        info_arg
    """
    try:
        sig = signature_no_eval(serializer)
    except (ValueError, TypeError):
        # `inspect.signature` might not be able to infer a signature, e.g. with C objects.
        # In this case, we assume no info argument is present:
        return False
    info_arg = _serializer_info_arg(mode, count_positional_required_params(sig))
    if info_arg is None:
        raise PydanticUserError(
            f'Unrecognized field_serializer function signature for {serializer} with `mode={mode}`:{sig}',
            code='field-serializer-signature',
        )
    else:
        return info_arg


def inspect_model_serializer(serializer: Callable[..., Any], mode: Literal['plain', 'wrap']) -> bool:
    """Look at a model serializer function and determine whether it takes an info argument.

    An error is raised if the function has an invalid signature.

    Args:
        serializer: The serializer function to check.
        mode: The serializer mode, either 'plain' or 'wrap'.

    Returns:
        `info_arg` - whether the function expects an info argument.
    """
    if isinstance(serializer, (staticmethod, classmethod)) or not is_instance_method_from_sig(serializer):
        raise PydanticUserError(
            '`@model_serializer` must be applied to instance methods', code='model-serializer-instance-method'
        )

    sig = signature_no_eval(serializer)
    info_arg = _serializer_info_arg(mode, count_positional_required_params(sig))
    if info_arg is None:
        raise PydanticUserError(
            f'Unrecognized model_serializer function signature for {serializer} with `mode={mode}`:{sig}',
            code='model-serializer-signature',
        )
    else:
        return info_arg


def _serializer_info_arg(mode: Literal['plain', 'wrap'], n_positional: int) -> bool | None:
    if mode == 'plain':
        if n_positional == 1:
            # (input_value: Any, /) -> Any
            return False
        elif n_positional == 2:
            # (model: Any, input_value: Any, /) -> Any
            return True
    else:
        assert mode == 'wrap', f"invalid mode: {mode!r}, expected 'plain' or 'wrap'"
        if n_positional == 2:
            # (input_value: Any, serializer: SerializerFunctionWrapHandler, /) -> Any
            return False
        elif n_positional == 3:
            # (input_value: Any, serializer: SerializerFunctionWrapHandler, info: SerializationInfo, /) -> Any
            return True

    return None


AnyDecoratorCallable: TypeAlias = (
    'Union[classmethod[Any, Any, Any], staticmethod[Any, Any], partialmethod[Any], Callable[..., Any]]'
)


def is_instance_method_from_sig(function: AnyDecoratorCallable) -> bool:
    """Whether the function is an instance method.

    It will consider a function as instance method if the first parameter of
    function is `self`.

    Args:
        function: The function to check.

    Returns:
        `True` if the function is an instance method, `False` otherwise.
    """
    sig = signature_no_eval(unwrap_wrapped_function(function))
    first = next(iter(sig.parameters.values()), None)
    if first and first.name == 'self':
        return True
    return False


def ensure_classmethod_based_on_signature(function: AnyDecoratorCallable) -> Any:
    """Apply the `@classmethod` decorator on the function.

    Args:
        function: The function to apply the decorator on.

    Return:
        The `@classmethod` decorator applied function.
    """
    if not isinstance(
        unwrap_wrapped_function(function, unwrap_class_static_method=False), classmethod
    ) and _is_classmethod_from_sig(function):
        return classmethod(function)  # type: ignore[arg-type]
    return function


def _is_classmethod_from_sig(function: AnyDecoratorCallable) -> bool:
    sig = signature_no_eval(unwrap_wrapped_function(function))
    first = next(iter(sig.parameters.values()), None)
    if first and first.name == 'cls':
        return True
    return False


def unwrap_wrapped_function(
    func: Any,
    *,
    unwrap_partial: bool = True,
    unwrap_class_static_method: bool = True,
) -> Any:
    """Recursively unwraps a wrapped function until the underlying function is reached.
    This handles property, functools.partial, functools.partialmethod, staticmethod, and classmethod.

    Args:
        func: The function to unwrap.
        unwrap_partial: If True (default), unwrap partial and partialmethod decorators.
        unwrap_class_static_method: If True (default), also unwrap classmethod and staticmethod
            decorators. If False, only unwrap partial and partialmethod decorators.

    Returns:
        The underlying function of the wrapped function.
    """
    # Define the types we want to check against as a single tuple.
    unwrap_types = (
        (property, cached_property)
        + ((partial, partialmethod) if unwrap_partial else ())
        + ((staticmethod, classmethod) if unwrap_class_static_method else ())
    )

    while isinstance(func, unwrap_types):
        if unwrap_class_static_method and isinstance(func, (classmethod, staticmethod)):
            func = func.__func__
        elif isinstance(func, (partial, partialmethod)):
            func = func.func
        elif isinstance(func, property):
            func = func.fget  # arbitrary choice, convenient for computed fields
        else:
            # Make coverage happy as it can only get here in the last possible case
            assert isinstance(func, cached_property)
            func = func.func  # type: ignore

    return func


_function_like = (
    partial,
    partialmethod,
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    types.WrapperDescriptorType,
    types.MethodWrapperType,
    types.MemberDescriptorType,
)


def get_callable_return_type(
    callable_obj: Any,
    globalns: GlobalsNamespace | None = None,
    localns: MappingNamespace | None = None,
) -> Any | PydanticUndefinedType:
    """Get the callable return type.

    Args:
        callable_obj: The callable to analyze.
        globalns: The globals namespace to use during type annotation evaluation.
        localns: The locals namespace to use during type annotation evaluation.

    Returns:
        The function return type.
    """
    if isinstance(callable_obj, type):
        # types are callables, and we assume the return type
        # is the type itself (e.g. `int()` results in an instance of `int`).
        return callable_obj

    if not isinstance(callable_obj, _function_like):
        call_func = getattr(type(callable_obj), '__call__', None)  # noqa: B004
        if call_func is not None:
            callable_obj = call_func

    hints = get_function_type_hints(
        unwrap_wrapped_function(callable_obj),
        include_keys={'return'},
        globalns=globalns,
        localns=localns,
    )
    return hints.get('return', PydanticUndefined)


def count_positional_required_params(sig: Signature) -> int:
    """Get the number of positional (required) arguments of a signature.

    This function should only be used to inspect signatures of validation and serialization functions.
    The first argument (the value being serialized or validated) is counted as a required argument
    even if a default value exists.

    Returns:
        The number of positional arguments of a signature.
    """
    parameters = list(sig.parameters.values())
    return sum(
        1
        for param in parameters
        if can_be_positional(param)
        # First argument is the value being validated/serialized, and can have a default value
        # (e.g. `float`, which has signature `(x=0, /)`). We assume other parameters (the info arg
        # for instance) should be required, and thus without any default value.
        and (param.default is Parameter.empty or param is parameters[0])
    )


def ensure_property(f: Any) -> Any:
    """Ensure that a function is a `property` or `cached_property`, or is a valid descriptor.

    Args:
        f: The function to check.

    Returns:
        The function, or a `property` or `cached_property` instance wrapping the function.
    """
    if ismethoddescriptor(f) or isdatadescriptor(f):
        return f
    else:
        return property(f)
