"""Convert python types to pydantic-core schema."""

from __future__ import annotations as _annotations

import collections.abc
import dataclasses
import datetime
import inspect
import os
import pathlib
import re
import sys
import typing
import warnings
from collections.abc import Generator, Iterable, Iterator, Mapping
from contextlib import contextmanager
from copy import copy
from decimal import Decimal
from enum import Enum
from fractions import Fraction
from functools import partial
from inspect import Parameter, _ParameterKind
from ipaddress import IPv4Address, IPv4Interface, IPv4Network, IPv6Address, IPv6Interface, IPv6Network
from itertools import chain
from operator import attrgetter
from types import FunctionType, GenericAlias, LambdaType, MethodType
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Final,
    ForwardRef,
    Literal,
    TypeVar,
    Union,
    cast,
    overload,
)
from uuid import UUID
from zoneinfo import ZoneInfo

import typing_extensions
from pydantic_core import (
    MISSING,
    CoreSchema,
    MultiHostUrl,
    PydanticCustomError,
    PydanticSerializationUnexpectedValue,
    PydanticUndefined,
    Url,
    core_schema,
    to_jsonable_python,
)
from typing_extensions import TypeAlias, TypeAliasType, get_args, get_origin, is_typeddict
from typing_inspection import typing_objects
from typing_inspection.introspection import AnnotationSource, get_literal_values, is_union_origin

from ..aliases import AliasChoices, AliasPath
from ..annotated_handlers import GetCoreSchemaHandler, GetJsonSchemaHandler
from ..config import ConfigDict, JsonDict, JsonEncoder, JsonSchemaExtraCallable
from ..errors import (
    PydanticForbiddenQualifier,
    PydanticInvalidForJsonSchema,
    PydanticSchemaGenerationError,
    PydanticUndefinedAnnotation,
    PydanticUserError,
)
from ..functional_validators import AfterValidator, BeforeValidator, FieldValidatorModes, PlainValidator, WrapValidator
from ..json_schema import JsonSchemaValue
from ..version import version_short
from ..warnings import (
    ArbitraryTypeWarning,
    PydanticDeprecatedSince20,
    TypedDictExtraConfigWarning,
    UnsupportedFieldAttributeWarning,
)
from . import _decorators, _discriminated_union, _known_annotated_metadata, _repr, _typing_extra
from ._config import ConfigWrapper, ConfigWrapperStack
from ._core_metadata import CoreMetadata, update_core_metadata
from ._core_utils import (
    get_ref,
    get_type_ref,
    is_list_like_schema_with_items_schema,
)
from ._decorators import (
    Decorator,
    DecoratorInfos,
    FieldSerializerDecoratorInfo,
    FieldValidatorDecoratorInfo,
    ModelSerializerDecoratorInfo,
    ModelValidatorDecoratorInfo,
    RootValidatorDecoratorInfo,
    ValidatorDecoratorInfo,
    get_attribute_from_bases,
    inspect_field_serializer,
    inspect_model_serializer,
    inspect_validator,
)
from ._docs_extraction import extract_docstrings_from_cls
from ._fields import (
    collect_dataclass_fields,
    rebuild_dataclass_fields,
    rebuild_model_fields,
    takes_validated_data_argument,
    update_field_from_config,
)
from ._forward_ref import PydanticRecursiveRef
from ._generics import get_standard_typevars_map, replace_types
from ._import_utils import import_cached_base_model, import_cached_field_info
from ._mock_val_ser import MockCoreSchema
from ._namespace_utils import NamespacesTuple, NsResolver
from ._schema_gather import MissingDefinitionError, gather_schemas_for_cleaning
from ._schema_generation_shared import CallbackGetCoreSchemaHandler
from ._utils import lenient_issubclass, smart_deepcopy

if TYPE_CHECKING:
    from ..fields import ComputedFieldInfo, FieldInfo
    from ..main import BaseModel
    from ..types import Discriminator
    from ._dataclasses import StandardDataclass
    from ._schema_generation_shared import GetJsonSchemaFunction

_SUPPORTS_TYPEDDICT = sys.version_info >= (3, 12)

FieldDecoratorInfo = Union[ValidatorDecoratorInfo, FieldValidatorDecoratorInfo, FieldSerializerDecoratorInfo]
FieldDecoratorInfoType = TypeVar('FieldDecoratorInfoType', bound=FieldDecoratorInfo)
AnyFieldDecorator = Union[
    Decorator[ValidatorDecoratorInfo],
    Decorator[FieldValidatorDecoratorInfo],
    Decorator[FieldSerializerDecoratorInfo],
]

ModifyCoreSchemaWrapHandler: TypeAlias = GetCoreSchemaHandler
GetCoreSchemaFunction: TypeAlias = Callable[[Any, ModifyCoreSchemaWrapHandler], core_schema.CoreSchema]
ParametersCallback: TypeAlias = "Callable[[int, str, Any], Literal['skip'] | None]"

TUPLE_TYPES: list[type] = [typing.Tuple, tuple]  # noqa: UP006
LIST_TYPES: list[type] = [typing.List, list, collections.abc.MutableSequence]  # noqa: UP006
SET_TYPES: list[type] = [typing.Set, set, collections.abc.MutableSet]  # noqa: UP006
FROZEN_SET_TYPES: list[type] = [typing.FrozenSet, frozenset, collections.abc.Set]  # noqa: UP006
DICT_TYPES: list[type] = [typing.Dict, dict]  # noqa: UP006
IP_TYPES: list[type] = [IPv4Address, IPv4Interface, IPv4Network, IPv6Address, IPv6Interface, IPv6Network]
SEQUENCE_TYPES: list[type] = [typing.Sequence, collections.abc.Sequence]
ITERABLE_TYPES: list[type] = [typing.Iterable, collections.abc.Iterable, typing.Generator, collections.abc.Generator]
TYPE_TYPES: list[type] = [typing.Type, type]  # noqa: UP006
PATTERN_TYPES: list[type] = [typing.Pattern, re.Pattern]
PATH_TYPES: list[type] = [
    os.PathLike,
    pathlib.Path,
    pathlib.PurePath,
    pathlib.PosixPath,
    pathlib.PurePosixPath,
    pathlib.PureWindowsPath,
]
MAPPING_TYPES = [
    typing.Mapping,
    typing.MutableMapping,
    collections.abc.Mapping,
    collections.abc.MutableMapping,
    collections.OrderedDict,
    typing_extensions.OrderedDict,
    typing.DefaultDict,  # noqa: UP006
    collections.defaultdict,
]
COUNTER_TYPES = [collections.Counter, typing.Counter]
DEQUE_TYPES: list[type] = [collections.deque, typing.Deque]  # noqa: UP006

# Note: This does not play very well with type checkers. For example,
# `a: LambdaType = lambda x: x` will raise a type error by Pyright.
ValidateCallSupportedTypes = Union[
    LambdaType,
    FunctionType,
    MethodType,
    partial,
]

VALIDATE_CALL_SUPPORTED_TYPES = get_args(ValidateCallSupportedTypes)
UNSUPPORTED_STANDALONE_FIELDINFO_ATTRIBUTES: list[tuple[str, Any]] = [
    ('alias', None),
    ('validation_alias', None),
    ('serialization_alias', None),
    # will be set if any alias is set, so disable it to avoid double warnings:
    # 'alias_priority',
    ('default', PydanticUndefined),
    ('default_factory', None),
    ('exclude', None),
    ('deprecated', None),
    ('repr', True),
    ('validate_default', None),
    ('frozen', None),
    ('init', None),
    ('init_var', None),
    ('kw_only', None),
]
"""`FieldInfo` attributes (and their default value) that can't be used outside of a model (e.g. in a type adapter or a PEP 695 type alias)."""

_mode_to_validator: dict[
    FieldValidatorModes, type[BeforeValidator | AfterValidator | PlainValidator | WrapValidator]
] = {'before': BeforeValidator, 'after': AfterValidator, 'plain': PlainValidator, 'wrap': WrapValidator}


def check_validator_fields_against_field_name(
    info: FieldDecoratorInfo,
    field: str,
) -> bool:
    """Check if field name is in validator fields.

    Args:
        info: The field info.
        field: The field name to check.

    Returns:
        `True` if field name is in validator fields, `False` otherwise.
    """
    fields = info.fields
    return '*' in fields or field in fields


def check_decorator_fields_exist(decorators: Iterable[AnyFieldDecorator], fields: Iterable[str]) -> None:
    """Check if the defined fields in decorators exist in `fields` param.

    It ignores the check for a decorator if the decorator has `*` as field or `check_fields=False`.

    Args:
        decorators: An iterable of decorators.
        fields: An iterable of fields name.

    Raises:
        PydanticUserError: If one of the field names does not exist in `fields` param.
    """
    fields = set(fields)
    for dec in decorators:
        if '*' in dec.info.fields:
            continue
        if dec.info.check_fields is False:
            continue
        for field in dec.info.fields:
            if field not in fields:
                raise PydanticUserError(
                    f'Decorators defined with incorrect fields: {dec.cls_ref}.{dec.cls_var_name}'
                    " (use check_fields=False if you're inheriting from the model and intended this)",
                    code='decorator-missing-field',
                )


def filter_field_decorator_info_by_field(
    validator_functions: Iterable[Decorator[FieldDecoratorInfoType]], field: str
) -> list[Decorator[FieldDecoratorInfoType]]:
    return [dec for dec in validator_functions if check_validator_fields_against_field_name(dec.info, field)]


def apply_each_item_validators(
    schema: core_schema.CoreSchema,
    each_item_validators: list[Decorator[ValidatorDecoratorInfo]],
) -> core_schema.CoreSchema:
    # This V1 compatibility shim should eventually be removed

    # fail early if each_item_validators is empty
    if not each_item_validators:
        return schema

    # push down any `each_item=True` validators
    # note that this won't work for any Annotated types that get wrapped by a function validator
    # but that's okay because that didn't exist in V1
    if schema['type'] == 'nullable':
        schema['schema'] = apply_each_item_validators(schema['schema'], each_item_validators)
        return schema
    elif schema['type'] == 'tuple':
        if (variadic_item_index := schema.get('variadic_item_index')) is not None:
            schema['items_schema'][variadic_item_index] = apply_validators(
                schema['items_schema'][variadic_item_index],
                each_item_validators,
            )
    elif is_list_like_schema_with_items_schema(schema):
        inner_schema = schema.get('items_schema', core_schema.any_schema())
        schema['items_schema'] = apply_validators(inner_schema, each_item_validators)
    elif schema['type'] == 'dict':
        inner_schema = schema.get('values_schema', core_schema.any_schema())
        schema['values_schema'] = apply_validators(inner_schema, each_item_validators)
    else:
        raise TypeError(
            f'`@validator(..., each_item=True)` cannot be applied to fields with a schema of {schema["type"]}'
        )
    return schema


def _extract_json_schema_info_from_field_info(
    info: FieldInfo | ComputedFieldInfo,
) -> tuple[JsonDict | None, JsonDict | JsonSchemaExtraCallable | None]:
    json_schema_updates = {
        'title': info.title,
        'description': info.description,
        'deprecated': bool(info.deprecated) or info.deprecated == '' or None,
        'examples': to_jsonable_python(info.examples),
    }
    json_schema_updates = {k: v for k, v in json_schema_updates.items() if v is not None}
    return (json_schema_updates or None, info.json_schema_extra)


JsonEncoders = dict[type[Any], JsonEncoder]


def _add_custom_serialization_from_json_encoders(
    json_encoders: JsonEncoders | None, tp: Any, schema: CoreSchema
) -> CoreSchema:
    """Iterate over the json_encoders and add the first matching encoder to the schema.

    Args:
        json_encoders: A dictionary of types and their encoder functions.
        tp: The type to check for a matching encoder.
        schema: The schema to add the encoder to.
    """
    if not json_encoders:
        return schema
    if 'serialization' in schema:
        return schema
    # Check the class type and its superclasses for a matching encoder
    # Decimal.__class__.__mro__ (and probably other cases) doesn't include Decimal itself
    # if the type is a GenericAlias (e.g. from list[int]) we need to use __class__ instead of .__mro__
    for base in (tp, *getattr(tp, '__mro__', tp.__class__.__mro__)[:-1]):
        encoder = json_encoders.get(base)
        if encoder is None:
            continue

        warnings.warn(
            f'`json_encoders` is deprecated. See https://docs.pydantic.dev/{version_short()}/concepts/serialization/#custom-serializers for alternatives',
            PydanticDeprecatedSince20,
        )

        # TODO: in theory we should check that the schema accepts a serialization key
        schema['serialization'] = core_schema.plain_serializer_function_ser_schema(encoder, when_used='json')
        return schema

    return schema


GENERATE_SCHEMA_ERRORS = (
    PydanticForbiddenQualifier,
    PydanticInvalidForJsonSchema,
    PydanticSchemaGenerationError,
    PydanticUndefinedAnnotation,
)
"""Errors raised during core schema generation. This does *not* include `InvalidSchemaError`, which is raised during schema cleaning."""


class InvalidSchemaError(Exception):
    """The core schema is invalid."""


