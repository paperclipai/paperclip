#!/bin/sh
# SYNTHETIC FIXTURE ONLY. Transplant the DB-source pattern, not this job body.
set -eu
/usr/local/libexec/paperclip/pg-client psql -X -qAt -v ON_ERROR_STOP=1 -c 'UPDATE wipcap_state SET checked = true' >/dev/null
