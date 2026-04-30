from __future__ import annotations

import os
import inspect
import weakref
from typing import (
    IO,
    TYPE_CHECKING,
    Any,
    Type,
    Union,
    Generic,
    TypeVar,
    Callable,
    Iterable,
    Optional,
    AsyncIterable,
    cast,
)
from datetime import date, datetime
from typing_extensions import (
    List,
    Unpack,
    Literal,
    ClassVar,
    Protocol,
    Required,
    ParamSpec,
    TypedDict,
    TypeGuard,
    final,
    override,
    runtime_checkable,
)

import pydantic
from pydantic.fields import FieldInfo

from ._types import (
    Body,
    IncEx,
    Query,
    ModelT,
    Headers,
    Timeout,
    NotGiven,
    AnyMapping,
    HttpxRequestFiles,
)
from ._utils import (
    PropertyInfo,
    is_list,
    is_given,
    json_safe,
    lru_cache,
    is_mapping,
    parse_date,
    coerce_boolean,
    parse_datetime,
    strip_not_given,
    extract_type_arg,
    is_annotated_type,
    is_type_alias_type,
    strip_annotated_type,
)
from ._compat import (
    PYDANTIC_V1,
    ConfigDict,
    GenericModel as BaseGenericModel,
    get_args,
    is_union,
    parse_obj,
    get_origin,
    is_literal_type,
    get_model_config,
    get_model_fields,
    field_get_default,
)
from ._constants import RAW_RESPONSE_HEADER

if TYPE_CHECKING:
    from pydantic_core.core_schema import ModelField, ModelSchema, LiteralSchema, ModelFieldsSchema

__all__ = ["BaseModel", "GenericModel"]

_T = TypeVar("_T")
_BaseModelT = TypeVar("_BaseModelT", bound="BaseModel")

P = ParamSpec("P")


@runtime_checkable
class _ConfigProtocol(Protocol):
    allow_population_by_field_name: bool


