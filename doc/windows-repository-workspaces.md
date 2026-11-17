# Repository workspaces on Windows

Managed repository clones on Windows pass `git -c core.longpaths=true clone` so
long paths work during repository initialization and template copying. They also
save `core.longpaths=true` in the clone's local Git configuration for the initial
checkout and later branch checkouts, including when managed credentials disable
global and system Git config.
Their temporary clone directories use a short name under the canonical staging
parent. This keeps Windows Git remote helpers below their metadata path limits
without changing the published workspace or crossing filesystem boundaries.
Nested-clone migration requires a replacement shared base to persist the same
long-path setting; otherwise it skips migration and keeps the standalone clone.
Object-backed restores initialize with global and system Git config disabled on
Windows, then save the setting before fetching objects or checking out files.
Use `GIT_TEMPLATE_DIR` for an explicit template directory on this restore path.
Isolated workspace rehomes also preserve it and allow Git-generated settings such
as `core.symlinks=false`. On Windows, an expired source
whose Git config is no longer available requires a shared base with long paths enabled.
Fresh isolated attempts on Windows use a compact `w/` namespace with full UUIDs
encoded in lowercase base36 and a short `w` seed directory. The identity remains
reversible; source admission, task reuse and chat validation use the same parser.
Existing legacy attempts stay in place and keep their files. Conflicting legacy
and compact roots are rejected rather than silently switching directories.
This shortens the published nested checkout as well as its clone staging path,
so later HTTP fetches stay within Git for Windows' metadata path limit.
