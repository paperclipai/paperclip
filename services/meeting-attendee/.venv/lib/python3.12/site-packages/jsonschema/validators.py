"""
Creation and extension of validators, with implementations for existing drafts.
"""
from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Mapping, Sequence
from functools import lru_cache
from operator import methodcaller
from typing import TYPE_CHECKING
from urllib.parse import unquote, urldefrag, urljoin, urlsplit
from warnings import warn
import contextlib
import json
import reprlib
import warnings

from attrs import define, field, fields
from jsonschema_specifications import REGISTRY as SPECIFICATIONS
from rpds import HashTrieMap
import referencing.exceptions
import referencing.jsonschema

from jsonschema import (
    _format,
    _keywords,
    _legacy_keywords,
    _types,
    _typing,
    _utils,
    exceptions,
)

if TYPE_CHECKING:
    from jsonschema.protocols import Validator

_UNSET = _utils.Unset()

_VALIDATORS: dict[str, Validator] = {}
_META_SCHEMAS = _utils.URIDict()


def __getattr__(name):
    if name == "ErrorTree":
        warnings.warn(
            "Importing ErrorTree from jsonschema.validators is deprecated. "
            "Instead import it from jsonschema.exceptions.",
            DeprecationWarning,
            stacklevel=2,
        )
        from jsonschema.exceptions import ErrorTree
        return ErrorTree
    elif name == "validators":
        warnings.warn(
            "Accessing jsonschema.validators.validators is deprecated. "
            "Use jsonschema.validators.validator_for with a given schema.",
            DeprecationWarning,
            stacklevel=2,
        )
        return _VALIDATORS
    elif name == "meta_schemas":
        warnings.warn(
            "Accessing jsonschema.validators.meta_schemas is deprecated. "
            "Use jsonschema.validators.validator_for with a given schema.",
            DeprecationWarning,
            stacklevel=2,
        )
        return _META_SCHEMAS
    elif name == "RefResolver":
        warnings.warn(
            _RefResolver._DEPRECATION_MESSAGE,
            DeprecationWarning,
            stacklevel=2,
        )
        return _RefResolver
    raise AttributeError(f"module {__name__} has no attribute {name}")


def validates(version):
    """
    Register the decorated validator for a ``version`` of the specification.

    Registered validators and their meta schemas will be considered when
    parsing :kw:`$schema` keywords' URIs.

    Arguments:

        version (str):

            An identifier to use as the version's name

    Returns:

        collections.abc.Callable:

            a class decorator to decorate the validator with the version

    """

    def _validates(cls):
        _VALIDATORS[version] = cls
        meta_schema_id = cls.ID_OF(cls.META_SCHEMA)
        _META_SCHEMAS[meta_schema_id] = cls
        return cls
    return _validates


def _warn_for_remote_retrieve(uri: str):
    from urllib.request import Request, urlopen
    headers = {"User-Agent": "python-jsonschema (deprecated $ref resolution)"}
    request = Request(uri, headers=headers)  # noqa: S310
    with urlopen(request) as response:  # noqa: S310
        warnings.warn(
            "Automatically retrieving remote references can be a security "
            "vulnerability and is discouraged by the JSON Schema "
            "specifications. Relying on this behavior is deprecated "
            "and will shortly become an error. If you are sure you want to "
            "remotely retrieve your reference and that it is safe to do so, "
            "you can find instructions for doing so via referencing.Registry "
            "in the referencing documentation "
            "(https://referencing.readthedocs.org).",
            DeprecationWarning,
            stacklevel=9,  # Ha ha ha ha magic numbers :/
        )
        return referencing.Resource.from_contents(
            json.load(response),
            default_specification=referencing.jsonschema.DRAFT202012,
        )


_REMOTE_WARNING_REGISTRY = SPECIFICATIONS.combine(
    referencing.Registry(retrieve=_warn_for_remote_retrieve),  # type: ignore[call-arg]
)


