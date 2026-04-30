"""
An unused schema registry should not cause slower validation.

"Unused" here means one where no reference resolution is occurring anyhow.

See https://github.com/python-jsonschema/jsonschema/issues/1088.
"""
from pyperf import Runner
from referencing import Registry
from referencing.jsonschema import DRAFT201909

from jsonschema import Draft201909Validator

registry = Registry().with_resource(
    "urn:example:foo",
    DRAFT201909.create_resource({}),
)

schema = {"$ref": "https://json-schema.org/draft/2019-09/schema"}
instance = {"maxLength": 4}

no_registry = Draft201909Validator(schema)
with_useless_registry = Draft201909Validator(schema, registry=registry)

if __name__ == "__main__":
    runner = Runner()

    runner.bench_func(
        "no registry",
        lambda: no_registry.is_valid(instance),
    )
    runner.bench_func(
        "useless registry",
        lambda: with_useless_registry.is_valid(instance),
    )