class GenerateSchema:
    """Generate core schema for a Pydantic model, dataclass and types like `str`, `datetime`, ... ."""

    __slots__ = (
        '_config_wrapper_stack',
        '_ns_resolver',
        '_typevars_map',
        'field_name_stack',
        'model_type_stack',
        'defs',
    )

    def __init__(
        self,
        config_wrapper: ConfigWrapper,
        ns_resolver: NsResolver | None = None,
        typevars_map: Mapping[TypeVar, Any] | None = None,
    ) -> None:
        # we need a stack for recursing into nested models
        self._config_wrapper_stack = ConfigWrapperStack(config_wrapper)
        self._ns_resolver = ns_resolver or NsResolver()
        self._typevars_map = typevars_map
        self.field_name_stack = _FieldNameStack()
        self.model_type_stack = _ModelTypeStack()
        self.defs = _Definitions()

    def __init_subclass__(cls) -> None:
        super().__init_subclass__()
        warnings.warn(
            'Subclassing `GenerateSchema` is not supported. The API is highly subject to change in minor versions.',
            UserWarning,
            stacklevel=2,
        )

    @property
    def _config_wrapper(self) -> ConfigWrapper:
        return self._config_wrapper_stack.tail

    @property
    def _types_namespace(self) -> NamespacesTuple:
        return self._ns_resolver.types_namespace

    @property
    def _arbitrary_types(self) -> bool:
        return self._config_wrapper.arbitrary_types_allowed

    # the following methods can be overridden but should be considered
    # unstable / private APIs
    def _list_schema(self, items_type: Any) -> CoreSchema:
        return core_schema.list_schema(self.generate_schema(items_type))

    def _dict_schema(self, keys_type: Any, values_type: Any) -> CoreSchema:
        return core_schema.dict_schema(self.generate_schema(keys_type), self.generate_schema(values_type))

    def _set_schema(self, items_type: Any) -> CoreSchema:
        return core_schema.set_schema(self.generate_schema(items_type))

    def _frozenset_schema(self, items_type: Any) -> CoreSchema:
        return core_schema.frozenset_schema(self.generate_schema(items_type))

    def _enum_schema(self, enum_type: type[Enum]) -> CoreSchema:
        cases: list[Any] = list(enum_type.__members__.values())

        enum_ref = get_type_ref(enum_type)
        description = None if not enum_type.__doc__ else inspect.cleandoc(enum_type.__doc__)
        if (
            description == 'An enumeration.'
        ):  # This is the default value provided by enum.EnumMeta.__new__; don't use it
            description = None
        js_updates = {'title': enum_type.__name__, 'description': description}
        js_updates = {k: v for k, v in js_updates.items() if v is not None}

        sub_type: Literal['str', 'int', 'float'] | None = None
        if issubclass(enum_type, int):
            sub_type = 'int'
            value_ser_type: core_schema.SerSchema = core_schema.simple_ser_schema('int')
        elif issubclass(enum_type, str):
            # this handles `StrEnum` (3.11 only), and also `Foobar(str, Enum)`
            sub_type = 'str'
            value_ser_type = core_schema.simple_ser_schema('str')
        elif issubclass(enum_type, float):
            sub_type = 'float'
            value_ser_type = core_schema.simple_ser_schema('float')
        else:
            # TODO this is an ugly hack, how do we trigger an Any schema for serialization?
            value_ser_type = core_schema.plain_serializer_function_ser_schema(lambda x: x)

        if cases:

            def get_json_schema(schema: CoreSchema, handler: GetJsonSchemaHandler) -> JsonSchemaValue:
                json_schema = handler(schema)
                original_schema = handler.resolve_ref_schema(json_schema)
                original_schema.update(js_updates)
                return json_schema

            # we don't want to add the missing to the schema if it's the default one
            default_missing = getattr(enum_type._missing_, '__func__', None) is Enum._missing_.__func__  # pyright: ignore[reportFunctionMemberAccess]
            enum_schema = core_schema.enum_schema(
                enum_type,
                cases,
                sub_type=sub_type,
                missing=None if default_missing else enum_type._missing_,
                ref=enum_ref,
                metadata={'pydantic_js_functions': [get_json_schema]},
            )

            if self._config_wrapper.use_enum_values:
                enum_schema = core_schema.no_info_after_validator_function(
                    attrgetter('value'), enum_schema, serialization=value_ser_type
                )

            return enum_schema

        else:

            def get_json_schema_no_cases(_, handler: GetJsonSchemaHandler) -> JsonSchemaValue:
                json_schema = handler(core_schema.enum_schema(enum_type, cases, sub_type=sub_type, ref=enum_ref))
                original_schema = handler.resolve_ref_schema(json_schema)
                original_schema.update(js_updates)
                return json_schema

            # Use an isinstance check for enums with no cases.
            # The most important use case for this is creating TypeVar bounds for generics that should
            # be restricted to enums. This is more consistent than it might seem at first, since you can only
            # subclass enum.Enum (or subclasses of enum.Enum) if all parent classes have no cases.
            # We use the get_json_schema function when an Enum subclass has been declared with no cases
            # so that we can still generate a valid json schema.
            return core_schema.is_instance_schema(
                enum_type,
                metadata={'pydantic_js_functions': [get_json_schema_no_cases]},
            )

    def _ip_schema(self, tp: Any) -> CoreSchema:
        from ._validators import IP_VALIDATOR_LOOKUP, IpType

        ip_type_json_schema_format: dict[type[IpType], str] = {
            IPv4Address: 'ipv4',
            IPv4Network: 'ipv4network',
            IPv4Interface: 'ipv4interface',
            IPv6Address: 'ipv6',
            IPv6Network: 'ipv6network',
            IPv6Interface: 'ipv6interface',
        }

        def ser_ip(ip: Any, info: core_schema.SerializationInfo) -> str | IpType:
            if not isinstance(ip, (tp, str)):
                raise PydanticSerializationUnexpectedValue(
                    f"Expected `{tp}` but got `{type(ip)}` with value `'{ip}'` - serialized value may not be as expected."
                )
            if info.mode == 'python':
                return ip
            return str(ip)

        return core_schema.lax_or_strict_schema(
            lax_schema=core_schema.no_info_plain_validator_function(IP_VALIDATOR_LOOKUP[tp]),
            strict_schema=core_schema.json_or_python_schema(
                json_schema=core_schema.no_info_after_validator_function(tp, core_schema.str_schema()),
                python_schema=core_schema.is_instance_schema(tp),
            ),
            serialization=core_schema.plain_serializer_function_ser_schema(ser_ip, info_arg=True, when_used='always'),
            metadata={
                'pydantic_js_functions': [lambda _1, _2: {'type': 'string', 'format': ip_type_json_schema_format[tp]}]
            },
        )

    def _path_schema(self, tp: Any, path_type: Any) -> CoreSchema:
        if tp is os.PathLike and (path_type not in {str, bytes} and not typing_objects.is_any(path_type)):
            raise PydanticUserError(
                '`os.PathLike` can only be used with `str`, `bytes` or `Any`', code='schema-for-unknown-type'
            )

        path_constructor = pathlib.PurePath if tp is os.PathLike else tp
        strict_inner_schema = (
            core_schema.bytes_schema(strict=True) if (path_type is bytes) else core_schema.str_schema(strict=True)
        )
        lax_inner_schema = core_schema.bytes_schema() if (path_type is bytes) else core_schema.str_schema()

        def path_validator(input_value: str | bytes) -> os.PathLike[Any]:  # type: ignore
            try:
                if path_type is bytes:
                    if isinstance(input_value, bytes):
                        try:
                            input_value = input_value.decode()
                        except UnicodeDecodeError as e:
                            raise PydanticCustomError('bytes_type', 'Input must be valid bytes') from e
                    else:
                        raise PydanticCustomError('bytes_type', 'Input must be bytes')
                elif not isinstance(input_value, str):
                    raise PydanticCustomError('path_type', 'Input is not a valid path')

                return path_constructor(input_value)  # type: ignore
            except TypeError as e:
                raise PydanticCustomError('path_type', 'Input is not a valid path') from e

        def ser_path(path: Any, info: core_schema.SerializationInfo) -> str | os.PathLike[Any]:
            if not isinstance(path, (tp, str)):
                raise PydanticSerializationUnexpectedValue(
                    f"Expected `{tp}` but got `{type(path)}` with value `'{path}'` - serialized value may not be as expected."
                )
            if info.mode == 'python':
                return path
            return str(path)

        instance_schema = core_schema.json_or_python_schema(
            json_schema=core_schema.no_info_after_validator_function(path_validator, lax_inner_schema),
            python_schema=core_schema.is_instance_schema(tp),
        )

        schema = core_schema.lax_or_strict_schema(
            lax_schema=core_schema.union_schema(
                [
                    instance_schema,
                    core_schema.no_info_after_validator_function(path_validator, strict_inner_schema),
                ],
                custom_error_type='path_type',
                custom_error_message=f'Input is not a valid path for {tp}',
            ),
            strict_schema=instance_schema,
            serialization=core_schema.plain_serializer_function_ser_schema(ser_path, info_arg=True, when_used='always'),
            metadata={'pydantic_js_functions': [lambda source, handler: {**handler(source), 'format': 'path'}]},
        )
        return schema

    def _deque_schema(self, items_type: Any) -> CoreSchema:
        from ._serializers import serialize_sequence_via_list
        from ._validators import deque_validator

        item_type_schema = self.generate_schema(items_type)

        # we have to use a lax list schema here, because we need to validate the deque's
        # items via a list schema, but it's ok if the deque itself is not a list
        list_schema = core_schema.list_schema(item_type_schema, strict=False)

        check_instance = core_schema.json_or_python_schema(
            json_schema=list_schema,
            python_schema=core_schema.is_instance_schema(collections.deque, cls_repr='Deque'),
        )

        lax_schema = core_schema.no_info_wrap_validator_function(deque_validator, list_schema)

        return core_schema.lax_or_strict_schema(
            lax_schema=lax_schema,
            strict_schema=core_schema.chain_schema([check_instance, lax_schema]),
            serialization=core_schema.wrap_serializer_function_ser_schema(
                serialize_sequence_via_list, schema=item_type_schema, info_arg=True
            ),
        )

    def _mapping_schema(self, tp: Any, keys_type: Any, values_type: Any) -> CoreSchema:
        from ._validators import MAPPING_ORIGIN_MAP, defaultdict_validator, get_defaultdict_default_default_factory

        mapped_origin = MAPPING_ORIGIN_MAP[tp]
        keys_schema = self.generate_schema(keys_type)
        with warnings.catch_warnings():
            # We kind of abused `Field()` default factories to be able to specify
            # the `defaultdict`'s `default_factory`. As a consequence, we get warnings
            # as normally `FieldInfo.default_factory` is unsupported in the context where
            # `Field()` is used and our only solution is to ignore them (note that this might
            # wrongfully ignore valid warnings, e.g. if the `value_type` is a PEP 695 type alias
            # with unsupported metadata).
            warnings.simplefilter('ignore', category=UnsupportedFieldAttributeWarning)
            values_schema = self.generate_schema(values_type)
        dict_schema = core_schema.dict_schema(keys_schema, values_schema, strict=False)

        if mapped_origin is dict:
            schema = dict_schema
        else:
            check_instance = core_schema.json_or_python_schema(
                json_schema=dict_schema,
                python_schema=core_schema.is_instance_schema(mapped_origin),
            )

            if tp is collections.defaultdict:
                default_default_factory = get_defaultdict_default_default_factory(values_type)
                coerce_instance_wrap = partial(
                    core_schema.no_info_wrap_validator_function,
                    partial(defaultdict_validator, default_default_factory=default_default_factory),
                )
            else:
                coerce_instance_wrap = partial(core_schema.no_info_after_validator_function, mapped_origin)

            lax_schema = coerce_instance_wrap(dict_schema)
            strict_schema = core_schema.chain_schema([check_instance, lax_schema])

            schema = core_schema.lax_or_strict_schema(
                lax_schema=lax_schema,
                strict_schema=strict_schema,
                serialization=core_schema.wrap_serializer_function_ser_schema(
                    lambda v, h: h(v), schema=dict_schema, info_arg=False
                ),
            )

        return schema

    def _fraction_schema(self) -> CoreSchema:
        """Support for [`fractions.Fraction`][fractions.Fraction]."""
        from ._validators import fraction_validator

        # TODO: note, this is a fairly common pattern, re lax / strict for attempted type coercion,
        # can we use a helper function to reduce boilerplate?
        return core_schema.lax_or_strict_schema(
            lax_schema=core_schema.no_info_plain_validator_function(fraction_validator),
            strict_schema=core_schema.json_or_python_schema(
                json_schema=core_schema.no_info_plain_validator_function(fraction_validator),
                python_schema=core_schema.is_instance_schema(Fraction),
            ),
            # use str serialization to guarantee round trip behavior
            serialization=core_schema.to_string_ser_schema(when_used='always'),
            metadata={'pydantic_js_functions': [lambda _1, _2: {'type': 'string', 'format': 'fraction'}]},
        )

    def _arbitrary_type_schema(self, tp: Any) -> CoreSchema:
        if not isinstance(tp, type):
            warnings.warn(
                f'{tp!r} is not a Python type (it may be an instance of an object),'
                ' Pydantic will allow any object with no validation since we cannot even'
                ' enforce that the input is an instance of the given type.'
                ' To get rid of this error wrap the type with `pydantic.SkipValidation`.',
                ArbitraryTypeWarning,
            )
            return core_schema.any_schema()
        return core_schema.is_instance_schema(tp)

    def _unknown_type_schema(self, obj: Any) -> CoreSchema:
        raise PydanticSchemaGenerationError(
            f'Unable to generate pydantic-core schema for {obj!r}. '
            'Set `arbitrary_types_allowed=True` in the model_config to ignore this error'
            ' or implement `__get_pydantic_core_schema__` on your type to fully support it.'
            '\n\nIf you got this error by calling handler(<some type>) within'
            ' `__get_pydantic_core_schema__` then you likely need to call'
            ' `handler.generate_schema(<some type>)` since we do not call'
            ' `__get_pydantic_core_schema__` on `<some type>` otherwise to avoid infinite recursion.'
        )

    def _apply_discriminator_to_union(
        self, schema: CoreSchema, discriminator: str | Discriminator | None
    ) -> CoreSchema:
        if discriminator is None:
            return schema
        try:
            return _discriminated_union.apply_discriminator(
                schema,
                discriminator,
                self.defs._definitions,
            )
        except _discriminated_union.MissingDefinitionForUnionRef:
            # defer until defs are resolved
            _discriminated_union.set_discriminator_in_metadata(
                schema,
                discriminator,
            )
            return schema

    def clean_schema(self, schema: CoreSchema) -> CoreSchema:
        return self.defs.finalize_schema(schema)

    def _add_js_function(self, metadata_schema: CoreSchema, js_function: Callable[..., Any]) -> None:
        metadata = metadata_schema.get('metadata', {})
        pydantic_js_functions = metadata.setdefault('pydantic_js_functions', [])
        # because of how we generate core schemas for nested generic models
        # we can end up adding `BaseModel.__get_pydantic_json_schema__` multiple times
        # this check may fail to catch duplicates if the function is a `functools.partial`
        # or something like that, but if it does it'll fail by inserting the duplicate
        if js_function not in pydantic_js_functions:
            pydantic_js_functions.append(js_function)
        metadata_schema['metadata'] = metadata

    def generate_schema(
        self,
        obj: Any,
    ) -> core_schema.CoreSchema:
        """Generate core schema.

        Args:
            obj: The object to generate core schema for.

        Returns:
            The generated core schema.

        Raises:
            PydanticUndefinedAnnotation:
                If it is not possible to evaluate forward reference.
            PydanticSchemaGenerationError:
                If it is not possible to generate pydantic-core schema.
            TypeError:
                - If `alias_generator` returns a disallowed type (must be str, AliasPath or AliasChoices).
                - If V1 style validator with `each_item=True` applied on a wrong field.
            PydanticUserError:
                - If `typing.TypedDict` is used instead of `typing_extensions.TypedDict` on Python < 3.12.
                - If `__modify_schema__` method is used instead of `__get_pydantic_json_schema__`.
        """
        schema = self._generate_schema_from_get_schema_method(obj, obj)

        if schema is None:
            schema = self._generate_schema_inner(obj)

        metadata_js_function = _extract_get_pydantic_json_schema(obj)
        if metadata_js_function is not None:
            metadata_schema = resolve_original_schema(schema, self.defs)
            if metadata_schema:
                self._add_js_function(metadata_schema, metadata_js_function)

        schema = _add_custom_serialization_from_json_encoders(self._config_wrapper.json_encoders, obj, schema)

        return schema

    def _model_schema(self, cls: type[BaseModel]) -> core_schema.CoreSchema:
        """Generate schema for a Pydantic model."""
        BaseModel_ = import_cached_base_model()

        with self.defs.get_schema_or_ref(cls) as (model_ref, maybe_schema):
            if maybe_schema is not None:
                return maybe_schema

            schema = cls.__dict__.get('__pydantic_core_schema__')
            if schema is not None and not isinstance(schema, MockCoreSchema):
                if schema['type'] == 'definitions':
                    schema = self.defs.unpack_definitions(schema)
                ref = get_ref(schema)
                if ref:
                    return self.defs.create_definition_reference_schema(schema)
                else:
                    return schema

            config_wrapper = ConfigWrapper(cls.model_config, check=False)

            with self._config_wrapper_stack.push(config_wrapper), self._ns_resolver.push(cls):
                core_config = self._config_wrapper.core_config(title=cls.__name__)

                if cls.__pydantic_fields_complete__ or cls is BaseModel_:
                    fields = getattr(cls, '__pydantic_fields__', {})
                    extra_info = getattr(cls, '__pydantic_extra_info__', None)
                else:
                    if '__pydantic_fields__' not in cls.__dict__:
                        # This happens when we have a loop in the schema generation:
                        # class Base[T](BaseModel):
                        #     t: T
                        #
                        # class Other(BaseModel):
                        #     b: 'Base[Other]'
                        # When we build fields for `Other`, we evaluate the forward annotation.
                        # At this point, `Other` doesn't have the model fields set. We create
                        # `Base[Other]`; model fields are successfully built, and we try to generate
                        # a schema for `t: Other`. As `Other.__pydantic_fields__` aren't set, we abort.
                        raise PydanticUndefinedAnnotation(
                            name=cls.__name__,
                            message=f'Class {cls.__name__!r} is not defined',
                        )
                    try:
                        fields, extra_info = rebuild_model_fields(
                            cls,
                            config_wrapper=self._config_wrapper,
                            ns_resolver=self._ns_resolver,
                            typevars_map=self._typevars_map or {},
                        )
                    except NameError as e:
                        raise PydanticUndefinedAnnotation.from_name_error(e) from e

                decorators = cls.__pydantic_decorators__
                computed_fields = decorators.computed_fields
                check_decorator_fields_exist(
                    chain(
                        decorators.field_validators.values(),
                        decorators.field_serializers.values(),
                        decorators.validators.values(),
                    ),
                    {*fields.keys(), *computed_fields.keys()},
                )

                model_validators = decorators.model_validators.values()

                extras_schema = None
                extras_keys_schema = None
                if core_config.get('extra_fields_behavior') == 'allow' and extra_info is not None:
                    tp = get_origin(extra_info.annotation)
                    if tp not in DICT_TYPES:
                        raise PydanticSchemaGenerationError(
                            'The type annotation for `__pydantic_extra__` must be `dict[str, ...]`'
                        )
                    # See the comments in `_get_args_resolving_forward_refs()` for why we need
                    # to re-evaluate the annotation:
                    extra_keys_type, extra_items_type = self._get_args_resolving_forward_refs(
                        extra_info.annotation,
                        required=True,
                    )
                    if extra_keys_type is not str:
                        extras_keys_schema = self.generate_schema(extra_keys_type)
                    if not typing_objects.is_any(extra_items_type):
                        extras_schema = self.generate_schema(extra_items_type)

                generic_origin: type[BaseModel] | None = getattr(cls, '__pydantic_generic_metadata__', {}).get('origin')

                if cls.__pydantic_root_model__:
                    # FIXME: should the common field metadata be used here?
                    inner_schema, _ = self._common_field_schema('root', fields['root'], decorators)
                    inner_schema = apply_model_validators(inner_schema, model_validators, 'inner')
                    model_schema = core_schema.model_schema(
                        cls,
                        inner_schema,
                        generic_origin=generic_origin,
                        custom_init=getattr(cls, '__pydantic_custom_init__', None),
                        root_model=True,
                        post_init=getattr(cls, '__pydantic_post_init__', None),
                        config=core_config,
                        ref=model_ref,
                    )
                else:
                    fields_schema: core_schema.CoreSchema = core_schema.model_fields_schema(
                        {k: self._generate_md_field_schema(k, v, decorators) for k, v in fields.items()},
                        computed_fields=[
                            self._computed_field_schema(d, decorators.field_serializers)
                            for d in computed_fields.values()
                        ],
                        extras_schema=extras_schema,
                        extras_keys_schema=extras_keys_schema,
                        model_name=cls.__name__,
                    )
                    inner_schema = apply_validators(fields_schema, decorators.root_validators.values())
                    inner_schema = apply_model_validators(inner_schema, model_validators, 'inner')

                    model_schema = core_schema.model_schema(
                        cls,
                        inner_schema,
                        generic_origin=generic_origin,
                        custom_init=getattr(cls, '__pydantic_custom_init__', None),
                        root_model=False,
                        post_init=getattr(cls, '__pydantic_post_init__', None),
                        config=core_config,
                        ref=model_ref,
                    )

                schema = self._apply_model_serializers(model_schema, decorators.model_serializers.values())
                schema = apply_model_validators(schema, model_validators, 'outer')
                return self.defs.create_definition_reference_schema(schema)

    def _resolve_self_type(self, obj: Any) -> Any:
        obj = self.model_type_stack.get()
        if obj is None:
            raise PydanticUserError('`typing.Self` is invalid in this context', code='invalid-self-type')
        return obj

    def _generate_schema_from_get_schema_method(self, obj: Any, source: Any) -> core_schema.CoreSchema | None:
        BaseModel_ = import_cached_base_model()

        get_schema = getattr(obj, '__get_pydantic_core_schema__', None)
        is_base_model_get_schema = (
            getattr(get_schema, '__func__', None) is BaseModel_.__get_pydantic_core_schema__.__func__  # pyright: ignore[reportFunctionMemberAccess]
        )

        if (
            get_schema is not None
            # BaseModel.__get_pydantic_core_schema__ is defined for backwards compatibility,
            # to allow existing code to call `super().__get_pydantic_core_schema__` in Pydantic
            # model that overrides `__get_pydantic_core_schema__`. However, it raises a deprecation
            # warning stating that the method will be removed, and during the core schema gen we actually
            # don't call the method:
            and not is_base_model_get_schema
        ):
            # Some referenceable types might have a `__get_pydantic_core_schema__` method
            # defined on it by users (e.g. on a dataclass). This generally doesn't play well
            # as these types are already recognized by the `GenerateSchema` class and isn't ideal
            # as we might end up calling `get_schema_or_ref` (expensive) on types that are actually
            # not referenceable:
            with self.defs.get_schema_or_ref(obj) as (_, maybe_schema):
                if maybe_schema is not None:
                    return maybe_schema

            if obj is source:
                ref_mode = 'unpack'
            else:
                ref_mode = 'to-def'
            schema = get_schema(
                source, CallbackGetCoreSchemaHandler(self._generate_schema_inner, self, ref_mode=ref_mode)
            )
            if schema['type'] == 'definitions':
                schema = self.defs.unpack_definitions(schema)

            ref = get_ref(schema)
            if ref:
                return self.defs.create_definition_reference_schema(schema)

            # Note: if schema is of type `'definition-ref'`, we might want to copy it as a
            # safety measure (because these are inlined in place -- i.e. mutated directly)
            return schema

        if get_schema is None and (validators := getattr(obj, '__get_validators__', None)) is not None:
            from pydantic.v1 import BaseModel as BaseModelV1

            if issubclass(obj, BaseModelV1):
                warnings.warn(
                    f'Mixing V1 models and V2 models (or constructs, like `TypeAdapter`) is not supported. Please upgrade `{obj.__name__}` to V2.',
                    UserWarning,
                )
            else:
                warnings.warn(
                    '`__get_validators__` is deprecated and will be removed, use `__get_pydantic_core_schema__` instead.',
                    PydanticDeprecatedSince20,
                )
            return core_schema.chain_schema([core_schema.with_info_plain_validator_function(v) for v in validators()])

    def _resolve_forward_ref(self, obj: Any) -> Any:
        # we assume that types_namespace has the target of forward references in its scope,
        # but this could fail, for example, if calling Validator on an imported type which contains
        # forward references to other types only defined in the module from which it was imported
        # `Validator(SomeImportedTypeAliasWithAForwardReference)`
        # or the equivalent for BaseModel
        # class Model(BaseModel):
        #   x: SomeImportedTypeAliasWithAForwardReference
        try:
            obj = _typing_extra.eval_type_backport(obj, *self._types_namespace)
        except NameError as e:
            raise PydanticUndefinedAnnotation.from_name_error(e) from e

        # if obj is still a ForwardRef, it means we can't evaluate it, raise PydanticUndefinedAnnotation
        if isinstance(obj, ForwardRef):
            raise PydanticUndefinedAnnotation(obj.__forward_arg__, f'Unable to evaluate forward reference {obj}')

        if self._typevars_map:
            obj = replace_types(obj, self._typevars_map)

        return obj

    @overload
    def _get_args_resolving_forward_refs(self, obj: Any, required: Literal[True]) -> tuple[Any, ...]: ...

    @overload
    def _get_args_resolving_forward_refs(self, obj: Any) -> tuple[Any, ...] | None: ...

    def _get_args_resolving_forward_refs(self, obj: Any, required: bool = False) -> tuple[Any, ...] | None:
        args = get_args(obj)
        if args:
            if isinstance(obj, GenericAlias):
                # PEP 585 generic aliases don't convert args to ForwardRefs, unlike `typing.List/Dict` etc.
                # This was fixed in https://github.com/python/cpython/pull/30900 (Python 3.11).
                # TODO: this shouldn't be necessary (probably even this `_get_args_resolving_forward_refs()` function)
                # once we drop support for Python 3.10 *or* if we implement our own `typing._eval_type()` implementation.
                args = (_typing_extra._make_forward_ref(a) if isinstance(a, str) else a for a in args)
            args = tuple(self._resolve_forward_ref(a) if isinstance(a, ForwardRef) else a for a in args)
        elif required:  # pragma: no cover
            raise TypeError(f'Expected {obj} to have generic parameters but it had none')
        return args

    def _get_first_arg_or_any(self, obj: Any) -> Any:
        args = self._get_args_resolving_forward_refs(obj)
        if not args:
            return Any
        return args[0]

    def _get_first_two_args_or_any(self, obj: Any) -> tuple[Any, Any]:
        args = self._get_args_resolving_forward_refs(obj)
        if not args:
            return (Any, Any)
        if len(args) < 2:
            origin = get_origin(obj)
            raise TypeError(f'Expected two type arguments for {origin}, got 1')
        return args[0], args[1]

    def _generate_schema_inner(self, obj: Any) -> core_schema.CoreSchema:
        if typing_objects.is_self(obj):
            obj = self._resolve_self_type(obj)

        if typing_objects.is_annotated(get_origin(obj)):
            return self._annotated_schema(obj)

        if isinstance(obj, dict):
            # we assume this is already a valid schema
            return obj  # type: ignore[return-value]

        if isinstance(obj, str):
            obj = ForwardRef(obj)

        if isinstance(obj, ForwardRef):
            return self.generate_schema(self._resolve_forward_ref(obj))

        BaseModel = import_cached_base_model()

        if lenient_issubclass(obj, BaseModel):
            with self.model_type_stack.push(obj):
                return self._model_schema(obj)

        if isinstance(obj, PydanticRecursiveRef):
            return core_schema.definition_reference_schema(schema_ref=obj.type_ref)

        return self.match_type(obj)

    def match_type(self, obj: Any) -> core_schema.CoreSchema:  # noqa: C901
        """Main mapping of types to schemas.

        The general structure is a series of if statements starting with the simple cases
        (non-generic primitive types) and then handling generics and other more complex cases.

        Each case either generates a schema directly, calls into a public user-overridable method
        (like `GenerateSchema.tuple_variable_schema`) or calls into a private method that handles some
        boilerplate before calling into the user-facing method (e.g. `GenerateSchema._tuple_schema`).

        The idea is that we'll evolve this into adding more and more user facing methods over time
        as they get requested and we figure out what the right API for them is.
        """
        if obj is str:
            return core_schema.str_schema()
        elif obj is bytes:
            return core_schema.bytes_schema()
        elif obj is int:
            return core_schema.int_schema()
        elif obj is float:
            return core_schema.float_schema()
        elif obj is bool:
            return core_schema.bool_schema()
        elif obj is complex:
            return core_schema.complex_schema()
        elif typing_objects.is_any(obj) or obj is object:
            return core_schema.any_schema()
        elif obj is datetime.date:
            return core_schema.date_schema()
        elif obj is datetime.datetime:
            return core_schema.datetime_schema()
        elif obj is datetime.time:
            return core_schema.time_schema()
        elif obj is datetime.timedelta:
            return core_schema.timedelta_schema()
        elif obj is Decimal:
            return core_schema.decimal_schema()
        elif obj is UUID:
            return core_schema.uuid_schema()
        elif obj is Url:
            return core_schema.url_schema()
        elif obj is Fraction:
            return self._fraction_schema()
        elif obj is MultiHostUrl:
            return core_schema.multi_host_url_schema()
        elif obj is None or obj is _typing_extra.NoneType:
            return core_schema.none_schema()
        if obj is MISSING:
            return core_schema.missing_sentinel_schema()
        elif obj in IP_TYPES:
            return self._ip_schema(obj)
        elif obj in TUPLE_TYPES:
            return self._tuple_schema(obj)
        elif obj in LIST_TYPES:
            return self._list_schema(Any)
        elif obj in SET_TYPES:
            return self._set_schema(Any)
        elif obj in FROZEN_SET_TYPES:
            return self._frozenset_schema(Any)
        elif obj in SEQUENCE_TYPES:
            return self._sequence_schema(Any)
        elif obj in ITERABLE_TYPES:
            return self._iterable_schema(obj)
        elif obj in DICT_TYPES:
            return self._dict_schema(Any, Any)
        elif obj in PATH_TYPES:
            return self._path_schema(obj, Any)
        elif obj in DEQUE_TYPES:
            return self._deque_schema(Any)
        elif obj in MAPPING_TYPES:
            return self._mapping_schema(obj, Any, Any)
        elif obj in COUNTER_TYPES:
            return self._mapping_schema(obj, Any, int)
        elif typing_objects.is_typealiastype(obj):
            return self._type_alias_type_schema(obj)
        elif obj is type:
            return self._type_schema()
        elif _typing_extra.is_callable(obj):
            return core_schema.callable_schema()
        elif typing_objects.is_literal(get_origin(obj)):
            return self._literal_schema(obj)
        elif is_typeddict(obj):
            return self._typed_dict_schema(obj, None)
        elif inspect.isclass(obj) and issubclass(obj, Enum):
            # NOTE: this must come before the `is_namedtuple()` check as enums values
            # can be namedtuples:
            return self._enum_schema(obj)
        elif _typing_extra.is_namedtuple(obj):
            return self._namedtuple_schema(obj, None)
        elif typing_objects.is_newtype(obj):
            # NewType, can't use isinstance because it fails <3.10
            return self.generate_schema(obj.__supertype__)
        elif obj in PATTERN_TYPES:
            return self._pattern_schema(obj)
        elif _typing_extra.is_hashable(obj):
            return self._hashable_schema()
        elif isinstance(obj, typing.TypeVar):
            return self._unsubstituted_typevar_schema(obj)
        elif _typing_extra.is_finalvar(obj):
            if obj is Final:
                return core_schema.any_schema()
            return self.generate_schema(
                self._get_first_arg_or_any(obj),
            )
        elif isinstance(obj, VALIDATE_CALL_SUPPORTED_TYPES):
            return self._call_schema(obj)  # pyright: ignore[reportArgumentType]
        elif obj is ZoneInfo:
            return self._zoneinfo_schema()

        # dataclasses.is_dataclass coerces dc instances to types, but we only handle
        # the case of a dc type here
        if dataclasses.is_dataclass(obj):
            return self._dataclass_schema(obj, None)  # pyright: ignore[reportArgumentType]

        origin = get_origin(obj)
        if origin is not None:
            return self._match_generic_type(obj, origin)

        if self._arbitrary_types:
            return self._arbitrary_type_schema(obj)
        return self._unknown_type_schema(obj)

    def _match_generic_type(self, obj: Any, origin: Any) -> CoreSchema:  # noqa: C901
        # Need to handle generic dataclasses before looking for the schema properties because attribute accesses
        # on _GenericAlias delegate to the origin type, so lose the information about the concrete parametrization
        # As a result, currently, there is no way to cache the schema for generic dataclasses. This may be possible
        # to resolve by modifying the value returned by `Generic.__class_getitem__`, but that is a dangerous game.
        if dataclasses.is_dataclass(origin):
            return self._dataclass_schema(obj, origin)  # pyright: ignore[reportArgumentType]
        if _typing_extra.is_namedtuple(origin):
            return self._namedtuple_schema(obj, origin)

        schema = self._generate_schema_from_get_schema_method(origin, obj)
        if schema is not None:
            return schema

        if typing_objects.is_typealiastype(origin):
            return self._type_alias_type_schema(obj)
        elif is_union_origin(origin):
            return self._union_schema(obj)
        elif origin in TUPLE_TYPES:
            return self._tuple_schema(obj)
        elif origin in LIST_TYPES:
            return self._list_schema(self._get_first_arg_or_any(obj))
        elif origin in SET_TYPES:
            return self._set_schema(self._get_first_arg_or_any(obj))
        elif origin in FROZEN_SET_TYPES:
            return self._frozenset_schema(self._get_first_arg_or_any(obj))
        elif origin in DICT_TYPES:
            return self._dict_schema(*self._get_first_two_args_or_any(obj))
        elif origin in PATH_TYPES:
            return self._path_schema(origin, self._get_first_arg_or_any(obj))
        elif origin in DEQUE_TYPES:
            return self._deque_schema(self._get_first_arg_or_any(obj))
        elif origin in MAPPING_TYPES:
            return self._mapping_schema(origin, *self._get_first_two_args_or_any(obj))
        elif origin in COUNTER_TYPES:
            return self._mapping_schema(origin, self._get_first_arg_or_any(obj), int)
        elif is_typeddict(origin):
            return self._typed_dict_schema(obj, origin)
        elif origin in TYPE_TYPES:
            return self._subclass_schema(obj)
        elif origin in SEQUENCE_TYPES:
            return self._sequence_schema(self._get_first_arg_or_any(obj))
        elif origin in ITERABLE_TYPES:
            return self._iterable_schema(obj)
        elif origin in PATTERN_TYPES:
            return self._pattern_schema(obj)

        if self._arbitrary_types:
            return self._arbitrary_type_schema(origin)
        return self._unknown_type_schema(obj)

    def _generate_td_field_schema(
        self,
        name: str,
        field_info: FieldInfo,
        decorators: DecoratorInfos,
        *,
        required: bool = True,
    ) -> core_schema.TypedDictField:
        """Prepare a TypedDictField to represent a model or typeddict field."""
        schema, metadata = self._common_field_schema(name, field_info, decorators)
        return core_schema.typed_dict_field(
            schema,
            required=False if not field_info.is_required() else required,
            serialization_exclude=field_info.exclude,
            validation_alias=_convert_to_aliases(field_info.validation_alias),
            serialization_alias=field_info.serialization_alias,
            serialization_exclude_if=field_info.exclude_if,
            metadata=metadata,
        )

    def _generate_md_field_schema(
        self,
        name: str,
        field_info: FieldInfo,
        decorators: DecoratorInfos,
    ) -> core_schema.ModelField:
        """Prepare a ModelField to represent a model field."""
        schema, metadata = self._common_field_schema(name, field_info, decorators)
        return core_schema.model_field(
            schema,
            serialization_exclude=field_info.exclude,
            validation_alias=_convert_to_aliases(field_info.validation_alias),
            serialization_alias=field_info.serialization_alias,
            serialization_exclude_if=field_info.exclude_if,
            frozen=field_info.frozen,
            metadata=metadata,
        )

    def _generate_dc_field_schema(
        self,
        name: str,
        field_info: FieldInfo,
        decorators: DecoratorInfos,
    ) -> core_schema.DataclassField:
        """Prepare a DataclassField to represent the parameter/field, of a dataclass."""
        schema, metadata = self._common_field_schema(name, field_info, decorators)
        return core_schema.dataclass_field(
            name,
            schema,
            init=field_info.init,
            init_only=field_info.init_var or None,
            kw_only=None if field_info.kw_only else False,
            serialization_exclude=field_info.exclude,
            validation_alias=_convert_to_aliases(field_info.validation_alias),
            serialization_alias=field_info.serialization_alias,
            serialization_exclude_if=field_info.exclude_if,
            frozen=field_info.frozen,
            metadata=metadata,
        )

    def _common_field_schema(  # C901
        self, name: str, field_info: FieldInfo, decorators: DecoratorInfos
    ) -> tuple[CoreSchema, dict[str, Any]]:
        source_type, annotations = field_info.annotation, field_info.metadata

        def set_discriminator(schema: CoreSchema) -> CoreSchema:
            schema = self._apply_discriminator_to_union(schema, field_info.discriminator)
            return schema

        # Convert `@field_validator` decorators to `Before/After/Plain/WrapValidator` instances:
        validators_from_decorators = [
            _mode_to_validator[decorator.info.mode]._from_decorator(decorator)
            for decorator in filter_field_decorator_info_by_field(decorators.field_validators.values(), name)
        ]

        with self.field_name_stack.push(name):
            if field_info.discriminator is not None:
                schema = self._apply_annotations(
                    source_type, annotations + validators_from_decorators, transform_inner_schema=set_discriminator
                )
            else:
                schema = self._apply_annotations(
                    source_type,
                    annotations + validators_from_decorators,
                )

        # This V1 compatibility shim should eventually be removed
        # push down any `each_item=True` validators
        # note that this won't work for any Annotated types that get wrapped by a function validator
        # but that's okay because that didn't exist in V1
        this_field_validators = filter_field_decorator_info_by_field(decorators.validators.values(), name)
        if _validators_require_validate_default(this_field_validators):
            field_info.validate_default = True
        each_item_validators = [v for v in this_field_validators if v.info.each_item is True]
        this_field_validators = [v for v in this_field_validators if v not in each_item_validators]
        schema = apply_each_item_validators(schema, each_item_validators)

        schema = apply_validators(schema, this_field_validators)

        # the default validator needs to go outside of any other validators
        # so that it is the topmost validator for the field validator
        # which uses it to check if the field has a default value or not
        if not field_info.is_required():
            schema = wrap_default(field_info, schema)

        schema = self._apply_field_serializers(
            schema, filter_field_decorator_info_by_field(decorators.field_serializers.values(), name)
        )

        pydantic_js_updates, pydantic_js_extra = _extract_json_schema_info_from_field_info(field_info)
        core_metadata: dict[str, Any] = {}
        update_core_metadata(
            core_metadata, pydantic_js_updates=pydantic_js_updates, pydantic_js_extra=pydantic_js_extra
        )

        return schema, core_metadata

    def _union_schema(self, union_type: Any) -> core_schema.CoreSchema:
        """Generate schema for a Union."""
        args = self._get_args_resolving_forward_refs(union_type, required=True)
        choices: list[CoreSchema] = []
        nullable = False
        for arg in args:
            if arg is None or arg is _typing_extra.NoneType:
                nullable = True
            else:
                choices.append(self.generate_schema(arg))

        if len(choices) == 1:
            s = choices[0]
        else:
            choices_with_tags: list[CoreSchema | tuple[CoreSchema, str]] = []
            for choice in choices:
                tag = cast(CoreMetadata, choice.get('metadata', {})).get('pydantic_internal_union_tag_key')
                if tag is not None:
                    choices_with_tags.append((choice, tag))
                else:
                    choices_with_tags.append(choice)
            s = core_schema.union_schema(choices_with_tags)

        if nullable:
            s = core_schema.nullable_schema(s)
        return s

    def _type_alias_type_schema(self, obj: TypeAliasType) -> CoreSchema:
        with self.defs.get_schema_or_ref(obj) as (ref, maybe_schema):
            if maybe_schema is not None:
                return maybe_schema

            origin: TypeAliasType = get_origin(obj) or obj
            typevars_map = get_standard_typevars_map(obj)

            with self._ns_resolver.push(origin):
                try:
                    annotation = _typing_extra.eval_type(origin.__value__, *self._types_namespace)
                except NameError as e:
                    raise PydanticUndefinedAnnotation.from_name_error(e) from e
                annotation = replace_types(annotation, typevars_map)
                schema = self.generate_schema(annotation)
                assert schema['type'] != 'definitions'
                schema['ref'] = ref  # type: ignore
            return self.defs.create_definition_reference_schema(schema)

    def _literal_schema(self, literal_type: Any) -> CoreSchema:
        """Generate schema for a Literal."""
        expected = list(get_literal_values(literal_type, type_check=False, unpack_type_aliases='eager'))
        assert expected, f'literal "expected" cannot be empty, obj={literal_type}'
        schema = core_schema.literal_schema(expected)

        if self._config_wrapper.use_enum_values and any(isinstance(v, Enum) for v in expected):
            schema = core_schema.no_info_after_validator_function(
                lambda v: v.value if isinstance(v, Enum) else v, schema
            )

        return schema

    def _typed_dict_schema(self, typed_dict_cls: Any, origin: Any) -> core_schema.CoreSchema:
        """Generate a core schema for a `TypedDict` class.

        To be able to build a `DecoratorInfos` instance for the `TypedDict` class (which will include
        validators, serializers, etc.), we need to have access to the original bases of the class
        (see https://docs.python.org/3/library/types.html#types.get_original_bases).
        However, the `__orig_bases__` attribute was only added in 3.12 (https://github.com/python/cpython/pull/103698).

        For this reason, we require Python 3.12 (or using the `typing_extensions` backport).
        """
        FieldInfo = import_cached_field_info()

        with (
            self.model_type_stack.push(typed_dict_cls),
            self.defs.get_schema_or_ref(typed_dict_cls) as (
                typed_dict_ref,
                maybe_schema,
            ),
        ):
            if maybe_schema is not None:
                return maybe_schema

            typevars_map = get_standard_typevars_map(typed_dict_cls)
            if origin is not None:
                typed_dict_cls = origin

            if not _SUPPORTS_TYPEDDICT and type(typed_dict_cls).__module__ == 'typing':
                raise PydanticUserError(
                    'Please use `typing_extensions.TypedDict` instead of `typing.TypedDict` on Python < 3.12.',
                    code='typed-dict-version',
                )

            try:
                # if a typed dictionary class doesn't have config, we use the parent's config, hence a default of `None`
                # see https://github.com/pydantic/pydantic/issues/10917
                config: ConfigDict | None = get_attribute_from_bases(typed_dict_cls, '__pydantic_config__')
            except AttributeError:
                config = None

            with self._config_wrapper_stack.push(config):
                core_config = self._config_wrapper.core_config(title=typed_dict_cls.__name__)

                required_keys: frozenset[str] = typed_dict_cls.__required_keys__

                fields: dict[str, core_schema.TypedDictField] = {}

                decorators = DecoratorInfos.build(typed_dict_cls, replace_wrapped_methods=False)
                decorators.update_from_config(self._config_wrapper)

                if self._config_wrapper.use_attribute_docstrings:
                    field_docstrings = extract_docstrings_from_cls(typed_dict_cls, use_inspect=True)
                else:
                    field_docstrings = None

                try:
                    annotations = _typing_extra.get_cls_type_hints(typed_dict_cls, ns_resolver=self._ns_resolver)
                except NameError as e:
                    raise PydanticUndefinedAnnotation.from_name_error(e) from e

                readonly_fields: list[str] = []

                for field_name, annotation in annotations.items():
                    field_info = FieldInfo.from_annotation(annotation, _source=AnnotationSource.TYPED_DICT)
                    field_info.annotation = replace_types(field_info.annotation, typevars_map)

                    required = (
                        field_name in required_keys or 'required' in field_info._qualifiers
                    ) and 'not_required' not in field_info._qualifiers
                    if 'read_only' in field_info._qualifiers:
                        readonly_fields.append(field_name)

                    if (
                        field_docstrings is not None
                        and field_info.description is None
                        and field_name in field_docstrings
                    ):
                        field_info.description = field_docstrings[field_name]
                    update_field_from_config(self._config_wrapper, field_name, field_info)

                    fields[field_name] = self._generate_td_field_schema(
                        field_name, field_info, decorators, required=required
                    )

                if readonly_fields:
                    fields_repr = ', '.join(repr(f) for f in readonly_fields)
                    plural = len(readonly_fields) >= 2
                    warnings.warn(
                        f'Item{"s" if plural else ""} {fields_repr} on TypedDict class {typed_dict_cls.__name__!r} '
                        f'{"are" if plural else "is"} using the `ReadOnly` qualifier. Pydantic will not protect items '
                        'from any mutation on dictionary instances.',
                        UserWarning,
                    )

                extra_behavior: core_schema.ExtraBehavior = 'ignore'
                extras_schema: CoreSchema | None = None  # For 'allow', equivalent to `Any` - no validation performed.

                # `__closed__` is `None` when not specified (equivalent to `False`):
                is_closed = bool(getattr(typed_dict_cls, '__closed__', False))
                extra_items = getattr(typed_dict_cls, '__extra_items__', typing_extensions.NoExtraItems)
                if is_closed:
                    extra_behavior = 'forbid'
                    extras_schema = None
                elif not typing_objects.is_noextraitems(extra_items):
                    extra_behavior = 'allow'
                    extras_schema = self.generate_schema(replace_types(extra_items, typevars_map))

                if (config_extra := self._config_wrapper.extra) in ('allow', 'forbid'):
                    if is_closed and config_extra == 'allow':
                        warnings.warn(
                            f"TypedDict class {typed_dict_cls.__qualname__!r} is closed, but 'extra' configuration "
                            "is set to `'allow'`. The 'extra' configuration value will be ignored.",
                            category=TypedDictExtraConfigWarning,
                        )
                    elif not typing_objects.is_noextraitems(extra_items) and config_extra == 'forbid':
                        warnings.warn(
                            f"TypedDict class {typed_dict_cls.__qualname__!r} allows extra items, but 'extra' configuration "
                            "is set to `'forbid'`. The 'extra' configuration value will be ignored.",
                            category=TypedDictExtraConfigWarning,
                        )
                    else:
                        extra_behavior = config_extra

                td_schema = core_schema.typed_dict_schema(
                    fields,
                    cls=typed_dict_cls,
                    computed_fields=[
                        self._computed_field_schema(d, decorators.field_serializers)
                        for d in decorators.computed_fields.values()
                    ],
                    extra_behavior=extra_behavior,
                    extras_schema=extras_schema,
                    ref=typed_dict_ref,
                    config=core_config,
                )

                schema = self._apply_model_serializers(td_schema, decorators.model_serializers.values())
                schema = apply_model_validators(schema, decorators.model_validators.values(), 'all')
                return self.defs.create_definition_reference_schema(schema)

    def _namedtuple_schema(self, namedtuple_cls: Any, origin: Any) -> core_schema.CoreSchema:
        """Generate schema for a NamedTuple."""
        with (
            self.model_type_stack.push(namedtuple_cls),
            self.defs.get_schema_or_ref(namedtuple_cls) as (
                namedtuple_ref,
                maybe_schema,
            ),
        ):
            if maybe_schema is not None:
                return maybe_schema
            typevars_map = get_standard_typevars_map(namedtuple_cls)
            if origin is not None:
                namedtuple_cls = origin

            try:
                annotations = _typing_extra.get_cls_type_hints(namedtuple_cls, ns_resolver=self._ns_resolver)
            except NameError as e:
                raise PydanticUndefinedAnnotation.from_name_error(e) from e

            # Filter annotations to only include fields that are actually in the NamedTuple
            # (as subclassing an existing NamedTuple is not supported yet - see https://github.com/python/typing/issues/427)
            # and use `Any` if no annotation exist (i.e. when using `collections.namedtuple()`).
            annotations = {field_name: annotations.get(field_name, Any) for field_name in namedtuple_cls._fields}

            if typevars_map:
                annotations = {
                    field_name: replace_types(annotation, typevars_map)
                    for field_name, annotation in annotations.items()
                }

            arguments_schema = core_schema.arguments_schema(
                [
                    self._generate_parameter_schema(
                        field_name,
                        annotation,
                        source=AnnotationSource.NAMED_TUPLE,
                        default=namedtuple_cls._field_defaults.get(field_name, Parameter.empty),
                    )
                    for field_name, annotation in annotations.items()
                ],
                metadata={'pydantic_js_prefer_positional_arguments': True},
            )
            schema = core_schema.call_schema(arguments_schema, namedtuple_cls, ref=namedtuple_ref)
            return self.defs.create_definition_reference_schema(schema)

    def _generate_parameter_schema(
        self,
        name: str,
        annotation: type[Any],
        source: AnnotationSource,
        default: Any = Parameter.empty,
        mode: Literal['positional_only', 'positional_or_keyword', 'keyword_only'] | None = None,
    ) -> core_schema.ArgumentsParameter:
        """Generate the definition of a field in a namedtuple or a parameter in a function signature.

        This definition is meant to be used for the `'arguments'` core schema, which will be replaced
        in V3 by the `'arguments-v3`'.
        """
        FieldInfo = import_cached_field_info()

        if default is Parameter.empty:
            field = FieldInfo.from_annotation(annotation, _source=source)
        else:
            field = FieldInfo.from_annotated_attribute(annotation, default, _source=source)

        assert field.annotation is not None, 'field.annotation should not be None when generating a schema'
        update_field_from_config(self._config_wrapper, name, field)

        with self.field_name_stack.push(name):
            schema = self._apply_annotations(
                field.annotation,
                [field],
                # Because we pass `field` as metadata above (required for attributes relevant for
                # JSON Scheme generation), we need to ignore the potential warnings about `FieldInfo`
                # attributes that will not be used:
                check_unsupported_field_info_attributes=False,
            )

        if not field.is_required():
            schema = wrap_default(field, schema)

        parameter_schema = core_schema.arguments_parameter(
            name,
            schema,
            mode=mode,
            alias=_convert_to_aliases(field.validation_alias),
        )

        return parameter_schema

    def _generate_parameter_v3_schema(
        self,
        name: str,
        annotation: Any,
        source: AnnotationSource,
        mode: Literal[
            'positional_only',
            'positional_or_keyword',
            'keyword_only',
            'var_args',
            'var_kwargs_uniform',
            'var_kwargs_unpacked_typed_dict',
        ],
        default: Any = Parameter.empty,
    ) -> core_schema.ArgumentsV3Parameter:
        """Generate the definition of a parameter in a function signature.

        This definition is meant to be used for the `'arguments-v3'` core schema, which will replace
        the `'arguments`' schema in V3.
        """
        FieldInfo = import_cached_field_info()

        if default is Parameter.empty:
            field = FieldInfo.from_annotation(annotation, _source=source)
        else:
            field = FieldInfo.from_annotated_attribute(annotation, default, _source=source)
        update_field_from_config(self._config_wrapper, name, field)

        with self.field_name_stack.push(name):
            schema = self._apply_annotations(
                field.annotation,
                [field],
                # Because we pass `field` as metadata above (required for attributes relevant for
                # JSON Scheme generation), we need to ignore the potential warnings about `FieldInfo`
                # attributes that will not be used:
                check_unsupported_field_info_attributes=False,
            )

        if not field.is_required():
            schema = wrap_default(field, schema)

        parameter_schema = core_schema.arguments_v3_parameter(
            name=name,
            schema=schema,
            mode=mode,
            alias=_convert_to_aliases(field.validation_alias),
        )

        return parameter_schema

    def _tuple_schema(self, tuple_type: Any) -> core_schema.CoreSchema:
        """Generate schema for a Tuple, e.g. `tuple[int, str]` or `tuple[int, ...]`."""
        # TODO: do we really need to resolve type vars here?
        typevars_map = get_standard_typevars_map(tuple_type)
        params = self._get_args_resolving_forward_refs(tuple_type)

        if typevars_map and params:
            params = tuple(replace_types(param, typevars_map) for param in params)

        # NOTE: subtle difference: `tuple[()]` gives `params=()`, whereas `typing.Tuple[()]` gives `params=((),)`
        # This is only true for <3.11, on Python 3.11+ `typing.Tuple[()]` gives `params=()`
        if not params:
            if tuple_type in TUPLE_TYPES:
                return core_schema.tuple_schema([core_schema.any_schema()], variadic_item_index=0)
            else:
                # special case for `tuple[()]` which means `tuple[]` - an empty tuple
                return core_schema.tuple_schema([])
        elif params[-1] is Ellipsis:
            if len(params) == 2:
                return core_schema.tuple_schema([self.generate_schema(params[0])], variadic_item_index=0)
            else:
                # TODO: something like https://github.com/pydantic/pydantic/issues/5952
                raise ValueError('Variable tuples can only have one type')
        elif len(params) == 1 and params[0] == ():
            # special case for `tuple[()]` which means `tuple[]` - an empty tuple
            # NOTE: This conditional can be removed when we drop support for Python 3.10.
            return core_schema.tuple_schema([])
        else:
            return core_schema.tuple_schema([self.generate_schema(param) for param in params])

    def _type_schema(self) -> core_schema.CoreSchema:
        return core_schema.custom_error_schema(
            core_schema.is_instance_schema(type),
            custom_error_type='is_type',
            custom_error_message='Input should be a type',
        )

    def _zoneinfo_schema(self) -> core_schema.CoreSchema:
        """Generate schema for a zone_info.ZoneInfo object"""
        from ._validators import validate_str_is_valid_iana_tz

        metadata = {'pydantic_js_functions': [lambda _1, _2: {'type': 'string', 'format': 'zoneinfo'}]}
        return core_schema.no_info_plain_validator_function(
            validate_str_is_valid_iana_tz,
            serialization=core_schema.to_string_ser_schema(),
            metadata=metadata,
        )

    def _union_is_subclass_schema(self, union_type: Any) -> core_schema.CoreSchema:
        """Generate schema for `type[Union[X, ...]]`."""
        args = self._get_args_resolving_forward_refs(union_type, required=True)
        return core_schema.union_schema([self.generate_schema(type[args]) for args in args])

    def _subclass_schema(self, type_: Any) -> core_schema.CoreSchema:
        """Generate schema for a type, e.g. `type[int]`."""
        type_param = self._get_first_arg_or_any(type_)

        # Assume `type[Annotated[<typ>, ...]]` is equivalent to `type[<typ>]`:
        type_param = _typing_extra.annotated_type(type_param) or type_param

        if typing_objects.is_any(type_param):
            return self._type_schema()
        elif typing_objects.is_typealiastype(type_param):
            return self.generate_schema(type[type_param.__value__])
        elif typing_objects.is_typevar(type_param):
            if type_param.__bound__:
                if is_union_origin(get_origin(type_param.__bound__)):
                    return self._union_is_subclass_schema(type_param.__bound__)
                return core_schema.is_subclass_schema(type_param.__bound__)
            elif type_param.__constraints__:
                return core_schema.union_schema([self.generate_schema(type[c]) for c in type_param.__constraints__])
            else:
                return self._type_schema()
        elif is_union_origin(get_origin(type_param)):
            return self._union_is_subclass_schema(type_param)
        else:
            if typing_objects.is_self(type_param):
                type_param = self._resolve_self_type(type_param)
            if _typing_extra.is_generic_alias(type_param):
                raise PydanticUserError(
                    'Subscripting `type[]` with an already parametrized type is not supported. '
                    f'Instead of using type[{type_param!r}], use type[{_repr.display_as_type(get_origin(type_param))}].',
                    code=None,
                )
            if not inspect.isclass(type_param):
                # when using type[None], this doesn't type convert to type[NoneType], and None isn't a class
                # so we handle it manually here
                if type_param is None:
                    return core_schema.is_subclass_schema(_typing_extra.NoneType)
                raise TypeError(f'Expected a class, got {type_param!r}')
            return core_schema.is_subclass_schema(type_param)

    def _sequence_schema(self, items_type: Any) -> core_schema.CoreSchema:
        """Generate schema for a Sequence, e.g. `Sequence[int]`."""
        from ._serializers import serialize_sequence_via_list

        item_type_schema = self.generate_schema(items_type)
        list_schema = core_schema.list_schema(item_type_schema)

        json_schema = smart_deepcopy(list_schema)
        python_schema = core_schema.is_instance_schema(typing.Sequence, cls_repr='Sequence')
        if not typing_objects.is_any(items_type):
            from ._validators import sequence_validator

            python_schema = core_schema.chain_schema(
                [python_schema, core_schema.no_info_wrap_validator_function(sequence_validator, list_schema)],
            )

        serialization = core_schema.wrap_serializer_function_ser_schema(
            serialize_sequence_via_list, schema=item_type_schema, info_arg=True
        )
        return core_schema.json_or_python_schema(
            json_schema=json_schema, python_schema=python_schema, serialization=serialization
        )

    def _iterable_schema(self, type_: Any) -> core_schema.GeneratorSchema:
        """Generate a schema for an `Iterable`."""
        item_type = self._get_first_arg_or_any(type_)

        return core_schema.generator_schema(self.generate_schema(item_type))

    def _pattern_schema(self, pattern_type: Any) -> core_schema.CoreSchema:
        from . import _validators

        metadata = {'pydantic_js_functions': [lambda _1, _2: {'type': 'string', 'format': 'regex'}]}
        ser = core_schema.plain_serializer_function_ser_schema(
            attrgetter('pattern'), when_used='json', return_schema=core_schema.str_schema()
        )
        if pattern_type is typing.Pattern or pattern_type is re.Pattern:
            # bare type
            return core_schema.no_info_plain_validator_function(
                _validators.pattern_either_validator, serialization=ser, metadata=metadata
            )

        param = self._get_args_resolving_forward_refs(
            pattern_type,
            required=True,
        )[0]
        if param is str:
            return core_schema.no_info_plain_validator_function(
                _validators.pattern_str_validator, serialization=ser, metadata=metadata
            )
        elif param is bytes:
            return core_schema.no_info_plain_validator_function(
                _validators.pattern_bytes_validator, serialization=ser, metadata=metadata
            )
        else:
            raise PydanticSchemaGenerationError(f'Unable to generate pydantic-core schema for {pattern_type!r}.')

    def _hashable_schema(self) -> core_schema.CoreSchema:
        return core_schema.custom_error_schema(
            schema=core_schema.json_or_python_schema(
                json_schema=core_schema.chain_schema(
                    [core_schema.any_schema(), core_schema.is_instance_schema(collections.abc.Hashable)]
                ),
                python_schema=core_schema.is_instance_schema(collections.abc.Hashable),
            ),
            custom_error_type='is_hashable',
            custom_error_message='Input should be hashable',
        )

    def _dataclass_schema(
        self, dataclass: type[StandardDataclass], origin: type[StandardDataclass] | None
    ) -> core_schema.CoreSchema:
        """Generate schema for a dataclass."""
        with (
            self.model_type_stack.push(dataclass),
            self.defs.get_schema_or_ref(dataclass) as (
                dataclass_ref,
                maybe_schema,
            ),
        ):
            if maybe_schema is not None:
                return maybe_schema

            schema = dataclass.__dict__.get('__pydantic_core_schema__')
            if schema is not None and not isinstance(schema, MockCoreSchema):
                if schema['type'] == 'definitions':
                    schema = self.defs.unpack_definitions(schema)
                ref = get_ref(schema)
                if ref:
                    return self.defs.create_definition_reference_schema(schema)
                else:
                    return schema

            typevars_map = get_standard_typevars_map(dataclass)
            if origin is not None:
                dataclass = origin

            # if (plain) dataclass doesn't have config, we use the parent's config, hence a default of `None`
            # (Pydantic dataclasses have an empty dict config by default).
            # see https://github.com/pydantic/pydantic/issues/10917
            config = getattr(dataclass, '__pydantic_config__', None)

            from ..dataclasses import is_pydantic_dataclass

            with self._ns_resolver.push(dataclass), self._config_wrapper_stack.push(config):
                if is_pydantic_dataclass(dataclass):
                    if dataclass.__pydantic_fields_complete__():
                        # Copy the field info instances to avoid mutating the `FieldInfo` instances
                        # of the generic dataclass generic origin (e.g. `apply_typevars_map` below).
                        # Note that we don't apply `deepcopy` on `__pydantic_fields__` because we
                        # don't want to copy the `FieldInfo` attributes:
                        fields = {
                            f_name: copy(field_info) for f_name, field_info in dataclass.__pydantic_fields__.items()
                        }
                        if typevars_map:
                            for field in fields.values():
                                field.apply_typevars_map(typevars_map, *self._types_namespace)
                    else:
                        try:
                            fields = rebuild_dataclass_fields(
                                dataclass,
                                config_wrapper=self._config_wrapper,
                                ns_resolver=self._ns_resolver,
                                typevars_map=typevars_map or {},
                            )
                        except NameError as e:
                            raise PydanticUndefinedAnnotation.from_name_error(e) from e
                else:
                    fields = collect_dataclass_fields(
                        dataclass,
                        typevars_map=typevars_map,
                        config_wrapper=self._config_wrapper,
                    )

                if self._config_wrapper.extra == 'allow':
                    # disallow combination of init=False on a dataclass field and extra='allow' on a dataclass
                    for field_name, field in fields.items():
                        if field.init is False:
                            raise PydanticUserError(
                                f'Field {field_name} has `init=False` and dataclass has config setting `extra="allow"`. '
                                f'This combination is not allowed.',
                                code='dataclass-init-false-extra-allow',
                            )

                decorators = dataclass.__dict__.get('__pydantic_decorators__')
                if decorators is None:
                    decorators = DecoratorInfos.build(dataclass, replace_wrapped_methods=False)
                    decorators.update_from_config(self._config_wrapper)
                # Move kw_only=False args to the start of the list, as this is how vanilla dataclasses work.
                # Note that when kw_only is missing or None, it is treated as equivalent to kw_only=True
                args = sorted(
                    (self._generate_dc_field_schema(k, v, decorators) for k, v in fields.items()),
                    key=lambda a: a.get('kw_only') is not False,
                )
                has_post_init = hasattr(dataclass, '__post_init__')
                has_slots = hasattr(dataclass, '__slots__')

                args_schema = core_schema.dataclass_args_schema(
                    dataclass.__name__,
                    args,
                    computed_fields=[
                        self._computed_field_schema(d, decorators.field_serializers)
                        for d in decorators.computed_fields.values()
                    ],
                    collect_init_only=has_post_init,
                )

                inner_schema = apply_validators(args_schema, decorators.root_validators.values())

                model_validators = decorators.model_validators.values()
                inner_schema = apply_model_validators(inner_schema, model_validators, 'inner')

                core_config = self._config_wrapper.core_config(title=dataclass.__name__)

                dc_schema = core_schema.dataclass_schema(
                    dataclass,
                    inner_schema,
                    generic_origin=origin,
                    post_init=has_post_init,
                    ref=dataclass_ref,
                    fields=[field.name for field in dataclasses.fields(dataclass)],
                    slots=has_slots,
                    config=core_config,
                    # we don't use a custom __setattr__ for dataclasses, so we must
                    # pass along the frozen config setting to the pydantic-core schema
                    frozen=self._config_wrapper_stack.tail.frozen,
                )
                schema = self._apply_model_serializers(dc_schema, decorators.model_serializers.values())
                schema = apply_model_validators(schema, model_validators, 'outer')
                return self.defs.create_definition_reference_schema(schema)

    def _call_schema(self, function: ValidateCallSupportedTypes) -> core_schema.CallSchema:
        """Generate schema for a Callable.

        TODO support functional validators once we support them in Config
        """
        arguments_schema = self._arguments_schema(function)

        return_schema: core_schema.CoreSchema | None = None
        config_wrapper = self._config_wrapper
        if config_wrapper.validate_return:
            sig = _typing_extra.signature_no_eval(function)
            return_hint = sig.return_annotation
            if return_hint is not sig.empty:
                globalns, localns = self._types_namespace
                type_hints = _typing_extra.get_function_type_hints(
                    function, globalns=globalns, localns=localns, include_keys={'return'}
                )
                return_schema = self.generate_schema(type_hints['return'])

        return core_schema.call_schema(
            arguments_schema,
            function,
            return_schema=return_schema,
        )

    def _arguments_schema(
        self, function: ValidateCallSupportedTypes, parameters_callback: ParametersCallback | None = None
    ) -> core_schema.ArgumentsSchema:
        """Generate schema for a Signature."""
        mode_lookup: dict[_ParameterKind, Literal['positional_only', 'positional_or_keyword', 'keyword_only']] = {
            Parameter.POSITIONAL_ONLY: 'positional_only',
            Parameter.POSITIONAL_OR_KEYWORD: 'positional_or_keyword',
            Parameter.KEYWORD_ONLY: 'keyword_only',
        }

        sig = _typing_extra.signature_no_eval(function)
        globalns, localns = self._types_namespace
        type_hints = _typing_extra.get_function_type_hints(function, globalns=globalns, localns=localns)

        arguments_list: list[core_schema.ArgumentsParameter] = []
        var_args_schema: core_schema.CoreSchema | None = None
        var_kwargs_schema: core_schema.CoreSchema | None = None
        var_kwargs_mode: core_schema.VarKwargsMode | None = None

        for i, (name, p) in enumerate(sig.parameters.items()):
            if p.annotation is sig.empty:
                annotation = typing.cast(Any, Any)
            else:
                annotation = type_hints[name]

            if parameters_callback is not None:
                result = parameters_callback(i, name, annotation)
                if result == 'skip':
                    continue

            parameter_mode = mode_lookup.get(p.kind)
            if parameter_mode is not None:
                arg_schema = self._generate_parameter_schema(
                    name, annotation, AnnotationSource.FUNCTION, p.default, parameter_mode
                )
                arguments_list.append(arg_schema)
            elif p.kind == Parameter.VAR_POSITIONAL:
                var_args_schema = self.generate_schema(annotation)
            else:
                assert p.kind == Parameter.VAR_KEYWORD, p.kind

                unpack_type = _typing_extra.unpack_type(annotation)
                if unpack_type is not None:
                    origin = get_origin(unpack_type) or unpack_type
                    if not is_typeddict(origin):
                        raise PydanticUserError(
                            f'Expected a `TypedDict` class inside `Unpack[...]`, got {unpack_type!r}',
                            code='unpack-typed-dict',
                        )
                    non_pos_only_param_names = {
                        name for name, p in sig.parameters.items() if p.kind != Parameter.POSITIONAL_ONLY
                    }
                    overlapping_params = non_pos_only_param_names.intersection(origin.__annotations__)
                    if overlapping_params:
                        raise PydanticUserError(
                            f'Typed dictionary {origin.__name__!r} overlaps with parameter'
                            f'{"s" if len(overlapping_params) >= 2 else ""} '
                            f'{", ".join(repr(p) for p in sorted(overlapping_params))}',
                            code='overlapping-unpack-typed-dict',
                        )

                    var_kwargs_mode = 'unpacked-typed-dict'
                    var_kwargs_schema = self._typed_dict_schema(unpack_type, get_origin(unpack_type))
                else:
                    var_kwargs_mode = 'uniform'
                    var_kwargs_schema = self.generate_schema(annotation)

        return core_schema.arguments_schema(
            arguments_list,
            var_args_schema=var_args_schema,
            var_kwargs_mode=var_kwargs_mode,
            var_kwargs_schema=var_kwargs_schema,
            validate_by_name=self._config_wrapper.validate_by_name,
        )

    def _arguments_v3_schema(
        self, function: ValidateCallSupportedTypes, parameters_callback: ParametersCallback | None = None
    ) -> core_schema.ArgumentsV3Schema:
        mode_lookup: dict[
            _ParameterKind, Literal['positional_only', 'positional_or_keyword', 'var_args', 'keyword_only']
        ] = {
            Parameter.POSITIONAL_ONLY: 'positional_only',
            Parameter.POSITIONAL_OR_KEYWORD: 'positional_or_keyword',
            Parameter.VAR_POSITIONAL: 'var_args',
            Parameter.KEYWORD_ONLY: 'keyword_only',
        }

        sig = _typing_extra.signature_no_eval(function)
        globalns, localns = self._types_namespace
        type_hints = _typing_extra.get_function_type_hints(function, globalns=globalns, localns=localns)

        parameters_list: list[core_schema.ArgumentsV3Parameter] = []

        for i, (name, p) in enumerate(sig.parameters.items()):
            if parameters_callback is not None:
                result = parameters_callback(i, name, p.annotation)
                if result == 'skip':
                    continue

            if p.annotation is Parameter.empty:
                annotation = typing.cast(Any, Any)
            else:
                annotation = type_hints[name]

            parameter_mode = mode_lookup.get(p.kind)
            if parameter_mode is None:
                assert p.kind == Parameter.VAR_KEYWORD, p.kind

                unpack_type = _typing_extra.unpack_type(annotation)
                if unpack_type is not None:
                    origin = get_origin(unpack_type) or unpack_type
                    if not is_typeddict(origin):
                        raise PydanticUserError(
                            f'Expected a `TypedDict` class inside `Unpack[...]`, got {unpack_type!r}',
                            code='unpack-typed-dict',
                        )
                    non_pos_only_param_names = {
                        name for name, p in sig.parameters.items() if p.kind != Parameter.POSITIONAL_ONLY
                    }
                    overlapping_params = non_pos_only_param_names.intersection(origin.__annotations__)
                    if overlapping_params:
                        raise PydanticUserError(
                            f'Typed dictionary {origin.__name__!r} overlaps with parameter'
                            f'{"s" if len(overlapping_params) >= 2 else ""} '
                            f'{", ".join(repr(p) for p in sorted(overlapping_params))}',
                            code='overlapping-unpack-typed-dict',
                        )
                    parameter_mode = 'var_kwargs_unpacked_typed_dict'
                    annotation = unpack_type
                else:
                    parameter_mode = 'var_kwargs_uniform'

            parameters_list.append(
                self._generate_parameter_v3_schema(
                    name, annotation, AnnotationSource.FUNCTION, parameter_mode, default=p.default
                )
            )

        return core_schema.arguments_v3_schema(
            parameters_list,
            validate_by_name=self._config_wrapper.validate_by_name,
        )

    def _unsubstituted_typevar_schema(self, typevar: typing.TypeVar) -> core_schema.CoreSchema:
        try:
            has_default = typevar.has_default()  # pyright: ignore[reportAttributeAccessIssue]
        except AttributeError:
            # Happens if using `typing.TypeVar` (and not `typing_extensions`) on Python < 3.13
            pass
        else:
            if has_default:
                return self.generate_schema(typevar.__default__)  # pyright: ignore[reportAttributeAccessIssue]

        if constraints := typevar.__constraints__:
            return self._union_schema(typing.Union[constraints])

        if bound := typevar.__bound__:
            schema = self.generate_schema(bound)
            schema['serialization'] = core_schema.simple_ser_schema('any')
            return schema

        return core_schema.any_schema()

    def _computed_field_schema(
        self,
        d: Decorator[ComputedFieldInfo],
        field_serializers: dict[str, Decorator[FieldSerializerDecoratorInfo]],
    ) -> core_schema.ComputedField:
        if d.info.return_type is not PydanticUndefined:
            return_type = d.info.return_type
        else:
            try:
                # Do not pass in globals as the function could be defined in a different module.
                # Instead, let `get_callable_return_type` infer the globals to use, but still pass
                # in locals that may contain a parent/rebuild namespace:
                return_type = _decorators.get_callable_return_type(d.func, localns=self._types_namespace.locals)
            except NameError as e:
                raise PydanticUndefinedAnnotation.from_name_error(e) from e
        if return_type is PydanticUndefined:
            raise PydanticUserError(
                'Computed field is missing return type annotation or specifying `return_type`'
                ' to the `@computed_field` decorator (e.g. `@computed_field(return_type=int | str)`)',
                code='model-field-missing-annotation',
            )

        return_type = replace_types(return_type, self._typevars_map)
        # Create a new ComputedFieldInfo so that different type parametrizations of the same
        # generic model's computed field can have different return types.
        d.info = dataclasses.replace(d.info, return_type=return_type)
        return_type_schema = self.generate_schema(return_type)
        # Apply serializers to computed field if there exist
        return_type_schema = self._apply_field_serializers(
            return_type_schema,
            filter_field_decorator_info_by_field(field_serializers.values(), d.cls_var_name),
        )

        pydantic_js_updates, pydantic_js_extra = _extract_json_schema_info_from_field_info(d.info)
        core_metadata: dict[str, Any] = {}
        update_core_metadata(
            core_metadata,
            pydantic_js_updates={'readOnly': True, **(pydantic_js_updates if pydantic_js_updates else {})},
            pydantic_js_extra=pydantic_js_extra,
        )
        exclude_if = d.info.exclude_if
        # TODO: Should we support exclude_if from annotations?
        return core_schema.computed_field(
            d.cls_var_name,
            return_schema=return_type_schema,
            alias=d.info.alias,
            serialization_exclude_if=exclude_if,
            metadata=core_metadata,
        )

    def _annotated_schema(self, annotated_type: Any) -> core_schema.CoreSchema:
        """Generate schema for an Annotated type, e.g. `Annotated[int, Field(...)]` or `Annotated[int, Gt(0)]`."""
        FieldInfo = import_cached_field_info()
        source_type, *annotations = self._get_args_resolving_forward_refs(
            annotated_type,
            required=True,
        )
        schema = self._apply_annotations(source_type, annotations)
        # put the default validator last so that TypeAdapter.get_default_value() works
        # even if there are function validators involved
        for annotation in annotations:
            if isinstance(annotation, FieldInfo):
                schema = wrap_default(annotation, schema)
        return schema

    def _apply_annotations(
        self,
        source_type: Any,
        annotations: list[Any],
        transform_inner_schema: Callable[[CoreSchema], CoreSchema] = lambda x: x,
        check_unsupported_field_info_attributes: bool = True,
    ) -> CoreSchema:
        """Apply arguments from `Annotated` or from `FieldInfo` to a schema.

        This gets called by `GenerateSchema._annotated_schema` but differs from it in that it does
        not expect `source_type` to be an `Annotated` object, it expects it to be  the first argument of that
        (in other words, `GenerateSchema._annotated_schema` just unpacks `Annotated`, this process it).
        """
        annotations = list(_known_annotated_metadata.expand_grouped_metadata(annotations))

        pydantic_js_annotation_functions: list[GetJsonSchemaFunction] = []

        def inner_handler(obj: Any) -> CoreSchema:
            schema = self._generate_schema_from_get_schema_method(obj, source_type)

            if schema is None:
                schema = self._generate_schema_inner(obj)

            metadata_js_function = _extract_get_pydantic_json_schema(obj)
            if metadata_js_function is not None:
                metadata_schema = resolve_original_schema(schema, self.defs)
                if metadata_schema is not None:
                    self._add_js_function(metadata_schema, metadata_js_function)
            return transform_inner_schema(schema)

        get_inner_schema = CallbackGetCoreSchemaHandler(inner_handler, self)

        for annotation in annotations:
            if annotation is None:
                continue
            get_inner_schema = self._get_wrapped_inner_schema(
                get_inner_schema,
                annotation,
                pydantic_js_annotation_functions,
                check_unsupported_field_info_attributes=check_unsupported_field_info_attributes,
            )

        schema = get_inner_schema(source_type)
        if pydantic_js_annotation_functions:
            core_metadata = schema.setdefault('metadata', {})
            update_core_metadata(core_metadata, pydantic_js_annotation_functions=pydantic_js_annotation_functions)
        return _add_custom_serialization_from_json_encoders(self._config_wrapper.json_encoders, source_type, schema)

    def _apply_single_annotation(
        self,
        schema: core_schema.CoreSchema,
        metadata: Any,
        check_unsupported_field_info_attributes: bool = True,
    ) -> core_schema.CoreSchema:
        FieldInfo = import_cached_field_info()

        if isinstance(metadata, FieldInfo):
            if (
                check_unsupported_field_info_attributes
                # HACK: we don't want to emit the warning for `FieldInfo` subclasses, because FastAPI does weird manipulations
                # with its subclasses and their annotations:
                and type(metadata) is FieldInfo
            ):
                for attr, value in (unsupported_attributes := self._get_unsupported_field_info_attributes(metadata)):
                    warnings.warn(
                        f'The {attr!r} attribute with value {value!r} was provided to the `Field()` function, '
                        f'which has no effect in the context it was used. {attr!r} is field-specific metadata, '
                        'and can only be attached to a model field using `Annotated` metadata or by assignment. '
                        'This may have happened because an `Annotated` type alias using the `type` statement was '
                        'used, or if the `Field()` function was attached to a single member of a union type.',
                        category=UnsupportedFieldAttributeWarning,
                    )

                if (
                    metadata.default_factory_takes_validated_data
                    and self.model_type_stack.get() is None
                    and 'defaut_factory' not in unsupported_attributes
                ):
                    warnings.warn(
                        "A 'default_factory' taking validated data as an argument was provided to the `Field()` function, "
                        'but no validated data is available in the context it was used.',
                        category=UnsupportedFieldAttributeWarning,
                    )

            for field_metadata in metadata.metadata:
                schema = self._apply_single_annotation(schema, field_metadata)

            if metadata.discriminator is not None:
                schema = self._apply_discriminator_to_union(schema, metadata.discriminator)
            return schema

        if schema['type'] == 'nullable':
            # for nullable schemas, metadata is automatically applied to the inner schema
            inner = schema.get('schema', core_schema.any_schema())
            inner = self._apply_single_annotation(inner, metadata)
            if inner:
                schema['schema'] = inner
            return schema

        if schema['type'] == 'union' and any(
            choice['type'] == 'missing-sentinel' for choice in core_schema.iter_union_choices(schema)
        ):
            # Same behavior as for nullable schemas. This is a bit gross, but we have to support the same pattern
            filtered_choices = [
                choice
                for choice in schema['choices']
                if (choice[0] if isinstance(choice, tuple) else choice)['type'] != 'missing-sentinel'
            ]
            if len(filtered_choices) >= 2:
                # e.g. `Annotated[int | str | MISSING, Constraint(...)]`. We apply `Constraint(...)` to `int | str`,
                # and create a new union semantically equivalent to `Annotated[int | str, Constraint(...)] | MISSING`:
                filtered_union = core_schema.union_schema(filtered_choices)
                filtered_union = self._apply_single_annotation(filtered_union, metadata)
                new_union = schema.copy()
                new_union['choices'] = [
                    filtered_union,
                    next(
                        choice
                        for choice in schema['choices']
                        if (choice[0] if isinstance(choice, tuple) else choice)['type'] == 'missing-sentinel'
                    ),
                ]
                return new_union
            elif len(filtered_choices) == 1:
                # e.g. `Annotated[int | MISSING, Constraint(...)]`. We apply `Constraint(...)` to `int`, and reconstruct
                # a new union preserving the order.
                inner = filtered_choices[0][0] if isinstance(filtered_choices[0], tuple) else filtered_choices[0]
                inner = self._apply_single_annotation(inner, metadata)

                # Create a new union schema, preserving the order of the union:
                new_union = schema.copy()
                new_union['choices'] = [
                    (inner, choice[1])
                    if isinstance(choice, tuple) and choice[0]['type'] != 'missing-sentinel'
                    else inner
                    if not isinstance(choice, tuple) and choice['type'] != 'missing-sentinel'
                    else choice
                    for choice in schema['choices']
                ]
                return new_union

        original_schema = schema
        ref = schema.get('ref')
        if ref is not None:
            schema = schema.copy()
            new_ref = ref + f'_{repr(metadata)}'
            if (existing := self.defs.get_schema_from_ref(new_ref)) is not None:
                return existing
            schema['ref'] = new_ref  # pyright: ignore[reportGeneralTypeIssues]
        elif schema['type'] == 'definition-ref':
            ref = schema['schema_ref']
            if (referenced_schema := self.defs.get_schema_from_ref(ref)) is not None:
                schema = referenced_schema.copy()
                new_ref = ref + f'_{repr(metadata)}'
                if (existing := self.defs.get_schema_from_ref(new_ref)) is not None:
                    return existing
                schema['ref'] = new_ref  # pyright: ignore[reportGeneralTypeIssues]

        maybe_updated_schema = _known_annotated_metadata.apply_known_metadata(metadata, schema)

        if maybe_updated_schema is not None:
            return maybe_updated_schema
        return original_schema

    def _apply_single_annotation_json_schema(
        self, schema: core_schema.CoreSchema, metadata: Any
    ) -> core_schema.CoreSchema:
        FieldInfo = import_cached_field_info()

        if isinstance(metadata, FieldInfo):
            for field_metadata in metadata.metadata:
                schema = self._apply_single_annotation_json_schema(schema, field_metadata)

            pydantic_js_updates, pydantic_js_extra = _extract_json_schema_info_from_field_info(metadata)
            core_metadata = schema.setdefault('metadata', {})
            update_core_metadata(
                core_metadata, pydantic_js_updates=pydantic_js_updates, pydantic_js_extra=pydantic_js_extra
            )
        return schema

    def _get_unsupported_field_info_attributes(self, field_info: FieldInfo) -> list[tuple[str, Any]]:
        """Get the list of unsupported `FieldInfo` attributes when not directly used in `Annotated` for field annotations."""
        unused_metadata: list[tuple[str, Any]] = []
        for unused_metadata_name, unset_value in UNSUPPORTED_STANDALONE_FIELDINFO_ATTRIBUTES:
            if (
                (unused_metadata_value := getattr(field_info, unused_metadata_name)) is not unset_value
                # `default` and `default_factory` can still be used with a type adapter, so only include them
                # if used with a model-like class:
                and (
                    unused_metadata_name not in ('default', 'default_factory')
                    or self.model_type_stack.get() is not None
                )
                # Setting `alias` will set `validation/serialization_alias` as well, so we want to avoid duplicate warnings:
                and (
                    unused_metadata_name not in ('validation_alias', 'serialization_alias')
                    or 'alias' not in field_info._attributes_set
                )
            ):
                unused_metadata.append((unused_metadata_name, unused_metadata_value))

        return unused_metadata

    def _get_wrapped_inner_schema(
        self,
        get_inner_schema: GetCoreSchemaHandler,
        annotation: Any,
        pydantic_js_annotation_functions: list[GetJsonSchemaFunction],
        check_unsupported_field_info_attributes: bool = False,
    ) -> CallbackGetCoreSchemaHandler:
        annotation_get_schema: GetCoreSchemaFunction | None = getattr(annotation, '__get_pydantic_core_schema__', None)

        def new_handler(source: Any) -> core_schema.CoreSchema:
            if annotation_get_schema is not None:
                schema = annotation_get_schema(source, get_inner_schema)
            else:
                schema = get_inner_schema(source)
                schema = self._apply_single_annotation(
                    schema,
                    annotation,
                    check_unsupported_field_info_attributes=check_unsupported_field_info_attributes,
                )
                schema = self._apply_single_annotation_json_schema(schema, annotation)

            metadata_js_function = _extract_get_pydantic_json_schema(annotation)
            if metadata_js_function is not None:
                pydantic_js_annotation_functions.append(metadata_js_function)
            return schema

        return CallbackGetCoreSchemaHandler(new_handler, self)

    def _apply_field_serializers(
        self,
        schema: core_schema.CoreSchema,
        serializers: list[Decorator[FieldSerializerDecoratorInfo]],
    ) -> core_schema.CoreSchema:
        """Apply field serializers to a schema."""
        if serializers:
            schema = copy(schema)
            if schema['type'] == 'definitions':
                inner_schema = schema['schema']
                schema['schema'] = self._apply_field_serializers(inner_schema, serializers)
                return schema
            elif 'ref' in schema:
                schema = self.defs.create_definition_reference_schema(schema)

            # use the last serializer to make it easy to override a serializer set on a parent model
            serializer = serializers[-1]
            is_field_serializer, info_arg = inspect_field_serializer(serializer.func, serializer.info.mode)

            if serializer.info.return_type is not PydanticUndefined:
                return_type = serializer.info.return_type
            else:
                try:
                    # Do not pass in globals as the function could be defined in a different module.
                    # Instead, let `get_callable_return_type` infer the globals to use, but still pass
                    # in locals that may contain a parent/rebuild namespace:
                    return_type = _decorators.get_callable_return_type(
                        serializer.func, localns=self._types_namespace.locals
                    )
                except NameError as e:
                    raise PydanticUndefinedAnnotation.from_name_error(e) from e

            if return_type is PydanticUndefined:
                return_schema = None
            else:
                return_schema = self.generate_schema(return_type)

            if serializer.info.mode == 'wrap':
                schema['serialization'] = core_schema.wrap_serializer_function_ser_schema(
                    serializer.func,
                    is_field_serializer=is_field_serializer,
                    info_arg=info_arg,
                    return_schema=return_schema,
                    when_used=serializer.info.when_used,
                )
            else:
                assert serializer.info.mode == 'plain'
                schema['serialization'] = core_schema.plain_serializer_function_ser_schema(
                    serializer.func,
                    is_field_serializer=is_field_serializer,
                    info_arg=info_arg,
                    return_schema=return_schema,
                    when_used=serializer.info.when_used,
                )
        return schema

    def _apply_model_serializers(
        self, schema: core_schema.CoreSchema, serializers: Iterable[Decorator[ModelSerializerDecoratorInfo]]
    ) -> core_schema.CoreSchema:
        """Apply model serializers to a schema."""
        ref: str | None = schema.pop('ref', None)  # type: ignore
        if serializers:
            serializer = list(serializers)[-1]
            info_arg = inspect_model_serializer(serializer.func, serializer.info.mode)

            if serializer.info.return_type is not PydanticUndefined:
                return_type = serializer.info.return_type
            else:
                try:
                    # Do not pass in globals as the function could be defined in a different module.
                    # Instead, let `get_callable_return_type` infer the globals to use, but still pass
                    # in locals that may contain a parent/rebuild namespace:
                    return_type = _decorators.get_callable_return_type(
                        serializer.func, localns=self._types_namespace.locals
                    )
                except NameError as e:
                    raise PydanticUndefinedAnnotation.from_name_error(e) from e

            if return_type is PydanticUndefined:
                return_schema = None
            else:
                return_schema = self.generate_schema(return_type)

            if serializer.info.mode == 'wrap':
                ser_schema: core_schema.SerSchema = core_schema.wrap_serializer_function_ser_schema(
                    serializer.func,
                    info_arg=info_arg,
                    return_schema=return_schema,
                    when_used=serializer.info.when_used,
                )
            else:
                # plain
                ser_schema = core_schema.plain_serializer_function_ser_schema(
                    serializer.func,
                    info_arg=info_arg,
                    return_schema=return_schema,
                    when_used=serializer.info.when_used,
                )
            schema['serialization'] = ser_schema
        if ref:
            schema['ref'] = ref  # type: ignore
        return schema


