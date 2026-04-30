"""
A performance benchmark using the official test suite.

This benchmarks jsonschema using every valid example in the
JSON-Schema-Test-Suite. It will take some time to complete.
"""
from pyperf import Runner

from jsonschema.tests._suite import Suite

if __name__ == "__main__":
    Suite().benchmark(runner=Runner())
