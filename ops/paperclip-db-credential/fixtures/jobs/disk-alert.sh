#!/bin/sh
# SYNTHETIC FIXTURE ONLY. Transplant the DB-source pattern, not this job body.
set -eu
/usr/local/libexec/paperclip/pg-client psql -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM disk_records' >/dev/null
