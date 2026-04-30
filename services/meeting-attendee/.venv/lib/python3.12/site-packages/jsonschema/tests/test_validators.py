from __future__ import annotations

from collections import deque, namedtuple
from contextlib import contextmanager
from decimal import Decimal
from io import BytesIO
from typing import Any
from unittest import TestCase, mock
from urllib.request import pathname2url
import json
import os
import sys
import tempfile
import warnings

from attrs import define, field
from referencing.jsonschema import DRAFT202012
import referencing.exceptions

from jsonschema import (
    FormatChecker,
    TypeChecker,
    exceptions,
    protocols,
    validators,
)


def fail(validator, errors, instance, schema):
    for each in errors:
        each.setdefault("message", "You told me to fail!")
        yield exceptions.ValidationError(**each)


class TestCreateAndExtend(TestCase):
    def setUp(self):
        self.addCleanup(
            self.assertEqual,
            validators._META_SCHEMAS,
            dict(validators._META_SCHEMAS),
        )
        self.addCleanup(
            self.assertEqual,
            validators._VALIDATORS,
            dict(validators._VALIDATORS),
        )

        self.meta_schema = {"$id": "some://meta/schema"}
        self.validators = {"fail": fail}
        self.type_checker = TypeChecker()
        self.Validator = validators.create(
            meta_schema=self.meta_schema,
            validators=self.validators,
            type_checker=self.type_checker,
        )

    def test_attrs(self):
        self.assertEqual(
            (
                self.Validator.VALIDATORS,
                self.Validator.META_SCHEMA,
                self.Validator.TYPE_CHECKER,
            ), (
                self.validators,
                self.meta_schema,
                self.type_checker,
            ),
        )

    def test_init(self):
        schema = {"fail": []}
        self.assertEqual(self.Validator(schema).schema, schema)

    def test_iter_errors_successful(self):
        schema = {"fail": []}
        validator = self.Validator(schema)

        errors = list(validator.iter_errors("hello"))
        self.assertEqual(errors, [])

    def test_iter_errors_one_error(self):
        schema = {"fail": [{"message": "Whoops!"}]}
        validator = self.Validator(schema)

        expected_error = exceptions.ValidationError(
            "Whoops!",
            instance="goodbye",
            schema=schema,
            validator="fail",
            validator_value=[{"message": "Whoops!"}],
            schema_path=deque(["fail"]),
        )

        errors = list(validator.iter_errors("goodbye"))
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]._contents(), expected_error._contents())

    def test_iter_errors_multiple_errors(self):
        schema = {
            "fail": [
                {"message": "First"},
                {"message": "Second!", "validator": "asdf"},
                {"message": "Third"},
            ],
        }
        validator = self.Validator(schema)

        errors = list(validator.iter_errors("goodbye"))
        self.assertEqual(len(errors), 3)

    def test_if_a_version_is_provided_it_is_registered(self):
        Validator = validators.create(
            meta_schema={"$id": "something"},
            version="my version",
        )
        self.addCleanup(validators._META_SCHEMAS.pop, "something")
        self.addCleanup(validators._VALIDATORS.pop, "my version")
        self.assertEqual(Validator.__name__, "MyVersionValidator")
        self.assertEqual(Validator.__qualname__, "MyVersionValidator")

    def test_repr(self):
        Validator = validators.create(
            meta_schema={"$id": "something"},
            version="my version",
        )
        self.addCleanup(validators._META_SCHEMAS.pop, "something")
        self.addCleanup(validators._VALIDATORS.pop, "my version")
        self.assertEqual(
            repr(Validator({})),
            "MyVersionValidator(schema={}, format_checker=None)",
        )

    def test_long_repr(self):
        Validator = validators.create(
            meta_schema={"$id": "something"},
            version="my version",
        )
        self.addCleanup(validators._META_SCHEMAS.pop, "something")
        self.addCleanup(validators._VALIDATORS.pop, "my version")
        self.assertEqual(
            repr(Validator({"a": list(range(1000))})), (
                "MyVersionValidator(schema={'a': [0, 1, 2, 3, 4, 5, ...]}, "
                "format_checker=None)"
            ),
        )

    def test_repr_no_version(self):
        Validator = validators.create(meta_schema={})
        self.assertEqual(
            repr(Validator({})),
            "Validator(schema={}, format_checker=None)",
        )

    def test_dashes_are_stripped_from_validator_names(self):
        Validator = validators.create(
            meta_schema={"$id": "something"},
            version="foo-bar",
        )
        self.addCleanup(validators._META_SCHEMAS.pop, "something")
        self.addCleanup(validators._VALIDATORS.pop, "foo-bar")
        self.assertEqual(Validator.__qualname__, "FooBarValidator")

    def test_if_a_version_is_not_provided_it_is_not_registered(self):
        original = dict(validators._META_SCHEMAS)
        validators.create(meta_schema={"id": "id"})
        self.assertEqual(validators._META_SCHEMAS, original)

    def test_validates_registers_meta_schema_id(self):
        meta_schema_key = "meta schema id"
        my_meta_schema = {"id": meta_schema_key}

        validators.create(
            meta_schema=my_meta_schema,
            version="my version",
            id_of=lambda s: s.get("id", ""),
        )
        self.addCleanup(validators._META_SCHEMAS.pop, meta_schema_key)
        self.addCleanup(validators._VALIDATORS.pop, "my version")

        self.assertIn(meta_schema_key, validators._META_SCHEMAS)

    def test_validates_registers_meta_schema_draft6_id(self):
        meta_schema_key = "meta schema $id"
        my_meta_schema = {"$id": meta_schema_key}

        validators.create(
            meta_schema=my_meta_schema,
            version="my version",
        )
        self.addCleanup(validators._META_SCHEMAS.pop, meta_schema_key)
        self.addCleanup(validators._VALIDATORS.pop, "my version")

        self.assertIn(meta_schema_key, validators._META_SCHEMAS)

    def test_create_default_types(self):
        Validator = validators.create(meta_schema={}, validators=())
        self.assertTrue(
            all(
                Validator({}).is_type(instance=instance, type=type)
                for type, instance in [
                    ("array", []),
                    ("boolean", True),
                    ("integer", 12),
                    ("null", None),
                    ("number", 12.0),
                    ("object", {}),
                    ("string", "foo"),
                ]
            ),
        )

    def test_check_schema_with_different_metaschema(self):
        """
        One can create a validator class whose metaschema uses a different
        dialect than itself.
        """

        NoEmptySchemasValidator = validators.create(
            meta_schema={
                "$schema": validators.Draft202012Validator.META_SCHEMA["$id"],
                "not": {"const": {}},
            },
        )
        NoEmptySchemasValidator.check_schema({"foo": "bar"})

        with self.assertRaises(exceptions.SchemaError):
            NoEmptySchemasValidator.check_schema({})

        NoEmptySchemasValidator({"foo": "bar"}).validate("foo")

    def test_check_schema_with_different_metaschema_defaults_to_self(self):
        """
        A validator whose metaschema doesn't declare $schema defaults to its
        own validation behavior, not the latest "normal" specification.
        """

        NoEmptySchemasValidator = validators.create(
            meta_schema={"fail": [{"message": "Meta schema whoops!"}]},
            validators={"fail": fail},
        )
        with self.assertRaises(exceptions.SchemaError):
            NoEmptySchemasValidator.check_schema({})

    def test_extend(self):
        original = dict(self.Validator.VALIDATORS)
        new = object()

        Extended = validators.extend(
            self.Validator,
            validators={"new": new},
        )
        self.assertEqual(
            (
                Extended.VALIDATORS,
                Extended.META_SCHEMA,
                Extended.TYPE_CHECKER,
                self.Validator.VALIDATORS,
            ), (
                dict(original, new=new),
                self.Validator.META_SCHEMA,
                self.Validator.TYPE_CHECKER,
                original,
            ),
        )

    def test_extend_idof(self):
        """
        Extending a validator preserves its notion of schema IDs.
        """
        def id_of(schema):
            return schema.get("__test__", self.Validator.ID_OF(schema))
        correct_id = "the://correct/id/"
        meta_schema = {
            "$id": "the://wrong/id/",
            "__test__": correct_id,
        }
        Original = validators.create(
            meta_schema=meta_schema,
            validators=self.validators,
            type_checker=self.type_checker,
            id_of=id_of,
        )
        self.assertEqual(Original.ID_OF(Original.META_SCHEMA), correct_id)

        Derived = validators.extend(Original)
        self.assertEqual(Derived.ID_OF(Derived.META_SCHEMA), correct_id)

    def test_extend_applicable_validators(self):
        """
        Extending a validator preserves its notion of applicable validators.
        """

        schema = {
            "$defs": {"test": {"type": "number"}},
            "$ref": "#/$defs/test",
            "maximum": 1,
        }

        draft4 = validators.Draft4Validator(schema)
        self.assertTrue(draft4.is_valid(37))  # as $ref ignores siblings

        Derived = validators.extend(validators.Draft4Validator)
        self.assertTrue(Derived(schema).is_valid(37))


