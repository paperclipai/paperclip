Remaining Work: AgentVault + Polytician → Unified Product                                                                                                                               
                                                                                                                                                                                          
  Phase 0: Unblock Both Builds (prerequisite for everything)                                                                                                                              
                                                                                                                                                                                          
  0.1 — Fix AgentVault TypeScript Compilation (56 errors)                                                                                                                               

  Single blocker causing 16+ cascade test failures:
  - src/wallet/hsm/ledger-provider.ts:86 — await in non-async function pubkeyToEthAddress(). Add async keyword + Promise<string> return type. This one fix resolves 16 cascade test
  failures across wallet tests.

  Ambiguous export:
  - src/archival/index.ts:9 — ArchiveResult exported from both archive-manager.ts and arweave-archiver.ts. Use named re-exports instead of export *.

  Type incompatibilities (noble-curves):
  - src/security/bls-threshold.ts:235,293,353 — H2CPoint<Fp2> vs WeierstrassPoint<Fp2> mismatch. Cast or adjust function signatures. .toHex() doesn't exist on H2CPoint. Decision: either
  fix the types to match the noble-curves v2 API, or remove BLS threshold if it's not needed for MVP.

  Buffer/ArrayBuffer confusion:
  - src/security/webauthn.ts:108,328,334 — ArrayBuffer cast to Buffer fails. Use Buffer.from(new Uint8Array(...)). Also fix orphaned _ function/assignment.

  String | undefined narrowing (15 locations):
  - cli/commands/pilot.ts:230,375 — add null guards before buildReplicaUrl() / getPrivateReplicaStatus()
  - src/trading/ip-whitelist.ts:109,111,135,143,165,202 — add CIDR split validation
  - src/pilot/private-replica.ts:276 — guard regex match results
  - src/wallet/hsm/sgx-provider.ts:109,129 — remove unused _sessionId, unused pong

  Unused imports/variables (15 locations):
  - cli/commands/mirror.ts:27 — remove saveMirrorConfig
  - src/packaging/parsers/clawdbot.ts:186, generic.ts:141 — remove unused verbose params
  - src/wallet/hsm/ledger-provider.ts:76,120 — remove unused function + import
  - src/wallet/secure-wallet.ts:179 — remove destructured salt
  - Test files: 6 unused imports across agent-lifecycle, bittensor-inference, ephemeral-keys, vetkeys-threshold, consensus, provider test files

  Test framework type issues:
  - tests/archival/arweave-archiver.test.ts:318,337 — update vi.fn<[T], void>() to Vitest v4 syntax: vi.fn<(result: T) => void>()
  - tests/vault/bitwarden.test.ts:49,126,148 — fix execFile mock cast, add stderr type guard
  - tests/security/mfa-approval.test.ts:303,314,315,600 — add null guards for split results
  - tests/security/vetkeys-threshold.test.ts:265,285,424,432 — add array bounds checks, fix optional property types
  - tests/security/webauthn.test.ts:155, tests/wallet/secure-wallet.test.ts:222 — null guards

  Effort: ~90 minutes total. Mostly mechanical. The BLS threshold decision is the only one requiring thought.

  ---
  0.2 — Fix Polytician TypeScript Compilation (18 error instances, 3 root causes)

  EventEmitter overrides (14 errors):
  - src/events/concept-events.ts:32-49 — Add override keyword to 9 method signatures (emit, on, off overloads). Required by noImplicitOverride: true in tsconfig.

  Undefined property access:
  - src/integrations/agent-vault/connectors/memory-sync.connector.ts:117 — Add existing.updatedAt !== undefined && before comparison.

  ThoughtForm type mismatch:
  - src/integrations/agent-vault/tools/vault-tools.ts:387 — Record<string, unknown> passed where ThoughtForm expected. Validate with ThoughtFormSchema.parse() or add type assertion.

  Effort: ~8 minutes.

  ---
  0.3 — Fix Failing Tests

  AgentVault (27 failing → 0):

  ┌────────────────────────────────────────────────────┬──────────────┬─────────────────────────────────────────────────────────────────────────────────────┐
  │                     Root Cause                     │ Tests Fixed  │                                         Fix                                         │
  ├────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ ledger-provider.ts async bug                       │ 16 (cascade) │ Fixed in 0.1                                                                        │
  ├────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ deployer.test.ts + pipeline.test.ts HttpAgent mock │ 6            │ Replace vi.fn().mockImplementation(() => ({...})) with a proper class MockHttpAgent │
  ├────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ actor-types.test.ts method count                   │ 1            │ Change expected from 19 → 22, add 3 ThoughtForm methods to array                    │
  ├────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ vault/cli.test.ts subcommand count                 │ 1            │ Change expected from 7 → 8, add store                                               │
  ├────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ arweave-archiver.test.ts vi.fn generics            │ 2            │ Update to Vitest v4 type syntax                                                     │
  ├────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ mfa-approval.test.ts null checks                   │ 1            │ Add guard for .split('token=')[1]                                                   │
  └────────────────────────────────────────────────────┴──────────────┴─────────────────────────────────────────────────────────────────────────────────────┘

  Polytician (1 failing → 0):
  - tests/server.test.ts:78 — Add 'agentvault_backup' to expected tool list, change count from 10 → 11.

  Effort: ~2 hours total.

  ---
  Phase 1: REST Bridge API (P0 — blocks everything else)

  This is the critical missing piece. Polytician's HTTP clients call 6 endpoints that don't exist in AgentVault. The webapp already has a Next.js API routes structure
  (webapp/src/app/api/), and the inference route exists as a stub. The AGENTVAULT_COMPATIBILITY_PRD.md in polytician specifies the exact contract.

  1.1 — Auth Middleware

  File: webapp/src/app/api/_middleware.ts (or a shared utility)

  - Validate Authorization: Bearer <token> against AGENTVAULT_POLYTICIAN_API_TOKEN env var
  - Return 401 if missing, 403 if invalid
  - Reused by all 6 routes

  1.2 — POST /api/inference (replace stub)

  File: webapp/src/app/api/inference/route.ts (exists, currently returns { id: 'query-1', ...body })

  - Import InferenceFallbackChain from src/inference/fallback-chain.ts
  - Parse AVInferRequest (prompt, preferredBackend, maxTokens, temperature, systemPrompt)
  - If preferredBackend set, disable other providers
  - Call fallback chain, map result to { text, backend, latencyMs }
  - Return 502 if all providers fail

  1.3 — GET /api/memory-repo/branches/[branch]

  File: webapp/src/app/api/memory-repo/branches/[branch]/route.ts (new)

  - Use ICPClient to call memory_repo canister:
    - switchBranch(branch) then getCurrentState() for entries
    - log(branch) for headSha
  - Reconstruct entries with key, contentType, data, tags, metadata

  1.4 — POST /api/memory-repo/commits

  File: webapp/src/app/api/memory-repo/commits/route.ts (new)

  - Ensure branch exists (createBranch() with catch)
  - Serialize entries as JSON diff
  - Call commit(message, diff, tags) on canister
  - Return { sha, branch, author, timestamp, message, entries }

  1.5 — POST /api/memory-repo/tombstone

  File: webapp/src/app/api/memory-repo/tombstone/route.ts (new)

  - Switch to branch
  - Call commit("tombstone: <key>", JSON.stringify({ deleted: key }), ["tombstone"])
  - Return 204

  1.6 — POST /api/archival/upload

  File: webapp/src/app/api/archival/upload/route.ts (new)

  - Import ArweaveClient
  - Load JWK from config/env
  - Convert tags + metadata to Arweave transaction tags
  - Call arweaveClient.uploadData(), map to { txId, url, timestamp, tags, size }

  1.7 — GET /api/secrets/[name]

  File: webapp/src/app/api/secrets/[name]/route.ts (new)

  - Import configured SecretProvider (HashiCorp or Bitwarden)
  - Call provider.getSecret(name)
  - Return { name, value, provider, rotatedAt }
  - Must require auth — never expose secrets without it

  Effort: 3-4 days.

  ---
  Phase 2: Agent Type Detection + MCP Registration (P1, parallel tracks)

  2.1 — Polytician Agent Type Parser

  Files to create:
  - src/packaging/parsers/polytician.ts — Parse .polytician.json configs
  - Update src/packaging/parsers/index.ts — Export new parser
  - Update src/packaging/detector.ts — Add 'polytician' to AgentType union, detection heuristic (.polytician.json exists, or polytician in package.json deps)

  Detection heuristic: .polytician.json → package.json has polytician dep → dist/index.js has MCP server pattern

  Effort: 1 day.

  2.2 — MCP Server Registration in Canister

  Files to modify:
  - canister/agent.did — Add MCPServerRegistration type, 3 new methods
  - canister/agent.mo — Stable mcpServers HashMap, registerMCPServer(), listMCPServers(), removeMCPServer()
  - src/canister/actor.idl.ts — Mirror IDL changes

  Files to create:
  - cli/commands/mcp.ts — agentvault mcp register-polytician --entry <path> --namespace <ns> --health-port 8787
    - Probes Polytician health endpoint
    - Discovers tools via MCP stdio
    - Stores registration in canister

  Effort: 2 days.

  2.3 — MCP Client Utility (shared by CLI, orchestrator, webapp)

  File: src/orchestration/mcp-client.ts

  - PolyticianMCPClient class
  - Spawns Polytician as child process, connects via stdio using @modelcontextprotocol/sdk/client
  - Methods: connect(), callTool(name, args), disconnect()
  - Reused by CLI commands, orchestrator enricher, and webapp proxy routes

  Effort: 1 day.

  ---
  Phase 3: Orchestrator Context Enrichment (P1, requires Phase 2)

  3.1 — Context Enricher Module

  File: src/orchestration/polytician-enricher.ts

  - enrichWithPolyticianContext(prompt, config) → { enrichedPrompt, conceptsUsed }
  - Uses PolyticianMCPClient to:
    a. Call search_concepts with prompt as query
    b. Call read_concept for top-K results (default K=5)
    c. Prepend context block to prompt
    d. Truncate to maxContextLength (default 8000 chars)

  3.2 — Wire into Orchestrator

  File: src/orchestration/claude.ts

  - After loading conventions, before API call:
    - Check for registered Polytician server via listMCPServers()
    - If found, enrich prompt with semantic context
  - After orchestration:
    - Save result as new concept via save_concept tool

  Effort: 2 days.

  ---
  Phase 4: Inference Implementation Decision (P1)

  The inference subsystem has a complete architecture but mixed real/mock status:

  ┌────────────────┬────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────┐
  │    Provider    │                  Code Status                   │                                      What's Missing                                      │
  ├────────────────┼────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Venice AI      │ Fully implemented, ephemeral key cycling works │ Needs VENICE_API_KEY env var. Client is real.                                            │
  ├────────────────┼────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Local (Ollama) │ Fully implemented                              │ Needs Ollama running at localhost:11434                                                  │
  ├────────────────┼────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Bittensor      │ Fully implemented client                       │ Wallet signing is HMAC placeholder (not sr25519). Endpoint api.bittensor.com unverified. │
  └────────────────┴────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────┘

  Decision needed: Ship with Venice + Local first? Or invest in real Bittensor integration?

  Minimum viable inference:
  1. Set VENICE_API_KEY → Venice works immediately
  2. ollama serve + ollama pull llama3 → Local works immediately
  3. Wire the fallback chain into the /api/inference route (Phase 1.2)

  Full Bittensor support (optional, deferred):
  - Replace HMAC signing with sr25519 via @polkadot/util-crypto
  - Verify endpoint against a real Bittensor subnet
  - Generate and manage hotkey/coldkey pairs

  Effort: 4 hours for Venice+Local. 2-3 days for Bittensor.

  ---
  Phase 5: Dashboard + CLI (P2)

  5.1 — Webapp Dashboard: "Semantic Memory" Tab

  New files in webapp/:
  - src/app/api/polytician/[agentId]/stats/route.ts
  - src/app/api/polytician/[agentId]/concepts/route.ts
  - src/app/api/polytician/[agentId]/concepts/[id]/route.ts
  - src/app/api/polytician/[agentId]/search/route.ts
  - src/app/api/polytician/[agentId]/archive/route.ts
  - src/components/ConceptList.tsx — Paginated table with tag badges, representation icons
  - src/components/SemanticSearchBar.tsx — Debounced search → result cards with distance bars
  - src/components/ConceptGraph.tsx — Force-directed entity/relationship graph (SVG)
  - src/components/ArchivePanel.tsx — Arweave receipt list + "Archive Now" button

  Each API route spawns Polytician via PolyticianMCPClient and proxies the appropriate MCP tool.

  Effort: 4-5 days.

  5.2 — CLI Subcommands

  File: cli/commands/polytician.ts + register in cli/index.ts

  ┌──────────────────────────────────────┬─────────────────────────────────────────────┐
  │               Command                │                 Description                 │
  ├──────────────────────────────────────┼─────────────────────────────────────────────┤
  │ agentvault polytician status         │ Probe health, call get_stats + health_check │
  ├──────────────────────────────────────┼─────────────────────────────────────────────┤
  │ agentvault polytician search <query> │ Call search_concepts, format results        │
  ├──────────────────────────────────────┼─────────────────────────────────────────────┤
  │ agentvault polytician push-all       │ Push all concepts to memory_repo            │
  ├──────────────────────────────────────┼─────────────────────────────────────────────┤
  │ agentvault polytician pull           │ Pull from memory_repo                       │
  ├──────────────────────────────────────┼─────────────────────────────────────────────┤
  │ agentvault polytician archive <id>   │ Archive concept to Arweave                  │
  ├──────────────────────────────────────┼─────────────────────────────────────────────┤
  │ agentvault polytician register       │ Register MCP server in canister             │
  └──────────────────────────────────────┴─────────────────────────────────────────────┘

  Effort: 2-3 days.

  ---
  Phase 6: Testing (P1, runs alongside all phases)

  6.1 — REST Bridge Unit Tests

  For each of the 6 API routes:
  - Mock canister client / ArweaveClient / SecretProvider
  - Test: missing fields → 400, missing token → 401, happy path response shape, canister error → 502

  6.2 — Integration Test: Round-Trip

  Start Polytician → save concept via MCP → verify push to memory_repo →
  simulate pull with test data → verify concept in Polytician →
  call vault_infer → verify inference routing → call vault_archive_concept →
  verify Arweave upload

  6.3 — Parser + Orchestrator Tests

  - Detection: .polytician.json → detectAgentType() returns 'polytician'
  - Enrichment: Mock MCP responses → verify enriched prompt format and truncation

  Effort: 3-4 days total.

  ---
  Phase 7: Cleanup (P3)

  7.1 — Delete Stale Branches

  AgentVault — safe to delete:
  - claude/add-thoughtform-commits-dW102 (work superseded)
  - claude/code-review-* (one-off reviews)
  - claude/implement-cli-merge-hVi1m, claude/implement-cli-rebase-JoOt7 (already on main)
  - revert-22-claude/add-merkle-root-backup-AetAV (stale revert)

  Polytician — safe to delete:
  - claude/add-encryption-placeholder-kQn37 (encryption already on main)
  - claude/add-gzip-compression-3RtZL (compression already on main)

  Merge dependabot PRs in both repos.

  7.2 — Documentation

  - Create .env.example in AgentVault with all required env vars
  - Document VENICE_API_KEY, AGENTVAULT_POLYTICIAN_API_TOKEN, LOCAL_MODEL_ENDPOINT
  - Add Ollama setup instructions
  - Write integration guide: "Connecting Polytician to AgentVault"

  7.3 — Decide on BLS Threshold Signatures

  src/security/bls-threshold.ts doesn't compile due to noble-curves type mismatches. Either:
  - Fix it — update to match noble-curves v2 API (half day)
  - Remove it — if VetKeys AES-256-GCM is sufficient for the product (10 min)

  ---
  Summary Timeline

  ┌───────┬──────────────────────────────────────────────┬──────────┬───────────────┐
  │ Phase │                     Work                     │  Effort  │ Dependencies  │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 0     │ Fix builds + tests                           │ 2 days   │ None          │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 1     │ REST bridge (6 endpoints + auth)             │ 3-4 days │ Phase 0       │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 2     │ Agent parser + MCP registration + MCP client │ 3 days   │ Phase 0       │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 3     │ Orchestrator enrichment                      │ 2 days   │ Phase 2       │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 4     │ Inference (Venice + Local minimum)           │ 4 hours  │ Phase 1       │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 5     │ Dashboard + CLI                              │ 5-7 days │ Phases 1-3    │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 6     │ Testing                                      │ 3-4 days │ Alongside all │
  ├───────┼──────────────────────────────────────────────┼──────────┼───────────────┤
  │ 7     │ Cleanup + docs                               │ 1-2 days │ After Phase 5 │
  └───────┴──────────────────────────────────────────────┴──────────┴───────────────┘

  Critical path: Phase 0 → Phase 1 → Phase 4 → Phase 3

  Phases 0-4 deliver a working integrated product (builds compile, repos talk to each other, inference works, orchestrator enriches prompts). That's roughly 8-10 days of focused work.

  Phases 5-7 deliver the polish (dashboard, CLI convenience, docs, cleanup). Add ~8-10 more days.

  Total to production-ready alpha: ~3-4 weeks.