_VALIDATOR_F_MATCH: Mapping[
    tuple[FieldValidatorModes, Literal['no-info', 'with-info']],
    Callable[[Callable[..., Any], core_schema.CoreSchema], core_schema.CoreSchema],
] = {
    ('before', 'no-info'): lambda f, schema: core_schema.no_info_before_validator_function(f, schema),
    ('after', 'no-info'): lambda f, schema: core_schema.no_info_after_validator_function(f, schema),
    ('plain', 'no-info'): lambda f, _: core_schema.no_info_plain_validator_function(f),
    ('wrap', 'no-info'): lambda f, schema: core_schema.no_info_wrap_validator_function(f, schema),
    ('before', 'with-info'): lambda f, schema: core_schema.with_info_before_validator_function(f, schema),
    ('after', 'with-info'): lambda f, schema: core_schema.with_info_after_validator_function(f, schema),
    ('plain', 'with-info'): lambda f, _: core_schema.with_info_plain_validator_function(f),
    ('wrap', 'with-info'): lambda f, schema: core_schema.with_info_wrap_validator_function(f, schema),
}


# TODO V3: this function is only used for deprecated decorators. It should
# be removed once we drop support for those.
def apply_validators(
    schema: core_schema.CoreSchema,
    validators: Iterable[Decorator[RootValidatorDecoratorInfo]]
    | Iterable[Decorator[ValidatorDecoratorInfo]]
    | Iterable[Decorator[FieldValidatorDecoratorInfo]],
) -> core_schema.CoreSchema:
    """Apply validators to a schema.

    Args:
        schema: The schema to apply validators on.
        validators: An iterable of validators.
        field_name: The name of the field if validators are being applied to a model field.

    Returns:
        The updated schema.
    """
    for validator in validators:
        # Actually, type could be 'field' or 'model', but this is only used for deprecated
        # decorators, so let's not worry about it.
        info_arg = inspect_validator(validator.func, mode=validator.info.mode, type='field')
        val_type = 'with-info' if info_arg else 'no-info'

        schema = _VALIDATOR_F_MATCH[(validator.info.mode, val_type)](validator.func, schema)
    return schema


