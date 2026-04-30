"""
Fuzzing setup for OSS-Fuzz.

See https://github.com/google/oss-fuzz/tree/master/projects/jsonschema for the
other half of the setup here.
"""
import sys

from hypothesis import given, strategies

import jsonschema

PRIM = strategies.one_of(
    strategies.booleans(),
    strategies.integers(),
    strategies.floats(allow_nan=False, allow_infinity=False),
    strategies.text(),
)
DICT = strategies.recursive(
    base=strategies.one_of(
        strategies.booleans(),
        strategies.dictionaries(strategies.text(), PRIM),
    ),
    extend=lambda inner: strategies.dictionaries(strategies.text(), inner),
)


@given(obj1=DICT, obj2=DICT)
def test_schemas(obj1, obj2):
    try:
        jsonschema.validate(instance=obj1, schema=obj2)
    except jsonschema.exceptions.ValidationError:
        pass
    except jsonschema.exceptions.SchemaError:
        pass


def main():
    atheris.instrument_all()
    atheris.Setup(
        sys.argv,
        test_schemas.hypothesis.fuzz_one_input,
        enable_python_coverage=True,
    )
    atheris.Fuzz()


if __name__ == "__main__":
    import atheris
    main()