def create(
    meta_schema: referencing.jsonschema.ObjectSchema,
    validators: (
        Mapping[str, _typing.SchemaKeywordValidator]
        | Iterable[tuple[str, _typing.SchemaKeywordValidator]]
    ) = (),
    version: str | None = None,
    type_checker: _types.TypeChecker = _types.draft202012_type_checker,
    format_checker: _format.FormatChecker = _format.draft202012_format_checker,
    id_of: _typing.id_of = referencing.jsonschema.DRAFT202012.id_of,
    applicable_validators: _typing.ApplicableValidators = methodcaller(
        "items",
    ),
) -> type[Validator]:
    """
    Create a new validator class.

    Arguments:

        meta_schema:

            the meta schema for the new validator class

        validators:

            a mapping from names to callables, where each callable will
            validate the schema property with the given name.

            Each callable should take 4 arguments:

                1. a validator instance,
                2. the value of the property being validated within the
                   instance
                3. the instance
                4. the schema

        version:

            an identifier for the version that this validator class will
            validate. If provided, the returned validator class will
            have its ``__name__`` set to include the version, and also
            will have `jsonschema.validators.validates` automatically
            called for the given version.

        type_checker:

            a type checker, used when applying the :kw:`type` keyword.

            If unprovided, a `jsonschema.TypeChecker` will be created
            with a set of default types typical of JSON Schema drafts.

        format_checker:

            a format checker, used when applying the :kw:`format` keyword.

            If unprovided, a `jsonschema.FormatChecker` will be created
            with a set of default formats typical of JSON Schema drafts.

        id_of:

            A function that given a schema, returns its ID.

        applicable_validators:

            A function that, given a schema, returns the list of
            applicable schema keywords and associated values
            which will be used to validate the instance.
            This is mostly used to support pre-draft 7 versions of JSON Schema
            which specified behavior around ignoring keywords if they were
            siblings of a ``$ref`` keyword. If you're not attempting to
            implement similar behavior, you can typically ignore this argument
            and leave it at its default.

    Returns:

        a new `jsonschema.protocols.Validator` class

    """
    # preemptively don't shadow the `Validator.format_checker` local
    format_checker_arg = format_checker

    specification = referencing.jsonschema.specification_with(
        dialect_id=id_of(meta_schema) or "urn:unknown-dialect",
        default=referencing.Specification.OPAQUE,
    )

    @define
    class Validator:

        VALIDATORS = dict(validators)  # noqa: RUF012
        META_SCHEMA = dict(meta_schema)  # noqa: RUF012
        TYPE_CHECKER = type_checker
        FORMAT_CHECKER = format_checker_arg
        ID_OF = staticmethod(id_of)

        _APPLICABLE_VALIDATORS = applicable_validators
        _validators = field(init=False, repr=False, eq=False)

        schema: referencing.jsonschema.Schema = field(repr=reprlib.repr)
        _ref_resolver = field(default=None, repr=False, alias="resolver")
        format_checker: _format.FormatChecker | None = field(default=None)
        # TODO: include new meta-schemas added at runtime
        _registry: referencing.jsonschema.SchemaRegistry = field(
            default=_REMOTE_WARNING_REGISTRY,
            kw_only=True,
            repr=False,
        )
        _resolver = field(
            alias="_resolver",
            default=None,
            kw_only=True,
            repr=False,
        )

        def __init_subclass__(cls):
            warnings.warn(
                (
                    "Subclassing validator classes is not intended to "
                    "be part of their public API. A future version "
                    "will make doing so an error, as the behavior of "
                    "subclasses isn't guaranteed to stay the same "
                    "between releases of jsonschema. Instead, prefer "
                    "composition of validators, wrapping them in an object "
                    "owned entirely by the downstream library."
                ),
                DeprecationWarning,
                stacklevel=2,
            )

            def evolve(self, **changes):
                cls = self.__class__
                schema = changes.setdefault("schema", self.schema)
                NewValidator = validator_for(schema, default=cls)

                for field in fields(cls):  # noqa: F402
                    if not field.init:
                        continue
                    attr_name = field.name
                    init_name = field.alias
                    if init_name not in changes:
                        changes[init_name] = getattr(self, attr_name)

                return NewValidator(**changes)

            cls.evolve = evolve

        def __attrs_post_init__(self):
            if self._resolver is None:
                registry = self._registry
                if registry is not _REMOTE_WARNING_REGISTRY:
                    registry = SPECIFICATIONS.combine(registry)
                resource = specification.create_resource(self.schema)
                self._resolver = registry.resolver_with_root(resource)

            if self.schema is True or self.schema is False:
                self._validators = []
            else:
                self._validators = [
                    (self.VALIDATORS[k], k, v)
                    for k, v in applicable_validators(self.schema)
                    if k in self.VALIDATORS
                ]

            # REMOVEME: Legacy ref resolution state management.
            push_scope = getattr(self._ref_resolver, "push_scope", None)
            if push_scope is not None:
                id = id_of(self.schema)
                if id is not None:
                    push_scope(id)

        @classmethod
        def check_schema(cls, schema, format_checker=_UNSET):
            Validator = validator_for(cls.META_SCHEMA, default=cls)
            if format_checker is _UNSET:
                format_checker = Validator.FORMAT_CHECKER
            validator = Validator(
                schema=cls.META_SCHEMA,
                format_checker=format_checker,
            )
            for error in validator.iter_errors(schema):
                raise exceptions.SchemaError.create_from(error)

        @property
        def resolver(self):
            warnings.warn(
                (
                    f"Accessing {self.__class__.__name__}.resolver is "
                    "deprecated as of v4.18.0, in favor of the "
                    "https://github.com/python-jsonschema/referencing "
                    "library, which provides more compliant referencing "
                    "behavior as well as more flexible APIs for "
                    "customization."
                ),
                DeprecationWarning,
                stacklevel=2,
            )
            if self._ref_resolver is None:
                self._ref_resolver = _RefResolver.from_schema(
                    self.schema,
                    id_of=id_of,
                )
            return self._ref_resolver

        def evolve(self, **changes):
            schema = changes.setdefault("schema", self.schema)
            NewValidator = validator_for(schema, default=self.__class__)

            for (attr_name, init_name) in evolve_fields:
                if init_name not in changes:
                    changes[init_name] = getattr(self, attr_name)

            return NewValidator(**changes)

        def iter_errors(self, instance, _schema=None):
            if _schema is not None:
                warnings.warn(
                    (
                        "Passing a schema to Validator.iter_errors "
                        "is deprecated and will be removed in a future "
                        "release. Call validator.evolve(schema=new_schema)."
                        "iter_errors(...) instead."
                    ),
                    DeprecationWarning,
                    stacklevel=2,
                )
                validators = [
                    (self.VALIDATORS[k], k, v)
                    for k, v in applicable_validators(_schema)
                    if k in self.VALIDATORS
                ]
            else:
                _schema, validators = self.schema, self._validators

            if _schema is True:
                return
            elif _schema is False:
                yield exceptions.ValidationError(
                    f"False schema does not allow {instance!r}",
                    validator=None,
                    validator_value=None,
                    instance=instance,
                    schema=_schema,
                )
                return

            for validator, k, v in validators:
                errors = validator(self, v, instance, _schema) or ()
                for error in errors:
                    # set details if not already set by the called fn
                    error._set(
                        validator=k,
                        validator_value=v,
                        instance=instance,
                        schema=_schema,
                        type_checker=self.TYPE_CHECKER,
                    )
                    if k not in {"if", "$ref"}:
                        error.schema_path.appendleft(k)
                    yield error

        def descend(
            self,
            instance,
            schema,
            path=None,
            schema_path=None,
            resolver=None,
        ):
            if schema is True:
                return
            elif schema is False:
                yield exceptions.ValidationError(
                    f"False schema does not allow {instance!r}",
                    validator=None,
                    validator_value=None,
                    instance=instance,
                    schema=schema,
                )
                return

            if self._ref_resolver is not None:
                evolved = self.evolve(schema=schema)
            else:
                if resolver is None:
                    resolver = self._resolver.in_subresource(
                        specification.create_resource(schema),
                    )
                evolved = self.evolve(schema=schema, _resolver=resolver)

            for k, v in applicable_validators(schema):
                validator = evolved.VALIDATORS.get(k)
                if validator is None:
                    continue

                errors = validator(evolved, v, instance, schema) or ()
                for error in errors:
                    # set details if not already set by the called fn
                    error._set(
                        validator=k,
                        validator_value=v,
                        instance=instance,
                        schema=schema,
                        type_checker=evolved.TYPE_CHECKER,
                    )
                    if k not in {"if", "$ref"}:
                        error.schema_path.appendleft(k)
                    if path is not None:
                        error.path.appendleft(path)
                    if schema_path is not None:
                        error.schema_path.appendleft(schema_path)
                    yield error

        def validate(self, *args, **kwargs):
            for error in self.iter_errors(*args, **kwargs):
                raise error

        def is_type(self, instance, type):
            try:
                return self.TYPE_CHECKER.is_type(instance, type)
            except exceptions.UndefinedTypeCheck:
                exc = exceptions.UnknownType(type, instance, self.schema)
                raise exc from None

        def _validate_reference(self, ref, instance):
            if self._ref_resolver is None:
                try:
                    resolved = self._resolver.lookup(ref)
                except referencing.exceptions.Unresolvable as err:
                    raise exceptions._WrappedReferencingError(err) from err

                return self.descend(
                    instance,
                    resolved.contents,
                    resolver=resolved.resolver,
                )
            else:
                resolve = getattr(self._ref_resolver, "resolve", None)
                if resolve is None:
                    with self._ref_resolver.resolving(ref) as resolved:
                        return self.descend(instance, resolved)
                else:
                    scope, resolved = resolve(ref)
                    self._ref_resolver.push_scope(scope)

                    try:
                        return list(self.descend(instance, resolved))
                    finally:
                        self._ref_resolver.pop_scope()

        def is_valid(self, instance, _schema=None):
            if _schema is not None:
                warnings.warn(
                    (
                        "Passing a schema to Validator.is_valid is deprecated "
                        "and will be removed in a future release. Call "
                        "validator.evolve(schema=new_schema).is_valid(...) "
                        "instead."
                    ),
                    DeprecationWarning,
                    stacklevel=2,
                )
                self = self.evolve(schema=_schema)

            error = next(self.iter_errors(instance), None)
            return error is None

    evolve_fields = [
        (field.name, field.alias)
        for field in fields(Validator)
        if field.init
    ]

    if version is not None:
        safe = version.title().replace(" ", "").replace("-", "")
        Validator.__name__ = Validator.__qualname__ = f"{safe}Validator"
        Validator = validates(version)(Validator)  # type: ignore[misc]

    return Validator  # type: ignore[return-value]


