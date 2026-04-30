from __future__ import annotations

import inspect
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Union

from pydantic_core import CoreSchema, core_schema
from typing_extensions import TypeGuard, get_args, get_origin
from typing_inspection import typing_objects

from . import _repr
from ._typing_extra import is_generic_alias

if TYPE_CHECKING:
    from rich.console import Console

AnyFunctionSchema = Union[
    core_schema.AfterValidatorFunctionSchema,
    core_schema.BeforeValidatorFunctionSchema,
    core_schema.WrapValidatorFunctionSchema,
    core_schema.PlainValidatorFunctionSchema,
]


FunctionSchemaWithInnerSchema = Union[
    core_schema.AfterValidatorFunctionSchema,
    core_schema.BeforeValidatorFunctionSchema,
    core_schema.WrapValidatorFunctionSchema,
]

CoreSchemaField = Union[
    core_schema.ModelField, core_schema.DataclassField, core_schema.TypedDictField, core_schema.ComputedField
]
CoreSchemaOrField = Union[core_schema.CoreSchema, CoreSchemaField]

_CORE_SCHEMA_FIELD_TYPES = {'typed-dict-field', 'dataclass-field', 'model-field', 'computed-field'}
_FUNCTION_WITH_INNER_SCHEMA_TYPES = {'function-before', 'function-after', 'function-wrap'}
_LIST_LIKE_SCHEMA_WITH_ITEMS_TYPES = {'list', 'set', 'frozenset'}


def is_core_schema(
    schema: CoreSchemaOrField,
) -> TypeGuard[CoreSchema]:
    return schema['type'] not in _CORE_SCHEMA_FIELD_TYPES


def is_core_schema_field(
    schema: CoreSchemaOrField,
) -> TypeGuard[CoreSchemaField]:
    return schema['type'] in _CORE_SCHEMA_FIELD_TYPES


def is_function_with_inner_schema(
    schema: CoreSchemaOrField,
) -> TypeGuard[FunctionSchemaWithInnerSchema]:
    return schema['type'] in _FUNCTION_WITH_INNER_SCHEMA_TYPES


def is_list_like_schema_with_items_schema(
    schema: CoreSchema,
) -> TypeGuard[core_schema.ListSchema | core_schema.SetSchema | core_schema.FrozenSetSchema]:
    return schema['type'] in _LIST_LIKE_SCHEMA_WITH_ITEMS_TYPES


def get_type_ref(type_: Any, args_override: tuple[type[Any], ...] | None = None) -> str:
    """Produces the ref to be used for this type by pydantic_core's core schemas.

    This `args_override` argument was added for the purpose of creating valid recursive references
    when creating generic models without needing to create a concrete class.
    """
    origin = get_origin(type_) or type_

    args = get_args(type_) if is_generic_alias(type_) else (args_override or ())
    generic_metadata = getattr(type_, '__pydantic_generic_metadata__', None)
    if generic_metadata:
        origin = generic_metadata['origin'] or origin
        args = generic_metadata['args'] or args

    module_name = getattr(origin, '__module__', '<No __module__>')
    if typing_objects.is_typealiastype(origin):
        type_ref = f'{module_name}.{origin.__name__}:{id(origin)}'
    else:
        try:
            qualname = getattr(origin, '__qualname__', f'<No __qualname__: {origin}>')
        except Exception:
            qualname = getattr(origin, '__qualname__', '<No __qualname__>')
        type_ref = f'{module_name}.{qualname}:{id(origin)}'

    arg_refs: list[str] = []
    for arg in args:
        if isinstance(arg, str):
            # Handle string literals as a special case; we may be able to remove this special handling if we
            # wrap them in a ForwardRef at some point.
            arg_ref = f'{arg}:str-{id(arg)}'
        else:
            arg_ref = f'{_repr.display_as_type(arg)}:{id(arg)}'
        arg_refs.append(arg_ref)
    if arg_refs:
        type_ref = f'{type_ref}[{",".join(arg_refs)}]'
    return type_ref


def get_ref(s: core_schema.CoreSchema) -> None | str:
    """Get the ref from the schema if it has one.
    This exists just for type checking to work correctly.
    """
    return s.get('ref', None)


def _clean_schema_for_pretty_print(obj: Any, strip_metadata: bool = True) -> Any:  # pragma: no cover
    """A utility function to remove irrelevant information from a core schema."""
    if isinstance(obj, Mapping):
        new_dct = {}
        for k, v in obj.items():
            if k == 'metadata' and strip_metadata:
                new_metadata = {}

                for meta_k, meta_v in v.items():
                    if meta_k in ('pydantic_js_functions', 'pydantic_js_annotation_functions'):
                        new_metadata['js_metadata'] = '<stripped>'
                    else:
                        new_metadata[meta_k] = _clean_schema_for_pretty_print(meta_v, strip_metadata=strip_metadata)

                if list(new_metadata.keys()) == ['js_metadata']:
                    new_metadata = {'<stripped>'}

                new_dct[k] = new_metadata
            # Remove some defaults:
            elif k in ('custom_init', 'root_model') and not v:
                continue
            else:
                new_dct[k] = _clean_schema_for_pretty_print(v, strip_metadata=strip_metadata)

        return new_dct
    elif isinstance(obj, Sequence) and not isinstance(obj, str):
        return [_clean_schema_for_pretty_print(v, strip_metadata=strip_metadata) for v in obj]
    else:
        return obj


def pretty_print_core_schema(
    val: Any,
    *,
    console: Console | None = None,
    max_depth: int | None = None,
    strip_metadata: bool = True,
) -> None:  # pragma: no cover
    """Pretty-print a core schema using the `rich` library.

    Args:
        val: The core schema to print, or a Pydantic model/dataclass/type adapter
            (in which case the cached core schema is fetched and printed).
        console: A rich console to use when printing. Defaults to the global rich console instance.
        max_depth: The number of nesting levels which may be printed.
        strip_metadata: Whether to strip metadata in the output. If `True` any known core metadata
            attributes will be stripped (but custom attributes are kept). Defaults to `True`.
    """
    # lazy import:
    from rich.pretty import pprint

    # circ. imports:
    from pydantic import BaseModel, TypeAdapter
    from pydantic.dataclasses import is_pydantic_dataclass

    if (inspect.isclass(val) and issubclass(val, BaseModel)) or is_pydantic_dataclass(val):
        val = val.__pydantic_core_schema__
    if isinstance(val, TypeAdapter):
        val = val.core_schema
    cleaned_schema = _clean_schema_for_pretty_print(val, strip_metadata=strip_metadata)

    pprint(cleaned_schema, console=console, max_depth=max_depth)


pps = pretty_print_core_schema
