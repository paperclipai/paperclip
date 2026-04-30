"""
A benchmark for validation of schemas containing lots of useless keywords.

Checks we filter them out once, ahead of time.
"""

from pyperf import Runner

from jsonschema import Draft202012Validator

NUM_USELESS = 100000
schema = dict(
    [
        ("not", {"const": 42}),
        *((str(i), i) for i in range(NUM_USELESS)),
        ("type", "integer"),
        *((str(i), i) for i in range(NUM_USELESS, NUM_USELESS)),
        ("minimum", 37),
    ],
)
validator = Draft202012Validator(schema)

valid = 3737
invalid = 12


if __name__ == "__main__":
    runner = Runner()
    runner.bench_func("beginning of schema", lambda: validator.is_valid(42))
    runner.bench_func("middle of schema", lambda: validator.is_valid("foo"))
    runner.bench_func("end of schema", lambda: validator.is_valid(12))
    runner.bench_func("valid", lambda: validator.is_valid(3737))