def extend(
    validator,
    validators=(),
    version=None,
    type_checker=None,
    format_checker=None,
):
    """
    Create a new validator class by extending an existing one.

    Arguments:

        validator (jsonschema.protocols.Validator):

            an existing validator class

        validators (collections.abc.Mapping):

            a mapping of new validator callables to extend with, whose
            structure is as in `create`.

            .. note::

                Any validator callables with the same name as an
                existing one will (silently) replace the old validator
                callable entirely, effectively overriding any validation
                done in the "parent" validator class.

                If you wish to instead extend the behavior of a parent's
                validator callable, delegate and call it directly in
                the new validator function by retrieving it using
                ``OldValidator.VALIDATORS["validation_keyword_name"]``.

        version (str):

            a version for the new validator class

        type_checker (jsonschema.TypeChecker):

            a type checker, used when applying the :kw:`type` keyword.

            If unprovided, the type checker of the extended
            `jsonschema.protocols.Validator` will be carried along.

        format_checker (jsonschema.FormatChecker):

            a format checker, used when applying the :kw:`format` keyword.

            If unprovided, the format checker of the extended
            `jsonschema.protocols.Validator` will be carried along.

    Returns:

        a new `jsonschema.protocols.Validator` class extending the one
        provided

    .. note:: Meta Schemas

        The new validator class will have its parent's meta schema.

        If you wish to change or extend the meta schema in the new
        validator class, modify ``META_SCHEMA`` directly on the returned
        class. Note that no implicit copying is done, so a copy should
        likely be made before modifying it, in order to not affect the
        old validator.

    """
    all_validators = dict(validator.VALIDATORS)
    all_validators.update(validators)

    if type_checker is None:
        type_checker = validator.TYPE_CHECKER
    if format_checker is None:
        format_checker = validator.FORMAT_CHECKER
    return create(
        meta_schema=validator.META_SCHEMA,
        validators=all_validators,
        version=version,
        type_checker=type_checker,
        format_checker=format_checker,
        id_of=validator.ID_OF,
        applicable_validators=validator._APPLICABLE_VALIDATORS,
    )


