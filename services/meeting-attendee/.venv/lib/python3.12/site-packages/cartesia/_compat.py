from __future__ import annotations

from typing import TYPE_CHECKING, Any, Union, Generic, TypeVar, Callable, cast, overload
from datetime import date, datetime
from typing_extensions import Self, Literal

import pydantic
from pydantic.fields import FieldInfo

from ._types import IncEx, StrBytesIntFloat

_T = TypeVar("_T")
_ModelT = TypeVar("_ModelT", bound=pydantic.BaseModel)

# --------------- Pydantic v2, v3 compatibility ---------------

# Pyright incorrectly reports some of our functions as overriding a method when they don't
# pyright: reportIncompatibleMethodOverride=false

PYDANTIC_V1 = pydantic.VERSION.startswith("1.")

if TYPE_CHECKING:

    def parse_date(value: date | StrBytesIntFloat) -> date:  # noqa: ARG001
        ...

    def parse_datetime(value: Union[datetime, StrBytesIntFloat]) -> datetime:  # noqa: ARG001
        ...

    def get_args(t: type[Any]) -> tuple[Any, ...]:  # noqa: ARG001
        ...

    def is_union(tp: type[Any] | None) -> bool:  # noqa: ARG001
        ...

    def get_origin(t: type[Any]) -> type[Any] | None:  # noqa: ARG001
        ...

    def is_literal_type(type_: type[Any]) -> bool:  # noqa: ARG001
        ...

    def is_typeddict(type_: type[Any]) -> bool:  # noqa: ARG001
        ...

else:
    # v1 re-exports
    if PYDANTIC_V1:
        from pydantic.typing import (
            get_args as get_args,
            is_union as is_union,
            get_origin as get_origin,
            is_typeddict as is_typeddict,
            is_literal_type as is_literal_type,
        )
        from pydantic.datetime_parse import parse_date as parse_date, parse_datetime as parse_datetime
    else:
        from ._utils import (
            get_args as get_args,
            is_union as is_union,
            get_origin as get_origin,
            parse_date as parse_date,
            is_typeddict as is_typeddict,
            parse_datetime as parse_datetime,
            is_literal_type as is_literal_type,
        )


# refactored config
if TYPE_CHECKING:
    from pydantic import ConfigDict as ConfigDict
else:
    if PYDANTIC_V1:
        # TODO: provide an error message here?
        ConfigDict = None
    else:
        from pydantic import ConfigDict as ConfigDict


# renamed methods / properties
def parse_obj(model: type[_ModelT], value: object) -> _ModelT:
    if PYDANTIC_V1:
        return cast(_ModelT, model.parse_obj(value))  # pyright: ignore[reportDeprecated, reportUnnecessaryCast]
    else:
        return model.model_validate(value)


def field_is_required(field: FieldInfo) -> bool:
    if PYDANTIC_V1:
        return field.required  # type: ignore
    return field.is_required()


def field_get_default(field: FieldInfo) -> Any:
    value = field.get_default()
    if PYDANTIC_V1:
        return value
    from pydantic_core import PydanticUndefined

    if value == PydanticUndefined:
        return None
    return value


def field_outer_type(field: FieldInfo) -> Any:
    if PYDANTIC_V1:
        return field.outer_type_  # type: ignore
    return field.annotation


def get_model_config(model: type[pydantic.BaseModel]) -> Any:
    if PYDANTIC_V1:
        return model.__config__  # type: ignore
    return model.model_config


def get_model_fields(model: type[pydantic.BaseModel]) -> dict[str, FieldInfo]:
    if PYDANTIC_V1:
        return model.__fields__  # type: ignore
    return model.model_fields


def model_copy(model: _ModelT, *, deep: bool = False) -> _ModelT:
    if PYDANTIC_V1:
        return model.copy(deep=deep)  # type: ignore
    return model.model_copy(deep=deep)


def model_json(model: pydantic.BaseModel, *, indent: int | None = None) -> str:
    if PYDANTIC_V1:
        return model.json(indent=indent)  # type: ignore
    return model.model_dump_json(indent=indent)


def model_dump(
    model: pydantic.BaseModel,
    *,
    exclude: IncEx | None = None,
    exclude_unset: bool = False,
    exclude_defaults: bool = False,
    warnings: bool = True,
    mode: Literal["json", "python"] = "python",
    by_alias: bool | None = None,
) -> dict[str, Any]:
    if (not PYDANTIC_V1) or hasattr(model, "model_dump"):
        return model.model_dump(
            mode=mode,
            exclude=exclude,
            exclude_unset=exclude_unset,
            exclude_defaults=exclude_defaults,
            # warnings are not supported in Pydantic v1
            warnings=True if PYDANTIC_V1 else warnings,
            by_alias=by_alias,
        )
    return cast(
        "dict[str, Any]",
        model.dict(  # pyright: ignore[reportDeprecated, reportUnnecessaryCast]
            exclude=exclude, exclude_unset=exclude_unset, exclude_defaults=exclude_defaults, by_alias=bool(by_alias)
        ),
    )


def model_parse(model: type[_ModelT], data: Any) -> _ModelT:
    if PYDANTIC_V1:
        return model.parse_obj(data)  # pyright: ignore[reportDeprecated]
    return model.model_validate(data)


# generic models
if TYPE_CHECKING:

    class GenericModel(pydantic.BaseModel): ...

else:
    if PYDANTIC_V1:
        import pydantic.generics

        class GenericModel(pydantic.generics.GenericModel, pydantic.BaseModel): ...
    else:
        # there no longer needs to be a distinction in v2 but
        # we still have to create our own subclass to avoid
        # inconsistent MRO ordering errors
        class GenericModel(pydantic.BaseModel): ...


# cached properties
if TYPE_CHECKING:
    cached_property = property

    # we define a separate type (copied from typeshed)
    # that represents that `cached_property` is `set`able
    # at runtime, which differs from `@property`.
    #
    # this is a separate type as editors likely special case
    # `@property` and we don't want to cause issues just to have
    # more helpful internal types.

    class typed_cached_property(Generic[_T]):
        func: Callable[[Any], _T]
        attrname: str | None

        def __init__(self, func: Callable[[Any], _T]) -> None: ...

        @overload
        def __get__(self, instance: None, owner: type[Any] | None = None) -> Self: ...

        @overload
        def __get__(self, instance: object, owner: type[Any] | None = None) -> _T: ...

        def __get__(self, instance: object, owner: type[Any] | None = None) -> _T | Self:
            raise NotImplementedError()

        def __set_name__(self, owner: type[Any], name: str) -> None: ...

        # __set__ is not defined at runtime, but @cached_property is designed to be settable
        def __set__(self, instance: object, value: _T) -> None: ...
else:
    from functools import cached_property as cached_property

    typed_cached_property = cached_property
