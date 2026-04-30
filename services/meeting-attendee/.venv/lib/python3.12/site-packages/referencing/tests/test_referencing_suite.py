from pathlib import Path
import json
import os

import pytest

from referencing import Registry
from referencing.exceptions import Unresolvable
import referencing.jsonschema


class SuiteNotFound(Exception):
    def __str__(self):  # pragma: no cover
        return (
            "Cannot find the referencing suite. "
            "Set the REFERENCING_SUITE environment variable to the path to "
            "the suite, or run the test suite from alongside a full checkout "
            "of the git repository."
        )


if "REFERENCING_SUITE" in os.environ:  # pragma: no cover
    SUITE = Path(os.environ["REFERENCING_SUITE"]) / "tests"
else:
    SUITE = Path(__file__).parent.parent.parent / "suite/tests"
if not SUITE.is_dir():  # pragma: no cover
    raise SuiteNotFound()
DIALECT_IDS = json.loads(SUITE.joinpath("specifications.json").read_text())


@pytest.mark.parametrize(
    "test_path",
    [
        pytest.param(each, id=f"{each.parent.name}-{each.stem}")
        for each in SUITE.glob("*/**/*.json")
    ],
)
def test_referencing_suite(test_path, subtests):
    dialect_id = DIALECT_IDS[test_path.relative_to(SUITE).parts[0]]
    specification = referencing.jsonschema.specification_with(dialect_id)
    loaded = json.loads(test_path.read_text())
    registry = loaded["registry"]
    registry = Registry().with_resources(
        (uri, specification.create_resource(contents))
        for uri, contents in loaded["registry"].items()
    )
    for test in loaded["tests"]:
        with subtests.test(test=test):
            if "normalization" in test_path.stem:
                pytest.xfail("APIs need to change for proper URL support.")

            resolver = registry.resolver(base_uri=test.get("base_uri", ""))

            if test.get("error"):
                with pytest.raises(Unresolvable):
                    resolver.lookup(test["ref"])
            else:
                resolved = resolver.lookup(test["ref"])
                assert resolved.contents == test["target"]

                then = test.get("then")
                while then:  # pragma: no cover
                    with subtests.test(test=test, then=then):
                        resolved = resolved.resolver.lookup(then["ref"])
                        assert resolved.contents == then["target"]
                    then = then.get("then")
