# Sandbox managed runtime span test audit

Exact audit base: PR #16111, `06c1b2035df44fa03c065ddd69e8bf8df8513b86`.
This proposal is stacked after PR #16114 and changes only
`packages/adapter-utils/src/sandbox-managed-runtime.test.ts` plus this receipt.

## Change and measured scope

Retire `opens one named span per outbound restore task: restore.workspace, restore.asset.<key>` and transfer its two completed-span membership assertions to the surviving `with concurrency permitted, the workspace and asset restore task spans overlap in time` keeper. The keeper uses the same workspace, home asset, prepare arguments, and restore call. It holds both callbacks, verifies the two live spans overlap, releases them, awaits completion, and checks the exact completed span names. This preserves both overlap and completed-name contracts in one real traversal.

Owner inventory: 79 declarations / 107 cases before; 78 declarations / 106 cases after. One real fixture + prepare + restore traversal is removed. Test source changes: +3 / −21 lines, net −18. No production code, calls, or assertions outside this single transferred contract are removed.

## Evidence

The complete serial owner run passed at baseline (107/107, no skips), candidate (106/106), full revert (107/107), and restored candidate (106/106). Each used the existing Vitest runner, one worker, a unique temporary root outside Git, and no database. The source and production files were restored byte-for-byte after proof.

A real production mutation renamed only `restore.workspace` to `restore.workspace_missing` in `packages/adapter-utils/src/sandbox-managed-runtime.ts:1781`. The original test failed its exact `opened` membership assertion; the candidate keeper failed its exact live-span assertion after both tasks started. Each selected mutation run failed only its intended case. Other cases were unselected skips and are not claimed as coverage evidence. The mutation was restored before the final candidate run.

Candidate test SHA-256: `ddc0c52da16eca5f4cb2c36acefdc209bc2c17bfbba75b2080061b0c1b17d370`.
Original test SHA-256 after restoration: `1c575bfd8e391886a5a23facfa19ed149732139c908f19fb6fad650083270e25`.
Production owner SHA-256 after restoration: `2b6093b6481d9ef1f30a9c5798d2d9b4d3c8355867dad4b2bb685a554413b49d`.

Focused validation command:

```sh
node node_modules/vitest/vitest.mjs run packages/adapter-utils/src/sandbox-managed-runtime.test.ts --exclude '**/dist/**' --pool=forks --maxWorkers=1
```

No CI runtime reduction is claimed. A first baseline attempt used a temporary directory inside Git and produced unrelated fixture failures (72 passed / 35 failed); it was rejected and not used as evidence. The accepted sequence used a unique external `TMPDIR`, passed all controls, and left no source changes.

Full command transcripts, selected failure stacks, environment details, and hashes were retained in the temporary audit packet and are not part of this PR. The hash and exact owner locations above identify the reviewed candidate.
