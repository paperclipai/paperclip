# pyright: reportTypedDictNotRequiredAccess=false, reportGeneralTypeIssues=false, reportArgumentType=false, reportAttributeAccessIssue=false
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TypedDict

from pydantic_core.core_schema import (
    ComputedField,
    CoreSchema,
    DefinitionReferenceSchema,
    SerSchema,
    iter_union_choices,
)
from typing_extensions import TypeAlias

AllSchemas: TypeAlias = 'CoreSchema | SerSchema | ComputedField'


class GatherResult(TypedDict):
    """Schema traversing result."""

    collected_references: dict[str, DefinitionReferenceSchema | None]
    """The collected definition references.

    If a definition reference schema can be inlined, it means that there is
    only one in the whole core schema. As such, it is stored as the value.
    Otherwise, the value is set to `None`.
    """

    deferred_discriminator_schemas: list[CoreSchema]
    """The list of core schemas having the discriminator application deferred."""


class MissingDefinitionError(LookupError):
    """A reference was pointing to a non-existing core schema."""

    def __init__(self, schema_reference: str, /) -> None:
        self.schema_reference = schema_reference


@dataclass
class GatherContext:
    """The current context used during core schema traversing.

    Context instances should only be used during schema traversing.
    """

    definitions: dict[str, CoreSchema]
    """The available definitions."""

    deferred_discriminator_schemas: list[CoreSchema] = field(init=False, default_factory=list)
    """The list of core schemas having the discriminator application deferred.

    Internally, these core schemas have a specific key set in the core metadata dict.
    """

    collected_references: dict[str, DefinitionReferenceSchema | None] = field(init=False, default_factory=dict)
    """The collected definition references.

    If a definition reference schema can be inlined, it means that there is
    only one in the whole core schema. As such, it is stored as the value.
    Otherwise, the value is set to `None`.

    During schema traversing, definition reference schemas can be added as candidates, or removed
    (by setting the value to `None`).
    """


def traverse_metadata(schema: AllSchemas, ctx: GatherContext) -> None:
    meta = schema.get('metadata')
    if meta is not None and 'pydantic_internal_union_discriminator' in meta:
        ctx.deferred_discriminator_schemas.append(schema)  # pyright: ignore[reportArgumentType]


def traverse_definition_ref(def_ref_schema: DefinitionReferenceSchema, ctx: GatherContext) -> None:
    schema_ref = def_ref_schema['schema_ref']

    if schema_ref not in ctx.collected_references:
        definition = ctx.definitions.get(schema_ref)
        if definition is None:
            raise MissingDefinitionError(schema_ref)

        # The `'definition-ref'` schema was only encountered once, make it
        # a candidate to be inlined:
        ctx.collected_references[schema_ref] = def_ref_schema
        traverse_schema(definition, ctx)
        if 'serialization' in def_ref_schema:
            traverse_schema(def_ref_schema['serialization'], ctx)
        traverse_metadata(def_ref_schema, ctx)
    else:
        # The `'definition-ref'` schema was already encountered, meaning
        # the previously encountered schema (and this one) can't be inlined:
        ctx.collected_references[schema_ref] = None


