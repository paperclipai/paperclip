# Windows setup and native runtime

On native Windows, use the Node installation that includes npm. Packaging scripts
run `npm-cli.js` through Node, so an installation path with spaces is supported.
The local POSIX sandbox tests require Git for Windows in its standard
`Program Files/Git` location. These fixtures use Git Bash and POSIX sandbox paths;
host file transfers retain Windows drive paths. Full workspace typechecking also
requires Rust and Cargo for the native Runner. POSIX mode-bit assertions do not
validate Windows ACLs.

The root postinstall links the development plugin SDK with Windows directory
junctions. This link operation does not require Developer Mode or elevation.
Existing SDK installs are preserved, and repeated postinstalls reuse the link.

Codex observability configuration uses a compact, agent-and-settings-specific
directory on Windows. The managed account's temporary provider path is already
long; extra nested identity directories can prevent Codex from opening its SQLite
state. Credentials and conversation directories still link to the managed home.
To exercise initialization with a real installed Codex executable, set
`PAPERCLIP_TEST_CODEX_BINARY` to its full path and run
`pnpm exec vitest run packages/adapter-utils/src/codex-observability-home.windows.test.ts`.
The test uses synthetic credentials and makes no model request.

Native Codex uses the executable from its matching Windows platform package.
The native Windows runtime uses the separate `@openai/codex-native` dependency
(Codex 0.166.0) and the MXC sandbox. The ACP bridge retains its independently
qualified Codex dependency. MXC requires a supported Windows 11 build; an
unavailable sandbox fails closed. Filesystem read restrictions remain enabled.
When the installed executable is outside the system volume, only its executable
resources are copied to a hash-verified cache under
`%LOCALAPPDATA%/Paperclip/runtime-cache/native-codex`. The per-user local application
data path and its canonical cache path must be on the Windows system volume.
A relocated application data path on another volume fails setup with an explicit
error; Paperclip does not create a shared machine cache. Credentials and sessions are never
copied there. A cold cache hashes and copies the runtime once; subsequent lookups
reuse the generation while its file identities and timestamps remain unchanged.
The optional live confinement regression is:
`PAPERCLIP_LIVE_WINDOWS_MXC=1 pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/codex/windows-mxc.test.ts`.
Keep that optional dependency installed with the main Codex package. A missing
or mismatched platform package fails setup instead of using another executable.
Managed account probes use the account home prepared by the server. Windows
credential reads check regular files and path identity without Unix uid/mode
bits. Unbound credential links remain refused. The native observer detects
credential refreshes without putting credential content in its durable events.
Assigned skill snapshots use Windows write-deny ACLs, applied with the built-in
System32 whoami and icacls tools. A failed ACL operation refuses publication;
cleanup removes the snapshot's deny rules before deleting the owned tree.

Embedded PostgreSQL on Windows stops through its matching `pg_ctl.exe` with a
bounded fast shutdown. The recorded postmaster PID must match the owned process
before shutdown. This lets PostgreSQL flush and retire its workers before a
development preflight or restart releases the port. An ownership mismatch or
failed shutdown is reported instead of forcing termination of a process tree.

Windows x64 Codex agents keep Legacy as their automatic default until Windows Runner daemons ship in public releases. Explicit native selection remains available for installations with a locally built daemon or PAPERCLIP_RUNNER_BINARY.

## Windows process handoff evidence

The Windows process supervisor reports settlement through a named pipe after the
kernel job completion event and an active-process count of zero. The parent
requires a matching supervisor exit code and a per-launch secret. The secret is
passed only to the supervisor environment and removed before the provider is
created. It is absent from argv and the provider environment. Writable temporary
files and a killed supervisor cannot authorize handoff. Missing or invalid proof
keeps handoff blocked. The pipe closes when launch fails or settlement finishes.
