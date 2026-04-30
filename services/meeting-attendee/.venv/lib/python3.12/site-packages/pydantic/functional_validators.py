"""This module contains related classes and functions for validation."""

from __future__ import annotations as _annotations

import dataclasses
import sys
import warnings
from functools import partialmethod
from typing import TYPE_CHECKING, Annotated, Any, Callable, Literal, TypeVar, Union, cast, overload

from pydantic_core import PydanticUndefined, core_schema
from typing_extensions import Self, TypeAlias

from ._internal import _decorators, _generics, _internal_dataclass
from .annotated_handlers import GetCoreSchemaHandler
from .errors import PydanticUserError
from .version import version_short
from .warnings import ArbitraryTypeWarning, PydanticDeprecatedSince212

if sys.version_info < (3, 11):
    from typing_extensions import Protocol
else:
    from typing import Protocol

_inspect_validator = _decorators.inspect_validator


@dataclasses.dataclass(frozen=True, **_internal_dataclass.slots_true)
class AfterValidator:
    """!!! abstract "Usage Documentation"
        [field *after* validators](../concepts/validators.md#field-after-validator)

    A metadata class that indicates that a validation should be applied **after** the inner validation logic.

    Attributes:
        func: The validator function.

    Example:
        ```python
        from typing import Annotated

        from pydantic import AfterValidator, BaseModel, ValidationError

        MyInt = Annotated[int, AfterValidator(lambda v: v + 1)]

        class Model(BaseModel):
            a: MyInt

        print(Model(a=1).a)
        #> 2

        try:
            Model(a='a')
        except ValidationError as e:
            print(e.json(indent=2))
            '''
            [
              {
                "type": "int_parsing",
                "loc": [
                  "a"
                ],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": "a",
                "url": "https://errors.pydantic.dev/2/v/int_parsing"
              }
            ]
            '''
        ```
    """

    func: core_schema.NoInfoValidatorFunction | core_schema.WithInfoValidatorFunction

    def __get_pydantic_core_schema__(self, source_type: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
        schema = handler(source_type)
        info_arg = _inspect_validator(self.func, mode='after', type='field')
        if info_arg:
            func = cast(core_schema.WithInfoValidatorFunction, self.func)
            return core_schema.with_info_after_validator_function(func, schema=schema)
        else:
            func = cast(core_schema.NoInfoValidatorFunction, self.func)
            return core_schema.no_info_after_validator_function(func, schema=schema)

    @classmethod
    def _from_decorator(cls, decorator: _decorators.Decorator[_decorators.FieldValidatorDecoratorInfo]) -> Self:
        return cls(func=decorator.func)


@dataclasses.dataclass(frozen=True, **_internal_dataclass.slots_true)
class BeforeValidator:
    """!!! abstract "Usage Documentation"
        [field *before* validators](../concepts/validators.md#field-before-validator)

    A metadata class that indicates that a validation should be applied **before** the inner validation logic.

    Attributes:
        func: The validator function.
        json_schema_input_type: The input type used to generate the appropriate
            JSON Schema (in validation mode). The actual input type is `Any`.

    Example:
        ```python
        from typing import Annotated

        from pydantic import BaseModel, BeforeValidator

        MyInt = Annotated[int, BeforeValidator(lambda v: v + 1)]

        class Model(BaseModel):
            a: MyInt

        print(Model(a=1).a)
        #> 2

        try:
            Model(a='a')
        except TypeError as e:
            print(e)
            #> can only concatenate str (not "int") to str
        ```
    """

    func: core_schema.NoInfoValidatorFunction | core_schema.WithInfoValidatorFunction
    json_schema_input_type: Any = PydanticUndefined

    def __get_pydantic_core_schema__(self, source_type: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
        schema = handler(source_type)
        input_schema = (
            None
            if self.json_schema_input_type is PydanticUndefined
            else handler.generate_schema(self.json_schema_input_type)
        )

        info_arg = _inspect_validator(self.func, mode='before', type='field')
        if info_arg:
            func = cast(core_schema.WithInfoValidatorFunction, self.func)
            return core_schema.with_info_before_validator_function(
                func,
                schema=schema,
                json_schema_input_schema=input_schema,
            )
        else:
            func = cast(core_schema.NoInfoValidatorFunction, self.func)
            return core_schema.no_info_before_validator_function(
                func, schema=schema, json_schema_input_schema=input_schema
            )

    @classmethod
    def _from_decorator(cls, decorator: _decorators.Decorator[_decorators.FieldValidatorDecoratorInfo]) -> Self:
        return cls(
            func=decorator.func,
            json_schema_input_type=decorator.info.json_schema_input_type,
        )


@dataclasses.dataclass(frozen=True, **_internal_dataclass.slots_true)
class PlainValidator:
    """!!! abstract "Usage Documentation"
        [field *plain* validators](../concepts/validators.md#field-plain-validator)

    A metadata class that indicates that a validation should be applied **instead** of the inner validation logic.

    !!! note
        Before v2.9, `PlainValidator` wasn't always compatible with JSON Schema generation for `mode='validation'`.
        You can now use the `json_schema_input_type` argument to specify the input type of the function
        to be used in the JSON schema when `mode='validation'` (the default). See the example below for more details.

    Attributes:
        func: The validator function.
        json_schema_input_type: The input type used to generate the appropriate
            JSON Schema (in validation mode). The actual input type is `Any`.

    Example:
        ```python
        from typing import Annotated, Union

        from pydantic import BaseModel, PlainValidator

        def validate(v: object) -> int:
            if not isinstance(v, (int, str)):
                raise ValueError(f'Expected int or str, got {type(v)}')

            return int(v) + 1

        MyInt = Annotated[
            int,
            PlainValidator(validate, json_schema_input_type=Union[str, int]),  # (1)!
        ]

        class Model(BaseModel):
            a: MyInt

        print(Model(a='1').a)
        #> 2

        print(Model(a=1).a)
        #> 2
        ```

        1. In this example, we've specified the `json_schema_input_type` as `Union[str, int]` which indicates to the JSON schema
        generator that in validation mode, the input type for the `a` field can be either a [`str`][] or an [`int`][].
    """

    func: core_schema.NoInfoValidatorFunction | core_schema.WithInfoValidatorFunction
    json_schema_input_type: Any = Any

    def __get_pydantic_core_schema__(self, source_type: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
        # Note that for some valid uses of PlainValidator, it is not possible to generate a core schema for the
        # source_type, so calling `handler(source_type)` will error, which prevents us from generating a proper
        # serialization schema. To work around this for use cases that will not involve serialization, we simply
        # catch any PydanticSchemaGenerationError that may be raised while attempting to build the serialization schema
        # and abort any attempts to handle special serialization.
        from pydantic import PydanticSchemaGenerationError

        try:
            schema = handler(source_type)
            # TODO if `schema['serialization']` is one of `'include-exclude-dict/sequence',
            # schema validation will fail. That's why we use 'type ignore' comments below.
            serialization = schema.get(
                'serialization',
                core_schema.wrap_serializer_function_ser_schema(
                    function=lambda v, h: h(v),
                    schema=schema,
                    return_schema=handler.generate_schema(source_type),
                ),
            )
        except PydanticSchemaGenerationError:
            serialization = None

        input_schema = handler.generate_schema(self.json_schema_input_type)

        info_arg = _inspect_validator(self.func, mode='plain', type='field')
        if info_arg:
            func = cast(core_schema.WithInfoValidatorFunction, self.func)
            return core_schema.with_info_plain_validator_function(
                func,
                serialization=serialization,  # pyright: ignore[reportArgumentType]
                json_schema_input_schema=input_schema,
            )
        else:
            func = cast(core_schema.NoInfoValidatorFunction, self.func)
            return core_schema.no_info_plain_validator_function(
                func,
                serialization=serialization,  # pyright: ignore[reportArgumentType]
                json_schema_input_schema=input_schema,
            )

    @classmethod
    def _from_decorator(cls, decorator: _decorators.Decorator[_decorators.FieldValidatorDecoratorInfo]) -> Self:
        return cls(
            func=decorator.func,
            json_schema_input_type=decorator.info.json_schema_input_type,
        )


@dataclasses.dataclass(frozen=True, **_internal_dataclass.slots_true)
class WrapValidator:
    """!!! abstract "Usage Documentation"
        [field *wrap* validators](../concepts/validators.md#field-wrap-validator)

    A metadata class that indicates that a validation should be applied **around** the inner validation logic.

    Attributes:
        func: The validator function.
        json_schema_input_type: The input type used to generate the appropriate
            JSON Schema (in validation mode). The actual input type is `Any`.

    ```python
    from datetime import datetime
    from typing import Annotated

    from pydantic import BaseModel, ValidationError, WrapValidator

    def validate_timestamp(v, handler):
        if v == 'now':
            # we don't want to bother with further validation, just return the new value
            return datetime.now()
        try:
            return handler(v)
        except ValidationError:
            # validation failed, in this case we want to return a default value
            return datetime(2000, 1, 1)

    MyTimestamp = Annotated[datetime, WrapValidator(validate_timestamp)]

    class Model(BaseModel):
        a: MyTimestamp

    print(Model(a='now').a)
    #> 2032-01-02 03:04:05.000006
    print(Model(a='invalid').a)
    #> 2000-01-01 00:00:00
    ```
    """

    func: core_schema.NoInfoWrapValidatorFunction | core_schema.WithInfoWrapValidatorFunction
    json_schema_input_type: Any = PydanticUndefined

    def __get_pydantic_core_schema__(self, source_type: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
        schema = handler(source_type)
        input_schema = (
            None
            if self.json_schema_input_type is PydanticUndefined
            else handler.generate_schema(self.json_schema_input_type)
        )

        info_arg = _inspect_validator(self.func, mode='wrap', type='field')
        if info_arg:
            func = cast(core_schema.WithInfoWrapValidatorFunction, self.func)
            return core_schema.with_info_wrap_validator_function(
                func,
                schema=schema,
                json_schema_input_schema=input_schema,
            )
        else:
            func = cast(core_schema.NoInfoWrapValidatorFunction, self.func)
            return core_schema.no_info_wrap_validator_function(
                func,
                schema=schema,
                json_schema_input_schema=input_schema,
            )

    @classmethod
    def _from_decorator(cls, decorator: _decorators.Decorator[_decorators.FieldValidatorDecoratorInfo]) -> Self:
        return cls(
            func=decorator.func,
            json_schema_input_type=decorator.info.json_schema_input_type,
        )


if TYPE_CHECKING:

    class _OnlyValueValidatorClsMethod(Protocol):
        def __call__(self, cls: Any, value: Any, /) -> Any: ...

    class _V2ValidatorClsMethod(Protocol):
        def __call__(self, cls: Any, value: Any, info: core_schema.ValidationInfo[Any], /) -> Any: ...

    class _OnlyValueWrapValidatorClsMethod(Protocol):
        def __call__(self, cls: Any, value: Any, handler: core_schema.ValidatorFunctionWrapHandler, /) -> Any: ...

    class _V2WrapValidatorClsMethod(Protocol):
        def __call__(
            self,
            cls: Any,
            value: Any,
            handler: core_schema.ValidatorFunctionWrapHandler,
            info: core_schema.ValidationInfo[Any],
            /,
        ) -> Any: ...

    _V2Validator = Union[
        _V2ValidatorClsMethod,
        core_schema.WithInfoValidatorFunction,
        _OnlyValueValidatorClsMethod,
        core_schema.NoInfoValidatorFunction,
    ]

    _V2WrapValidator = Union[
        _V2WrapValidatorClsMethod,
        core_schema.WithInfoWrapValidatorFunction,
        _OnlyValueWrapValidatorClsMethod,
        core_schema.NoInfoWrapValidatorFunction,
    ]

    _PartialClsOrStaticMethod: TypeAlias = Union[classmethod[Any, Any, Any], staticmethod[Any, Any], partialmethod[Any]]

    _V2BeforeAfterOrPlainValidatorType = TypeVar(
        '_V2BeforeAfterOrPlainValidatorType',
        bound=Union[_V2Validator, _PartialClsOrStaticMethod],
    )
    _V2WrapValidatorType = TypeVar('_V2WrapValidatorType', bound=Union[_V2WrapValidator, _PartialClsOrStaticMethod])

FieldValidatorModes: TypeAlias = Literal['before', 'after', 'wrap', 'plain']


@overload
def field_validator(
    field: str,
    /,
    *fields: str,
    mode: Literal['wrap'],
    check_fields: bool | None = ...,
    json_schema_input_type: Any = ...,
) -> Callable[[_V2WrapValidatorType], _V2WrapValidatorType]: ...


@overload
def field_validator(
    field: str,
    /,
    *fields: str,
    mode: Literal['before', 'plain'],
    check_fields: bool | None = ...,
    json_schema_input_type: Any = ...,
) -> Callable[[_V2BeforeAfterOrPlainValidatorType], _V2BeforeAfterOrPlainValidatorType]: ...


@overload
def field_validator(
    field: str,
    /,
    *fields: str,
    mode: Literal['after'] = ...,
    check_fields: bool | None = ...,
) -> Callable[[_V2BeforeAfterOrPlainValidatorType], _V2BeforeAfterOrPlainValidatorType]: ...


def field_validator(  # noqa: D417
    field: str,
    /,
    *fields: str,
    mode: FieldValidatorModes = 'after',
    check_fields: bool | None = None,
    json_schema_input_type: Any = PydanticUndefined,
) -> Callable[[Any], Any]:
    """!!! abstract "Usage Documentation"
        [field validators](../concepts/validators.md#field-validators)

    Decorate methods on the class indicating that they should be used to validate fields.

    Example usage:
    ```python
    from typing import Any

    from pydantic import (
        BaseModel,
        ValidationError,
        field_validator,
    )

    class Model(BaseModel):
        a: str

        @field_validator('a')
        @classmethod
        def ensure_foobar(cls, v: Any):
            if 'foobar' not in v:
                raise ValueError('"foobar" not found in a')
            return v

    print(repr(Model(a='this is foobar good')))
    #> Model(a='this is foobar good')

    try:
        Model(a='snap')
    except ValidationError as exc_info:
        print(exc_info)
        '''
        1 validation error for Model
        a
          Value error, "foobar" not found in a [type=value_error, input_value='snap', input_type=str]
        '''
    ```

    For more in depth examples, see [Field Validators](../concepts/validators.md#field-validators).

    Args:
        *fields: The field names the validator should apply to.
        mode: Specifies whether to validate the fields before or after validation.
        check_fields: Whether to check that the fields actually exist on the model.
        json_schema_input_type: The input type of the function. This is only used to generate
            the appropriate JSON Schema (in validation mode) and can only specified
            when `mode` is either `'before'`, `'plain'` or `'wrap'`.

    Raises:
        PydanticUserError:
            - If the decorator is used without any arguments (at least one field name must be provided).
            - If the provided field names are not strings.
            - If `json_schema_input_type` is provided with an unsupported `mode`.
            - If the decorator is applied to an instance method.
    """
    if callable(field) or isinstance(field, classmethod):
        raise PydanticUserError(
            'The `@field_validator` decorator cannot be used without arguments, at least one field must be provided. '
            "For example: `@field_validator('<field_name>', ...)`.",
            code='decorator-missing-arguments',
        )

    if mode not in ('before', 'plain', 'wrap') and json_schema_input_type is not PydanticUndefined:
        raise PydanticUserError(
            f"`json_schema_input_type` can't be used when mode is set to {mode!r}",
            code='validator-input-type',
        )

    if json_schema_input_type is PydanticUndefined and mode == 'plain':
        json_schema_input_type = Any

    fields = field, *fields
    if not all(isinstance(field, str) for field in fields):
        raise PydanticUserError(
            'The provided field names to the `@field_validator` decorator should be strings. '
            "For example: `@field_validator('<field_name_1>', '<field_name_2>', ...).`",
            code='decorator-invalid-fields',
        )

    def dec(
        f: Callable[..., Any] | staticmethod[Any, Any] | classmethod[Any, Any, Any],
    ) -> _decorators.PydanticDescriptorProxy[Any]:
        if _decorators.is_instance_method_from_sig(f):
            raise PydanticUserError(
                'The `@field_validator` decorator cannot be applied to instance methods',
                code='validator-instance-method',
            )

        # auto apply the @classmethod decorator
        f = _decorators.ensure_classmethod_based_on_signature(f)

        dec_info = _decorators.FieldValidatorDecoratorInfo(
            fields=fields, mode=mode, check_fields=check_fields, json_schema_input_type=json_schema_input_type
        )
        return _decorators.PydanticDescriptorProxy(f, dec_info)

    return dec


_ModelType = TypeVar('_ModelType')
_ModelTypeCo = TypeVar('_ModelTypeCo', covariant=True)


class ModelWrapValidatorHandler(core_schema.ValidatorFunctionWrapHandler, Protocol[_ModelTypeCo]):
    """`@model_validator` decorated function handler argument type. This is used when `mode='wrap'`."""

    def __call__(  # noqa: D102
        self,
        value: Any,
        outer_location: str | int | None = None,
        /,
    ) -> _ModelTypeCo:  # pragma: no cover
        ...


class ModelWrapValidatorWithoutInfo(Protocol[_ModelType]):
    """A `@model_validator` decorated function signature.
    This is used when `mode='wrap'` and the function does not have info argument.
    """

    def __call__(  # noqa: D102
        self,
        cls: type[_ModelType],
        # this can be a dict, a model instance
        # or anything else that gets passed to validate_python
        # thus validators _must_ handle all cases
        value: Any,
        handler: ModelWrapValidatorHandler[_ModelType],
        /,
    ) -> _ModelType: ...


class ModelWrapValidator(Protocol[_ModelType]):
    """A `@model_validator` decorated function signature. This is used when `mode='wrap'`."""

    def __call__(  # noqa: D102
        self,
        cls: type[_ModelType],
        # this can be a dict, a model instance
        # or anything else that gets passed to validate_python
        # thus validators _must_ handle all cases
        value: Any,
        handler: ModelWrapValidatorHandler[_ModelType],
        info: core_schema.ValidationInfo,
        /,
    ) -> _ModelType: ...


class FreeModelBeforeValidatorWithoutInfo(Protocol):
    """A `@model_validator` decorated function signature.
    This is used when `mode='before'` and the function does not have info argument.
    """

    def __call__(  # noqa: D102
        self,
        # this can be a dict, a model instance
        # or anything else that gets passed to validate_python
        # thus validators _must_ handle all cases
        value: Any,
        /,
    ) -> Any: ...


class ModelBeforeValidatorWithoutInfo(Protocol):
    """A `@model_validator` decorated function signature.
    This is used when `mode='before'` and the function does not have info argument.
    """

    def __call__(  # noqa: D102
        self,
        cls: Any,
        # this can be a dict, a model instance
        # or anything else that gets passed to validate_python
        # thus validators _must_ handle all cases
        value: Any,
        /,
    ) -> Any: ...


class FreeModelBeforeValidator(Protocol):
    """A `@model_validator` decorated function signature. This is used when `mode='before'`."""

    def __call__(  # noqa: D102
        self,
        # this can be a dict, a model instance
        # or anything else that gets passed to validate_python
        # thus validators _must_ handle all cases
        value: Any,
        info: core_schema.ValidationInfo[Any],
        /,
    ) -> Any: ...


class ModelBeforeValidator(Protocol):
    """A `@model_validator` decorated function signature. This is used when `mode='before'`."""

    def __call__(  # noqa: D102
        self,
        cls: Any,
        # this can be a dict, a model instance
        # or anything else that gets passed to validate_python
        # thus validators _must_ handle all cases
        value: Any,
        info: core_schema.ValidationInfo[Any],
        /,
    ) -> Any: ...


ModelAfterValidatorWithoutInfo = Callable[[_ModelType], _ModelType]
"""A `@model_validator` decorated function signature. This is used when `mode='after'` and the function does not
have info argument.
"""

ModelAfterValidator = Callable[[_ModelType, core_schema.ValidationInfo[Any]], _ModelType]
"""A `@model_validator` decorated function signature. This is used when `mode='after'`."""

_AnyModelWrapValidator = Union[ModelWrapValidator[_ModelType], ModelWrapValidatorWithoutInfo[_ModelType]]
_AnyModelBeforeValidator = Union[
    FreeModelBeforeValidator, ModelBeforeValidator, FreeModelBeforeValidatorWithoutInfo, ModelBeforeValidatorWithoutInfo
]
_AnyModelAfterValidator = Union[ModelAfterValidator[_ModelType], ModelAfterValidatorWithoutInfo[_ModelType]]


@overload
def model_validator(
    *,
    mode: Literal['wrap'],
) -> Callable[
    [_AnyModelWrapValidator[_ModelType]], _decorators.PydanticDescriptorProxy[_decorators.ModelValidatorDecoratorInfo]
]: ...


@overload
def model_validator(
    *,
    mode: Literal['before'],
) -> Callable[
    [_AnyModelBeforeValidator], _decorators.PydanticDescriptorProxy[_decorators.ModelValidatorDecoratorInfo]
]: ...


@overload
def model_validator(
    *,
    mode: Literal['after'],
) -> Callable[
    [_AnyModelAfterValidator[_ModelType]], _decorators.PydanticDescriptorProxy[_decorators.ModelValidatorDecoratorInfo]
]: ...


def model_validator(
    *,
    mode: Literal['wrap', 'before', 'after'],
) -> Any:
    """!!! abstract "Usage Documentation"
        [Model Validators](../concepts/validators.md#model-validators)

    Decorate model methods for validation purposes.

    Example usage:
    ```python
    from typing_extensions import Self

    from pydantic import BaseModel, ValidationError, model_validator

    class Square(BaseModel):
        width: float
        height: float

        @model_validator(mode='after')
        def verify_square(self) -> Self:
            if self.width != self.height:
                raise ValueError('width and height do not match')
            return self

    s = Square(width=1, height=1)
    print(repr(s))
    #> Square(width=1.0, height=1.0)

    try:
        Square(width=1, height=2)
    except ValidationError as e:
        print(e)
        '''
        1 validation error for Square
          Value error, width and height do not match [type=value_error, input_value={'width': 1, 'height': 2}, input_type=dict]
        '''
    ```

    For more in depth examples, see [Model Validators](../concepts/validators.md#model-validators).

    Args:
        mode: A required string literal that specifies the validation mode.
            It can be one of the following: 'wrap', 'before', or 'after'.

    Returns:
        A decorator that can be used to decorate a function to be used as a model validator.
    """

    def dec(f: Any) -> _decorators.PydanticDescriptorProxy[Any]:
        # auto apply the @classmethod decorator. NOTE: in V3, do not apply the conversion for 'after' validators:
        f = _decorators.ensure_classmethod_based_on_signature(f)
        if mode == 'after' and isinstance(f, classmethod):
            warnings.warn(
                category=PydanticDeprecatedSince212,
                message=(
                    "Using `@model_validator` with mode='after' on a classmethod is deprecated. Instead, use an instance method. "
                    f'See the documentation at https://docs.pydantic.dev/{version_short()}/concepts/validators/#model-after-validator.'
                ),
                stacklevel=2,
            )

        dec_info = _decorators.ModelValidatorDecoratorInfo(mode=mode)
        return _decorators.PydanticDescriptorProxy(f, dec_info)

    return dec


AnyType = TypeVar('AnyType')


if TYPE_CHECKING:
    # If we add configurable attributes to IsInstance, we'd probably need to stop hiding it from type checkers like this
    InstanceOf = Annotated[AnyType, ...]  # `IsInstance[Sequence]` will be recognized by type checkers as `Sequence`

else:

    @dataclasses.dataclass(**_internal_dataclass.slots_true)
    class InstanceOf:
        '''Generic type for annotating a type that is an instance of a given class.

        Example:
            ```python
            from pydantic import BaseModel, InstanceOf

            class Foo:
                ...

            class Bar(BaseModel):
                foo: InstanceOf[Foo]

            Bar(foo=Foo())
            try:
                Bar(foo=42)
            except ValidationError as e:
                print(e)
                """
                [
                │   {
                │   │   'type': 'is_instance_of',
                │   │   'loc': ('foo',),
                │   │   'msg': 'Input should be an instance of Foo',
                │   │   'input': 42,
                │   │   'ctx': {'class': 'Foo'},
                │   │   'url': 'https://errors.pydantic.dev/0.38.0/v/is_instance_of'
                │   }
                ]
                """
            ```
        '''

        @classmethod
        def __class_getitem__(cls, item: AnyType) -> AnyType:
            return Annotated[item, cls()]

        @classmethod
        def __get_pydantic_core_schema__(cls, source: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
            from pydantic._internal._generate_schema import GENERATE_SCHEMA_ERRORS

            # use the generic _origin_ as the second argument to isinstance when appropriate
            instance_of_schema = core_schema.is_instance_schema(_generics.get_origin(source) or source)

            try:
                # Try to generate the "standard" schema, which will be used when loading from JSON
                original_schema = handler(source)
            except GENERATE_SCHEMA_ERRORS:
                # If that fails, just produce a schema that can validate from python
                return instance_of_schema
            else:
                # Use the "original" approach to serialization
                instance_of_schema['serialization'] = core_schema.wrap_serializer_function_ser_schema(
                    function=lambda v, h: h(v), schema=original_schema
                )
                return core_schema.json_or_python_schema(python_schema=instance_of_schema, json_schema=original_schema)

        __hash__ = object.__hash__


if TYPE_CHECKING:
    SkipValidation = Annotated[AnyType, ...]  # SkipValidation[list[str]] will be treated by type checkers as list[str]
else:

    @dataclasses.dataclass(**_internal_dataclass.slots_true)
    class SkipValidation:
        """If this is applied as an annotation (e.g., via `x: Annotated[int, SkipValidation]`), validation will be
            skipped. You can also use `SkipValidation[int]` as a shorthand for `Annotated[int, SkipValidation]`.

        This can be useful if you want to use a type annotation for documentation/IDE/type-checking purposes,
        and know that it is safe to skip validation for one or more of the fields.

        Because this converts the validation schema to `any_schema`, subsequent annotation-applied transformations
        may not have the expected effects. Therefore, when used, this annotation should generally be the final
        annotation applied to a type.
        """

        def __class_getitem__(cls, item: Any) -> Any:
            return Annotated[item, SkipValidation()]

        @classmethod
        def __get_pydantic_core_schema__(cls, source: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', ArbitraryTypeWarning)
                original_schema = handler(source)
            metadata = {'pydantic_js_annotation_functions': [lambda _c, h: h(original_schema)]}
            return core_schema.any_schema(
                metadata=metadata,
                serialization=core_schema.wrap_serializer_function_ser_schema(
                    function=lambda v, h: h(v), schema=original_schema
                ),
            )

        __hash__ = object.__hash__


_FromTypeT = TypeVar('_FromTypeT')


class ValidateAs:
    """A helper class to validate a custom type from a type that is natively supported by Pydantic.

    Args:
        from_type: The type natively supported by Pydantic to use to perform validation.
        instantiation_hook: A callable taking the validated type as an argument, and returning
            the populated custom type.

    Example:
        ```python {lint="skip"}
        from typing import Annotated

        from pydantic import BaseModel, TypeAdapter, ValidateAs

        class MyCls:
            def __init__(self, a: int) -> None:
                self.a = a

            def __repr__(self) -> str:
                return f"MyCls(a={self.a})"

        class Model(BaseModel):
            a: int


        ta = TypeAdapter(
            Annotated[MyCls, ValidateAs(Model, lambda v: MyCls(a=v.a))]
        )

        print(ta.validate_python({'a': 1}))
        #> MyCls(a=1)
        ```
    """

    # TODO: make use of PEP 747
    def __init__(self, from_type: type[_FromTypeT], /, instantiation_hook: Callable[[_FromTypeT], Any]) -> None:
        self.from_type = from_type
        self.instantiation_hook = instantiation_hook

    def __get_pydantic_core_schema__(self, source: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
        schema = handler(self.from_type)
        return core_schema.no_info_after_validator_function(
            self.instantiation_hook,
            schema=schema,
        )