class TestValidationErrorMessages(TestCase):
    def message_for(self, instance, schema, *args, **kwargs):
        cls = kwargs.pop("cls", validators._LATEST_VERSION)
        cls.check_schema(schema)
        validator = cls(schema, *args, **kwargs)
        errors = list(validator.iter_errors(instance))
        self.assertTrue(errors, msg=f"No errors were raised for {instance!r}")
        self.assertEqual(
            len(errors),
            1,
            msg=f"Expected exactly one error, found {errors!r}",
        )
        return errors[0].message

    def test_single_type_failure(self):
        message = self.message_for(instance=1, schema={"type": "string"})
        self.assertEqual(message, "1 is not of type 'string'")

    def test_single_type_list_failure(self):
        message = self.message_for(instance=1, schema={"type": ["string"]})
        self.assertEqual(message, "1 is not of type 'string'")

    def test_multiple_type_failure(self):
        types = "string", "object"
        message = self.message_for(instance=1, schema={"type": list(types)})
        self.assertEqual(message, "1 is not of type 'string', 'object'")

    def test_object_with_named_type_failure(self):
        schema = {"type": [{"name": "Foo", "minimum": 3}]}
        message = self.message_for(
            instance=1,
            schema=schema,
            cls=validators.Draft3Validator,
        )
        self.assertEqual(message, "1 is not of type 'Foo'")

    def test_minimum(self):
        message = self.message_for(instance=1, schema={"minimum": 2})
        self.assertEqual(message, "1 is less than the minimum of 2")

    def test_maximum(self):
        message = self.message_for(instance=1, schema={"maximum": 0})
        self.assertEqual(message, "1 is greater than the maximum of 0")

    def test_dependencies_single_element(self):
        depend, on = "bar", "foo"
        schema = {"dependencies": {depend: on}}
        message = self.message_for(
            instance={"bar": 2},
            schema=schema,
            cls=validators.Draft3Validator,
        )
        self.assertEqual(message, "'foo' is a dependency of 'bar'")

    def test_object_without_title_type_failure_draft3(self):
        type = {"type": [{"minimum": 3}]}
        message = self.message_for(
            instance=1,
            schema={"type": [type]},
            cls=validators.Draft3Validator,
        )
        self.assertEqual(
            message,
            "1 is not of type {'type': [{'minimum': 3}]}",
        )

    def test_dependencies_list_draft3(self):
        depend, on = "bar", "foo"
        schema = {"dependencies": {depend: [on]}}
        message = self.message_for(
            instance={"bar": 2},
            schema=schema,
            cls=validators.Draft3Validator,
        )
        self.assertEqual(message, "'foo' is a dependency of 'bar'")

    def test_dependencies_list_draft7(self):
        depend, on = "bar", "foo"
        schema = {"dependencies": {depend: [on]}}
        message = self.message_for(
            instance={"bar": 2},
            schema=schema,
            cls=validators.Draft7Validator,
        )
        self.assertEqual(message, "'foo' is a dependency of 'bar'")

    def test_additionalItems_single_failure(self):
        message = self.message_for(
            instance=[2],
            schema={"items": [], "additionalItems": False},
            cls=validators.Draft3Validator,
        )
        self.assertIn("(2 was unexpected)", message)

    def test_additionalItems_multiple_failures(self):
        message = self.message_for(
            instance=[1, 2, 3],
            schema={"items": [], "additionalItems": False},
            cls=validators.Draft3Validator,
        )
        self.assertIn("(1, 2, 3 were unexpected)", message)

    def test_additionalProperties_single_failure(self):
        additional = "foo"
        schema = {"additionalProperties": False}
        message = self.message_for(instance={additional: 2}, schema=schema)
        self.assertIn("('foo' was unexpected)", message)

    def test_additionalProperties_multiple_failures(self):
        schema = {"additionalProperties": False}
        message = self.message_for(
            instance=dict.fromkeys(["foo", "bar"]),
            schema=schema,
        )

        self.assertIn(repr("foo"), message)
        self.assertIn(repr("bar"), message)
        self.assertIn("were unexpected)", message)

    def test_const(self):
        schema = {"const": 12}
        message = self.message_for(
            instance={"foo": "bar"},
            schema=schema,
        )
        self.assertIn("12 was expected", message)

    def test_contains_draft_6(self):
        schema = {"contains": {"const": 12}}
        message = self.message_for(
            instance=[2, {}, []],
            schema=schema,
            cls=validators.Draft6Validator,
        )
        self.assertEqual(
            message,
            "None of [2, {}, []] are valid under the given schema",
        )

    def test_invalid_format_default_message(self):
        checker = FormatChecker(formats=())
        checker.checks("thing")(lambda value: False)

        schema = {"format": "thing"}
        message = self.message_for(
            instance="bla",
            schema=schema,
            format_checker=checker,
        )

        self.assertIn(repr("bla"), message)
        self.assertIn(repr("thing"), message)
        self.assertIn("is not a", message)

    def test_additionalProperties_false_patternProperties(self):
        schema = {"type": "object",
                  "additionalProperties": False,
                  "patternProperties": {
                      "^abc$": {"type": "string"},
                      "^def$": {"type": "string"},
                  }}
        message = self.message_for(
            instance={"zebra": 123},
            schema=schema,
            cls=validators.Draft4Validator,
        )
        self.assertEqual(
            message,
            "{} does not match any of the regexes: {}, {}".format(
                repr("zebra"), repr("^abc$"), repr("^def$"),
            ),
        )
        message = self.message_for(
            instance={"zebra": 123, "fish": 456},
            schema=schema,
            cls=validators.Draft4Validator,
        )
        self.assertEqual(
            message,
            "{}, {} do not match any of the regexes: {}, {}".format(
                repr("fish"), repr("zebra"), repr("^abc$"), repr("^def$"),
            ),
        )

    def test_False_schema(self):
        message = self.message_for(
            instance="something",
            schema=False,
        )
        self.assertEqual(message, "False schema does not allow 'something'")

    def test_multipleOf(self):
        message = self.message_for(
            instance=3,
            schema={"multipleOf": 2},
        )
        self.assertEqual(message, "3 is not a multiple of 2")

    def test_minItems(self):
        message = self.message_for(instance=[], schema={"minItems": 2})
        self.assertEqual(message, "[] is too short")

    def test_maxItems(self):
        message = self.message_for(instance=[1, 2, 3], schema={"maxItems": 2})
        self.assertEqual(message, "[1, 2, 3] is too long")

    def test_minItems_1(self):
        message = self.message_for(instance=[], schema={"minItems": 1})
        self.assertEqual(message, "[] should be non-empty")

    def test_maxItems_0(self):
        message = self.message_for(instance=[1, 2, 3], schema={"maxItems": 0})
        self.assertEqual(message, "[1, 2, 3] is expected to be empty")

    def test_minLength(self):
        message = self.message_for(
            instance="",
            schema={"minLength": 2},
        )
        self.assertEqual(message, "'' is too short")

    def test_maxLength(self):
        message = self.message_for(
            instance="abc",
            schema={"maxLength": 2},
        )
        self.assertEqual(message, "'abc' is too long")

    def test_minLength_1(self):
        message = self.message_for(instance="", schema={"minLength": 1})
        self.assertEqual(message, "'' should be non-empty")

    def test_maxLength_0(self):
        message = self.message_for(instance="abc", schema={"maxLength": 0})
        self.assertEqual(message, "'abc' is expected to be empty")

    def test_minProperties(self):
        message = self.message_for(instance={}, schema={"minProperties": 2})
        self.assertEqual(message, "{} does not have enough properties")

    def test_maxProperties(self):
        message = self.message_for(
            instance={"a": {}, "b": {}, "c": {}},
            schema={"maxProperties": 2},
        )
        self.assertEqual(
            message,
            "{'a': {}, 'b': {}, 'c': {}} has too many properties",
        )

    def test_minProperties_1(self):
        message = self.message_for(instance={}, schema={"minProperties": 1})
        self.assertEqual(message, "{} should be non-empty")

    def test_maxProperties_0(self):
        message = self.message_for(
            instance={1: 2},
            schema={"maxProperties": 0},
        )
        self.assertEqual(message, "{1: 2} is expected to be empty")

    def test_prefixItems_with_items(self):
        message = self.message_for(
            instance=[1, 2, "foo"],
            schema={"items": False, "prefixItems": [{}, {}]},
        )
        self.assertEqual(
            message,
            "Expected at most 2 items but found 1 extra: 'foo'",
        )

    def test_prefixItems_with_multiple_extra_items(self):
        message = self.message_for(
            instance=[1, 2, "foo", 5],
            schema={"items": False, "prefixItems": [{}, {}]},
        )
        self.assertEqual(
            message,
            "Expected at most 2 items but found 2 extra: ['foo', 5]",
        )

    def test_pattern(self):
        message = self.message_for(
            instance="bbb",
            schema={"pattern": "^a*$"},
        )
        self.assertEqual(message, "'bbb' does not match '^a*$'")

    def test_does_not_contain(self):
        message = self.message_for(
            instance=[],
            schema={"contains": {"type": "string"}},
        )
        self.assertEqual(
            message,
            "[] does not contain items matching the given schema",
        )

    def test_contains_too_few(self):
        message = self.message_for(
            instance=["foo", 1],
            schema={"contains": {"type": "string"}, "minContains": 2},
        )
        self.assertEqual(
            message,
            "Too few items match the given schema "
            "(expected at least 2 but only 1 matched)",
        )

    def test_contains_too_few_both_constrained(self):
        message = self.message_for(
            instance=["foo", 1],
            schema={
                "contains": {"type": "string"},
                "minContains": 2,
                "maxContains": 4,
            },
        )
        self.assertEqual(
            message,
            "Too few items match the given schema (expected at least 2 but "
            "only 1 matched)",
        )

    def test_contains_too_many(self):
        message = self.message_for(
            instance=["foo", "bar", "baz"],
            schema={"contains": {"type": "string"}, "maxContains": 2},
        )
        self.assertEqual(
            message,
            "Too many items match the given schema (expected at most 2)",
        )

    def test_contains_too_many_both_constrained(self):
        message = self.message_for(
            instance=["foo"] * 5,
            schema={
                "contains": {"type": "string"},
                "minContains": 2,
                "maxContains": 4,
            },
        )
        self.assertEqual(
            message,
            "Too many items match the given schema (expected at most 4)",
        )

    def test_exclusiveMinimum(self):
        message = self.message_for(
            instance=3,
            schema={"exclusiveMinimum": 5},
        )
        self.assertEqual(
            message,
            "3 is less than or equal to the minimum of 5",
        )

    def test_exclusiveMaximum(self):
        message = self.message_for(instance=3, schema={"exclusiveMaximum": 2})
        self.assertEqual(
            message,
            "3 is greater than or equal to the maximum of 2",
        )

    def test_required(self):
        message = self.message_for(instance={}, schema={"required": ["foo"]})
        self.assertEqual(message, "'foo' is a required property")

    def test_dependentRequired(self):
        message = self.message_for(
            instance={"foo": {}},
            schema={"dependentRequired": {"foo": ["bar"]}},
        )
        self.assertEqual(message, "'bar' is a dependency of 'foo'")

    def test_oneOf_matches_none(self):
        message = self.message_for(instance={}, schema={"oneOf": [False]})
        self.assertEqual(
            message,
            "{} is not valid under any of the given schemas",
        )

    def test_oneOf_matches_too_many(self):
        message = self.message_for(instance={}, schema={"oneOf": [True, True]})
        self.assertEqual(message, "{} is valid under each of True, True")

    def test_unevaluated_items(self):
        schema = {"type": "array", "unevaluatedItems": False}
        message = self.message_for(instance=["foo", "bar"], schema=schema)
        self.assertIn(
            message,
            "Unevaluated items are not allowed ('foo', 'bar' were unexpected)",
        )

    def test_unevaluated_items_on_invalid_type(self):
        schema = {"type": "array", "unevaluatedItems": False}
        message = self.message_for(instance="foo", schema=schema)
        self.assertEqual(message, "'foo' is not of type 'array'")

    def test_unevaluated_properties_invalid_against_subschema(self):
        schema = {
            "properties": {"foo": {"type": "string"}},
            "unevaluatedProperties": {"const": 12},
        }
        message = self.message_for(
            instance={
                "foo": "foo",
                "bar": "bar",
                "baz": 12,
            },
            schema=schema,
        )
        self.assertEqual(
            message,
            "Unevaluated properties are not valid under the given schema "
            "('bar' was unevaluated and invalid)",
        )

    def test_unevaluated_properties_disallowed(self):
        schema = {"type": "object", "unevaluatedProperties": False}
        message = self.message_for(
            instance={
                "foo": "foo",
                "bar": "bar",
            },
            schema=schema,
        )
        self.assertEqual(
            message,
            "Unevaluated properties are not allowed "
            "('bar', 'foo' were unexpected)",
        )

    def test_unevaluated_properties_on_invalid_type(self):
        schema = {"type": "object", "unevaluatedProperties": False}
        message = self.message_for(instance="foo", schema=schema)
        self.assertEqual(message, "'foo' is not of type 'object'")

    def test_single_item(self):
        schema = {"prefixItems": [{}], "items": False}
        message = self.message_for(
            instance=["foo", "bar", "baz"],
            schema=schema,
        )
        self.assertEqual(
            message,
            "Expected at most 1 item but found 2 extra: ['bar', 'baz']",
        )

    def test_heterogeneous_additionalItems_with_Items(self):
        schema = {"items": [{}], "additionalItems": False}
        message = self.message_for(
            instance=["foo", "bar", 37],
            schema=schema,
            cls=validators.Draft7Validator,
        )
        self.assertEqual(
            message,
            "Additional items are not allowed ('bar', 37 were unexpected)",
        )

    def test_heterogeneous_items_prefixItems(self):
        schema = {"prefixItems": [{}], "items": False}
        message = self.message_for(
            instance=["foo", "bar", 37],
            schema=schema,
        )
        self.assertEqual(
            message,
            "Expected at most 1 item but found 2 extra: ['bar', 37]",
        )

    def test_heterogeneous_unevaluatedItems_prefixItems(self):
        schema = {"prefixItems": [{}], "unevaluatedItems": False}
        message = self.message_for(
            instance=["foo", "bar", 37],
            schema=schema,
        )
        self.assertEqual(
            message,
            "Unevaluated items are not allowed ('bar', 37 were unexpected)",
        )

    def test_heterogeneous_properties_additionalProperties(self):
        """
        Not valid deserialized JSON, but this should not blow up.
        """
        schema = {"properties": {"foo": {}}, "additionalProperties": False}
        message = self.message_for(
            instance={"foo": {}, "a": "baz", 37: 12},
            schema=schema,
        )
        self.assertEqual(
            message,
            "Additional properties are not allowed (37, 'a' were unexpected)",
        )

    def test_heterogeneous_properties_unevaluatedProperties(self):
        """
        Not valid deserialized JSON, but this should not blow up.
        """
        schema = {"properties": {"foo": {}}, "unevaluatedProperties": False}
        message = self.message_for(
            instance={"foo": {}, "a": "baz", 37: 12},
            schema=schema,
        )
        self.assertEqual(
            message,
            "Unevaluated properties are not allowed (37, 'a' were unexpected)",
        )


