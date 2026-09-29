#!/usr/bin/env python3
# SYNTHETIC FIXTURE ONLY. Transplant the DB-source pattern, not this job body.
import subprocess

subprocess.run(
    ["/usr/local/libexec/paperclip/pg-client", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM fleet_records"],
    check=True,
    stdout=subprocess.DEVNULL,
)