Draft3Validator = create(
    meta_schema=SPECIFICATIONS.contents(
        "http://json-schema.org/draft-03/schema#",
    ),
    validators={
        "$ref": _keywords.ref,
        "additionalItems": _legacy_keywords.additionalItems,
        "additionalProperties": _keywords.additionalProperties,
        "dependencies": _legacy_keywords.dependencies_draft3,
        "disallow": _legacy_keywords.disallow_draft3,
        "divisibleBy": _keywords.multipleOf,
        "enum": _keywords.enum,
        "extends": _legacy_keywords.extends_draft3,
        "format": _keywords.format,
        "items": _legacy_keywords.items_draft3_draft4,
        "maxItems": _keywords.maxItems,
        "maxLength": _keywords.maxLength,
        "maximum": _legacy_keywords.maximum_draft3_draft4,
        "minItems": _keywords.minItems,
        "minLength": _keywords.minLength,
        "minimum": _legacy_keywords.minimum_draft3_draft4,
        "pattern": _keywords.pattern,
        "patternProperties": _keywords.patternProperties,
        "properties": _legacy_keywords.properties_draft3,
        "type": _legacy_keywords.type_draft3,
        "uniqueItems": _keywords.uniqueItems,
    },
    type_checker=_types.draft3_type_checker,
    format_checker=_format.draft3_format_checker,
    version="draft3",
    id_of=referencing.jsonschema.DRAFT3.id_of,
    applicable_validators=_legacy_keywords.ignore_ref_siblings,
)

Draft4Validator = create(
    meta_schema=SPECIFICATIONS.contents(
        "http://json-schema.org/draft-04/schema#",
    ),
    validators={
        "$ref": _keywords.ref,
        "additionalItems": _legacy_keywords.additionalItems,
        "additionalProperties": _keywords.additionalProperties,
        "allOf": _keywords.allOf,
        "anyOf": _keywords.anyOf,
        "dependencies": _legacy_keywords.dependencies_draft4_draft6_draft7,
        "enum": _keywords.enum,
        "format": _keywords.format,
        "items": _legacy_keywords.items_draft3_draft4,
        "maxItems": _keywords.maxItems,
        "maxLength": _keywords.maxLength,
        "maxProperties": _keywords.maxProperties,
        "maximum": _legacy_keywords.maximum_draft3_draft4,
        "minItems": _keywords.minItems,
        "minLength": _keywords.minLength,
        "minProperties": _keywords.minProperties,
        "minimum": _legacy_keywords.minimum_draft3_draft4,
        "multipleOf": _keywords.multipleOf,
        "not": _keywords.not_,
        "oneOf": _keywords.oneOf,
        "pattern": _keywords.pattern,
        "patternProperties": _keywords.patternProperties,
        "properties": _keywords.properties,
        "required": _keywords.required,
        "type": _keywords.type,
        "uniqueItems": _keywords.uniqueItems,
    },
    type_checker=_types.draft4_type_checker,
    format_checker=_format.draft4_format_checker,
    version="draft4",
    id_of=referencing.jsonschema.DRAFT4.id_of,
    applicable_validators=_legacy_keywords.ignore_ref_siblings,
)