class TestValidationErrorDetails(TestCase):
    # TODO: These really need unit tests for each individual keyword, rather
    #       than just these higher level tests.
    def test_anyOf(self):
        instance = 5
        schema = {
            "anyOf": [
                {"minimum": 20},
                {"type": "string"},
            ],
        }

        validator = validators.Draft4Validator(schema)
        errors = list(validator.iter_errors(instance))
        self.assertEqual(len(errors), 1)
        e = errors[0]

        self.assertEqual(e.validator, "anyOf")
        self.assertEqual(e.validator_value, schema["anyOf"])
        self.assertEqual(e.instance, instance)
        self.assertEqual(e.schema, schema)
        self.assertIsNone(e.parent)

        self.assertEqual(e.path, deque([]))
        self.assertEqual(e.relative_path, deque([]))
        self.assertEqual(e.absolute_path, deque([]))
        self.assertEqual(e.json_path, "$")

        self.assertEqual(e.schema_path, deque(["anyOf"]))
        self.assertEqual(e.relative_schema_path, deque(["anyOf"]))
        self.assertEqual(e.absolute_schema_path, deque(["anyOf"]))

        self.assertEqual(len(e.context), 2)

        e1, e2 = sorted_errors(e.context)

        self.assertEqual(e1.validator, "minimum")
        self.assertEqual(e1.validator_value, schema["anyOf"][0]["minimum"])
        self.assertEqual(e1.instance, instance)
        self.assertEqual(e1.schema, schema["anyOf"][0])
        self.assertIs(e1.parent, e)

        self.assertEqual(e1.path, deque([]))
        self.assertEqual(e1.absolute_path, deque([]))
        self.assertEqual(e1.relative_path, deque([]))
        self.assertEqual(e1.json_path, "$")

        self.assertEqual(e1.schema_path, deque([0, "minimum"]))
        self.assertEqual(e1.relative_schema_path, deque([0, "minimum"]))
        self.assertEqual(
            e1.absolute_schema_path, deque(["anyOf", 0, "minimum"]),
        )

        self.assertFalse(e1.context)

        self.assertEqual(e2.validator, "type")
        self.assertEqual(e2.validator_value, schema["anyOf"][1]["type"])
        self.assertEqual(e2.instance, instance)
        self.assertEqual(e2.schema, schema["anyOf"][1])
        self.assertIs(e2.parent, e)

        self.assertEqual(e2.path, deque([]))
        self.assertEqual(e2.relative_path, deque([]))
        self.assertEqual(e2.absolute_path, deque([]))
        self.assertEqual(e2.json_path, "$")

        self.assertEqual(e2.schema_path, deque([1, "type"]))
        self.assertEqual(e2.relative_schema_path, deque([1, "type"]))
        self.assertEqual(e2.absolute_schema_path, deque(["anyOf", 1, "type"]))

        self.assertEqual(len(e2.context), 0)

    def test_type(self):
        instance = {"foo": 1}
        schema = {
            "type": [
                {"type": "integer"},
                {
                    "type": "object",
                    "properties": {"foo": {"enum": [2]}},
                },
            ],
        }

        validator = validators.Draft3Validator(schema)
        errors = list(validator.iter_errors(instance))
        self.assertEqual(len(errors), 1)
        e = errors[0]

        self.assertEqual(e.validator, "type")
        self.assertEqual(e.validator_value, schema["type"])
        self.assertEqual(e.instance, instance)
        self.assertEqual(e.schema, schema)
        self.assertIsNone(e.parent)

        self.assertEqual(e.path, deque([]))
        self.assertEqual(e.relative_path, deque([]))
        self.assertEqual(e.absolute_path, deque([]))
        self.assertEqual(e.json_path, "$")

        self.assertEqual(e.schema_path, deque(["type"]))
        self.assertEqual(e.relative_schema_path, deque(["type"]))
        self.assertEqual(e.absolute_schema_path, deque(["type"]))

        self.assertEqual(len(e.context), 2)

        e1, e2 = sorted_errors(e.context)

        self.assertEqual(e1.validator, "type")
        self.assertEqual(e1.validator_value, schema["type"][0]["type"])
        self.assertEqual(e1.instance, instance)
        self.assertEqual(e1.schema, schema["type"][0])
        self.assertIs(e1.parent, e)

        self.assertEqual(e1.path, deque([]))
        self.assertEqual(e1.relative_path, deque([]))
        self.assertEqual(e1.absolute_path, deque([]))
        self.assertEqual(e1.json_path, "$")

        self.assertEqual(e1.schema_path, deque([0, "type"]))
        self.assertEqual(e1.relative_schema_path, deque([0, "type"]))
        self.assertEqual(e1.absolute_schema_path, deque(["type", 0, "type"]))

        self.assertFalse(e1.context)

        self.assertEqual(e2.validator, "enum")
        self.assertEqual(e2.validator_value, [2])
        self.assertEqual(e2.instance, 1)
        self.assertEqual(e2.schema, {"enum": [2]})
        self.assertIs(e2.parent, e)

        self.assertEqual(e2.path, deque(["foo"]))
        self.assertEqual(e2.relative_path, deque(["foo"]))
        self.assertEqual(e2.absolute_path, deque(["foo"]))
        self.assertEqual(e2.json_path, "$.foo")

        self.assertEqual(
            e2.schema_path, deque([1, "properties", "foo", "enum"]),
        )
        self.assertEqual(
            e2.relative_schema_path, deque([1, "properties", "foo", "enum"]),
        )
        self.assertEqual(
            e2.absolute_schema_path,
            deque(["type", 1, "properties", "foo", "enum"]),
        )

        self.assertFalse(e2.context)

    def test_single_nesting(self):
        instance = {"foo": 2, "bar": [1], "baz": 15, "quux": "spam"}
        schema = {
            "properties": {
                "foo": {"type": "string"},
                "bar": {"minItems": 2},
                "baz": {"maximum": 10, "enum": [2, 4, 6, 8]},
            },
        }

        validator = validators.Draft3Validator(schema)
        errors = validator.iter_errors(instance)
        e1, e2, e3, e4 = sorted_errors(errors)

        self.assertEqual(e1.path, deque(["bar"]))
        self.assertEqual(e2.path, deque(["baz"]))
        self.assertEqual(e3.path, deque(["baz"]))
        self.assertEqual(e4.path, deque(["foo"]))

        self.assertEqual(e1.relative_path, deque(["bar"]))
        self.assertEqual(e2.relative_path, deque(["baz"]))
        self.assertEqual(e3.relative_path, deque(["baz"]))
        self.assertEqual(e4.relative_path, deque(["foo"]))

        self.assertEqual(e1.absolute_path, deque(["bar"]))
        self.assertEqual(e2.absolute_path, deque(["baz"]))
        self.assertEqual(e3.absolute_path, deque(["baz"]))
        self.assertEqual(e4.absolute_path, deque(["foo"]))

        self.assertEqual(e1.json_path, "$.bar")
        self.assertEqual(e2.json_path, "$.baz")
        self.assertEqual(e3.json_path, "$.baz")
        self.assertEqual(e4.json_path, "$.foo")

        self.assertEqual(e1.validator, "minItems")
        self.assertEqual(e2.validator, "enum")
        self.assertEqual(e3.validator, "maximum")
        self.assertEqual(e4.validator, "type")

    def test_multiple_nesting(self):
        instance = [1, {"foo": 2, "bar": {"baz": [1]}}, "quux"]
        schema = {
            "type": "string",
            "items": {
                "type": ["string", "object"],
                "properties": {
                    "foo": {"enum": [1, 3]},
                    "bar": {
                        "type": "array",
                        "properties": {
                            "bar": {"required": True},
                            "baz": {"minItems": 2},
                        },
                    },
                },
            },
        }

        validator = validators.Draft3Validator(schema)
        errors = validator.iter_errors(instance)
        e1, e2, e3, e4, e5, e6 = sorted_errors(errors)

        self.assertEqual(e1.path, deque([]))
        self.assertEqual(e2.path, deque([0]))
        self.assertEqual(e3.path, deque([1, "bar"]))
        self.assertEqual(e4.path, deque([1, "bar", "bar"]))
        self.assertEqual(e5.path, deque([1, "bar", "baz"]))
        self.assertEqual(e6.path, deque([1, "foo"]))

        self.assertEqual(e1.json_path, "$")
        self.assertEqual(e2.json_path, "$[0]")
        self.assertEqual(e3.json_path, "$[1].bar")
        self.assertEqual(e4.json_path, "$[1].bar.bar")
        self.assertEqual(e5.json_path, "$[1].bar.baz")
        self.assertEqual(e6.json_path, "$[1].foo")

        self.assertEqual(e1.schema_path, deque(["type"]))
        self.assertEqual(e2.schema_path, deque(["items", "type"]))
        self.assertEqual(
            list(e3.schema_path), ["items", "properties", "bar", "type"],
        )
        self.assertEqual(
            list(e4.schema_path),
            ["items", "properties", "bar", "properties", "bar", "required"],
        )
        self.assertEqual(
            list(e5.schema_path),
            ["items", "properties", "bar", "properties", "baz", "minItems"],
        )
        self.assertEqual(
            list(e6.schema_path), ["items", "properties", "foo", "enum"],
        )

        self.assertEqual(e1.validator, "type")
        self.assertEqual(e2.validator, "type")
        self.assertEqual(e3.validator, "type")
        self.assertEqual(e4.validator, "required")
        self.assertEqual(e5.validator, "minItems")
        self.assertEqual(e6.validator, "enum")

    def test_recursive(self):
        schema = {
            "definitions": {
                "node": {
                    "anyOf": [{
                        "type": "object",
                        "required": ["name", "children"],
                        "properties": {
                            "name": {
                                "type": "string",
                            },
                            "children": {
                                "type": "object",
                                "patternProperties": {
                                    "^.*$": {
                                        "$ref": "#/definitions/node",
                                    },
                                },
                            },
                        },
                    }],
                },
            },
            "type": "object",
            "required": ["root"],
            "properties": {"root": {"$ref": "#/definitions/node"}},
        }

        instance = {
            "root": {
                "name": "root",
                "children": {
                    "a": {
                        "name": "a",
                        "children": {
                            "ab": {
                                "name": "ab",
                                # missing "children"
                            },
                        },
                    },
                },
            },
        }
        validator = validators.Draft4Validator(schema)

        e, = validator.iter_errors(instance)
        self.assertEqual(e.absolute_path, deque(["root"]))
        self.assertEqual(
            e.absolute_schema_path, deque(["properties", "root", "anyOf"]),
        )
        self.assertEqual(e.json_path, "$.root")

        e1, = e.context
        self.assertEqual(e1.absolute_path, deque(["root", "children", "a"]))
        self.assertEqual(
            e1.absolute_schema_path, deque(
                [
                    "properties",
                    "root",
                    "anyOf",
                    0,
                    "properties",
                    "children",
                    "patternProperties",
                    "^.*$",
                    "anyOf",
                ],
            ),
        )
        self.assertEqual(e1.json_path, "$.root.children.a")

        e2, = e1.context
        self.assertEqual(
            e2.absolute_path, deque(
                ["root", "children", "a", "children", "ab"],
            ),
        )
        self.assertEqual(
            e2.absolute_schema_path, deque(
                [
                    "properties",
                    "root",
                    "anyOf",
                    0,
                    "properties",
                    "children",
                    "patternProperties",
                    "^.*$",
                    "anyOf",
                    0,
                    "properties",
                    "children",
                    "patternProperties",
                    "^.*$",
                    "anyOf",
                ],
            ),
        )
        self.assertEqual(e2.json_path, "$.root.children.a.children.ab")

    def test_additionalProperties(self):
        instance = {"bar": "bar", "foo": 2}
        schema = {"additionalProperties": {"type": "integer", "minimum": 5}}

        validator = validators.Draft3Validator(schema)
        errors = validator.iter_errors(instance)
        e1, e2 = sorted_errors(errors)

        self.assertEqual(e1.path, deque(["bar"]))
        self.assertEqual(e2.path, deque(["foo"]))

        self.assertEqual(e1.json_path, "$.bar")
        self.assertEqual(e2.json_path, "$.foo")

        self.assertEqual(e1.validator, "type")
        self.assertEqual(e2.validator, "minimum")

    def test_patternProperties(self):
        instance = {"bar": 1, "foo": 2}
        schema = {
            "patternProperties": {
                "bar": {"type": "string"},
                "foo": {"minimum": 5},
            },
        }

        validator = validators.Draft3Validator(schema)
        errors = validator.iter_errors(instance)
        e1, e2 = sorted_errors(errors)

        self.assertEqual(e1.path, deque(["bar"]))
        self.assertEqual(e2.path, deque(["foo"]))

        self.assertEqual(e1.json_path, "$.bar")
        self.assertEqual(e2.json_path, "$.foo")

        self.assertEqual(e1.validator, "type")
        self.assertEqual(e2.validator, "minimum")

    def test_additionalItems(self):
        instance = ["foo", 1]
        schema = {
            "items": [],
            "additionalItems": {"type": "integer", "minimum": 5},
        }

        validator = validators.Draft3Validator(schema)
        errors = validator.iter_errors(instance)
        e1, e2 = sorted_errors(errors)

        self.assertEqual(e1.path, deque([0]))
        self.assertEqual(e2.path, deque([1]))

        self.assertEqual(e1.json_path, "$[0]")
        self.assertEqual(e2.json_path, "$[1]")

        self.assertEqual(e1.validator, "type")
        self.assertEqual(e2.validator, "minimum")

    def test_additionalItems_with_items(self):
        instance = ["foo", "bar", 1]
        schema = {
            "items": [{}],
            "additionalItems": {"type": "integer", "minimum": 5},
        }

        validator = validators.Draft3Validator(schema)
        errors = validator.iter_errors(instance)
        e1, e2 = sorted_errors(errors)

        self.assertEqual(e1.path, deque([1]))
        self.assertEqual(e2.path, deque([2]))

        self.assertEqual(e1.json_path, "$[1]")
        self.assertEqual(e2.json_path, "$[2]")

        self.assertEqual(e1.validator, "type")
        self.assertEqual(e2.validator, "minimum")

    def test_propertyNames(self):
        instance = {"foo": 12}
        schema = {"propertyNames": {"not": {"const": "foo"}}}

        validator = validators.Draft7Validator(schema)
        error, = validator.iter_errors(instance)

        self.assertEqual(error.validator, "not")
        self.assertEqual(
            error.message,
            "'foo' should not be valid under {'const': 'foo'}",
        )
        self.assertEqual(error.path, deque([]))
        self.assertEqual(error.json_path, "$")
        self.assertEqual(error.schema_path, deque(["propertyNames", "not"]))

    def test_if_then(self):
        schema = {
            "if": {"const": 12},
            "then": {"const": 13},
        }

        validator = validators.Draft7Validator(schema)
        error, = validator.iter_errors(12)

        self.assertEqual(error.validator, "const")
        self.assertEqual(error.message, "13 was expected")
        self.assertEqual(error.path, deque([]))
        self.assertEqual(error.json_path, "$")
        self.assertEqual(error.schema_path, deque(["then", "const"]))

    def test_if_else(self):
        schema = {
            "if": {"const": 12},
            "else": {"const": 13},
        }

        validator = validators.Draft7Validator(schema)
        error, = validator.iter_errors(15)

        self.assertEqual(error.validator, "const")
        self.assertEqual(error.message, "13 was expected")
        self.assertEqual(error.path, deque([]))
        self.assertEqual(error.json_path, "$")
        self.assertEqual(error.schema_path, deque(["else", "const"]))

    def test_boolean_schema_False(self):
        validator = validators.Draft7Validator(False)
        error, = validator.iter_errors(12)

        self.assertEqual(
            (
                error.message,
                error.validator,
                error.validator_value,
                error.instance,
                error.schema,
                error.schema_path,
                error.json_path,
            ),
            (
                "False schema does not allow 12",
                None,
                None,
                12,
                False,
                deque([]),
                "$",
            ),
        )

    def test_ref(self):
        ref, schema = "someRef", {"additionalProperties": {"type": "integer"}}
        validator = validators.Draft7Validator(
            {"$ref": ref},
            resolver=validators._RefResolver("", {}, store={ref: schema}),
        )
        error, = validator.iter_errors({"foo": "notAnInteger"})

        self.assertEqual(
            (
                error.message,
                error.validator,
                error.validator_value,
                error.instance,
                error.absolute_path,
                error.schema,
                error.schema_path,
                error.json_path,
            ),
            (
                "'notAnInteger' is not of type 'integer'",
                "type",
                "integer",
                "notAnInteger",
                deque(["foo"]),
                {"type": "integer"},
                deque(["additionalProperties", "type"]),
                "$.foo",
            ),
        )

    def test_prefixItems(self):
        schema = {"prefixItems": [{"type": "string"}, {}, {}, {"maximum": 3}]}
        validator = validators.Draft202012Validator(schema)
        type_error, min_error = validator.iter_errors([1, 2, "foo", 5])
        self.assertEqual(
            (
                type_error.message,
                type_error.validator,
                type_error.validator_value,
                type_error.instance,
                type_error.absolute_path,
                type_error.schema,
                type_error.schema_path,
                type_error.json_path,
            ),
            (
                "1 is not of type 'string'",
                "type",
                "string",
                1,
                deque([0]),
                {"type": "string"},
                deque(["prefixItems", 0, "type"]),
                "$[0]",
            ),
        )
        self.assertEqual(
            (
                min_error.message,
                min_error.validator,
                min_error.validator_value,
                min_error.instance,
                min_error.absolute_path,
                min_error.schema,
                min_error.schema_path,
                min_error.json_path,
            ),
            (
                "5 is greater than the maximum of 3",
                "maximum",
                3,
                5,
                deque([3]),
                {"maximum": 3},
                deque(["prefixItems", 3, "maximum"]),
                "$[3]",
            ),
        )

    def test_prefixItems_with_items(self):
        schema = {
            "items": {"type": "string"},
            "prefixItems": [{}],
        }
        validator = validators.Draft202012Validator(schema)
        e1, e2 = validator.iter_errors(["foo", 2, "bar", 4, "baz"])
        self.assertEqual(
            (
                e1.message,
                e1.validator,
                e1.validator_value,
                e1.instance,
                e1.absolute_path,
                e1.schema,
                e1.schema_path,
                e1.json_path,
            ),
            (
                "2 is not of type 'string'",
                "type",
                "string",
                2,
                deque([1]),
                {"type": "string"},
                deque(["items", "type"]),
                "$[1]",
            ),
        )
        self.assertEqual(
            (
                e2.message,
                e2.validator,
                e2.validator_value,
                e2.instance,
                e2.absolute_path,
                e2.schema,
                e2.schema_path,
                e2.json_path,
            ),
            (
                "4 is not of type 'string'",
                "type",
                "string",
                4,
                deque([3]),
                {"type": "string"},
                deque(["items", "type"]),
                "$[3]",
            ),
        )

    def test_contains_too_many(self):
        """
        `contains` + `maxContains` produces only one error, even if there are
        many more incorrectly matching elements.
        """
        schema = {"contains": {"type": "string"}, "maxContains": 2}
        validator = validators.Draft202012Validator(schema)
        error, = validator.iter_errors(["foo", 2, "bar", 4, "baz", "quux"])
        self.assertEqual(
            (
                error.message,
                error.validator,
                error.validator_value,
                error.instance,
                error.absolute_path,
                error.schema,
                error.schema_path,
                error.json_path,
            ),
            (
                "Too many items match the given schema (expected at most 2)",
                "maxContains",
                2,
                ["foo", 2, "bar", 4, "baz", "quux"],
                deque([]),
                {"contains": {"type": "string"}, "maxContains": 2},
                deque(["contains"]),
                "$",
            ),
        )

    def test_contains_too_few(self):
        schema = {"contains": {"type": "string"}, "minContains": 2}
        validator = validators.Draft202012Validator(schema)
        error, = validator.iter_errors(["foo", 2, 4])
        self.assertEqual(
            (
                error.message,
                error.validator,
                error.validator_value,
                error.instance,
                error.absolute_path,
                error.schema,
                error.schema_path,
                error.json_path,
            ),
            (
                (
                    "Too few items match the given schema "
                    "(expected at least 2 but only 1 matched)"
                ),
                "minContains",
                2,
                ["foo", 2, 4],
                deque([]),
                {"contains": {"type": "string"}, "minContains": 2},
                deque(["contains"]),
                "$",
            ),
        )

    def test_contains_none(self):
        schema = {"contains": {"type": "string"}, "minContains": 2}
        validator = validators.Draft202012Validator(schema)
        error, = validator.iter_errors([2, 4])
        self.assertEqual(
            (
                error.message,
                error.validator,
                error.validator_value,
                error.instance,
                error.absolute_path,
                error.schema,
                error.schema_path,
                error.json_path,
            ),
            (
                "[2, 4] does not contain items matching the given schema",
                "contains",
                {"type": "string"},
                [2, 4],
                deque([]),
                {"contains": {"type": "string"}, "minContains": 2},
                deque(["contains"]),
                "$",
            ),
        )

    def test_ref_sibling(self):
        schema = {
            "$defs": {"foo": {"required": ["bar"]}},
            "properties": {
                "aprop": {
                    "$ref": "#/$defs/foo",
                    "required": ["baz"],
                },
            },
        }

        validator = validators.Draft202012Validator(schema)
        e1, e2 = validator.iter_errors({"aprop": {}})
        self.assertEqual(
            (
                e1.message,
                e1.validator,
                e1.validator_value,
                e1.instance,
                e1.absolute_path,
                e1.schema,
                e1.schema_path,
                e1.relative_schema_path,
                e1.json_path,
            ),
            (
                "'bar' is a required property",
                "required",
                ["bar"],
                {},
                deque(["aprop"]),
                {"required": ["bar"]},
                deque(["properties", "aprop", "required"]),
                deque(["properties", "aprop", "required"]),
                "$.aprop",
            ),
        )
        self.assertEqual(
            (
                e2.message,
                e2.validator,
                e2.validator_value,
                e2.instance,
                e2.absolute_path,
                e2.schema,
                e2.schema_path,
                e2.relative_schema_path,
                e2.json_path,
            ),
            (
                "'baz' is a required property",
                "required",
                ["baz"],
                {},
                deque(["aprop"]),
                {"$ref": "#/$defs/foo", "required": ["baz"]},
                deque(["properties", "aprop", "required"]),
                deque(["properties", "aprop", "required"]),
                "$.aprop",
            ),
        )


