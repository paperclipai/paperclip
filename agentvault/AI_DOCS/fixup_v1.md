Implementation Plan
Scope: Core End-to-End Flow
The goal is: Package agent -> Deploy to local replica -> Execute agent method -> Fetch state -> Query status. This requires fixing icpClient.ts, actor.ts, and the CLI commands that use them.
---
Day 1: Fix ICP Client Core (C1-C7)
Priority: Replace all stubs in icpClient.ts with real @dfinity/agent management canister calls.
Task 1.1: Fix checkConnection() (C5)
- Only call fetchRootKey() when network === 'local'
- On mainnet, use agent.status() to check connectivity instead
- File: src/deployment/icpClient.ts:42-57
Task 1.2: Implement real deploy() (C1)
- Use @dfinity/agent management canister to:
  1. provisional_create_canister_with_cycles for new canisters
  2. install_code with mode install or reinstall
- For upgrades: install_code with mode upgrade
- Return real canister ID from management canister response
- File: src/deployment/icpClient.ts:66-105
Task 1.3: Implement real getCanisterStatus() (C4)
- Call management canister's canister_status method
- Parse real status, memory_size, cycles from response
- Update principalPattern regex to accept valid Principal formats
- File: src/deployment/icpClient.ts:194-223
Task 1.4: Implement real executeAgent() (C2)
- Use callAgentMethod() (which already has the Actor switch mapping) instead of returning fake strings
- Route through Actor for real canister calls
- File: src/deployment/icpClient.ts:115-142
Task 1.5: Implement real loadAgentWasm() (C3)
- Use Actor to call the canister's loadAgentWasm method with actual WASM bytes
- File: src/deployment/icpClient.ts:152-186
Task 1.6: Fix calculateWasmHash() (C6)
- Replace base64 truncation with crypto.createHash('sha256').update(buffer).digest('hex')
- File: src/deployment/icpClient.ts:286-289
Task 1.7: Fix createAuthenticatedAgent() (C7)
- Accept an Ed25519KeyIdentity or similar identity parameter
- Wire identity to the HttpAgent for update calls
- File: src/canister/actor.ts:316-322
---
Day 2: Fix Security & Monitoring Bugs (H5, H8-H11)
Task 2.1: Fix timing attack in encryption (H8)
- Replace === with crypto.timingSafeEqual() for HMAC verification
- File: src/canister/encryption.ts:219-222
Task 2.2: Fix VetKeys zero IV (H5)
- Generate random IVs with crypto.randomBytes(12) for GCM / crypto.randomBytes(16) for CBC
- File: src/security/vetkeys.ts:255-259
Task 2.3: Fix cycle value parsing (H9)
- Correct multipliers: K=10^3, M=10^6, G=10^9, T=10^12
- File: src/monitoring/info.ts:85-101
Task 2.4: Fix formatCycles (H10)
- Correct divisor to 10^12 for T cycles display
- File: src/monitoring/health.ts:146
Task 2.5: Fix memory threshold math (H11)
- Compare against actual IC canister memory limit (~4GB) instead of 1024 * percent
- File: src/monitoring/health.ts:42-46 and src/monitoring/alerting.ts:124,134
Task 2.6: Fix Math.random() in security contexts (M15)
- Replace with crypto.randomBytes() in vetkeys.ts:219 and icpClient.ts:558-573
---
Day 3: Fix CLI Stubs for Core Flow (M8-M11)
Task 3.1: Implement init command (M8)
- Create project directory structure: .agentvault/, agent config file, example entry point
- File: cli/commands/init.ts
Task 3.2: Implement status command (M9)
- Check for .agentvault/ directory, read agent configs, check for deployed canisters
- File: cli/commands/status.ts
Task 3.3: Fix fetch command (M10)
- Use callAgentMethod('agent_get_state') instead of hardcoded state
- File: cli/commands/fetch.ts
Task 3.4: Fix exec command (M11)
- Use callAgentMethod('agent_step') for real execution
- File: cli/commands/exec.ts
Task 3.5: Fix show command
- Use callAgentMethod for tasks, memories, context queries
- File: cli/commands/show.ts
---
Day 4: Fix ESM/Runtime Issues & Module Bugs
Task 4.1: Fix require() in ESM modules (M1, M2)
- Replace require('arweave') with await import('arweave') in src/archival/arweave-client.ts:81
- Replace require('axios') with await import('axios') in src/inference/bittensor-client.ts:94
Task 4.2: Fix Candid/TypeScript mismatch (M12)
- Align setContext signature between actor.idl.ts and actor.ts
Task 4.3: Fix identity module parameter passing (M14)
- Change { name } to { identity: name } in src/icp/identity.ts:54,76
Task 4.4: Fix backup export to include real data (H12)
- Collect agent config, canister state, and metadata in the backup bundle
- File: src/backup/backup.ts:66-117
Task 4.5: Fix promotion to actually deploy (H14)
- Wire promoteCanister() to call deployAgent() on the target environment
- File: src/deployment/promotion.ts:97-127
---
Day 5: Add Tests for Core Flow
Task 5.1: Add tests for the real icpClient.ts methods
- Test deploy(), getCanisterStatus(), calculateWasmHash()
- Mock @dfinity/agent for unit tests, but also add integration test flag for real replica
Task 5.2: Add tests for init and status commands
Task 5.3: Add tests for encryption.ts (HMAC timing-safe check)
Task 5.4: Add tests for monitoring/info.ts (parseCycleValue)
Task 5.5: Add tests for monitoring/health.ts (threshold math, formatCycles)
---
Day 6: End-to-End Integration Test
Task 6.1: Create integration test that runs the full pipeline:
1. dfx start --background
2. agentvault init test-agent
3. agentvault package examples/agents/generic
4. agentvault deploy --network local
5. agentvault exec --canister-id <real-id>
6. agentvault show --canister-id <real-id>
7. agentvault fetch --canister-id <real-id>
8. dfx stop
Task 6.2: Verify npm run test still passes (354+ tests)
Task 6.3: Verify npm run typecheck passes
---
Day 7: Release Prep
Task 7.1: Mark non-core features as experimental
- Add [Experimental] prefix to CLI help text for: inference, archive, profile, trace, wallet-multi-send, wallet-process-queue
- Add warning messages when these commands are invoked
Task 7.2: Update README to reflect actual status
Task 7.3: Update CHANGELOG for this release
Task 7.4: Run npm run build and verify clean output
---
Out of Scope (Deferred)
These are real issues but not blocking the core flow:
| Issue | Reason for deferral |
|-------|-------------------|
| H1-H3: Wallet key derivation crypto | Wallet is not in the core flow. Mark as experimental. |
| H4: VetKeys mock adapter | Feature-flag it. Not needed for basic deploy/execute. |
| H6: Fake Shamir's SSS | Security module is experimental. |
| H7: Fake multisig signatures | Approve workflow is experimental. |
| H13: Bittensor client | Inference is experimental. |
| M3: Wallet storage encryption | Wallet is experimental. |
| M4-M7: Wallet module bugs | Wallet is experimental. |
| M13: Replace console.* with logger | Nice-to-have, not blocking. |
| Webapp bugs | Webapp is separate, not in core CLI flow. |
| 80%+ test coverage | Would take more than a week for 68 untested files. Focus on core flow tests. |
---
Estimated Effort
| Day | Tasks | Files Modified |
|-----|-------|---------------|
| 1 | ICP Client real implementation | 2 files (icpClient.ts, actor.ts) |
| 2 | Security & monitoring fixes | 5 files |
| 3 | CLI stub implementations | 5 files |
| 4 | ESM/runtime/module bug fixes | 6 files |
| 5 | Core flow tests | 5 new test files |
| 6 | E2E integration test | 1 new test file, verify existing |
| 7 | Release prep | README, CHANGELOG, help text |
Total: ~24 files modified/created over 7 days.
