# Task-watchdog child-completion graft runbook

This runbook hands the reviewed source fix to a release owner without replacing
newer routing overlays with build output from the validation base. The private
delivery manifest identifies the approved source commit, exact active preimage,
and replay-bundle attachment; those environment-specific values do not belong in
the public repository.

## Source acceptance

1. Confirm that the production source diff contains exactly three line-neutral
   replacements: two terminal caller guards and one filtered child query.
2. Run the focused route/service tests and
   `scripts/smoke/task-watchdog-child-completion.sh`.
3. Run server typecheck, server and CLI builds, the repository test suites, and
   the release smoke required by `doc/DEVELOPING.md`. Record every exit code;
   classify skips or baseline failures explicitly rather than calling them pass.
4. Confirm that the native runtime path is either covered by its adjacent tests
   or recorded as absent in the private applicability manifest. Do not copy a
   native subsystem from another branch into an older validation base.

## Fail-closed candidate construction

1. Build the clean validation base and approved source commit with the same
   lockfile, Node version, package-manager version, and build command in separate
   isolated checkouts.
2. Verify the build delta with the approved private replay bundle. Both target
   JavaScript files must change, no generated line may be added or removed, and
   the changed-path set must remain within the two target JavaScript files and
   their source maps.
3. Run the bundle's line-delta, tree-delta, and source-map graft checks. Any
   preimage drift, ambiguous replacement, mapping reflow on an unchanged
   generated line, or non-target hash drift is a hard stop. Do not relax a gate.
4. Graft only the reviewed changed lines and their aligned mappings onto the
   byte-exact active preimage. Never copy complete route or service build output
   from the validation base over the active release.
5. Create a new immutable copy-on-write release. Record full pre/post manifests,
   target hashes, the source commit, bundle checksum, toolchain, service command,
   approvals, and rollback target before activation.

## Staged verification and rollback

1. Run package-integrity and JavaScript syntax checks on the staged release.
2. Run `scripts/smoke/task-watchdog-child-completion.sh` for the behavioral
   contract. Optionally pass an explicit test/staging health endpoint and the
   continuity report:

   ```sh
   scripts/smoke/task-watchdog-child-completion.sh \
     --health-url http://127.0.0.1:3100/api/health \
     --continuity-json /path/to/continuity.json
   ```

3. Verify that the service command resolves to the new immutable release and
   that the continuity report has `lostRunIds=[]`. Use a dedicated test area;
   never use a live business issue as a probe.
4. Activation and rollback require the designated root approver. Rollback removes
   only the new activation layer and restores the recorded immutable predecessor;
   rerun health, continuity, and the smoke after rollback.