Draft6Validator = create(
    meta_schema=SPECIFICATIONS.contents(
        "http://json-schema.org/draft-06/schema#",
    ),
    validators={
        "$ref": _keywords.ref,
        "additionalItems": _legacy_keywords.additionalItems,
        "additionalProperties": _keywords.additionalProperties,
        "allOf": _keywords.allOf,
        "anyOf": _keywords.anyOf,
        "const": _keywords.const,
        "contains": _legacy_keywords.contains_draft6_draft7,
        "dependencies": _legacy_keywords.dependencies_draft4_draft6_draft7,
        "enum": _keywords.enum,
        "exclusiveMaximum": _keywords.exclusiveMaximum,
        "exclusiveMinimum": _keywords.exclusiveMinimum,
        "format": _keywords.format,
        "items": _legacy_keywords.items_draft6_draft7_draft201909,
        "maxItems": _keywords.maxItems,
        "maxLength": _keywords.maxLength,
        "maxProperties": _keywords.maxProperties,
        "maximum": _keywords.maximum,
        "minItems": _keywords.minItems,
        "minLength": _keywords.minLength,
        "minProperties": _keywords.minProperties,
        "minimum": _keywords.minimum,
        "multipleOf": _keywords.multipleOf,
        "not": _keywords.not_,
        "oneOf": _keywords.oneOf,
        "pattern": _keywords.pattern,
        "patternProperties": _keywords.patternProperties,
        "properties": _keywords.properties,
        "propertyNames": _keywords.propertyNames,
        "required": _keywords.required,
        "type": _keywords.type,
        "uniqueItems": _keywords.uniqueItems,
    },
    type_checker=_types.draft6_type_checker,
    format_checker=_format.draft6_format_checker,
    version="draft6",
    id_of=referencing.jsonschema.DRAFT6.id_of,
    applicable_validators=_legacy_keywords.ignore_ref_siblings,
)

Draft7Validator = create(
    meta_schema=SPECIFICATIONS.contents(
        "http://json-schema.org/draft-07/schema#",
    ),
    validators={
        "$ref": _keywords.ref,
        "additionalItems": _legacy_keywords.additionalItems,
        "additionalProperties": _keywords.additionalProperties,
        "allOf": _keywords.allOf,
        "anyOf": _keywords.anyOf,
        "const": _keywords.const,
        "contains": _legacy_keywords.contains_draft6_draft7,
        "dependencies": _legacy_keywords.dependencies_draft4_draft6_draft7,
        "enum": _keywords.enum,
        "exclusiveMaximum": _keywords.exclusiveMaximum,
        "exclusiveMinimum": _keywords.exclusiveMinimum,
        "format": _keywords.format,
        "if": _keywords.if_,
        "items": _legacy_keywords.items_draft6_draft7_draft201909,
        "maxItems": _keywords.maxItems,
        "maxLength": _keywords.maxLength,
        "maxProperties": _keywords.maxProperties,
        "maximum": _keywords.maximum,
        "minItems": _keywords.minItems,
        "minLength": _keywords.minLength,
        "minProperties": _keywords.minProperties,
        "minimum": _keywords.minimum,
        "multipleOf": _keywords.multipleOf,
        "not": _keywords.not_,
        "oneOf": _keywords.oneOf,
        "pattern": _keywords.pattern,
        "patternProperties": _keywords.patternProperties,
        "properties": _keywords.properties,
        "propertyNames": _keywords.propertyNames,
        "required": _keywords.required,
        "type": _keywords.type,
        "uniqueItems": _keywords.uniqueItems,
    },
    type_checker=_types.draft7_type_checker,
    format_checker=_format.draft7_format_checker,
    version="draft7",
    id_of=referencing.jsonschema.DRAFT7.id_of,
    applicable_validators=_legacy_keywords.ignore_ref_siblings,
)

Draft201909Validator = create(
    meta_schema=SPECIFICATIONS.contents(
        "https://json-schema.org/draft/2019-09/schema",
    ),
    validators={
        "$recursiveRef": _legacy_keywords.recursiveRef,
        "$ref": _keywords.ref,
        "additionalItems": _legacy_keywords.additionalItems,
        "additionalProperties": _keywords.additionalProperties,
        "allOf": _keywords.allOf,
        "anyOf": _keywords.anyOf,
        "const": _keywords.const,
        "contains": _keywords.contains,
        "dependentRequired": _keywords.dependentRequired,
        "dependentSchemas": _keywords.dependentSchemas,
        "enum": _keywords.enum,
        "exclusiveMaximum": _keywords.exclusiveMaximum,
        "exclusiveMinimum": _keywords.exclusiveMinimum,
        "format": _keywords.format,
        "if": _keywords.if_,
        "items": _legacy_keywords.items_draft6_draft7_draft201909,
        "maxItems": _keywords.maxItems,
        "maxLength": _keywords.maxLength,
        "maxProperties": _keywords.maxProperties,
        "maximum": _keywords.maximum,
        "minItems": _keywords.minItems,
        "minLength": _keywords.minLength,
        "minProperties": _keywords.minProperties,
        "minimum": _keywords.minimum,
        "multipleOf": _keywords.multipleOf,
        "not": _keywords.not_,
        "oneOf": _keywords.oneOf,
        "pattern": _keywords.pattern,
        "patternProperties": _keywords.patternProperties,
        "properties": _keywords.properties,
        "propertyNames": _keywords.propertyNames,
        "required": _keywords.required,
        "type": _keywords.type,
        "unevaluatedItems": _legacy_keywords.unevaluatedItems_draft2019,
        "unevaluatedProperties": (
            _legacy_keywords.unevaluatedProperties_draft2019
        ),
        "uniqueItems": _keywords.uniqueItems,
    },
    type_checker=_types.draft201909_type_checker,
    format_checker=_format.draft201909_format_checker,
    version="draft2019-09",
)