class MetaSchemaTestsMixin:
    # TODO: These all belong upstream
    def test_invalid_properties(self):
        with self.assertRaises(exceptions.SchemaError):
            self.Validator.check_schema({"properties": 12})

    def test_minItems_invalid_string(self):
        with self.assertRaises(exceptions.SchemaError):
            # needs to be an integer
            self.Validator.check_schema({"minItems": "1"})

    def test_enum_allows_empty_arrays(self):
        """
        Technically, all the spec says is they SHOULD have elements, not MUST.

        (As of Draft 6. Previous drafts do say MUST).

        See #529.
        """
        if self.Validator in {
            validators.Draft3Validator,
            validators.Draft4Validator,
        }:
            with self.assertRaises(exceptions.SchemaError):
                self.Validator.check_schema({"enum": []})
        else:
            self.Validator.check_schema({"enum": []})

    def test_enum_allows_non_unique_items(self):
        """
        Technically, all the spec says is they SHOULD be unique, not MUST.

        (As of Draft 6. Previous drafts do say MUST).

        See #529.
        """
        if self.Validator in {
            validators.Draft3Validator,
            validators.Draft4Validator,
        }:
            with self.assertRaises(exceptions.SchemaError):
                self.Validator.check_schema({"enum": [12, 12]})
        else:
            self.Validator.check_schema({"enum": [12, 12]})

    def test_schema_with_invalid_regex(self):
        with self.assertRaises(exceptions.SchemaError):
            self.Validator.check_schema({"pattern": "*notaregex"})

    def test_schema_with_invalid_regex_with_disabled_format_validation(self):
        self.Validator.check_schema(
            {"pattern": "*notaregex"},
            format_checker=None,
        )


