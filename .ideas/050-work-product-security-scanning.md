# 050 — Code & Dependency Security Scanning of Work Products

## Suggestion

When code-writing agents produce work products, Paperclip captures them
(`issue_work_products`, `work-products.ts`) and routes them through review/approval
(`approvals.ts`). But nothing inspects that code for **security problems** before it's accepted:
vulnerable dependencies (known CVEs), hardcoded insecure patterns (SQL string-building, disabled
TLS verification, `eval` of untrusted input), risky license additions, or dependencies pulled from
untrusted sources. Autonomous agents add packages and write code at machine speed; a human
reviewer eyeballing a diff (idea 017) will not catch a transitive CVE or a subtly insecure
pattern. This is the supply-chain/secure-code blind spot that complements the *exfiltration*
controls already proposed (secret-leak scanning idea 020, egress allow-listing idea 022).

Add **automated security scanning of code work products**: scan agent-produced code and its
dependencies for vulnerabilities and insecure patterns at the review gate, and block/flag based on
severity.

## How it could be achieved

1. **Hook the review gate.** When a code work product is submitted for approval, run scanners over
   the changeset (`workspace-operations.ts` already logs the files touched; idea 017 assembles the
   diff).
2. **Dependency vulnerability scan.** Detect added/changed manifests (package.json, requirements,
   go.mod, etc.) and check dependencies against a vulnerability database (e.g. OSV) for known CVEs
   and disallowed licenses. New transitive risk is the most common and least visible failure.
3. **Static pattern checks.** Run lightweight SAST-style rules for high-signal insecure patterns,
   reusing existing redaction/secret machinery (idea 020) for the "hardcoded credential" subset.
4. **Severity-graded gate.** Per company policy (and expressible in the policy engine, idea 043):
   critical findings *block* approval, mediums *flag* and require explicit human override (logged
   to the audit trail, idea 023), lows are advisory. Feeds the approval risk score (idea 016).
5. **Feed it back to the agent.** Return findings to the producing agent so it can fix and
   resubmit autonomously — turning the scan into a correction loop, not just a gate.

## Perceived complexity

**Medium.** The integration points (work products, the diff, the approval gate) exist; the work is
wiring in scanners and a severity policy. Dependency CVE scanning via an offline/online vuln DB is
well-trodden and high-value-first; static pattern analysis is broader and noisier and should ship
behind tuned, high-confidence rules to avoid review fatigue. The main caveats are keeping the vuln
database current and being language/ecosystem-aware (the value is uneven across stacks) — scope it
to the languages a company actually produces, and treat it as best-effort elsewhere.
