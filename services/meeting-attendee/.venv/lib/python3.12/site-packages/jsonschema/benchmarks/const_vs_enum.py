"""
A benchmark for comparing equivalent validation of `const` and `enum`.
"""

from pyperf import Runner

from jsonschema import Draft202012Validator

value = [37] * 100
const_schema = {"const": list(value)}
enum_schema = {"enum": [list(value)]}

valid = list(value)
invalid = [*valid, 73]

const = Draft202012Validator(const_schema)
enum = Draft202012Validator(enum_schema)

assert const.is_valid(valid)
assert enum.is_valid(valid)
assert not const.is_valid(invalid)
assert not enum.is_valid(invalid)


if __name__ == "__main__":
    runner = Runner()
    runner.bench_func("const valid", lambda: const.is_valid(valid))
    runner.bench_func("const invalid", lambda: const.is_valid(invalid))
    runner.bench_func("enum valid", lambda: enum.is_valid(valid))
    runner.bench_func("enum invalid", lambda: enum.is_valid(invalid))
