import type { Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { aiRoutingHarness, ADAPTER_AUTH_MISSING_CHECK_CODE, AI_CONNECTION_CAPABILITIES, type AiConnectionBinding } from "@paperclipai/shared";
import { requireServerAdapter } from "../adapters/index.js";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { environmentService } from "./environments.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { prepareManagedAiRuntime, assertManagedAiProjectAuth } from "./ai-connection-runtime.js";
import { aiConnectionService } from "./ai-connections.js";
import { validateAiApiKey } from "./ai-api-key-test.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function agentEnvironmentTestService(db: Db, pluginWorkerManager?: PluginWorkerManager) {
  const instanceSettings = instanceSettingsService(db);
  const environmentsSvc = environmentService(db);
  const environmentRuntime = environmentRuntimeService(db, { pluginWorkerManager });
  // A null agent override inherits the instance default, just like dispatch.
  // Resolve this before secrets or probes so a default remote environment can
  // never accidentally validate the account on the control-plane host.
  async function resolveAdapterTestEnvironmentId(companyId: string, environmentId: string | null | undefined) {
    if (environmentId) return environmentId;
    const settings = await instanceSettings.get();
    if (settings.defaultEnvironmentId) return settings.defaultEnvironmentId;
    if ((await instanceSettings.getExperimental()).enableManagedSandboxOnly === true) {
      const managed = await environmentsSvc.findManagedSandboxEnvironment(companyId);
      if (!managed) {
        throw unprocessable("The managed sandbox is unavailable. Restore Paperclip Computer and retry.", {
          code: "managed_sandbox_unavailable",
        });
      }
      return managed.id;
    }
    return null;
  }

  /**
   * Resolve the execution target the adapter should run its test probes against.
   *
   * - No environmentId / local environment → returns a local target so the
   *   adapter probes the Paperclip host (legacy behavior).
   * - SSH environment → builds an SSH execution target from the environment
   *   config so the adapter probes the remote box. No lease is required:
   *   the SSH spec is fully derived from the saved environment config.
   * - Sandbox / plugin environments → acquires an ad-hoc lease, realizes the
   *   workspace, and resolves a sandbox execution target wired to the runtime
   *   so the adapter probe runs inside the sandbox the same way a heartbeat
   *   would. The returned `release` callback rolls the lease back when the
   *   route is done.
   *
   * The caller MUST always invoke `release()` (typically in a `finally` block).
   */
  async function resolveAdapterTestExecutionContext(input: {
    agentId?: string;
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<{
    executionTarget: AdapterExecutionTarget | null;
    environmentName: string | null;
    fallbackChecks: AdapterEnvironmentCheck[];
    sandboxIdentityCheck?: AdapterEnvironmentCheck | null;
    release: (status?: "released" | "failed") => Promise<void>;
  }> {
    const noopRelease = async () => {};

    if (!input.environmentId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    const requestedEnvironment = await environmentsSvc.getById(input.environmentId);
    if (!requestedEnvironment) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. The test did not run.",
          },
        ],
        release: noopRelease,
      };
    }

    // Managed-sandbox-only policy: redirect a Test that would run on the local
    // host onto the platform-managed sandbox, the same as a real run does
    // (resolveExecutionWorkspaceEnvironmentId in heartbeat). Without this
    // redirect the Test probes the local host while the run executes in the
    // managed sandbox, so a passing Test validates the wrong execution target.
    // With no active managed sandbox the Test fails closed — never local.
    let environment = requestedEnvironment;
    if (requestedEnvironment.driver === "local") {
      const managedSandboxOnly =
        (await instanceSettings.getExperimental()).enableManagedSandboxOnly === true;
      if (managedSandboxOnly) {
        const managedSandboxEnvironment = await environmentsSvc.findManagedSandboxEnvironment(
          input.companyId,
        );
        if (!managedSandboxEnvironment) {
          return {
            executionTarget: null,
            environmentName: requestedEnvironment.name,
            fallbackChecks: [
              {
                code: "managed_sandbox_unavailable",
                level: "error",
                message:
                  "This instance runs agents only in its platform-managed sandbox, but no active managed sandbox environment exists. The test did not run.",
                hint: "Restore the managed sandbox environment, then test again.",
              },
            ],
            release: noopRelease,
          };
        }
        environment = managedSandboxEnvironment;
      }
    }

    if (environment.driver === "local") {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return {
            executionTarget: target,
            environmentName: environment.name,
            fallbackChecks: [],
            release: noopRelease,
          };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". The test did not run.`,
            },
          ],
          release: noopRelease,
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
          release: noopRelease,
        };
      }
    }

    // sandbox / plugin / other remote drivers: spin up an ad-hoc lease, realize
    // the workspace inside the box, and run the same probe SSH uses against
    // a sandbox execution target wired to the environment runtime.
    //
    // We pass `heartbeatRunId: null` because there's no heartbeat run for an
    // operator-initiated `Test` invocation — the leases table FKs heartbeat
    // run id to heartbeat_runs.id, and we don't want to manufacture a fake
    // run row. Cleanup goes through the driver's `releaseRunLease` directly
    // (by lease record), since the batch helper queries by heartbeatRunId.
    //
    // Sandbox tests boot a fresh throwaway sandbox (never resume a retained
    // agent lease) and archive it on release instead of deleting it, so the
    // operator can inspect the exact sandbox from the provider dashboard while
    // provider-side expiry reaps it later.
    const testEnvironment = environment.driver === "sandbox"
      ? {
          ...environment,
          config: {
            ...(environment.config ?? {}),
            reuseLease: false,
            archiveOnRelease: true,
          },
        }
      : environment;
    let leaseRecord: Awaited<ReturnType<typeof environmentRuntime.acquireRunLease>>;
    try {
      leaseRecord = await environmentRuntime.acquireRunLease({
        companyId: input.companyId,
        agentId: input.agentId,
        environment: testEnvironment,
        issueId: null,
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
        // Re-check the company binding atomically at lease time. The route
        // guard already rejected a foreign environment, but the binding could
        // change between the guard check and the lease acquire. This closes
        // that check-to-lease race so a foreign sandbox never gets a lease.
        assertCompanyBinding: true,
        // Apply the active custom-image template so the Test boots with the
        // operator's captured sandbox customizations and prepared image state,
        // matching what real agent runs use. Without this the test would
        // silently fall back to the base image.
        applyCustomImageTemplate: true,
      });
    } catch (err) {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_lease_acquire_failed",
            level: "error",
            message: `Could not acquire a lease for environment "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
            hint: "Check the environment's provider credentials and quota.",
          },
        ],
        release: noopRelease,
      };
    }

    const driver = environmentRuntime.getDriver(environment.driver);
    const releaseLease = async (status: "released" | "failed" = "released") => {
      try {
        if (driver) {
          await driver.releaseRunLease({
            environment: testEnvironment,
            lease: leaseRecord.lease,
            status,
          });
        } else {
          await environmentsSvc.releaseLease(leaseRecord.lease.id, status);
        }
      } catch (err) {
        // Cleanup failures must not mask the test result.
        // eslint-disable-next-line no-console
        console.warn(
          `[adapter-test] Failed to release lease ${leaseRecord.lease.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    let realizedCwd: string | null = null;
    try {
      const realized = await environmentRuntime.realizeWorkspace({
        environment: testEnvironment,
        lease: leaseRecord.lease,
        // No host workspace to copy for a Test invocation; sandbox/plugin
        // realize implementations use the lease metadata's remoteCwd to
        // create the working directory inside the box.
        workspace: {},
      });
      realizedCwd =
        typeof realized.cwd === "string" && realized.cwd.trim().length > 0
          ? realized.cwd.trim()
          : null;
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_workspace_realize_failed",
            level: "error",
            message: `Could not realize a workspace inside "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    let target: AdapterExecutionTarget | null;
    try {
      // Prefer the cwd the realize step returned; fall back to lease metadata.
      const leaseMetadataForTarget: Record<string, unknown> | null =
        realizedCwd
          ? { ...(leaseRecord.lease.metadata ?? {}), remoteCwd: realizedCwd }
          : (leaseRecord.lease.metadata as Record<string, unknown> | null) ?? null;

      target = await resolveEnvironmentExecutionTarget({
        db,
        companyId: input.companyId,
        adapterType: input.adapterType,
        environment: {
          id: testEnvironment.id,
          driver: testEnvironment.driver,
          config: testEnvironment.config ?? null,
        },
        leaseId: leaseRecord.lease.id,
        leaseMetadata: leaseMetadataForTarget,
        lease: leaseRecord.lease,
        environmentRuntime,
      });
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_failed",
            level: "error",
            message: `Could not resolve an execution target for "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    if (!target) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_unsupported",
            level: "warn",
            message:
              `Adapter "${input.adapterType}" is not allowed in "${environment.name}" environments.`,
          },
        ],
        release: noopRelease,
      };
    }

    return {
      executionTarget: target,
      environmentName: environment.name,
      fallbackChecks: [],
      sandboxIdentityCheck: buildSandboxIdentityCheck({
        environmentName: environment.name,
        lease: leaseRecord.lease,
      }),
      release: releaseLease,
    };
  }

  function readMetadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  }

  function buildSandboxIdentityCheck(input: {
    environmentName: string;
    lease: {
      id: string;
      provider?: string | null;
      providerLeaseId?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }): AdapterEnvironmentCheck {
    const metadata = input.lease.metadata ?? {};
    const provider = input.lease.provider ?? readMetadataString(metadata, ["provider"]);
    const sandboxId = readMetadataString(metadata, ["sandboxId", "sandboxID", "sandbox_id", "id"]);
    const sandboxName = readMetadataString(metadata, ["sandboxName", "sandbox_name", "name"]);
    const snapshotRef = readMetadataString(metadata, [
      "snapshot",
      "snapshotId",
      "snapshotID",
      "snapshotRef",
      "snapshot_ref",
      "templateRef",
      "template_ref",
      "templateId",
      "templateID",
      "image",
      "imageId",
      "imageID",
      "imageRef",
      "image_ref",
    ]);
    const templateKind = readMetadataString(metadata, [
      "templateKind",
      "template_kind",
      "templateRefKind",
      "template_ref_kind",
    ]);
    const detailParts = [
      `paperclipLeaseId=${input.lease.id}`,
      input.lease.providerLeaseId ? `providerLeaseId=${input.lease.providerLeaseId}` : null,
      provider ? `provider=${provider}` : null,
      sandboxId ? `sandboxId=${sandboxId}` : null,
      sandboxName ? `sandboxName=${sandboxName}` : null,
      snapshotRef ? `${templateKind ? `${templateKind}Ref` : "snapshotOrTemplateRef"}=${snapshotRef}` : null,
    ].filter((part): part is string => Boolean(part));

    return {
      code: "sandbox_test_identity",
      level: "info",
      message: `Environment test identity for "${input.environmentName}".`,
      detail: detailParts.join("; "),
      hint: "Use these provider-neutral IDs when comparing model-test output with provider logs or refreshed environment snapshots.",
    };
  }


  // The environment drivers the adapter Test route accepts. A local, SSH, or
  // sandbox environment can host a probe; a plugin environment cannot.
  const ADAPTER_TEST_ALLOWED_ENVIRONMENT_DRIVERS = ["local", "ssh", "sandbox"];

  // The fail-closed tenant-binding guard for the adapter Test route. A caller
  // may name any instance environment by id, so the route must reject an
  // environment that binds to another company before it resolves secrets,
  // merges env, resolves the target, leases a sandbox, or runs the adapter
  // test. The guard checks the company binding BEFORE it validates the status
  // or the driver, so it never reveals the status or the driver of a foreign
  // environment. A same-company or an instance-global environment then gets the
  // shared driver and status validation.
  async function assertAdapterTestEnvironmentForCompany(
    companyId: string,
    environmentId: string,
  ): Promise<void> {
    const environment = await environmentsSvc.getById(environmentId);
    if (!environment) {
      // A missing environment leaks no tenant state. The execution-context
      // resolver surfaces the existing environment_not_found check.
      return;
    }
    const boundCompanyIds = await environmentsSvc.listBoundCompanyIds(environmentId);
    if (boundCompanyIds.length > 0 && !boundCompanyIds.includes(companyId)) {
      throw forbidden("The selected environment belongs to another company.", {
        code: "environment_company_mismatch",
      });
    }
    await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId, {
      allowedDrivers: ADAPTER_TEST_ALLOWED_ENVIRONMENT_DRIVERS,
    });
  }

  async function testManagedEnvironment(adapterType: string, context: Parameters<ReturnType<typeof requireServerAdapter>["testEnvironment"]>[0], binding: AiConnectionBinding, managed: Awaited<ReturnType<typeof prepareManagedAiRuntime>>, agentId?: string) {
    const startedAt = new Date();
    const result = await probeManagedEnvironment(adapterType, context, binding);
    // A provider rejection invalidates the tested credential generation. A
    // missing CLI, unavailable environment, or other runtime error does not.
    if (result.status === "fail" && result.checks.some(check =>
      check.code === ADAPTER_AUTH_MISSING_CHECK_CODE || /_hello_probe_auth_required$/.test(check.code)
        || check.code === "ai_connection_api_key_rejected",
    )) {
      await aiConnectionService(db).markAuthenticationFailed({
        companyId: context.companyId, agentId, runStartedAt: startedAt,
        attribution: { ...managed.attribution, identity: managed.identity },
      });
    }
    return result;
  }

  async function probeManagedEnvironment(adapterType: string, context: Parameters<ReturnType<typeof requireServerAdapter>["testEnvironment"]>[0], binding: AiConnectionBinding) {
    await assertManagedAiProjectAuth(context.config, binding.provider, context.executionTarget);
    const result = await requireServerAdapter(adapterType).testEnvironment(context);
    if (result.status === "fail") return result;
    // The resolved method, not binding.method — on a responsible_user binding
    // that field is wire-compat only and the default connection decides.
    const resolvedMethod = (context.config as { managedAiConnection?: { method?: string } }).managedAiConnection?.method;
    // An api_key account does not take the CLI hello probe below: a key
    // travels as an env var any engine understands, and the engine's own test
    // above judged whether this runtime can execute with it — the ACP lane
    // deliberately runs no hello probe when a key is configured. Demanding one
    // anyway forced the CLI lane, whose probe needs a provider CLI on PATH,
    // and a clean install has none: that walled off onboarding's API-key path
    // on exactly the machines the release smoke exists to guard. The account
    // is still verified live here — the same provider-endpoint check the save
    // performed — so a key revoked since its save fails adoption rather than
    // producing an agent that cannot authenticate at runtime. The hello-probe
    // requirement stays for subscriptions: a stored login is a file layout
    // only a provider CLI reads, so proving the runtime lane can consume it
    // takes a real hello turn.
    if (resolvedMethod === "api_key" && !context.config.managedAiRouting) {
      const envKey = AI_CONNECTION_CAPABILITIES[binding.provider].methods.api_key?.envKey;
      const key = envKey ? parseObject(context.config.env)[envKey] : undefined;
      try {
        if (typeof key !== "string" || !key) throw unprocessable("The selected account's API key was not available to verify.");
        await validateAiApiKey(binding.provider, key);
        result.checks.push({ code: "ai_connection_api_key_reverified", level: "info", message: "The provider verified this API key for adoption." });
      } catch (error) {
        result.status = "fail";
        const rejected = error instanceof HttpError && asRecord(error.details)?.code === "ai_connection_api_key_rejected";
        result.checks.push({ code: rejected ? "ai_connection_api_key_rejected" : "ai_connection_verification_failed", level: "error", message: error instanceof HttpError ? error.message : "Could not verify the account. Try again." });
      }
      return result;
    }
    if (!result.checks.some(check => check.code.includes("hello_probe"))) {
      const providerAdapter = context.config.managedAiRouting ? aiRoutingHarness(adapterType, context.config.provider, context.config.acpxAgent) : { anthropic: "claude_local", openai: "codex_local", openrouter: "opencode_local", xai: "grok_local", google: "gemini_local" }[binding.provider];
      const probe = await requireServerAdapter(providerAdapter).testEnvironment({ ...context, adapterType: providerAdapter, config: { ...context.config, engine: "cli" } });
      result.checks.push(...probe.checks);
      result.status = probe.status === "fail" ? "fail" : result.status === "warn" || probe.status === "warn" ? "warn" : "pass";
    }
    if (!result.checks.some(check => /hello_probe_(passed|succeeded)$/.test(check.code))) {
      result.status = "fail";
      result.checks.push({ code: "ai_connection_validation_incomplete", level: "error", message: "The selected account has not completed a provider hello test. Retry before adopting it." });
    }
    return result;
  }


  return { resolveAdapterTestEnvironmentId, resolveAdapterTestExecutionContext, assertAdapterTestEnvironmentForCompany, testManagedEnvironment };
}
