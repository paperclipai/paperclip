# Shared skill repository qualification

Status: qualification in progress. These measurements do not prove a completed
agent start. No live instance has been migrated to this layout.

Repository skills previously included a complete repository in each portable
skill. The new native context retains one verified repository asset and small
discovery entries. This reduces copies within a session. It does not remove
existing saved sessions or change backup retention.

## Controlled provider staging

Run `node packages/paperclip-runner/scripts/benchmark-shared-skill-layout.mjs
--temp-root=<owned scratch directory> --files=128 --repetitions=3` after building
the Runner TypeScript package. The script uses three alternating pairs and fresh
provider homes. It measures fixture setup, staging, shared warm verification and
cleanup separately. It verifies physical file counts and rejects a same-size
source change whose modification time was restored.

The fixture contains 128 payload files of 16,384 bytes and four skill entries.
These are small synthetic repositories, not the full production workload.
The old portable path retains its existing checks; the shared path also verifies
the source and delivered bytes. The results therefore include that additional
integrity work. No timestamp-only trust is used.

| Platform | Selected entries | Portable staging median | Shared staging median |
| --- | ---: | ---: | ---: |
| Windows | 2 | 2,146.91 ms | 2,919.80 ms |
| Windows | 4 | 1,693.37 ms | 1,347.31 ms |
| Linux in WSL | 2 | 806.52 ms | 862.33 ms |
| Linux in WSL | 4 | 1,703.49 ms | 969.13 ms |

For four entries, delivered bytes fell from 8,390,408 to 2,097,992. Delivered
files fell from 532 to 136. The payload appeared four times in the portable
home and once in the shared home. For two entries, shared staging was slower
on both platforms. These results do not establish a general OS speed ranking.

Raw results: [Windows](2026-11-17-shared-skill-layout-windows.json) and
[Linux](2026-11-17-shared-skill-layout-linux.json). Windows used Node 26.12.1;
Linux used Node 24.22.3 and glibc 2.41 on its native WSL filesystem. The tested
integration source was `a9db65067f`, tree
`7b88e8e87be00359767d45411f8621876a163dc2`. The Linux source tree was checked
against that tree before its final Runner test run. Its local snapshot commit
differs from the integration commit; it is not a different source revision.

## Held-version native preparation

The isolated native Codex attempt held the same 13 skill versions as the earlier
Windows measurements: 24,975 logical files and 295,533,924 logical bytes.
The admitted v12 context contained eight repository entries referencing two
repository assets: 6,239 files and 73,863,652 bytes. Five standalone skills kept
their existing representation.

`runtime_context.skills` took 18,513 ms. Earlier attempts to prepare the isolated
instance had already populated some caches, so this is not a clean cold result.
The provider session did not open: Windows MXC returned `0x8007000F`. No first
tool was observed, and the failed attempt is not an end-to-end pass.

The existing real MXC confinement test passed on the NTFS volume, including an
inside write and an outside-read denial. The same test failed on the ReFS volume
with that HRESULT. This is evidence about this machine, not proof that every
ReFS volume is unsupported. The sandbox was not disabled. A proposed extra NTFS
test instance was cancelled and its temporary data removed; the original ReFS
test instance remains. Source data must not be silently moved to another volume.

## Remaining acceptance

- Complete a real native Codex start through its first tool, then warm resume.
- Report cold source assets and warm source assets separately.
- Retain the changed-file rejection checks during those runs.
- Complete the equivalent Linux run with the copied backup and existing access.
- Exercise filesystem capability handling for ReFS, NTFS and FAT32. Do not treat
  optional metadata support as a reason to skip byte checks or bypass a sandbox.
- Require the final source revision's relevant local checks and CI before rollout.

## Final review and current handoff status

The independent branch review found two issues. The final patch checks directory
ancestors before and after integrity reads. It rejects source and delivered
parent junction substitutions. On Windows, a failed ACL operation has a fallback
only after a positive FAT/FAT32/exFAT volume probe and a stable directory identity
check. Byte checks, read-only file attributes and provider sandbox policy remain.
Unknown filesystem or NTFS/ReFS permission errors still fail.

The final focused Windows check passed 170 tests in six files. The Runner SDK
TypeScript check also passed. The corresponding final Linux run did not pass:
the materialization file reported eight timeouts after two passing cases.
The isolated Linux server also stopped answering its health endpoint after its
restart. These results need diagnosis. They are not successful acceptance tests.
The local `pnpm verify` attempt produced no result before this handoff.

No successful end-to-end first-tool or warm-resume measurement is available.
This branch is a draft. The production instance has not been switched to it.
Physical FAT32 acceptance and a successful native run on this machine's ReFS
volume remain open. A positive mocked capability test is not physical-volume
qualification. Required CI and the upstream review are pending.
