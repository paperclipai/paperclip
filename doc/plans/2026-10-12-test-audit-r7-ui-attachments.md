# Test audit, Round 7 UI — Video attachments follow-up

This isolated follow-up removes **1 registered executions, 1 root renders and 22 net test lines** from `ui/src/components/IssueAttachmentsSection.test.tsx`. It changes no production lines and adds no helper. The pinned audit base is `c39262305b6b48a5decd564af8369083cd972b33`. Prior UI proof remains unchanged. Registration/render reductions are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact migrations

| Retired registration | Keeper | Original observations retained |
|---|---|---|
| `renders video attachments through the same player used for artifact outputs` | `lets video attachments open the shared media gallery` | const video = container.querySelector("video");; expect(video?.getAttribute("src")).toBe("/api/attachments/video-attachment/content");; expect(video?.getAttribute("controls")).not.toBeNull();; expect(fetchSpy).not.toHaveBeenCalled(); |

IssueAttachmentsSection.tsx classifies the same webm attachment into VideoAttachmentCard, which passes contentPath to the actual shared OutputVideoPlayer; OutputVideoPlayer supplies native controls. Gallery forwarding stays in AttachmentActions. Both tests use the same makeAttachment overrides, fresh query client/root/fetchSpy hooks, delete callback presence and act/flush lifecycle. The retired inline fresh vi.fn for onImageClick matches the existing keeper fresh named vi.fn after binding normalization; the keeper binding remains unchanged. Move video source, controls and no-fetch checks before gallery click. MIME fallback, non-video/non-markdown, generic download and read-only tests remain distinct.

The verifier reconstructs the exact candidate text from only the declared removals and insertions, requires byte equality, and compares the entire program AST after the same migrations. Every unrelated source byte, hook, mock, test body and binding remains unchanged, outside the audit receipt’s explicitly declared duplicate-title or blank-line cleanup where applicable. Setup ASTs are equal except the explicitly normalized attachment callback binding described above where applicable. No tests are skipped, softened, suppressed or added. Each file remains included in `@paperclipai/ui` under CI `general-workspaces-a`; Vitest file sharding selects it once across the two shards, with no workflow/config change.

## Complete-file evidence

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 8 | 8 | 0 | 0 |
| Candidate | 7 | 7 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/IssueAttachmentsSection.test.tsx`.

All 3 separately selected positive keeper controls passed. Every deliberate behavior mutation failed at the corresponding intended keeper assertion, not setup, timeout or another guard:

| Mutation | Intended assertion |
|---|---|
| source | `expect(video?.getAttribute("src")).toBe(` |
| controls | `expect(video?.getAttribute("controls")).not.toBeNull()` |
| fetch | `expect(fetchSpy).not.toHaveBeenCalled()` |

Every mutated production owner was restored byte for byte after each mutation and checked against pinned Git bytes. Name-filtered controls select exactly one keeper; their unselected tests are not full-suite evidence. [Compact controls](2026-10-12-test-audit-r7-ui-attachments-controls.json) preserve source/owner hashes, exact migration map, body verifier digests, complete run/log digests, intended failure receipts and restoration checks. Temporary AST/receipt scripts initially needed corrections for chained assertions or statement position; those verifier attempts produced no accepted test evidence.

The earlier broad local `pnpm test:run` was intentionally stopped before completion; it is not claimed as a pass. These focused runs do not substitute for pending delivery-head CI. No push, rebase, pull request or merge is included in this packet.