def _validators_require_validate_default(validators: Iterable[Decorator[ValidatorDecoratorInfo]]) -> bool:
    """In v1, if any of the validators for a field had `always=True`, the default value would be validated.

    This serves as an auxiliary function for re-implementing that logic, by looping over a provided
    collection of (v1-style) ValidatorDecoratorInfo's and checking if any of them have `always=True`.

    We should be able to drop this function and the associated logic calling it once we drop support
    for v1-style validator decorators. (Or we can extend it and keep it if we add something equivalent
    to the v1-validator `always` kwarg to `field_validator`.)
    """
    for validator in validators:
        if validator.info.always:
            return True
    return False


def _convert_to_aliases(
    alias: str | AliasChoices | AliasPath | None,
) -> str | list[str | int] | list[list[str | int]] | None:
    if isinstance(alias, (AliasChoices, AliasPath)):
        return alias.convert_to_aliases()
    else:
        return alias


def apply_model_validators(
    schema: core_schema.CoreSchema,
    validators: Iterable[Decorator[ModelValidatorDecoratorInfo]],
    mode: Literal['inner', 'outer', 'all'],
) -> core_schema.CoreSchema:
    """Apply model validators to a schema.

    If mode == 'inner', only "before" validators are applied
    If mode == 'outer', validators other than "before" are applied
    If mode == 'all', all validators are applied

    Args:
        schema: The schema to apply validators on.
        validators: An iterable of validators.
        mode: The validator mode.

    Returns:
        The updated schema.
    """
    ref: str | None = schema.pop('ref', None)  # type: ignore
    for validator in validators:
        if mode == 'inner' and validator.info.mode != 'before':
            continue
        if mode == 'outer' and validator.info.mode == 'before':
            continue
        info_arg = inspect_validator(validator.func, mode=validator.info.mode, type='model')
        if validator.info.mode == 'wrap':
            if info_arg:
                schema = core_schema.with_info_wrap_validator_function(function=validator.func, schema=schema)
            else:
                schema = core_schema.no_info_wrap_validator_function(function=validator.func, schema=schema)
        elif validator.info.mode == 'before':
            if info_arg:
                schema = core_schema.with_info_before_validator_function(function=validator.func, schema=schema)
            else:
                schema = core_schema.no_info_before_validator_function(function=validator.func, schema=schema)
        else:
            assert validator.info.mode == 'after'
            if info_arg:
                schema = core_schema.with_info_after_validator_function(function=validator.func, schema=schema)
            else:
                schema = core_schema.no_info_after_validator_function(function=validator.func, schema=schema)
    if ref:
        schema['ref'] = ref  # type: ignore
    return schema


