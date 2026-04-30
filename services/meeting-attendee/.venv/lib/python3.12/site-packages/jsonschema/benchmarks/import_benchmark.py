"""
A benchmark which measures the import time of jsonschema
"""

import subprocess
import sys


def import_time(loops):
    total_us = 0
    for _ in range(loops):
        p = subprocess.run(  # noqa: S603 (arguments are static)
            [sys.executable, "-X", "importtime", "-c", "import jsonschema"],
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            check=True,
        )

        line = p.stderr.splitlines()[-1]
        field = line.split(b"|")[-2].strip()
        us = int(field)  # microseconds
        total_us += us

    # pyperf expects seconds
    return total_us / 1_000_000.0

if __name__ == "__main__":
    from pyperf import Runner
    runner = Runner()

    runner.bench_time_func("Import time (cumulative)", import_time)