class ValidatorTestMixin(MetaSchemaTestsMixin):
    def test_it_implements_the_validator_protocol(self):
        self.assertIsInstance(self.Validator({}), protocols.Validator)

    def test_valid_instances_are_valid(self):
        schema, instance = self.valid
        self.assertTrue(self.Validator(schema).is_valid(instance))

    def test_invalid_instances_are_not_valid(self):
        schema, instance = self.invalid
        self.assertFalse(self.Validator(schema).is_valid(instance))

    def test_non_existent_properties_are_ignored(self):
        self.Validator({object(): object()}).validate(instance=object())

    def test_evolve(self):
        schema, format_checker = {"type": "integer"}, FormatChecker()
        original = self.Validator(
            schema,
            format_checker=format_checker,
        )
        new = original.evolve(
            schema={"type": "string"},
            format_checker=self.Validator.FORMAT_CHECKER,
        )

        expected = self.Validator(
            {"type": "string"},
            format_checker=self.Validator.FORMAT_CHECKER,
            _resolver=new._resolver,
        )

        self.assertEqual(new, expected)
        self.assertNotEqual(new, original)

    def test_evolve_with_subclass(self):
        """
        Subclassing validators isn't supported public API, but some users have
        done it, because we don't actually error entirely when it's done :/

        We need to deprecate doing so first to help as many of these users
        ensure they can move to supported APIs, but this test ensures that in
        the interim, we haven't broken those users.
        """

        with self.assertWarns(DeprecationWarning):
            @define
            class OhNo(self.Validator):
                foo = field(factory=lambda: [1, 2, 3])
                _bar = field(default=37)

        validator = OhNo({}, bar=12)
        self.assertEqual(validator.foo, [1, 2, 3])

        new = validator.evolve(schema={"type": "integer"})
        self.assertEqual(new.foo, [1, 2, 3])
        self.assertEqual(new._bar, 12)

    def test_is_type_is_true_for_valid_type(self):
        self.assertTrue(self.Validator({}).is_type("foo", "string"))

    def test_is_type_is_false_for_invalid_type(self):
        self.assertFalse(self.Validator({}).is_type("foo", "array"))

    def test_is_type_evades_bool_inheriting_from_int(self):
        self.assertFalse(self.Validator({}).is_type(True, "integer"))
        self.assertFalse(self.Validator({}).is_type(True, "number"))

    def test_it_can_validate_with_decimals(self):
        schema = {"items": {"type": "number"}}
        Validator = validators.extend(
            self.Validator,
            type_checker=self.Validator.TYPE_CHECKER.redefine(
                "number",
                lambda checker, thing: isinstance(
                    thing, (int, float, Decimal),
                ) and not isinstance(thing, bool),
            ),
        )

        validator = Validator(schema)
        validator.validate([1, 1.1, Decimal(1) / Decimal(8)])

        invalid = ["foo", {}, [], True, None]
        self.assertEqual(
            [error.instance for error in validator.iter_errors(invalid)],
            invalid,
        )

    def test_it_returns_true_for_formats_it_does_not_know_about(self):
        validator = self.Validator(
            {"format": "carrot"}, format_checker=FormatChecker(),
        )
        validator.validate("bugs")

    def test_it_does_not_validate_formats_by_default(self):
        validator = self.Validator({})
        self.assertIsNone(validator.format_checker)

    def test_it_validates_formats_if_a_checker_is_provided(self):
        checker = FormatChecker()
        bad = ValueError("Bad!")

        @checker.checks("foo", raises=ValueError)
        def check(value):
            if value == "good":
                return True
            elif value == "bad":
                raise bad
            else:  # pragma: no cover
                self.fail(f"What is {value}? [Baby Don't Hurt Me]")

        validator = self.Validator(
            {"format": "foo"}, format_checker=checker,
        )

        validator.validate("good")
        with self.assertRaises(exceptions.ValidationError) as cm:
            validator.validate("bad")

        # Make sure original cause is attached
        self.assertIs(cm.exception.cause, bad)

    def test_non_string_custom_type(self):
        non_string_type = object()
        schema = {"type": [non_string_type]}
        Crazy = validators.extend(
            self.Validator,
            type_checker=self.Validator.TYPE_CHECKER.redefine(
                non_string_type,
                lambda checker, thing: isinstance(thing, int),
            ),
        )
        Crazy(schema).validate(15)

    def test_it_properly_formats_tuples_in_errors(self):
        """
        A tuple instance properly formats validation errors for uniqueItems.

        See #224
        """
        TupleValidator = validators.extend(
            self.Validator,
            type_checker=self.Validator.TYPE_CHECKER.redefine(
                "array",
                lambda checker, thing: isinstance(thing, tuple),
            ),
        )
        with self.assertRaises(exceptions.ValidationError) as e:
            TupleValidator({"uniqueItems": True}).validate((1, 1))
        self.assertIn("(1, 1) has non-unique elements", str(e.exception))

    def test_check_redefined_sequence(self):
        """
        Allow array to validate against another defined sequence type
        """
        schema = {"type": "array", "uniqueItems": True}
        MyMapping = namedtuple("MyMapping", "a, b")
        Validator = validators.extend(
            self.Validator,
            type_checker=self.Validator.TYPE_CHECKER.redefine_many(
                {
                    "array": lambda checker, thing: isinstance(
                        thing, (list, deque),
                    ),
                    "object": lambda checker, thing: isinstance(
                        thing, (dict, MyMapping),
                    ),
                },
            ),
        )
        validator = Validator(schema)

        valid_instances = [
            deque(["a", None, "1", "", True]),
            deque([[False], [0]]),
            [deque([False]), deque([0])],
            [[deque([False])], [deque([0])]],
            [[[[[deque([False])]]]], [[[[deque([0])]]]]],
            [deque([deque([False])]), deque([deque([0])])],
            [MyMapping("a", 0), MyMapping("a", False)],
            [
                MyMapping("a", [deque([0])]),
                MyMapping("a", [deque([False])]),
            ],
            [
                MyMapping("a", [MyMapping("a", deque([0]))]),
                MyMapping("a", [MyMapping("a", deque([False]))]),
            ],
            [deque(deque(deque([False]))), deque(deque(deque([0])))],
        ]

        for instance in valid_instances:
            validator.validate(instance)

        invalid_instances = [
            deque(["a", "b", "a"]),
            deque([[False], [False]]),
            [deque([False]), deque([False])],
            [[deque([False])], [deque([False])]],
            [[[[[deque([False])]]]], [[[[deque([False])]]]]],
            [deque([deque([False])]), deque([deque([False])])],
            [MyMapping("a", False), MyMapping("a", False)],
            [
                MyMapping("a", [deque([False])]),
                MyMapping("a", [deque([False])]),
            ],
            [
                MyMapping("a", [MyMapping("a", deque([False]))]),
                MyMapping("a", [MyMapping("a", deque([False]))]),
            ],
            [deque(deque(deque([False]))), deque(deque(deque([False])))],
        ]

        for instance in invalid_instances:
            with self.assertRaises(exceptions.ValidationError):
                validator.validate(instance)

    def test_it_creates_a_ref_resolver_if_not_provided(self):
        with self.assertWarns(DeprecationWarning):
            resolver = self.Validator({}).resolver
        self.assertIsInstance(resolver, validators._RefResolver)

    def test_it_upconverts_from_deprecated_RefResolvers(self):
        ref, schema = "someCoolRef", {"type": "integer"}
        resolver = validators._RefResolver("", {}, store={ref: schema})
        validator = self.Validator({"$ref": ref}, resolver=resolver)

        with self.assertRaises(exceptions.ValidationError):
            validator.validate(None)

    def test_it_upconverts_from_yet_older_deprecated_legacy_RefResolvers(self):
        """
        Legacy RefResolvers support only the context manager form of
        resolution.
        """

        class LegacyRefResolver:
            @contextmanager
            def resolving(this, ref):
                self.assertEqual(ref, "the ref")
                yield {"type": "integer"}

        resolver = LegacyRefResolver()
        schema = {"$ref": "the ref"}

        with self.assertRaises(exceptions.ValidationError):
            self.Validator(schema, resolver=resolver).validate(None)