def wrap_default(field_info: FieldInfo, schema: core_schema.CoreSchema) -> core_schema.CoreSchema:
    """Wrap schema with default schema if default value or `default_factory` are available.

    Args:
        field_info: The field info object.
        schema: The schema to apply default on.

    Returns:
        Updated schema by default value or `default_factory`.
    """
    if field_info.default_factory:
        return core_schema.with_default_schema(
            schema,
            default_factory=field_info.default_factory,
            default_factory_takes_data=takes_validated_data_argument(field_info.default_factory),
            validate_default=field_info.validate_default,
        )
    elif field_info.default is not PydanticUndefined:
        return core_schema.with_default_schema(
            schema, default=field_info.default, validate_default=field_info.validate_default
        )
    else:
        return schema


def _extract_get_pydantic_json_schema(tp: Any) -> GetJsonSchemaFunction | None:
    """Extract `__get_pydantic_json_schema__` from a type, handling the deprecated `__modify_schema__`."""
    js_modify_function = getattr(tp, '__get_pydantic_json_schema__', None)

    if hasattr(tp, '__modify_schema__'):
        BaseModel = import_cached_base_model()

        has_custom_v2_modify_js_func = (
            js_modify_function is not None
            and BaseModel.__get_pydantic_json_schema__.__func__  # type: ignore
            not in (js_modify_function, getattr(js_modify_function, '__func__', None))
        )

        if not has_custom_v2_modify_js_func:
            cls_name = getattr(tp, '__name__', None)
            raise PydanticUserError(
                f'The `__modify_schema__` method is not supported in Pydantic v2. '
                f'Use `__get_pydantic_json_schema__` instead{f" in class `{cls_name}`" if cls_name else ""}.',
                code='custom-json-schema',
            )

    if (origin := get_origin(tp)) is not None:
        # Generic aliases proxy attribute access to the origin, *except* dunder attributes,
        # such as `__get_pydantic_json_schema__`, hence the explicit check.
        return _extract_get_pydantic_json_schema(origin)

    if js_modify_function is None:
        return None

    return js_modify_function


