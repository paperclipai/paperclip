from pyperf import Runner

from jsonschema import Draft202012Validator

schema = {
    "type": "array",
    "minLength": 1,
    "maxLength": 1,
    "items": {"type": "integer"},
}


if __name__ == "__main__":
    Runner().bench_func("validator creation", Draft202012Validator, schema)
