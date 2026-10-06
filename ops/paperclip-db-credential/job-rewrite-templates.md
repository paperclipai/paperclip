# Six host job source rewrites (review templates)

These are source-level patch instructions for the six existing host scripts, not
copies of their business logic. The inventory below was read on 2026-09-27;
no live script, SQL body, URL or password is committed. Apply each change to a
private copy, review the complete redacted diff and the exact SQL/privileges,
then install a root-owned script. This work is **gated on founder approval**.

All six scripts are launched only by `run-host-job`, which supplies that job's
`DATABASE_URL` from its private systemd credential. Every call to a libpq CLI
must use `/usr/local/libexec/paperclip/pg-client <command> ...`; the helper
passes the connection parameters through the job UID's environment, never
through `/proc/<pid>/cmdline`. Do not pass `DATABASE_URL`, `CONN`, `PG` or `DSN`
as a CLI argument, print it, put it in a shell trace, or keep a fallback literal.
The helper rejects unsupported URL query parameters rather than dropping TLS
settings silently. Python code that uses a driver directly may use
`os.environ["DATABASE_URL"]` in process memory, with no SQL/URL logging.

| Existing script | Source sites in the 2026-09-27 inventory | Required rewrite | SQL/role gate |
| --- | --- | --- | --- |
| `daily-report.py` | `CONN` at line 7; `psql` subprocesses at 17, 111, 115 | Delete literal `CONN`. Replace each `["psql", CONN, ...]` with `["/usr/local/libexec/paperclip/pg-client", "psql", ...]`; preserve SQL and output handling. | Audit all report SELECTs; grant only referenced tables/views. |
| `fleet-hourly-watch.py` | `PG` at line 13; `psql` subprocess at 21 | Delete literal `PG`. Replace `["psql", PG, ...]` with the helper invocation; preserve the existing query and decision logic. | Grant only monitored SELECTs. |
| `agent-watchdog.py` | `DSN` at line 44; central `psql()` at 83–84; callers at 151, 227, 296 | Delete literal `DSN`. Change the central helper's subprocess argv once to `["/usr/local/libexec/paperclip/pg-client", "psql", ...]`; leave callers and actions intact. | Audit both reads and writes, including functions/triggers invoked. |
| `testdb-gc.sh` | inline DB material at 2–6, 15, 26, 39–47, 63, 76, 95; `psql` at 27 and 85 | Remove inline connection material and fallbacks. Require `${DATABASE_URL:?}`; replace each `psql`/`dropdb`/`createdb` database argument with `pg-client <command>` and no URL argument. Preserve existing safety filters for disposable database names. | Use a role restricted to explicitly inventoried disposable DBs; prove it cannot modify the Paperclip DB. If ownership/SQL prevents this, do not enable the job. |
| `hela3909-deploy-wip-cap.sh` | DB material at 21, 39, 55; `psql` at 88, 97; `pg_dump` at 39 | Remove literal URL and inline `PGPASSWORD` assignment; require `${DATABASE_URL:?}`. Call `pg-client pg_dump` and `pg-client psql` without a URL argument; preserve backup destination and SQL. | Audit cap writes and backup read rights and the filesystem target. |
| `disk-alert.sh` | DB material at 56; `psql` at 74, 77 | Remove literal URL and any fallback; require `${DATABASE_URL:?}`. Call `pg-client psql` without a URL argument; preserve alert thresholds. | Grant only alert input SELECTs. |

Python replacement shape for the first three files:

```python
import subprocess

# Keep the existing SQL, flags and return handling. Never include a DB URL in argv.
result = subprocess.run(
    ["/usr/local/libexec/paperclip/pg-client", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql],
    check=True, capture_output=True, text=True,
)
```

Shell replacement shape for the last three files:

```sh
: "${DATABASE_URL:?run-host-job must supply a private credential}"
set +x
/usr/local/libexec/paperclip/pg-client psql -X -v ON_ERROR_STOP=1 -c "$sql"
```

The six `fixtures/jobs/` files use this same connection path with disposable
tables. They deliberately contain no production SQL and must never replace the
real jobs. `container-e2e.sh` installs the fixtures under the exact production
filenames, runs each through `run-host-job` with its own role, revokes its one
required privilege, and proves the second invocation fails. The resulting
synthetic test checks the transport and role isolation. Production SQL and
filesystem effects remain explicit live rollout gates.