class AntiDraft6LeakMixin:
    """
    Make sure functionality from draft 6 doesn't leak backwards in time.
    """

    def test_True_is_not_a_schema(self):
        with self.assertRaises(exceptions.SchemaError) as e:
            self.Validator.check_schema(True)
        self.assertIn("True is not of type", str(e.exception))

    def test_False_is_not_a_schema(self):
        with self.assertRaises(exceptions.SchemaError) as e:
            self.Validator.check_schema(False)
        self.assertIn("False is not of type", str(e.exception))

    def test_True_is_not_a_schema_even_if_you_forget_to_check(self):
        with self.assertRaises(Exception) as e:
            self.Validator(True).validate(12)
        self.assertNotIsInstance(e.exception, exceptions.ValidationError)

    def test_False_is_not_a_schema_even_if_you_forget_to_check(self):
        with self.assertRaises(Exception) as e:
            self.Validator(False).validate(12)
        self.assertNotIsInstance(e.exception, exceptions.ValidationError)


class TestDraft3Validator(AntiDraft6LeakMixin, ValidatorTestMixin, TestCase):
    Validator = validators.Draft3Validator
    valid: tuple[dict, dict] = ({}, {})
    invalid = {"type": "integer"}, "foo"

    def test_any_type_is_valid_for_type_any(self):
        validator = self.Validator({"type": "any"})
        validator.validate(object())

    def test_any_type_is_redefinable(self):
        """
        Sigh, because why not.
        """
        Crazy = validators.extend(
            self.Validator,
            type_checker=self.Validator.TYPE_CHECKER.redefine(
                "any", lambda checker, thing: isinstance(thing, int),
            ),
        )
        validator = Crazy({"type": "any"})
        validator.validate(12)
        with self.assertRaises(exceptions.ValidationError):
            validator.validate("foo")

    def test_is_type_is_true_for_any_type(self):
        self.assertTrue(self.Validator({"type": "any"}).is_valid(object()))

    def test_is_type_does_not_evade_bool_if_it_is_being_tested(self):
        self.assertTrue(self.Validator({}).is_type(True, "boolean"))
        self.assertTrue(self.Validator({"type": "any"}).is_valid(True))


