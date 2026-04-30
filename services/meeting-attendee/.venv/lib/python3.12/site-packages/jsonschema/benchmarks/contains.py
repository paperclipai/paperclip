"""
A benchmark for validation of the `contains` keyword.
"""

from pyperf import Runner

from jsonschema import Draft202012Validator

schema = {
    "type": "array",
    "contains": {"const": 37},
}
validator = Draft202012Validator(schema)

size = 1000
beginning = [37] + [0] * (size - 1)
middle = [0] * (size // 2) + [37] + [0] * (size // 2)
end = [0] * (size - 1) + [37]
invalid = [0] * size


if __name__ == "__main__":
    runner = Runner()
    runner.bench_func("baseline", lambda: validator.is_valid([]))
    runner.bench_func("beginning", lambda: validator.is_valid(beginning))
    runner.bench_func("middle", lambda: validator.is_valid(middle))
    runner.bench_func("end", lambda: validator.is_valid(end))
    runner.bench_func("invalid", lambda: validator.is_valid(invalid))