class BaseModel(pydantic.BaseModel):
    if PYDANTIC_V1:

        @property
        @override
        def model_fields_set(self) -> set[str]:
            # a forwards-compat shim for pydantic v2
            return self.__fields_set__  # type: ignore

        class Config(pydantic.BaseConfig):  # pyright: ignore[reportDeprecated]
            extra: Any = pydantic.Extra.allow  # type: ignore
    else:
        model_config: ClassVar[ConfigDict] = ConfigDict(
            extra="allow", defer_build=coerce_boolean(os.environ.get("DEFER_PYDANTIC_BUILD", "true"))
        )

    if TYPE_CHECKING:
        _request_id: Optional[str] = None
        """The ID of the request, returned via the `request-id` header. Useful for debugging requests and reporting issues to Anthropic.
        This will **only** be set for the top-level response object, it will not be defined for nested objects. For example:
        
        ```py
        message = await client.messages.create(...)
        message._request_id  # req_xxx
        message.usage._request_id  # raises `AttributeError`
        ```

        Note: unlike other properties that use an `_` prefix, this property
        *is* public. Unless documented otherwise, all other `_` prefix properties,
        methods and modules are *private*.
        """

    def to_dict(
        self,
        *,
        mode: Literal["json", "python"] = "python",
        use_api_names: bool = True,
        exclude_unset: bool = True,
        exclude_defaults: bool = False,
        exclude_none: bool = False,
        warnings: bool = True,
    ) -> dict[str, object]:
        """Recursively generate a dictionary representation of the model, optionally specifying which fields to include or exclude.

        By default, fields that were not set by the API will not be included,
        and keys will match the API response, *not* the property names from the model.

        For example, if the API responds with `"fooBar": true` but we've defined a `foo_bar: bool` property,
        the output will use the `"fooBar"` key (unless `use_api_names=False` is passed).

        Args:
            mode:
                If mode is 'json', the dictionary will only contain JSON serializable types. e.g. `datetime` will be turned into a string, `"2024-3-22T18:11:19.117000Z"`.
                If mode is 'python', the dictionary may contain any Python objects. e.g. `datetime(2024, 3, 22)`

            use_api_names: Whether to use the key that the API responded with or the property name. Defaults to `True`.
            exclude_unset: Whether to exclude fields that have not been explicitly set.
            exclude_defaults: Whether to exclude fields that are set to their default value from the output.
            exclude_none: Whether to exclude fields that have a value of `None` from the output.
            warnings: Whether to log warnings when invalid fields are encountered. This is only supported in Pydantic v2.
        """
        return self.model_dump(
            mode=mode,
            by_alias=use_api_names,
            exclude_unset=exclude_unset,
            exclude_defaults=exclude_defaults,
            exclude_none=exclude_none,
            warnings=warnings,
        )

    def to_json(
        self,
        *,
        indent: int | None = 2,
        use_api_names: bool = True,
        exclude_unset: bool = True,
        exclude_defaults: bool = False,
        exclude_none: bool = False,
        warnings: bool = True,
    ) -> str:
        """Generates a JSON string representing this model as it would be received from or sent to the API (but with indentation).

        By default, fields that were not set by the API will not be included,
        and keys will match the API response, *not* the property names from the model.

        For example, if the API responds with `"fooBar": true` but we've defined a `foo_bar: bool` property,
        the output will use the `"fooBar"` key (unless `use_api_names=False` is passed).

        Args:
            indent: Indentation to use in the JSON output. If `None` is passed, the output will be compact. Defaults to `2`
            use_api_names: Whether to use the key that the API responded with or the property name. Defaults to `True`.
            exclude_unset: Whether to exclude fields that have not been explicitly set.
            exclude_defaults: Whether to exclude fields that have the default value.
            exclude_none: Whether to exclude fields that have a value of `None`.
            warnings: Whether to show any warnings that occurred during serialization. This is only supported in Pydantic v2.
        """
        return self.model_dump_json(
            indent=indent,
            by_alias=use_api_names,
            exclude_unset=exclude_unset,
            exclude_defaults=exclude_defaults,
            exclude_none=exclude_none,
            warnings=warnings,
        )

    @override
    def __str__(self) -> str:
        # mypy complains about an invalid self arg
        return f"{self.__repr_name__()}({self.__repr_str__(', ')})"  # type: ignore[misc]

    # Override the 'construct' method in a way that supports recursive parsing without validation.
    # Based on https://github.com/samuelcolvin/pydantic/issues/1168#issuecomment-817742836.
    @classmethod
    @override
    def construct(  # pyright: ignore[reportIncompatibleMethodOverride]
        __cls: Type[ModelT],
        _fields_set: set[str] | None = None,
        **values: object,
    ) -> ModelT:
        m = __cls.__new__(__cls)
        fields_values: dict[str, object] = {}

        config = get_model_config(__cls)
        populate_by_name = (
            config.allow_population_by_field_name
            if isinstance(config, _ConfigProtocol)
            else config.get("populate_by_name")
        )

        if _fields_set is None:
            _fields_set = set()

        model_fields = get_model_fields(__cls)
        for name, field in model_fields.items():
            key = field.alias
            if key is None or (key not in values and populate_by_name):
                key = name

            if key in values:
                fields_values[name] = _construct_field(value=values[key], field=field, key=key)
                _fields_set.add(name)
            else:
                fields_values[name] = field_get_default(field)

        extra_field_type = _get_extra_fields_type(__cls)

        _extra = {}
        for key, value in values.items():
            if key not in model_fields:
                parsed = construct_type(value=value, type_=extra_field_type) if extra_field_type is not None else value

                if PYDANTIC_V1:
                    _fields_set.add(key)
                    fields_values[key] = parsed
                else:
                    _extra[key] = parsed

        object.__setattr__(m, "__dict__", fields_values)

        if PYDANTIC_V1:
            # init_private_attributes() does not exist in v2
            m._init_private_attributes()  # type: ignore

            # copied from Pydantic v1's `construct()` method
            object.__setattr__(m, "__fields_set__", _fields_set)
        else:
            # these properties are copied from Pydantic's `model_construct()` method
            object.__setattr__(m, "__pydantic_private__", None)
            object.__setattr__(m, "__pydantic_extra__", _extra)
            object.__setattr__(m, "__pydantic_fields_set__", _fields_set)

        return m

    if not TYPE_CHECKING:
        # type checkers incorrectly complain about this assignment
        # because the type signatures are technically different
        # although not in practice
        model_construct = construct

    if PYDANTIC_V1:
        # we define aliases for some of the new pydantic v2 methods so
        # that we can just document these methods without having to specify
        # a specific pydantic version as some users may not know which
        # pydantic version they are currently using

        @override
        def model_dump(
            self,
            *,
            mode: Literal["json", "python"] | str = "python",
            include: IncEx | None = None,
            exclude: IncEx | None = None,
            context: Any | None = None,
            by_alias: bool | None = None,
            exclude_unset: bool = False,
            exclude_defaults: bool = False,
            exclude_none: bool = False,
            exclude_computed_fields: bool = False,
            round_trip: bool = False,
            warnings: bool | Literal["none", "warn", "error"] = True,
            fallback: Callable[[Any], Any] | None = None,
            serialize_as_any: bool = False,
        ) -> dict[str, Any]:
            """Usage docs: https://docs.pydantic.dev/2.4/concepts/serialization/#modelmodel_dump

            Generate a dictionary representation of the model, optionally specifying which fields to include or exclude.

            Args:
                mode: The mode in which `to_python` should run.
                    If mode is 'json', the output will only contain JSON serializable types.
                    If mode is 'python', the output may contain non-JSON-serializable Python objects.
                include: A set of fields to include in the output.
                exclude: A set of fields to exclude from the output.
                context: Additional context to pass to the serializer.
                by_alias: Whether to use the field's alias in the dictionary key if defined.
                exclude_unset: Whether to exclude fields that have not been explicitly set.
                exclude_defaults: Whether to exclude fields that are set to their default value.
                exclude_none: Whether to exclude fields that have a value of `None`.
                exclude_computed_fields: Whether to exclude computed fields.
                    While this can be useful for round-tripping, it is usually recommended to use the dedicated
                    `round_trip` parameter instead.
                round_trip: If True, dumped values should be valid as input for non-idempotent types such as Json[T].
                warnings: How to handle serialization errors. False/"none" ignores them, True/"warn" logs errors,
                    "error" raises a [`PydanticSerializationError`][pydantic_core.PydanticSerializationError].
                fallback: A function to call when an unknown value is encountered. If not provided,
                    a [`PydanticSerializationError`][pydantic_core.PydanticSerializationError] error is raised.
                serialize_as_any: Whether to serialize fields with duck-typing serialization behavior.

            Returns:
                A dictionary representation of the model.
            """
            if mode not in {"json", "python"}:
                raise ValueError("mode must be either 'json' or 'python'")
            if round_trip != False:
                raise ValueError("round_trip is only supported in Pydantic v2")
            if warnings != True:
                raise ValueError("warnings is only supported in Pydantic v2")
            if context is not None:
                raise ValueError("context is only supported in Pydantic v2")
            if serialize_as_any != False:
                raise ValueError("serialize_as_any is only supported in Pydantic v2")
            if fallback is not None:
                raise ValueError("fallback is only supported in Pydantic v2")
            if exclude_computed_fields != False:
                raise ValueError("exclude_computed_fields is only supported in Pydantic v2")
            dumped = super().dict(  # pyright: ignore[reportDeprecated]
                include=include,
                exclude=exclude,
                by_alias=by_alias if by_alias is not None else False,
                exclude_unset=exclude_unset,
                exclude_defaults=exclude_defaults,
                exclude_none=exclude_none,
            )

            return cast("dict[str, Any]", json_safe(dumped)) if mode == "json" else dumped

        @override
        def model_dump_json(
            self,
            *,
            indent: int | None = None,
            ensure_ascii: bool = False,
            include: IncEx | None = None,
            exclude: IncEx | None = None,
            context: Any | None = None,
            by_alias: bool | None = None,
            exclude_unset: bool = False,
            exclude_defaults: bool = False,
            exclude_none: bool = False,
            exclude_computed_fields: bool = False,
            round_trip: bool = False,
            warnings: bool | Literal["none", "warn", "error"] = True,
            fallback: Callable[[Any], Any] | None = None,
            serialize_as_any: bool = False,
        ) -> str:
            """Usage docs: https://docs.pydantic.dev/2.4/concepts/serialization/#modelmodel_dump_json

            Generates a JSON representation of the model using Pydantic's `to_json` method.

            Args:
                indent: Indentation to use in the JSON output. If None is passed, the output will be compact.
                include: Field(s) to include in the JSON output. Can take either a string or set of strings.
                exclude: Field(s) to exclude from the JSON output. Can take either a string or set of strings.
                by_alias: Whether to serialize using field aliases.
                exclude_unset: Whether to exclude fields that have not been explicitly set.
                exclude_defaults: Whether to exclude fields that have the default value.
                exclude_none: Whether to exclude fields that have a value of `None`.
                round_trip: Whether to use serialization/deserialization between JSON and class instance.
                warnings: Whether to show any warnings that occurred during serialization.

            Returns:
                A JSON string representation of the model.
            """
            if round_trip != False:
                raise ValueError("round_trip is only supported in Pydantic v2")
            if warnings != True:
                raise ValueError("warnings is only supported in Pydantic v2")
            if context is not None:
                raise ValueError("context is only supported in Pydantic v2")
            if serialize_as_any != False:
                raise ValueError("serialize_as_any is only supported in Pydantic v2")
            if fallback is not None:
                raise ValueError("fallback is only supported in Pydantic v2")
            if ensure_ascii != False:
                raise ValueError("ensure_ascii is only supported in Pydantic v2")
            if exclude_computed_fields != False:
                raise ValueError("exclude_computed_fields is only supported in Pydantic v2")
            return super().json(  # type: ignore[reportDeprecated]
                indent=indent,
                include=include,
                exclude=exclude,
                by_alias=by_alias if by_alias is not None else False,
                exclude_unset=exclude_unset,
                exclude_defaults=exclude_defaults,
                exclude_none=exclude_none,
            )