class TestDraft4Validator(AntiDraft6LeakMixin, ValidatorTestMixin, TestCase):
    Validator = validators.Draft4Validator
    valid: tuple[dict, dict] = ({}, {})
    invalid = {"type": "integer"}, "foo"


class TestDraft6Validator(ValidatorTestMixin, TestCase):
    Validator = validators.Draft6Validator
    valid: tuple[dict, dict] = ({}, {})
    invalid = {"type": "integer"}, "foo"


class TestDraft7Validator(ValidatorTestMixin, TestCase):
    Validator = validators.Draft7Validator
    valid: tuple[dict, dict] = ({}, {})
    invalid = {"type": "integer"}, "foo"


class TestDraft201909Validator(ValidatorTestMixin, TestCase):
    Validator = validators.Draft201909Validator
    valid: tuple[dict, dict] = ({}, {})
    invalid = {"type": "integer"}, "foo"


class TestDraft202012Validator(ValidatorTestMixin, TestCase):
    Validator = validators.Draft202012Validator
    valid: tuple[dict, dict] = ({}, {})
    invalid = {"type": "integer"}, "foo"


class TestLatestValidator(TestCase):
    """
    These really apply to multiple versions but are easiest to test on one.
    """

    def test_ref_resolvers_may_have_boolean_schemas_stored(self):
        ref = "someCoolRef"
        schema = {"$ref": ref}
        resolver = validators._RefResolver("", {}, store={ref: False})
        validator = validators._LATEST_VERSION(schema, resolver=resolver)

        with self.assertRaises(exceptions.ValidationError):
            validator.validate(None)


class TestValidatorFor(TestCase):
    def test_draft_3(self):
        schema = {"$schema": "http://json-schema.org/draft-03/schema"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft3Validator,
        )

        schema = {"$schema": "http://json-schema.org/draft-03/schema#"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft3Validator,
        )

    def test_draft_4(self):
        schema = {"$schema": "http://json-schema.org/draft-04/schema"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft4Validator,
        )

        schema = {"$schema": "http://json-schema.org/draft-04/schema#"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft4Validator,
        )

    def test_draft_6(self):
        schema = {"$schema": "http://json-schema.org/draft-06/schema"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft6Validator,
        )

        schema = {"$schema": "http://json-schema.org/draft-06/schema#"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft6Validator,
        )

    def test_draft_7(self):
        schema = {"$schema": "http://json-schema.org/draft-07/schema"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft7Validator,
        )

        schema = {"$schema": "http://json-schema.org/draft-07/schema#"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft7Validator,
        )

    def test_draft_201909(self):
        schema = {"$schema": "https://json-schema.org/draft/2019-09/schema"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft201909Validator,
        )

        schema = {"$schema": "https://json-schema.org/draft/2019-09/schema#"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft201909Validator,
        )

    def test_draft_202012(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft202012Validator,
        )

        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema#"}
        self.assertIs(
            validators.validator_for(schema),
            validators.Draft202012Validator,
        )

    def test_True(self):
        self.assertIs(
            validators.validator_for(True),
            validators._LATEST_VERSION,
        )

    def test_False(self):
        self.assertIs(
            validators.validator_for(False),
            validators._LATEST_VERSION,
        )

    def test_custom_validator(self):
        Validator = validators.create(
            meta_schema={"id": "meta schema id"},
            version="12",
            id_of=lambda s: s.get("id", ""),
        )
        schema = {"$schema": "meta schema id"}
        self.assertIs(
            validators.validator_for(schema),
            Validator,
        )

    def test_custom_validator_draft6(self):
        Validator = validators.create(
            meta_schema={"$id": "meta schema $id"},
            version="13",
        )
        schema = {"$schema": "meta schema $id"}
        self.assertIs(
            validators.validator_for(schema),
            Validator,
        )

    def test_validator_for_jsonschema_default(self):
        self.assertIs(validators.validator_for({}), validators._LATEST_VERSION)

    def test_validator_for_custom_default(self):
        self.assertIs(validators.validator_for({}, default=None), None)

    def test_warns_if_meta_schema_specified_was_not_found(self):
        with self.assertWarns(DeprecationWarning) as cm:
            validators.validator_for(schema={"$schema": "unknownSchema"})

        self.assertEqual(cm.filename, __file__)
        self.assertEqual(
            str(cm.warning),
            "The metaschema specified by $schema was not found. "
            "Using the latest draft to validate, but this will raise "
            "an error in the future.",
        )

    def test_does_not_warn_if_meta_schema_is_unspecified(self):
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            validators.validator_for(schema={}, default={})
        self.assertFalse(w)

    def test_validator_for_custom_default_with_schema(self):
        schema, default = {"$schema": "mailto:foo@example.com"}, object()
        self.assertIs(validators.validator_for(schema, default), default)


class TestValidate(TestCase):
    def assertUses(self, schema, Validator):
        result = []
        with mock.patch.object(Validator, "check_schema", result.append):
            validators.validate({}, schema)
        self.assertEqual(result, [schema])

    def test_draft3_validator_is_chosen(self):
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-03/schema#"},
            Validator=validators.Draft3Validator,
        )
        # Make sure it works without the empty fragment
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-03/schema"},
            Validator=validators.Draft3Validator,
        )

    def test_draft4_validator_is_chosen(self):
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-04/schema#"},
            Validator=validators.Draft4Validator,
        )
        # Make sure it works without the empty fragment
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-04/schema"},
            Validator=validators.Draft4Validator,
        )

    def test_draft6_validator_is_chosen(self):
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-06/schema#"},
            Validator=validators.Draft6Validator,
        )
        # Make sure it works without the empty fragment
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-06/schema"},
            Validator=validators.Draft6Validator,
        )

    def test_draft7_validator_is_chosen(self):
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-07/schema#"},
            Validator=validators.Draft7Validator,
        )
        # Make sure it works without the empty fragment
        self.assertUses(
            schema={"$schema": "http://json-schema.org/draft-07/schema"},
            Validator=validators.Draft7Validator,
        )

    def test_draft202012_validator_is_chosen(self):
        self.assertUses(
            schema={
                "$schema": "https://json-schema.org/draft/2020-12/schema#",
            },
            Validator=validators.Draft202012Validator,
        )
        # Make sure it works without the empty fragment
        self.assertUses(
            schema={
                "$schema": "https://json-schema.org/draft/2020-12/schema",
            },
            Validator=validators.Draft202012Validator,
        )

    def test_draft202012_validator_is_the_default(self):
        self.assertUses(schema={}, Validator=validators.Draft202012Validator)

    def test_validation_error_message(self):
        with self.assertRaises(exceptions.ValidationError) as e:
            validators.validate(12, {"type": "string"})
        self.assertRegex(
            str(e.exception),
            "(?s)Failed validating '.*' in schema.*On instance",
        )

    def test_schema_error_message(self):
        with self.assertRaises(exceptions.SchemaError) as e:
            validators.validate(12, {"type": 12})
        self.assertRegex(
            str(e.exception),
            "(?s)Failed validating '.*' in metaschema.*On schema",
        )

    def test_it_uses_best_match(self):
        schema = {
            "oneOf": [
                {"type": "number", "minimum": 20},
                {"type": "array"},
            ],
        }
        with self.assertRaises(exceptions.ValidationError) as e:
            validators.validate(12, schema)
        self.assertIn("12 is less than the minimum of 20", str(e.exception))


class TestThreading(TestCase):
    """
    Threading-related functionality tests.

    jsonschema doesn't promise thread safety, and its validation behavior
    across multiple threads may change at any time, but that means it isn't
    safe to share *validators* across threads, not that anytime one has
    multiple threads that jsonschema won't work (it certainly is intended to).

    These tests ensure that this minimal level of functionality continues to
    work.
    """

    def test_validation_across_a_second_thread(self):
        failed = []

        def validate():
            try:
                validators.validate(instance=37, schema=True)
            except:  # pragma: no cover  # noqa: E722
                failed.append(sys.exc_info())

        validate()  # just verify it succeeds

        from threading import Thread
        thread = Thread(target=validate)
        thread.start()
        thread.join()
        self.assertEqual((thread.is_alive(), failed), (False, []))