Draft202012Validator = create(
    meta_schema=SPECIFICATIONS.contents(
        "https://json-schema.org/draft/2020-12/schema",
    ),
    validators={
        "$dynamicRef": _keywords.dynamicRef,
        "$ref": _keywords.ref,
        "additionalProperties": _keywords.additionalProperties,
        "allOf": _keywords.allOf,
        "anyOf": _keywords.anyOf,
        "const": _keywords.const,
        "contains": _keywords.contains,
        "dependentRequired": _keywords.dependentRequired,
        "dependentSchemas": _keywords.dependentSchemas,
        "enum": _keywords.enum,
        "exclusiveMaximum": _keywords.exclusiveMaximum,
        "exclusiveMinimum": _keywords.exclusiveMinimum,
        "format": _keywords.format,
        "if": _keywords.if_,
        "items": _keywords.items,
        "maxItems": _keywords.maxItems,
        "maxLength": _keywords.maxLength,
        "maxProperties": _keywords.maxProperties,
        "maximum": _keywords.maximum,
        "minItems": _keywords.minItems,
        "minLength": _keywords.minLength,
        "minProperties": _keywords.minProperties,
        "minimum": _keywords.minimum,
        "multipleOf": _keywords.multipleOf,
        "not": _keywords.not_,
        "oneOf": _keywords.oneOf,
        "pattern": _keywords.pattern,
        "patternProperties": _keywords.patternProperties,
        "prefixItems": _keywords.prefixItems,
        "properties": _keywords.properties,
        "propertyNames": _keywords.propertyNames,
        "required": _keywords.required,
        "type": _keywords.type,
        "unevaluatedItems": _keywords.unevaluatedItems,
        "unevaluatedProperties": _keywords.unevaluatedProperties,
        "uniqueItems": _keywords.uniqueItems,
    },
    type_checker=_types.draft202012_type_checker,
    format_checker=_format.draft202012_format_checker,
    version="draft2020-12",
)

_LATEST_VERSION: type[Validator] = Draft202012Validator