def traverse_schema(schema: AllSchemas, context: GatherContext) -> None:
    # TODO When we drop 3.9, use a match statement to get better type checking and remove
    # file-level type ignore.
    # (the `'type'` could also be fetched in every `if/elif` statement, but this alters performance).
    schema_type = schema['type']

    if schema_type == 'definition-ref':
        traverse_definition_ref(schema, context)
        # `traverse_definition_ref` handles the possible serialization and metadata schemas:
        return
    elif schema_type == 'definitions':
        traverse_schema(schema['schema'], context)
        for definition in schema['definitions']:
            traverse_schema(definition, context)
    elif schema_type in {'list', 'set', 'frozenset', 'generator'}:
        if 'items_schema' in schema:
            traverse_schema(schema['items_schema'], context)
    elif schema_type == 'tuple':
        if 'items_schema' in schema:
            for s in schema['items_schema']:
                traverse_schema(s, context)
    elif schema_type == 'dict':
        if 'keys_schema' in schema:
            traverse_schema(schema['keys_schema'], context)
        if 'values_schema' in schema:
            traverse_schema(schema['values_schema'], context)
    elif schema_type == 'union':
        for choice in iter_union_choices(schema):
            traverse_schema(choice, context)
    elif schema_type == 'tagged-union':
        for v in schema['choices'].values():
            traverse_schema(v, context)
    elif schema_type == 'chain':
        for step in schema['steps']:
            traverse_schema(step, context)
    elif schema_type == 'lax-or-strict':
        traverse_schema(schema['lax_schema'], context)
        traverse_schema(schema['strict_schema'], context)
    elif schema_type == 'json-or-python':
        traverse_schema(schema['json_schema'], context)
        traverse_schema(schema['python_schema'], context)
    elif schema_type in {'model-fields', 'typed-dict'}:
        if 'extras_schema' in schema:
            traverse_schema(schema['extras_schema'], context)
        if 'computed_fields' in schema:
            for s in schema['computed_fields']:
                traverse_schema(s, context)
        for s in schema['fields'].values():
            traverse_schema(s, context)
    elif schema_type == 'dataclass-args':
        if 'computed_fields' in schema:
            for s in schema['computed_fields']:
                traverse_schema(s, context)
        for s in schema['fields']:
            traverse_schema(s, context)
    elif schema_type == 'arguments':
        for s in schema['arguments_schema']:
            traverse_schema(s['schema'], context)
        if 'var_args_schema' in schema:
            traverse_schema(schema['var_args_schema'], context)
        if 'var_kwargs_schema' in schema:
            traverse_schema(schema['var_kwargs_schema'], context)
    elif schema_type == 'arguments-v3':
        for s in schema['arguments_schema']:
            traverse_schema(s['schema'], context)
    elif schema_type == 'call':
        traverse_schema(schema['arguments_schema'], context)
        if 'return_schema' in schema:
            traverse_schema(schema['return_schema'], context)
    elif schema_type == 'computed-field':
        traverse_schema(schema['return_schema'], context)
    elif schema_type == 'function-before':
        if 'schema' in schema:
            traverse_schema(schema['schema'], context)
        if 'json_schema_input_schema' in schema:
            traverse_schema(schema['json_schema_input_schema'], context)
    elif schema_type == 'function-plain':
        # TODO duplicate schema types for serializers and validators, needs to be deduplicated.
        if 'return_schema' in schema:
            traverse_schema(schema['return_schema'], context)
        if 'json_schema_input_schema' in schema:
            traverse_schema(schema['json_schema_input_schema'], context)
    elif schema_type == 'function-wrap':
        # TODO duplicate schema types for serializers and validators, needs to be deduplicated.
        if 'return_schema' in schema:
            traverse_schema(schema['return_schema'], context)
        if 'schema' in schema:
            traverse_schema(schema['schema'], context)
        if 'json_schema_input_schema' in schema:
            traverse_schema(schema['json_schema_input_schema'], context)
    else:
        if 'schema' in schema:
            traverse_schema(schema['schema'], context)

    if 'serialization' in schema:
        traverse_schema(schema['serialization'], context)
    traverse_metadata(schema, context)


def gather_schemas_for_cleaning(schema: CoreSchema, definitions: dict[str, CoreSchema]) -> GatherResult:
    """Traverse the core schema and definitions and return the necessary information for schema cleaning.

    During the core schema traversing, any `'definition-ref'` schema is:

    - Validated: the reference must point to an existing definition. If this is not the case, a
      `MissingDefinitionError` exception is raised.
    - Stored in the context: the actual reference is stored in the context. Depending on whether
      the `'definition-ref'` schema is encountered more that once, the schema itself is also
      saved in the context to be inlined (i.e. replaced by the definition it points to).
    """
    context = GatherContext(definitions)
    traverse_schema(schema, context)

    return {
        'collected_references': context.collected_references,
        'deferred_discriminator_schemas': context.deferred_discriminator_schemas,
    }
