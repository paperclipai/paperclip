"""
Validating highly nested schemas shouldn't cause exponential time blowups.

See https://github.com/python-jsonschema/jsonschema/issues/1097.
"""
from itertools import cycle

from jsonschema.validators import validator_for

metaschemaish = {
    "$id": "https://example.com/draft/2020-12/schema/strict",
    "$schema": "https://json-schema.org/draft/2020-12/schema",

    "$vocabulary": {
        "https://json-schema.org/draft/2020-12/vocab/core": True,
        "https://json-schema.org/draft/2020-12/vocab/applicator": True,
        "https://json-schema.org/draft/2020-12/vocab/unevaluated": True,
        "https://json-schema.org/draft/2020-12/vocab/validation": True,
        "https://json-schema.org/draft/2020-12/vocab/meta-data": True,
        "https://json-schema.org/draft/2020-12/vocab/format-annotation": True,
        "https://json-schema.org/draft/2020-12/vocab/content": True,
    },
    "$dynamicAnchor": "meta",

    "$ref": "https://json-schema.org/draft/2020-12/schema",
    "unevaluatedProperties": False,
}


def nested_schema(levels):
    """
    Produce a schema which validates deeply nested objects and arrays.
    """

    names = cycle(["foo", "bar", "baz", "quux", "spam", "eggs"])
    schema = {"type": "object", "properties": {"ham": {"type": "string"}}}
    for _, name in zip(range(levels - 1), names):
        schema = {"type": "object", "properties": {name: schema}}
    return schema


validator = validator_for(metaschemaish)(metaschemaish)

if __name__ == "__main__":
    from pyperf import Runner
    runner = Runner()

    not_nested = nested_schema(levels=1)
    runner.bench_func("not nested", lambda: validator.is_valid(not_nested))

    for levels in range(1, 11, 3):
        schema = nested_schema(levels=levels)
        runner.bench_func(
            f"nested * {levels}",
            lambda schema=schema: validator.is_valid(schema),
        )