class _RefResolver:
    """
    Resolve JSON References.

    Arguments:

        base_uri (str):

            The URI of the referring document

        referrer:

            The actual referring document

        store (dict):

            A mapping from URIs to documents to cache

        cache_remote (bool):

            Whether remote refs should be cached after first resolution

        handlers (dict):

            A mapping from URI schemes to functions that should be used
            to retrieve them

        urljoin_cache (:func:`functools.lru_cache`):

            A cache that will be used for caching the results of joining
            the resolution scope to subscopes.

        remote_cache (:func:`functools.lru_cache`):

            A cache that will be used for caching the results of
            resolved remote URLs.

    Attributes:

        cache_remote (bool):

            Whether remote refs should be cached after first resolution

    .. deprecated:: v4.18.0

        ``RefResolver`` has been deprecated in favor of `referencing`.

    """

    _DEPRECATION_MESSAGE = (
        "jsonschema.RefResolver is deprecated as of v4.18.0, in favor of the "
        "https://github.com/python-jsonschema/referencing library, which "
        "provides more compliant referencing behavior as well as more "
        "flexible APIs for customization. A future release will remove "
        "RefResolver. Please file a feature request (on referencing) if you "
        "are missing an API for the kind of customization you need."
    )

    def __init__(
        self,
        base_uri,
        referrer,
        store=HashTrieMap(),
        cache_remote=True,
        handlers=(),
        urljoin_cache=None,
        remote_cache=None,
    ):
        if urljoin_cache is None:
            urljoin_cache = lru_cache(1024)(urljoin)
        if remote_cache is None:
            remote_cache = lru_cache(1024)(self.resolve_from_url)

        self.referrer = referrer
        self.cache_remote = cache_remote
        self.handlers = dict(handlers)

        self._scopes_stack = [base_uri]

        self.store = _utils.URIDict(
            (uri, each.contents) for uri, each in SPECIFICATIONS.items()
        )
        self.store.update(
            (id, each.META_SCHEMA) for id, each in _META_SCHEMAS.items()
        )
        self.store.update(store)
        self.store.update(
            (schema["$id"], schema)
            for schema in store.values()
            if isinstance(schema, Mapping) and "$id" in schema
        )
        self.store[base_uri] = referrer

        self._urljoin_cache = urljoin_cache
        self._remote_cache = remote_cache

    @classmethod
    def from_schema(  # noqa: D417
        cls,
        schema,
        id_of=referencing.jsonschema.DRAFT202012.id_of,
        *args,
        **kwargs,
    ):
        """
        Construct a resolver from a JSON schema object.

        Arguments:

            schema:

                the referring schema

        Returns:

            `_RefResolver`

        """
        return cls(base_uri=id_of(schema) or "", referrer=schema, *args, **kwargs)  # noqa: B026, E501

    def push_scope(self, scope):
        """
        Enter a given sub-scope.

        Treats further dereferences as being performed underneath the
        given scope.
        """
        self._scopes_stack.append(
            self._urljoin_cache(self.resolution_scope, scope),
        )

    def pop_scope(self):
        """
        Exit the most recent entered scope.

        Treats further dereferences as being performed underneath the
        original scope.

        Don't call this method more times than `push_scope` has been
        called.
        """
        try:
            self._scopes_stack.pop()
        except IndexError:
            raise exceptions._RefResolutionError(
                "Failed to pop the scope from an empty stack. "
                "`pop_scope()` should only be called once for every "
                "`push_scope()`",
            ) from None

    @property
    def resolution_scope(self):
        """
        Retrieve the current resolution scope.
        """
        return self._scopes_stack[-1]

    @property
    def base_uri(self):
        """
        Retrieve the current base URI, not including any fragment.
        """
        uri, _ = urldefrag(self.resolution_scope)
        return uri

    @contextlib.contextmanager
    def in_scope(self, scope):
        """
        Temporarily enter the given scope for the duration of the context.

        .. deprecated:: v4.0.0
        """
        warnings.warn(
            "jsonschema.RefResolver.in_scope is deprecated and will be "
            "removed in a future release.",
            DeprecationWarning,
            stacklevel=3,
        )
        self.push_scope(scope)
        try:
            yield
        finally:
            self.pop_scope()

    @contextlib.contextmanager
    def resolving(self, ref):
        """
        Resolve the given ``ref`` and enter its resolution scope.

        Exits the scope on exit of this context manager.

        Arguments:

            ref (str):

                The reference to resolve

        """
        url, resolved = self.resolve(ref)
        self.push_scope(url)
        try:
            yield resolved
        finally:
            self.pop_scope()

    def _find_in_referrer(self, key):
        return self._get_subschemas_cache()[key]

    @lru_cache  # noqa: B019
    def _get_subschemas_cache(self):
        cache = {key: [] for key in _SUBSCHEMAS_KEYWORDS}
        for keyword, subschema in _search_schema(
            self.referrer, _match_subschema_keywords,
        ):
            cache[keyword].append(subschema)
        return cache

    @lru_cache  # noqa: B019
    def _find_in_subschemas(self, url):
        subschemas = self._get_subschemas_cache()["$id"]
        if not subschemas:
            return None
        uri, fragment = urldefrag(url)
        for subschema in subschemas:
            id = subschema["$id"]
            if not isinstance(id, str):
                continue
            target_uri = self._urljoin_cache(self.resolution_scope, id)
            if target_uri.rstrip("/") == uri.rstrip("/"):
                if fragment:
                    subschema = self.resolve_fragment(subschema, fragment)
                self.store[url] = subschema
                return url, subschema
        return None

    def resolve(self, ref):
        """
        Resolve the given reference.
        """
        url = self._urljoin_cache(self.resolution_scope, ref).rstrip("/")

        match = self._find_in_subschemas(url)
        if match is not None:
            return match

        return url, self._remote_cache(url)

    def resolve_from_url(self, url):
        """
        Resolve the given URL.
        """
        url, fragment = urldefrag(url)
        if not url:
            url = self.base_uri

        try:
            document = self.store[url]
        except KeyError:
            try:
                document = self.resolve_remote(url)
            except Exception as exc:
                raise exceptions._RefResolutionError(exc) from exc

        return self.resolve_fragment(document, fragment)

    def resolve_fragment(self, document, fragment):
        """
        Resolve a ``fragment`` within the referenced ``document``.

        Arguments:

            document:

                The referent document

            fragment (str):

                a URI fragment to resolve within it

        """
        fragment = fragment.lstrip("/")

        if not fragment:
            return document

        if document is self.referrer:
            find = self._find_in_referrer
        else:

            def find(key):
                yield from _search_schema(document, _match_keyword(key))

        for keyword in ["$anchor", "$dynamicAnchor"]:
            for subschema in find(keyword):
                if fragment == subschema[keyword]:
                    return subschema
        for keyword in ["id", "$id"]:
            for subschema in find(keyword):
                if "#" + fragment == subschema[keyword]:
                    return subschema

        # Resolve via path
        parts = unquote(fragment).split("/") if fragment else []
        for part in parts:
            part = part.replace("~1", "/").replace("~0", "~")

            if isinstance(document, Sequence):
                try:  # noqa: SIM105
                    part = int(part)
                except ValueError:
                    pass
            try:
                document = document[part]
            except (TypeError, LookupError) as err:
                raise exceptions._RefResolutionError(
                    f"Unresolvable JSON pointer: {fragment!r}",
                ) from err

        return document

    def resolve_remote(self, uri):
        """
        Resolve a remote ``uri``.

        If called directly, does not check the store first, but after
        retrieving the document at the specified URI it will be saved in
        the store if :attr:`cache_remote` is True.

        .. note::

            If the requests_ library is present, ``jsonschema`` will use it to
            request the remote ``uri``, so that the correct encoding is
            detected and used.

            If it isn't, or if the scheme of the ``uri`` is not ``http`` or
            ``https``, UTF-8 is assumed.

        Arguments:

            uri (str):

                The URI to resolve

        Returns:

            The retrieved document

        .. _requests: https://pypi.org/project/requests/

        """
        try:
            import requests
        except ImportError:
            requests = None

        scheme = urlsplit(uri).scheme

        if scheme in self.handlers:
            result = self.handlers[scheme](uri)
        elif scheme in ["http", "https"] and requests:
            # Requests has support for detecting the correct encoding of
            # json over http
            result = requests.get(uri).json()
        else:
            # Otherwise, pass off to urllib and assume utf-8
            from urllib.request import urlopen
            with urlopen(uri) as url:  # noqa: S310
                result = json.loads(url.read().decode("utf-8"))

        if self.cache_remote:
            self.store[uri] = result
        return result