def _construct_field(value: object, field: FieldInfo, key: str) -> object:
    if value is None:
        return field_get_default(field)

    if PYDANTIC_V1:
        type_ = cast(type, field.outer_type_)  # type: ignore
    else:
        type_ = field.annotation  # type: ignore

    if type_ is None:
        raise RuntimeError(f"Unexpected field type is None for {key}")

    return construct_type(value=value, type_=type_, metadata=getattr(field, "metadata", None))


def _get_extra_fields_type(cls: type[pydantic.BaseModel]) -> type | None:
    if PYDANTIC_V1:
        # TODO
        return None

    schema = cls.__pydantic_core_schema__
    if schema["type"] == "model":
        fields = schema["schema"]
        if fields["type"] == "model-fields":
            extras = fields.get("extras_schema")
            if extras and "cls" in extras:
                # mypy can't narrow the type
                return extras["cls"]  # type: ignore[no-any-return]

    return None


def is_basemodel(type_: type) -> bool:
    """Returns whether or not the given type is either a `BaseModel` or a union of `BaseModel`"""
    if is_union(type_):
        for variant in get_args(type_):
            if is_basemodel(variant):
                return True

        return False

    return is_basemodel_type(type_)


def is_basemodel_type(type_: type) -> TypeGuard[type[BaseModel] | type[GenericModel]]:
    origin = get_origin(type_) or type_
    if not inspect.isclass(origin):
        return False
    return issubclass(origin, BaseModel) or issubclass(origin, GenericModel)