class TestReferencing(TestCase):
    def test_registry_with_retrieve(self):
        def retrieve(uri):
            return DRAFT202012.create_resource({"type": "integer"})

        registry = referencing.Registry(retrieve=retrieve)
        schema = {"$ref": "https://example.com/"}
        validator = validators.Draft202012Validator(schema, registry=registry)

        self.assertEqual(
            (validator.is_valid(12), validator.is_valid("foo")),
            (True, False),
        )

    def test_custom_registries_do_not_autoretrieve_remote_resources(self):
        registry = referencing.Registry()
        schema = {"$ref": "https://example.com/"}
        validator = validators.Draft202012Validator(schema, registry=registry)

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            with self.assertRaises(referencing.exceptions.Unresolvable):
                validator.validate(12)
        self.assertFalse(w)


class TestRefResolver(TestCase):

    base_uri = ""
    stored_uri = "foo://stored"
    stored_schema = {"stored": "schema"}

    def setUp(self):
        self.referrer = {}
        self.store = {self.stored_uri: self.stored_schema}
        self.resolver = validators._RefResolver(
            self.base_uri, self.referrer, self.store,
        )

    def test_it_does_not_retrieve_schema_urls_from_the_network(self):
        ref = validators.Draft3Validator.META_SCHEMA["id"]
        with mock.patch.object(self.resolver, "resolve_remote") as patched:  # noqa: SIM117
            with self.resolver.resolving(ref) as resolved:
                pass
        self.assertEqual(resolved, validators.Draft3Validator.META_SCHEMA)
        self.assertFalse(patched.called)

    def test_it_resolves_local_refs(self):
        ref = "#/properties/foo"
        self.referrer["properties"] = {"foo": object()}
        with self.resolver.resolving(ref) as resolved:
            self.assertEqual(resolved, self.referrer["properties"]["foo"])

    def test_it_resolves_local_refs_with_id(self):
        schema = {"id": "http://bar/schema#", "a": {"foo": "bar"}}
        resolver = validators._RefResolver.from_schema(
            schema,
            id_of=lambda schema: schema.get("id", ""),
        )
        with resolver.resolving("#/a") as resolved:
            self.assertEqual(resolved, schema["a"])
        with resolver.resolving("http://bar/schema#/a") as resolved:
            self.assertEqual(resolved, schema["a"])

    def test_it_retrieves_stored_refs(self):
        with self.resolver.resolving(self.stored_uri) as resolved:
            self.assertIs(resolved, self.stored_schema)

        self.resolver.store["cached_ref"] = {"foo": 12}
        with self.resolver.resolving("cached_ref#/foo") as resolved:
            self.assertEqual(resolved, 12)

    def test_it_retrieves_unstored_refs_via_requests(self):
        ref = "http://bar#baz"
        schema = {"baz": 12}

        if "requests" in sys.modules:  # pragma: no cover
            self.addCleanup(
                sys.modules.__setitem__, "requests", sys.modules["requests"],
            )
        sys.modules["requests"] = ReallyFakeRequests({"http://bar": schema})

        with self.resolver.resolving(ref) as resolved:
            self.assertEqual(resolved, 12)

    def test_it_retrieves_unstored_refs_via_urlopen(self):
        ref = "http://bar#baz"
        schema = {"baz": 12}

        if "requests" in sys.modules:  # pragma: no cover
            self.addCleanup(
                sys.modules.__setitem__, "requests", sys.modules["requests"],
            )
        sys.modules["requests"] = None

        @contextmanager
        def fake_urlopen(url):
            self.assertEqual(url, "http://bar")
            yield BytesIO(json.dumps(schema).encode("utf8"))

        with mock.patch("urllib.request.urlopen", new=fake_urlopen):  # noqa: SIM117
            with self.resolver.resolving(ref) as resolved:
                pass
        self.assertEqual(resolved, 12)

    def test_it_retrieves_local_refs_via_urlopen(self):
        with tempfile.NamedTemporaryFile(delete=False, mode="wt") as tempf:
            self.addCleanup(os.remove, tempf.name)
            json.dump({"foo": "bar"}, tempf)

        ref = f"file://{pathname2url(tempf.name)}#foo"
        with self.resolver.resolving(ref) as resolved:
            self.assertEqual(resolved, "bar")

    def test_it_can_construct_a_base_uri_from_a_schema(self):
        schema = {"id": "foo"}
        resolver = validators._RefResolver.from_schema(
            schema,
            id_of=lambda schema: schema.get("id", ""),
        )
        self.assertEqual(resolver.base_uri, "foo")
        self.assertEqual(resolver.resolution_scope, "foo")
        with resolver.resolving("") as resolved:
            self.assertEqual(resolved, schema)
        with resolver.resolving("#") as resolved:
            self.assertEqual(resolved, schema)
        with resolver.resolving("foo") as resolved:
            self.assertEqual(resolved, schema)
        with resolver.resolving("foo#") as resolved:
            self.assertEqual(resolved, schema)

    def test_it_can_construct_a_base_uri_from_a_schema_without_id(self):
        schema = {}
        resolver = validators._RefResolver.from_schema(schema)
        self.assertEqual(resolver.base_uri, "")
        self.assertEqual(resolver.resolution_scope, "")
        with resolver.resolving("") as resolved:
            self.assertEqual(resolved, schema)
        with resolver.resolving("#") as resolved:
            self.assertEqual(resolved, schema)

    def test_custom_uri_scheme_handlers(self):
        def handler(url):
            self.assertEqual(url, ref)
            return schema

        schema = {"foo": "bar"}
        ref = "foo://bar"
        resolver = validators._RefResolver("", {}, handlers={"foo": handler})
        with resolver.resolving(ref) as resolved:
            self.assertEqual(resolved, schema)

    def test_cache_remote_on(self):
        response = [object()]

        def handler(url):
            try:
                return response.pop()
            except IndexError:  # pragma: no cover
                self.fail("Response must not have been cached!")

        ref = "foo://bar"
        resolver = validators._RefResolver(
            "", {}, cache_remote=True, handlers={"foo": handler},
        )
        with resolver.resolving(ref):
            pass
        with resolver.resolving(ref):
            pass

    def test_cache_remote_off(self):
        response = [object()]

        def handler(url):
            try:
                return response.pop()
            except IndexError:  # pragma: no cover
                self.fail("Handler called twice!")

        ref = "foo://bar"
        resolver = validators._RefResolver(
            "", {}, cache_remote=False, handlers={"foo": handler},
        )
        with resolver.resolving(ref):
            pass

    def test_if_you_give_it_junk_you_get_a_resolution_error(self):
        error = ValueError("Oh no! What's this?")

        def handler(url):
            raise error

        ref = "foo://bar"
        resolver = validators._RefResolver("", {}, handlers={"foo": handler})
        with self.assertRaises(exceptions._RefResolutionError) as err:  # noqa: SIM117
            with resolver.resolving(ref):
                self.fail("Shouldn't get this far!")  # pragma: no cover
        self.assertEqual(err.exception, exceptions._RefResolutionError(error))

    def test_helpful_error_message_on_failed_pop_scope(self):
        resolver = validators._RefResolver("", {})
        resolver.pop_scope()
        with self.assertRaises(exceptions._RefResolutionError) as exc:
            resolver.pop_scope()
        self.assertIn("Failed to pop the scope", str(exc.exception))

    def test_pointer_within_schema_with_different_id(self):
        """
        See #1085.
        """
        schema = validators.Draft7Validator.META_SCHEMA
        one = validators._RefResolver("", schema)
        validator = validators.Draft7Validator(schema, resolver=one)
        self.assertFalse(validator.is_valid({"maxLength": "foo"}))

        another = {
            "allOf": [{"$ref": validators.Draft7Validator.META_SCHEMA["$id"]}],
        }
        two = validators._RefResolver("", another)
        validator = validators.Draft7Validator(another, resolver=two)
        self.assertFalse(validator.is_valid({"maxLength": "foo"}))

    def test_newly_created_validator_with_ref_resolver(self):
        """
        See https://github.com/python-jsonschema/jsonschema/issues/1061#issuecomment-1624266555.
        """

        def handle(uri):
            self.assertEqual(uri, "http://example.com/foo")
            return {"type": "integer"}

        resolver = validators._RefResolver("", {}, handlers={"http": handle})
        Validator = validators.create(
            meta_schema={},
            validators=validators.Draft4Validator.VALIDATORS,
        )
        schema = {"$id": "http://example.com/bar", "$ref": "foo"}
        validator = Validator(schema, resolver=resolver)
        self.assertEqual(
            (validator.is_valid({}), validator.is_valid(37)),
            (False, True),
        )

    def test_refresolver_with_pointer_in_schema_with_no_id(self):
        """
        See https://github.com/python-jsonschema/jsonschema/issues/1124#issuecomment-1632574249.
        """

        schema = {
            "properties": {"x": {"$ref": "#/definitions/x"}},
            "definitions": {"x": {"type": "integer"}},
        }

        validator = validators.Draft202012Validator(
            schema,
            resolver=validators._RefResolver("", schema),
        )
        self.assertEqual(
            (validator.is_valid({"x": "y"}), validator.is_valid({"x": 37})),
            (False, True),
        )



def sorted_errors(errors):
    def key(error):
        return (
            [str(e) for e in error.path],
            [str(e) for e in error.schema_path],
        )
    return sorted(errors, key=key)


@define
class ReallyFakeRequests:

    _responses: dict[str, Any]

    def get(self, url):
        response = self._responses.get(url)
        if url is None:  # pragma: no cover
            raise ValueError("Unknown URL: " + repr(url))
        return _ReallyFakeJSONResponse(json.dumps(response))


@define
class _ReallyFakeJSONResponse:

    _response: str

    def json(self):
        return json.loads(self._response)
