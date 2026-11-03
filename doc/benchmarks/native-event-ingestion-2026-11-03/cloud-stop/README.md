# Real Daytona Stop acceptance

The production-built candidate at `137501f595fd5ee13d395e26b4147ca8bc4d4eb6` passed one real-Daytona Stop journey. The provider was a declared deterministic Codex fixture; native runnerd, authenticated Daytona ingress, the actual `sleep 60` process, Paperclip persistence, the visible Stop control, provider termination receipts, and independent Daytona SDK state were real. This is functional acceptance, not a performance comparison or a live-LLM claim.

`qualification.json` records native and shared acknowledgements, exact lease/provider binding, independent child retirement with no forbidden effect, stopped provider state, reload/no-successor checks, and direct PostgreSQL canonical-payload/cursor proof. `attempts.json` preserves the four earlier harness failures and their cleanup. All resources were deleted. The full traces and failed screenshots remain in private task evidence; this compact set includes the successful before/after screenshots.

The shared provider receipt took about12.4 seconds in this single observation; native acknowledgement took about0.4 seconds. These are individual functional timings, not latency distribution or performance acceptance evidence. Normal environment deletion returned HTTP success; exact-owned SDK deletion then independently established absence. Local cleanup initially met readonly skill directories; only directories in the stopped, recorded temporary data root were made writable without following symlinks, then the root was removed.

The verified cursor can contain gaps under the existing raw-transport cancellation policy. Database-retained event hashes and cursors were checked independently. This does not claim every ordinary streaming wire ACK was database durable.

## Reproduce

Paid opt-in. Use one sandbox, at most30 minutes, then delete it. The helper has a one-resource cap and an independent watchdog. Do not rerun with a fresh evidence directory to evade the cap. No automatic retry is provided. SDK 0.203.0 and the immutable image are pinned in the helper. Current runnerd and the self-contained fixture are staged through supported remote artifact paths; the old image runner/provider bridge is not used.

Build an independent checkout normally with locked dependencies (`pnpm install --frozen-lockfile`, `pnpm build`). Also run frozen install/build in `packages/plugins/sandbox-providers/daytona`, which has its own lockfile. Build the same revision's Linux-x64 runnerd using the locked Cargo release build on Linux and copy the executable to the controller. The tested controller was macOS arm64/Node 26.4.0; platform portability beyond that is not claimed.

In a shell with no inherited API keys/tokens, start the owned production controller using the app checkout's TSX loader and `helpers/launch.mjs`, with positional arguments: `APP_CHECKOUT EXPECTED_COMMIT NEW_EVIDENCE_DIRECTORY LINUX_RUNNERD_PATH PROVIDER_FIXTURE_PATH`. The last path is the absolute path of `helpers/provider.mjs`. Wait for `launch.json`. The launcher requires source and compiled build stamps to equal the expected commit.

In a separate shell, bind `DAYTONA_API_KEY` securely from your credential manager without printing it or placing it in arguments/files. Run the app checkout's Node+TSX loader on `helpers/run.mjs NEW_EVIDENCE_DIRECTORY/launch.json`. It sends the key once through the normal encrypted company-secret API, removes inherited credential environment variables before downstream work, and retains only secret references. No public controller tunnel is used. The helper installs the first-party plugin, creates an owned environment, creates a fresh task through the ordinary UI, observes the real process and actual normalized text, clicks the ordinary Stop button, and requires native/shared/provider/SDK/reload/cleanup gates.

Keep the isolated app/database alive for independent verification with the repository's `scripts/native-ingestion/verify-database.mjs` against the explicit owned loopback database. Then gracefully stop the recorded launcher, verify its HTTP/DB ports and process are gone, and remove only its recorded temporary data directory. Scan retained files and decompressed trace entries for the actual credential before sharing. The public helper adapts environment-supplied credentials, a one-resource cap, and the process-age guard to use the provider's own clock. It records all already-admitted owned IDs before enforcing the cap so failure cleanup can retire them. Exact executed private-helper hashes are recorded separately. These public adaptations passed syntax checks and an offline actual-source cleanup regression; they were not used for a second live acceptance claim.

Run `node helpers/verify-failure-cleanup.mjs` from this directory for the offline regression. It exercises the reproducer's actual admission and cleanup sections with two already-admitted owned IDs and a cap of one. Qualification must fail while both IDs reach the watchdog ledger and exact SDK cleanup. All external effects are stubbed; it creates no sandbox and reads no credential.

Example commands after setting the path variables (never include credentials in arguments):

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --import "$APP_CHECKOUT/server/node_modules/tsx/dist/loader.mjs" \
  "$HELPER_DIR/launch.mjs" "$APP_CHECKOUT" "$EXPECTED_COMMIT" \
  "$EVIDENCE_DIR" "$LINUX_RUNNERD" "$HELPER_DIR/provider.mjs"

# Separate shell: DAYTONA_API_KEY is already bound privately by the credential manager.
node --import "$APP_CHECKOUT/server/node_modules/tsx/dist/loader.mjs" \
  "$HELPER_DIR/run.mjs" "$EVIDENCE_DIR/launch.json"
```

The cost bound uses the official [Daytona pricing](https://www.daytona.io/pricing), checked November 3, 2026. It is a list-rate bound for the selected resources, not an invoice.

The independent process snapshot uses the provider clock for process age. Its RPC completed before the UI click, but provider and controller clocks are independent; no cross-host age or delivery interval is inferred. The later PR revision `fcb5d94848b3c4b0b32096ff5e023618e0f0637b` differs from the tested build only in `packages/plugins/paperclip-plugin-fake-sandbox/src/lease-cleanup.ts` and its test. The actual tested serving revision remains `137501f595fd5ee13d395e26b4147ca8bc4d4eb6`.