def build(
    base_model_cls: Callable[P, _BaseModelT],
    *args: P.args,
    **kwargs: P.kwargs,
) -> _BaseModelT:
    """Construct a BaseModel class without validation.

    This is useful for cases where you need to instantiate a `BaseModel`
    from an API response as this provides type-safe params which isn't supported
    by helpers like `construct_type()`.

    ```py
    build(MyModel, my_field_a="foo", my_field_b=123)
    ```
    """
    if args:
        raise TypeError(
            "Received positional arguments which are not supported; Keyword arguments must be used instead",
        )

    return cast(_BaseModelT, construct_type(type_=base_model_cls, value=kwargs))


def construct_type_unchecked(*, value: object, type_: type[_T]) -> _T:
    """Loose coercion to the expected type with construction of nested values.

    Note: the returned value from this function is not guaranteed to match the
    given type.
    """
    return cast(_T, construct_type(value=value, type_=type_))


def construct_type(*, value: object, type_: object, metadata: Optional[List[Any]] = None) -> object:
    """Loose coercion to the expected type with construction of nested values.

    If the given value does not match the expected type then it is returned as-is.
    """

    # store a reference to the original type we were given before we extract any inner
    # types so that we can properly resolve forward references in `TypeAliasType` annotations
    original_type = None

    # we allow `object` as the input type because otherwise, passing things like
    # `Literal['value']` will be reported as a type error by type checkers
    type_ = cast("type[object]", type_)
    if is_type_alias_type(type_):
        original_type = type_  # type: ignore[unreachable]
        type_ = type_.__value__  # type: ignore[unreachable]

    # unwrap `Annotated[T, ...]` -> `T`
    if metadata is not None and len(metadata) > 0:
        meta: tuple[Any, ...] = tuple(metadata)
    elif is_annotated_type(type_):
        meta = get_args(type_)[1:]
        type_ = extract_type_arg(type_, 0)
    else:
        meta = tuple()

    # we need to use the origin class for any types that are subscripted generics
    # e.g. Dict[str, object]
    origin = get_origin(type_) or type_
    args = get_args(type_)

    if is_union(origin):
        try:
            return validate_type(type_=cast("type[object]", original_type or type_), value=value)
        except Exception:
            pass

        # if the type is a discriminated union then we want to construct the right variant
        # in the union, even if the data doesn't match exactly, otherwise we'd break code
        # that relies on the constructed class types, e.g.
        #
        # class FooType:
        #   kind: Literal['foo']
        #   value: str
        #
        # class BarType:
        #   kind: Literal['bar']
        #   value: int
        #
        # without this block, if the data we get is something like `{'kind': 'bar', 'value': 'foo'}` then
        # we'd end up constructing `FooType` when it should be `BarType`.
        discriminator = _build_discriminated_union_meta(union=type_, meta_annotations=meta)
        if discriminator and is_mapping(value):
            variant_value = value.get(discriminator.field_alias_from or discriminator.field_name)
            if variant_value and isinstance(variant_value, str):
                variant_type = discriminator.mapping.get(variant_value)
                if variant_type:
                    return construct_type(type_=variant_type, value=value)

        # if the data is not valid, use the first variant that doesn't fail while deserializing
        for variant in args:
            try:
                return construct_type(value=value, type_=variant)
            except Exception:
                continue

        raise RuntimeError(f"Could not convert data into a valid instance of {type_}")

    if origin == dict:
        if not is_mapping(value):
            return value

        _, items_type = get_args(type_)  # Dict[_, items_type]
        return {key: construct_type(value=item, type_=items_type) for key, item in value.items()}

    if (
        not is_literal_type(type_)
        and inspect.isclass(origin)
        and (issubclass(origin, BaseModel) or issubclass(origin, GenericModel))
    ):
        if is_list(value):
            return [cast(Any, type_).construct(**entry) if is_mapping(entry) else entry for entry in value]

        if is_mapping(value):
            if issubclass(type_, BaseModel):
                return type_.construct(**value)  # type: ignore[arg-type]

            return cast(Any, type_).construct(**value)

    if origin == list:
        if not is_list(value):
            return value

        inner_type = args[0]  # List[inner_type]
        return [construct_type(value=entry, type_=inner_type) for entry in value]

    if origin == float:
        if isinstance(value, int):
            coerced = float(value)
            if coerced != value:
                return value
            return coerced

        return value

    if type_ == datetime:
        try:
            return parse_datetime(value)  # type: ignore
        except Exception:
            return value

    if type_ == date:
        try:
            return parse_date(value)  # type: ignore
        except Exception:
            return value

    return value


