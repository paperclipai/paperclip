
"""
A benchmark for validation of applicators containing lots of useless schemas.

Signals a small possible optimization to remove all such schemas ahead of time.
"""

from pyperf import Runner

from jsonschema import Draft202012Validator as Validator

NUM_USELESS = 100000

subschema = {"const": 37}

valid = 37
invalid = 12

baseline = Validator(subschema)


# These should be indistinguishable from just `subschema`
by_name = {
    "single subschema": {
        "anyOf": Validator({"anyOf": [subschema]}),
        "allOf": Validator({"allOf": [subschema]}),
        "oneOf": Validator({"oneOf": [subschema]}),
    },
    "redundant subschemas": {
        "anyOf": Validator({"anyOf": [subschema] * NUM_USELESS}),
        "allOf": Validator({"allOf": [subschema] * NUM_USELESS}),
    },
    "useless successful subschemas (beginning)": {
        "anyOf": Validator({"anyOf": [subschema, *[True] * NUM_USELESS]}),
        "allOf": Validator({"allOf": [subschema, *[True] * NUM_USELESS]}),
    },
    "useless successful subschemas (middle)": {
        "anyOf": Validator(
            {
                "anyOf": [
                    *[True] * (NUM_USELESS // 2),
                    subschema,
                    *[True] * (NUM_USELESS // 2),
                ],
            },
        ),
        "allOf": Validator(
            {
                "allOf": [
                    *[True] * (NUM_USELESS // 2),
                    subschema,
                    *[True] * (NUM_USELESS // 2),
                ],
            },
        ),
    },
    "useless successful subschemas (end)": {
        "anyOf": Validator({"anyOf": [*[True] * NUM_USELESS, subschema]}),
        "allOf": Validator({"allOf": [*[True] * NUM_USELESS, subschema]}),
    },
    "useless failing subschemas (beginning)": {
        "anyOf": Validator({"anyOf": [subschema, *[False] * NUM_USELESS]}),
        "oneOf": Validator({"oneOf": [subschema, *[False] * NUM_USELESS]}),
    },
    "useless failing subschemas (middle)": {
        "anyOf": Validator(
            {
                "anyOf": [
                    *[False] * (NUM_USELESS // 2),
                    subschema,
                    *[False] * (NUM_USELESS // 2),
                ],
            },
        ),
        "oneOf": Validator(
            {
                "oneOf": [
                    *[False] * (NUM_USELESS // 2),
                    subschema,
                    *[False] * (NUM_USELESS // 2),
                ],
            },
        ),
    },
    "useless failing subschemas (end)": {
        "anyOf": Validator({"anyOf": [*[False] * NUM_USELESS, subschema]}),
        "oneOf": Validator({"oneOf": [*[False] * NUM_USELESS, subschema]}),
    },
}

if __name__ == "__main__":
    runner = Runner()

    runner.bench_func("baseline valid", lambda: baseline.is_valid(valid))
    runner.bench_func("baseline invalid", lambda: baseline.is_valid(invalid))

    for group, applicators in by_name.items():
        for applicator, validator in applicators.items():
            runner.bench_func(
                f"{group}: {applicator} valid",
                lambda validator=validator: validator.is_valid(valid),
            )
            runner.bench_func(
                f"{group}: {applicator} invalid",
                lambda validator=validator: validator.is_valid(invalid),
            )