_SUBSCHEMAS_KEYWORDS = ("$id", "id", "$anchor", "$dynamicAnchor")


def _match_keyword(keyword):

    def matcher(value):
        if keyword in value:
            yield value

    return matcher


def _match_subschema_keywords(value):
    for keyword in _SUBSCHEMAS_KEYWORDS:
        if keyword in value:
            yield keyword, value


def _search_schema(schema, matcher):
    """Breadth-first search routine."""
    values = deque([schema])
    while values:
        value = values.pop()
        if not isinstance(value, dict):
            continue
        yield from matcher(value)
        values.extendleft(value.values())


def validate(instance, schema, cls=None, *args, **kwargs):  # noqa: D417
    """
    Validate an instance under the given schema.

        >>> validate([2, 3, 4], {"maxItems": 2})
        Traceback (most recent call last):
            ...
        ValidationError: [2, 3, 4] is too long

    :func:`~jsonschema.validators.validate` will first verify that the
    provided schema is itself valid, since not doing so can lead to less
    obvious error messages and fail in less obvious or consistent ways.

    If you know you have a valid schema already, especially
    if you intend to validate multiple instances with
    the same schema, you likely would prefer using the
    `jsonschema.protocols.Validator.validate` method directly on a
    specific validator (e.g. ``Draft202012Validator.validate``).


    Arguments:

        instance:

            The instance to validate

        schema:

            The schema to validate with

        cls (jsonschema.protocols.Validator):

            The class that will be used to validate the instance.

    If the ``cls`` argument is not provided, two things will happen
    in accordance with the specification. First, if the schema has a
    :kw:`$schema` keyword containing a known meta-schema [#]_ then the
    proper validator will be used. The specification recommends that
    all schemas contain :kw:`$schema` properties for this reason. If no
    :kw:`$schema` property is found, the default validator class is the
    latest released draft.

    Any other provided positional and keyword arguments will be passed
    on when instantiating the ``cls``.

    Raises:

        `jsonschema.exceptions.ValidationError`:

            if the instance is invalid

        `jsonschema.exceptions.SchemaError`:

            if the schema itself is invalid

    .. rubric:: Footnotes
    .. [#] known by a validator registered with
        `jsonschema.validators.validates`

    """
    if cls is None:
        cls = validator_for(schema)

    cls.check_schema(schema)
    validator = cls(schema, *args, **kwargs)
    error = exceptions.best_match(validator.iter_errors(instance))
    if error is not None:
        raise error


def validator_for(
    schema,
    default: type[Validator] | _utils.Unset = _UNSET,
) -> type[Validator]:
    """
    Retrieve the validator class appropriate for validating the given schema.

    Uses the :kw:`$schema` keyword that should be present in the given
    schema to look up the appropriate validator class.

    Arguments:

        schema (collections.abc.Mapping or bool):

            the schema to look at

        default:

            the default to return if the appropriate validator class
            cannot be determined.

            If unprovided, the default is to return the latest supported
            draft.

    Examples:

        The :kw:`$schema` JSON Schema keyword will control which validator
        class is returned:

        >>> schema = {
        ...     "$schema": "https://json-schema.org/draft/2020-12/schema",
        ...     "type": "integer",
        ... }
        >>> jsonschema.validators.validator_for(schema)
        <class 'jsonschema.validators.Draft202012Validator'>


        Here, a draft 7 schema instead will return the draft 7 validator:

        >>> schema = {
        ...     "$schema": "http://json-schema.org/draft-07/schema#",
        ...     "type": "integer",
        ... }
        >>> jsonschema.validators.validator_for(schema)
        <class 'jsonschema.validators.Draft7Validator'>


        Schemas with no ``$schema`` keyword will fallback to the default
        argument:

        >>> schema = {"type": "integer"}
        >>> jsonschema.validators.validator_for(
        ...     schema, default=Draft7Validator,
        ... )
        <class 'jsonschema.validators.Draft7Validator'>

        or if none is provided, to the latest version supported.
        Always including the keyword when authoring schemas is highly
        recommended.

    """
    DefaultValidator = _LATEST_VERSION if default is _UNSET else default

    if schema is True or schema is False or "$schema" not in schema:
        return DefaultValidator  # type: ignore[return-value]
    if schema["$schema"] not in _META_SCHEMAS and default is _UNSET:
        warn(
            (
                "The metaschema specified by $schema was not found. "
                "Using the latest draft to validate, but this will raise "
                "an error in the future."
            ),
            DeprecationWarning,
            stacklevel=2,
        )
    return _META_SCHEMAS.get(schema["$schema"], DefaultValidator)