@runtime_checkable
class CachedDiscriminatorType(Protocol):
    __discriminator__: DiscriminatorDetails


DISCRIMINATOR_CACHE: weakref.WeakKeyDictionary[type, DiscriminatorDetails] = weakref.WeakKeyDictionary()


class DiscriminatorDetails:
    field_name: str
    """The name of the discriminator field in the variant class, e.g.

    ```py
    class Foo(BaseModel):
        type: Literal['foo']
    ```

    Will result in field_name='type'
    """

    field_alias_from: str | None
    """The name of the discriminator field in the API response, e.g.

    ```py
    class Foo(BaseModel):
        type: Literal['foo'] = Field(alias='type_from_api')
    ```

    Will result in field_alias_from='type_from_api'
    """

    mapping: dict[str, type]
    """Mapping of discriminator value to variant type, e.g.

    {'foo': FooVariant, 'bar': BarVariant}
    """

    def __init__(
        self,
        *,
        mapping: dict[str, type],
        discriminator_field: str,
        discriminator_alias: str | None,
    ) -> None:
        self.mapping = mapping
        self.field_name = discriminator_field
        self.field_alias_from = discriminator_alias


def _build_discriminated_union_meta(*, union: type, meta_annotations: tuple[Any, ...]) -> DiscriminatorDetails | None:
    cached = DISCRIMINATOR_CACHE.get(union)
    if cached is not None:
        return cached

    discriminator_field_name: str | None = None

    for annotation in meta_annotations:
        if isinstance(annotation, PropertyInfo) and annotation.discriminator is not None:
            discriminator_field_name = annotation.discriminator
            break

    if not discriminator_field_name:
        return None

    mapping: dict[str, type] = {}
    discriminator_alias: str | None = None

    for variant in get_args(union):
        variant = strip_annotated_type(variant)
        if is_basemodel_type(variant):
            if PYDANTIC_V1:
                field_info = cast("dict[str, FieldInfo]", variant.__fields__).get(discriminator_field_name)  # pyright: ignore[reportDeprecated, reportUnnecessaryCast]
                if not field_info:
                    continue

                # Note: if one variant defines an alias then they all should
                discriminator_alias = field_info.alias

                if (annotation := getattr(field_info, "annotation", None)) and is_literal_type(annotation):
                    for entry in get_args(annotation):
                        if isinstance(entry, str):
                            mapping[entry] = variant
            else:
                field = _extract_field_schema_pv2(variant, discriminator_field_name)
                if not field:
                    continue

                # Note: if one variant defines an alias then they all should
                discriminator_alias = field.get("serialization_alias")

                field_schema = field["schema"]

                if field_schema["type"] == "literal":
                    for entry in cast("LiteralSchema", field_schema)["expected"]:
                        if isinstance(entry, str):
                            mapping[entry] = variant

    if not mapping:
        return None

    details = DiscriminatorDetails(
        mapping=mapping,
        discriminator_field=discriminator_field_name,
        discriminator_alias=discriminator_alias,
    )
    DISCRIMINATOR_CACHE.setdefault(union, details)
    return details


