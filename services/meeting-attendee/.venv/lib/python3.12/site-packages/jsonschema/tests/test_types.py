"""
Tests for the `TypeChecker`-based type interface.

The actual correctness of the type checking is handled in
`test_jsonschema_test_suite`; these tests check that TypeChecker
functions correctly at a more granular level.
"""
from collections import namedtuple
from unittest import TestCase

from jsonschema import ValidationError, _keywords
from jsonschema._types import TypeChecker
from jsonschema.exceptions import UndefinedTypeCheck, UnknownType
from jsonschema.validators import Draft202012Validator, extend


def equals_2(checker, instance):
    return instance == 2


def is_namedtuple(instance):
    return isinstance(instance, tuple) and getattr(instance, "_fields", None)


def is_object_or_named_tuple(checker, instance):
    if Draft202012Validator.TYPE_CHECKER.is_type(instance, "object"):
        return True
    return is_namedtuple(instance)


class TestTypeChecker(TestCase):
    def test_is_type(self):
        checker = TypeChecker({"two": equals_2})
        self.assertEqual(
            (
                checker.is_type(instance=2, type="two"),
                checker.is_type(instance="bar", type="two"),
            ),
            (True, False),
        )

    def test_is_unknown_type(self):
        with self.assertRaises(UndefinedTypeCheck) as e:
            TypeChecker().is_type(4, "foobar")
        self.assertIn(
            "'foobar' is unknown to this type checker",
            str(e.exception),
        )
        self.assertTrue(
            e.exception.__suppress_context__,
            msg="Expected the internal KeyError to be hidden.",
        )

    def test_checks_can_be_added_at_init(self):
        checker = TypeChecker({"two": equals_2})
        self.assertEqual(checker, TypeChecker().redefine("two", equals_2))

    def test_redefine_existing_type(self):
        self.assertEqual(
            TypeChecker().redefine("two", object()).redefine("two", equals_2),
            TypeChecker().redefine("two", equals_2),
        )

    def test_remove(self):
        self.assertEqual(
            TypeChecker({"two": equals_2}).remove("two"),
            TypeChecker(),
        )

    def test_remove_unknown_type(self):
        with self.assertRaises(UndefinedTypeCheck) as context:
            TypeChecker().remove("foobar")
        self.assertIn("foobar", str(context.exception))

    def test_redefine_many(self):
        self.assertEqual(
            TypeChecker().redefine_many({"foo": int, "bar": str}),
            TypeChecker().redefine("foo", int).redefine("bar", str),
        )

    def test_remove_multiple(self):
        self.assertEqual(
            TypeChecker({"foo": int, "bar": str}).remove("foo", "bar"),
            TypeChecker(),
        )

    def test_type_check_can_raise_key_error(self):
        """
        Make sure no one writes:

            try:
                self._type_checkers[type](...)
            except KeyError:

        ignoring the fact that the function itself can raise that.
        """

        error = KeyError("Stuff")

        def raises_keyerror(checker, instance):
            raise error

        with self.assertRaises(KeyError) as context:
            TypeChecker({"foo": raises_keyerror}).is_type(4, "foo")

        self.assertIs(context.exception, error)

    def test_repr(self):
        checker = TypeChecker({"foo": is_namedtuple, "bar": is_namedtuple})
        self.assertEqual(repr(checker), "<TypeChecker types={'bar', 'foo'}>")


class TestCustomTypes(TestCase):
    def test_simple_type_can_be_extended(self):
        def int_or_str_int(checker, instance):
            if not isinstance(instance, (int, str)):
                return False
            try:
                int(instance)
            except ValueError:
                return False
            return True

        CustomValidator = extend(
            Draft202012Validator,
            type_checker=Draft202012Validator.TYPE_CHECKER.redefine(
                "integer", int_or_str_int,
            ),
        )
        validator = CustomValidator({"type": "integer"})

        validator.validate(4)
        validator.validate("4")

        with self.assertRaises(ValidationError):
            validator.validate(4.4)

        with self.assertRaises(ValidationError):
            validator.validate("foo")

    def test_object_can_be_extended(self):
        schema = {"type": "object"}

        Point = namedtuple("Point", ["x", "y"])

        type_checker = Draft202012Validator.TYPE_CHECKER.redefine(
            "object", is_object_or_named_tuple,
        )

        CustomValidator = extend(
            Draft202012Validator,
            type_checker=type_checker,
        )
        validator = CustomValidator(schema)

        validator.validate(Point(x=4, y=5))

    def test_object_extensions_require_custom_validators(self):
        schema = {"type": "object", "required": ["x"]}

        type_checker = Draft202012Validator.TYPE_CHECKER.redefine(
            "object", is_object_or_named_tuple,
        )

        CustomValidator = extend(
            Draft202012Validator,
            type_checker=type_checker,
        )
        validator = CustomValidator(schema)

        Point = namedtuple("Point", ["x", "y"])
        # Cannot handle required
        with self.assertRaises(ValidationError):
            validator.validate(Point(x=4, y=5))

    def test_object_extensions_can_handle_custom_validators(self):
        schema = {
            "type": "object",
            "required": ["x"],
            "properties": {"x": {"type": "integer"}},
        }

        type_checker = Draft202012Validator.TYPE_CHECKER.redefine(
            "object", is_object_or_named_tuple,
        )

        def coerce_named_tuple(fn):
            def coerced(validator, value, instance, schema):
                if is_namedtuple(instance):
                    instance = instance._asdict()
                return fn(validator, value, instance, schema)
            return coerced

        required = coerce_named_tuple(_keywords.required)
        properties = coerce_named_tuple(_keywords.properties)

        CustomValidator = extend(
            Draft202012Validator,
            type_checker=type_checker,
            validators={"required": required, "properties": properties},
        )

        validator = CustomValidator(schema)

        Point = namedtuple("Point", ["x", "y"])
        # Can now process required and properties
        validator.validate(Point(x=4, y=5))

        with self.assertRaises(ValidationError):
            validator.validate(Point(x="not an integer", y=5))

        # As well as still handle objects.
        validator.validate({"x": 4, "y": 5})

        with self.assertRaises(ValidationError):
            validator.validate({"x": "not an integer", "y": 5})

    def test_unknown_type(self):
        with self.assertRaises(UnknownType) as e:
            Draft202012Validator({}).is_type(12, "some unknown type")
        self.assertIn("'some unknown type'", str(e.exception))
