# Repository workspace restoration compatibility

New isolated attempts use the standard task directory layout on every platform.
Existing compact attempts remain readable and reusable with their original company,
task and attempt identities. Recovery does not move or delete their files. If the
standard and compact paths both exist, automatic selection fails.

Git restoration and shared-base migration preserve a source checkout's recorded
long-path setting. A replacement that cannot preserve it is rejected. These checks
also apply on Linux when restoring an existing checkout. They do not enable a
native Windows agent runtime. Expiration is refused when a checkout requires
a local long-path setting that the saved restore recipe cannot reproduce; the
original checkout stays intact.

Worktree pointer paths must be absolute and are normalized before ownership checks.
Temporary clone paths stay out of concurrent repository scans. This PR does not
add Windows clone initialization, publication retries or a new short-path layout.