def _extract_field_schema_pv2(model: type[BaseModel], field_name: str) -> ModelField | None:
    schema = model.__pydantic_core_schema__
    if schema["type"] == "definitions":
        schema = schema["schema"]

    if schema["type"] != "model":
        return None

    schema = cast("ModelSchema", schema)
    fields_schema = schema["schema"]
    if fields_schema["type"] != "model-fields":
        return None

    fields_schema = cast("ModelFieldsSchema", fields_schema)
    field = fields_schema["fields"].get(field_name)
    if not field:
        return None

    return cast("ModelField", field)  # pyright: ignore[reportUnnecessaryCast]


def validate_type(*, type_: type[_T], value: object) -> _T:
    """Strict validation that the given value matches the expected type"""
    if inspect.isclass(type_) and issubclass(type_, pydantic.BaseModel):
        return cast(_T, parse_obj(type_, value))

    return cast(_T, _validate_non_model_type(type_=type_, value=value))


def set_pydantic_config(typ: Any, config: pydantic.ConfigDict) -> None:
    """Add a pydantic config for the given type.

    Note: this is a no-op on Pydantic v1.
    """
    setattr(typ, "__pydantic_config__", config)  # noqa: B010


def add_request_id(obj: BaseModel, request_id: str | None) -> None:
    obj._request_id = request_id

    # in Pydantic v1, using setattr like we do above causes the attribute
    # to be included when serializing the model which we don't want in this
    # case so we need to explicitly exclude it
    if PYDANTIC_V1:
        try:
            exclude_fields = obj.__exclude_fields__  # type: ignore
        except AttributeError:
            cast(Any, obj).__exclude_fields__ = {"_request_id", "__exclude_fields__"}
        else:
            cast(Any, obj).__exclude_fields__ = {*(exclude_fields or {}), "_request_id", "__exclude_fields__"}


# our use of subclassing here causes weirdness for type checkers,
# so we just pretend that we don't subclass
if TYPE_CHECKING:
    GenericModel = BaseModel
else:

    class GenericModel(BaseGenericModel, BaseModel):
        pass


if not PYDANTIC_V1:
    from pydantic import TypeAdapter as _TypeAdapter, computed_field as computed_field

    _CachedTypeAdapter = cast("TypeAdapter[object]", lru_cache(maxsize=None)(_TypeAdapter))

    if TYPE_CHECKING:
        from pydantic import TypeAdapter
    else:
        TypeAdapter = _CachedTypeAdapter

    def _validate_non_model_type(*, type_: type[_T], value: object) -> _T:
        return TypeAdapter(type_).validate_python(value)

