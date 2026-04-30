from __future__ import annotations

from typing import TYPE_CHECKING
import numbers

from attrs import evolve, field, frozen
from rpds import HashTrieMap

from jsonschema.exceptions import UndefinedTypeCheck

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from typing import Any


# unfortunately, the type of HashTrieMap is generic, and if used as an attrs
# converter, the generic type is presented to mypy, which then fails to match
# the concrete type of a type checker mapping
# this "do nothing" wrapper presents the correct information to mypy
def _typed_map_converter(
    init_val: Mapping[str, Callable[[TypeChecker, Any], bool]],
) -> HashTrieMap[str, Callable[[TypeChecker, Any], bool]]:
    return HashTrieMap.convert(init_val)


def is_array(checker, instance):
    return isinstance(instance, list)


def is_bool(checker, instance):
    return isinstance(instance, bool)


def is_integer(checker, instance):
    # bool inherits from int, so ensure bools aren't reported as ints
    if isinstance(instance, bool):
        return False
    return isinstance(instance, int)


def is_null(checker, instance):
    return instance is None


def is_number(checker, instance):
    # bool inherits from int, so ensure bools aren't reported as ints
    if isinstance(instance, bool):
        return False
    return isinstance(instance, numbers.Number)


def is_object(checker, instance):
    return isinstance(instance, dict)


def is_string(checker, instance):
    return isinstance(instance, str)


def is_any(checker, instance):
    return True


@frozen(repr=False)
class TypeChecker:
    """
    A :kw:`type` property checker.

    A `TypeChecker` performs type checking for a `Validator`, converting
    between the defined JSON Schema types and some associated Python types or
    objects.

    Modifying the behavior just mentioned by redefining which Python objects
    are considered to be of which JSON Schema types can be done using
    `TypeChecker.redefine` or `TypeChecker.redefine_many`, and types can be
    removed via `TypeChecker.remove`. Each of these return a new `TypeChecker`.

    Arguments:

        type_checkers:

            The initial mapping of types to their checking functions.

    """

    _type_checkers: HashTrieMap[
        str, Callable[[TypeChecker, Any], bool],
    ] = field(default=HashTrieMap(), converter=_typed_map_converter)

    def __repr__(self):
        types = ", ".join(repr(k) for k in sorted(self._type_checkers))
        return f"<{self.__class__.__name__} types={{{types}}}>"

    def is_type(self, instance, type: str) -> bool:
        """
        Check if the instance is of the appropriate type.

        Arguments:

            instance:

                The instance to check

            type:

                The name of the type that is expected.

        Raises:

            `jsonschema.exceptions.UndefinedTypeCheck`:

                if ``type`` is unknown to this object.

        """
        try:
            fn = self._type_checkers[type]
        except KeyError:
            raise UndefinedTypeCheck(type) from None

        return fn(self, instance)

    def redefine(self, type: str, fn) -> TypeChecker:
        """
        Produce a new checker with the given type redefined.

        Arguments:

            type:

                The name of the type to check.

            fn (collections.abc.Callable):

                A callable taking exactly two parameters - the type
                checker calling the function and the instance to check.
                The function should return true if instance is of this
                type and false otherwise.

        """
        return self.redefine_many({type: fn})

    def redefine_many(self, definitions=()) -> TypeChecker:
        """
        Produce a new checker with the given types redefined.

        Arguments:

            definitions (dict):

                A dictionary mapping types to their checking functions.

        """
        type_checkers = self._type_checkers.update(definitions)
        return evolve(self, type_checkers=type_checkers)

    def remove(self, *types) -> TypeChecker:
        """
        Produce a new checker with the given types forgotten.

        Arguments:

            types:

                the names of the types to remove.

        Raises:

            `jsonschema.exceptions.UndefinedTypeCheck`:

                if any given type is unknown to this object

        """
        type_checkers = self._type_checkers
        for each in types:
            try:
                type_checkers = type_checkers.remove(each)
            except KeyError:
                raise UndefinedTypeCheck(each) from None
        return evolve(self, type_checkers=type_checkers)


draft3_type_checker = TypeChecker(
    {
        "any": is_any,
        "array": is_array,
        "boolean": is_bool,
        "integer": is_integer,
        "object": is_object,
        "null": is_null,
        "number": is_number,
        "string": is_string,
    },
)
draft4_type_checker = draft3_type_checker.remove("any")
draft6_type_checker = draft4_type_checker.redefine(
    "integer",
    lambda checker, instance: (
        is_integer(checker, instance)
        or (isinstance(instance, float) and instance.is_integer())
    ),
)
draft7_type_checker = draft6_type_checker
draft201909_type_checker = draft7_type_checker
draft202012_type_checker = draft201909_type_checker