def resolve_original_schema(schema: CoreSchema, definitions: _Definitions) -> CoreSchema | None:
    if schema['type'] == 'definition-ref':
        return definitions.get_schema_from_ref(schema['schema_ref'])
    elif schema['type'] == 'definitions':
        return schema['schema']
    else:
        return schema


def _inlining_behavior(
    def_ref: core_schema.DefinitionReferenceSchema,
) -> Literal['inline', 'keep', 'preserve_metadata']:
    """Determine the inlining behavior of the `'definition-ref'` schema.

    - If no `'serialization'` schema and no metadata is attached, the schema can safely be inlined.
    - If it has metadata but only related to the deferred discriminator application, it can be inlined
      provided that such metadata is kept.
    - Otherwise, the schema should not be inlined. Doing so would remove the `'serialization'` schema or metadata.
    """
    if 'serialization' in def_ref:
        return 'keep'
    metadata = def_ref.get('metadata')
    if not metadata:
        return 'inline'
    if len(metadata) == 1 and 'pydantic_internal_union_discriminator' in metadata:
        return 'preserve_metadata'
    return 'keep'


class _Definitions:
    """Keeps track of references and definitions."""

    _recursively_seen: set[str]
    """A set of recursively seen references.

    When a referenceable type is encountered, the `get_schema_or_ref` context manager is
    entered to compute the reference. If the type references itself by some way (e.g. for
    a dataclass a Pydantic model, the class can be referenced as a field annotation),
    entering the context manager again will yield a `'definition-ref'` schema that should
    short-circuit the normal generation process, as the reference was already in this set.
    """

    _definitions: dict[str, core_schema.CoreSchema]
    """A mapping of references to their corresponding schema.

    When a schema for a referenceable type is generated, it is stored in this mapping. If the
    same type is encountered again, the reference is yielded by the `get_schema_or_ref` context
    manager.
    """

    def __init__(self) -> None:
        self._recursively_seen = set()
        self._definitions = {}

    @contextmanager
    def get_schema_or_ref(self, tp: Any, /) -> Generator[tuple[str, core_schema.DefinitionReferenceSchema | None]]:
        """Get a definition for `tp` if one exists.

        If a definition exists, a tuple of `(ref_string, CoreSchema)` is returned.
        If no definition exists yet, a tuple of `(ref_string, None)` is returned.

        Note that the returned `CoreSchema` will always be a `DefinitionReferenceSchema`,
        not the actual definition itself.

        This should be called for any type that can be identified by reference.
        This includes any recursive types.

        At present the following types can be named/recursive:

        - Pydantic model
        - Pydantic and stdlib dataclasses
        - Typed dictionaries
        - Named tuples
        - `TypeAliasType` instances
        - Enums
        """
        ref = get_type_ref(tp)
        # return the reference if we're either (1) in a cycle or (2) it the reference was already encountered:
        if ref in self._recursively_seen or ref in self._definitions:
            yield (ref, core_schema.definition_reference_schema(ref))
        else:
            self._recursively_seen.add(ref)
            try:
                yield (ref, None)
            finally:
                self._recursively_seen.discard(ref)

    def get_schema_from_ref(self, ref: str) -> CoreSchema | None:
        """Resolve the schema from the given reference."""
        return self._definitions.get(ref)

    def create_definition_reference_schema(self, schema: CoreSchema) -> core_schema.DefinitionReferenceSchema:
        """Store the schema as a definition and return a `'definition-reference'` schema pointing to it.

        The schema must have a reference attached to it.
        """
        ref = schema['ref']  # pyright: ignore
        self._definitions[ref] = schema
        return core_schema.definition_reference_schema(ref)

    def unpack_definitions(self, schema: core_schema.DefinitionsSchema) -> CoreSchema:
        """Store the definitions of the `'definitions'` core schema and return the inner core schema."""
        for def_schema in schema['definitions']:
            self._definitions[def_schema['ref']] = def_schema  # pyright: ignore
        return schema['schema']

    def finalize_schema(self, schema: CoreSchema) -> CoreSchema:
        """Finalize the core schema.

        This traverses the core schema and referenced definitions, replaces `'definition-ref'` schemas
        by the referenced definition if possible, and applies deferred discriminators.
        """
        definitions = self._definitions
        try:
            gather_result = gather_schemas_for_cleaning(
                schema,
                definitions=definitions,
            )
        except MissingDefinitionError as e:
            raise InvalidSchemaError from e

        remaining_defs: dict[str, CoreSchema] = {}

        # Note: this logic doesn't play well when core schemas with deferred discriminator metadata
        # and references are encountered. See the `test_deferred_discriminated_union_and_references()` test.
        for ref, inlinable_def_ref in gather_result['collected_references'].items():
            if inlinable_def_ref is not None and (inlining_behavior := _inlining_behavior(inlinable_def_ref)) != 'keep':
                if inlining_behavior == 'inline':
                    # `ref` was encountered, and only once:
                    #  - `inlinable_def_ref` is a `'definition-ref'` schema and is guaranteed to be
                    #    the only one. Transform it into the definition it points to.
                    #  - Do not store the definition in the `remaining_defs`.
                    inlinable_def_ref.clear()  # pyright: ignore[reportAttributeAccessIssue]
                    inlinable_def_ref.update(self._resolve_definition(ref, definitions))  # pyright: ignore
                elif inlining_behavior == 'preserve_metadata':
                    # `ref` was encountered, and only once, but contains discriminator metadata.
                    # We will do the same thing as if `inlining_behavior` was `'inline'`, but make
                    # sure to keep the metadata for the deferred discriminator application logic below.
                    meta = inlinable_def_ref.pop('metadata')
                    inlinable_def_ref.clear()  # pyright: ignore[reportAttributeAccessIssue]
                    inlinable_def_ref.update(self._resolve_definition(ref, definitions))  # pyright: ignore
                    inlinable_def_ref['metadata'] = meta
            else:
                # `ref` was encountered, at least two times (or only once, but with metadata or a serialization schema):
                # - Do not inline the `'definition-ref'` schemas (they are not provided in the gather result anyway).
                # - Store the definition in the `remaining_defs`
                remaining_defs[ref] = self._resolve_definition(ref, definitions)

        for cs in gather_result['deferred_discriminator_schemas']:
            discriminator: str | None = cs['metadata'].pop('pydantic_internal_union_discriminator', None)  # pyright: ignore[reportTypedDictNotRequiredAccess]
            if discriminator is None:
                # This can happen in rare scenarios, when a deferred schema is present multiple times in the
                # gather result (e.g. when using the `Sequence` type -- see `test_sequence_discriminated_union()`).
                # In this case, a previous loop iteration applied the discriminator and so we can just skip it here.
                continue
            applied = _discriminated_union.apply_discriminator(cs.copy(), discriminator, remaining_defs)
            # Mutate the schema directly to have the discriminator applied
            cs.clear()  # pyright: ignore[reportAttributeAccessIssue]
            cs.update(applied)  # pyright: ignore

        if remaining_defs:
            schema = core_schema.definitions_schema(schema=schema, definitions=[*remaining_defs.values()])
        return schema

    def _resolve_definition(self, ref: str, definitions: dict[str, CoreSchema]) -> CoreSchema:
        definition = definitions[ref]
        if definition['type'] != 'definition-ref':
            return definition

        # Some `'definition-ref'` schemas might act as "intermediate" references (e.g. when using
        # a PEP 695 type alias (which is referenceable) that references another PEP 695 type alias):
        visited: set[str] = set()
        while definition['type'] == 'definition-ref' and _inlining_behavior(definition) == 'inline':
            schema_ref = definition['schema_ref']
            if schema_ref in visited:
                raise PydanticUserError(
                    f'{ref} contains a circular reference to itself.', code='circular-reference-schema'
                )
            visited.add(schema_ref)
            definition = definitions[schema_ref]
        return {**definition, 'ref': ref}  # pyright: ignore[reportReturnType]


class _FieldNameStack:
    __slots__ = ('_stack',)

    def __init__(self) -> None:
        self._stack: list[str] = []

    @contextmanager
    def push(self, field_name: str) -> Iterator[None]:
        self._stack.append(field_name)
        yield
        self._stack.pop()

    def get(self) -> str | None:
        if self._stack:
            return self._stack[-1]
        else:
            return None


class _ModelTypeStack:
    __slots__ = ('_stack',)

    def __init__(self) -> None:
        self._stack: list[type] = []

    @contextmanager
    def push(self, type_obj: type) -> Iterator[None]:
        self._stack.append(type_obj)
        yield
        self._stack.pop()

    def get(self) -> type | None:
        if self._stack:
            return self._stack[-1]
        else:
            return None