elif not TYPE_CHECKING:  # TODO: condition is weird

    class RootModel(GenericModel, Generic[_T]):
        """Used as a placeholder to easily convert runtime types to a Pydantic format
        to provide validation.

        For example:
        ```py
        validated = RootModel[int](__root__="5").__root__
        # validated: 5
        ```
        """

        __root__: _T

    def _validate_non_model_type(*, type_: type[_T], value: object) -> _T:
        model = _create_pydantic_model(type_).validate(value)
        return cast(_T, model.__root__)

    def _create_pydantic_model(type_: _T) -> Type[RootModel[_T]]:
        return RootModel[type_]  # type: ignore

    def TypeAdapter(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("attempted to use TypeAdapter in pydantic v1")

    def computed_field(func: Any | None = None, /, **__: Any) -> Any:
        def _exc_func(*_: Any, **__: Any) -> Any:
            raise RuntimeError("attempted to use computed_field in pydantic v1")

        def _dec(*_: Any, **__: Any) -> Any:
            return _exc_func

        if func is not None:
            return _dec(func)
        else:
            return _dec


class FinalRequestOptionsInput(TypedDict, total=False):
    method: Required[str]
    url: Required[str]
    params: Query
    headers: Headers
    max_retries: int
    timeout: float | Timeout | None
    files: HttpxRequestFiles | None
    idempotency_key: str
    content: Union[bytes, bytearray, IO[bytes], Iterable[bytes], AsyncIterable[bytes], None]
    json_data: Body
    extra_json: AnyMapping
    follow_redirects: bool


@final
class FinalRequestOptions(pydantic.BaseModel):
    method: str
    url: str
    params: Query = {}
    headers: Union[Headers, NotGiven] = NotGiven()
    max_retries: Union[int, NotGiven] = NotGiven()
    timeout: Union[float, Timeout, None, NotGiven] = NotGiven()
    files: Union[HttpxRequestFiles, None] = None
    idempotency_key: Union[str, None] = None
    post_parser: Union[Callable[[Any], Any], NotGiven] = NotGiven()
    follow_redirects: Union[bool, None] = None

    content: Union[bytes, bytearray, IO[bytes], Iterable[bytes], AsyncIterable[bytes], None] = None
    # It should be noted that we cannot use `json` here as that would override
    # a BaseModel method in an incompatible fashion.
    json_data: Union[Body, None] = None
    extra_json: Union[AnyMapping, None] = None

    if PYDANTIC_V1:

        class Config(pydantic.BaseConfig):  # pyright: ignore[reportDeprecated]
            arbitrary_types_allowed: bool = True
    else:
        model_config: ClassVar[ConfigDict] = ConfigDict(arbitrary_types_allowed=True)

    def get_max_retries(self, max_retries: int) -> int:
        if isinstance(self.max_retries, NotGiven):
            return max_retries
        return self.max_retries

    def _strip_raw_response_header(self) -> None:
        if not is_given(self.headers):
            return

        if self.headers.get(RAW_RESPONSE_HEADER):
            self.headers = {**self.headers}
            self.headers.pop(RAW_RESPONSE_HEADER)

    # override the `construct` method so that we can run custom transformations.
    # this is necessary as we don't want to do any actual runtime type checking
    # (which means we can't use validators) but we do want to ensure that `NotGiven`
    # values are not present
    #
    # type ignore required because we're adding explicit types to `**values`
    @classmethod
    def construct(  # type: ignore
        cls,
        _fields_set: set[str] | None = None,
        **values: Unpack[FinalRequestOptionsInput],
    ) -> FinalRequestOptions:
        kwargs: dict[str, Any] = {
            # we unconditionally call `strip_not_given` on any value
            # as it will just ignore any non-mapping types
            key: strip_not_given(value)
            for key, value in values.items()
        }
        if PYDANTIC_V1:
            return cast(FinalRequestOptions, super().construct(_fields_set, **kwargs))  # pyright: ignore[reportDeprecated]
        return super().model_construct(_fields_set, **kwargs)

    if not TYPE_CHECKING:
        # type checkers incorrectly complain about this assignment
        model_construct = construct
