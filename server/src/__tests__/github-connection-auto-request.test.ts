import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import {
  detectUnconfiguredGitHubAuthFailureInEvents,
  isGitHubWorkspaceCloneAuthFailure,
} from "../services/git-auth-connection-detection.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { classifyRunLiveness } from "../services/run-liveness.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function toolExecutionEvent(options: {
  output: string;
  exitCode?: number | null;
  status?: string;
  name?: string;
  subject?: string;
}) {
  return {
    eventType: "tool.execution.completed",
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        eventType: "tool.execution.completed",
        payload: {
          schema: "paperclip.tool.execution.v1",
          transport: "process",
          operation: "shell",
          name: options.name ?? "git clone https://github.com/acme/private-repo.git",
          ...(options.subject ? { subject: options.subject } : {}),
          status: options.status ?? "failed",
          exitCode: options.exitCode === undefined ? 128 : options.exitCode,
          output: options.output,
        },
      },
    },
  };
}

function commandItemEvent(options: {
  command: string;
  output: string;
  exitCode?: number;
  status?: string;
}) {
  return {
    eventType: "item.completed",
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        eventType: "item.completed",
        payload: {
          item: {
            type: "command_execution",
            command: options.command,
            exit_code: options.exitCode ?? 128,
            status: options.status ?? "failed",
            aggregated_output: options.output,
          },
        },
      },
    },
  };
}

function createTestLifecycle(db: ReturnType<typeof createDb>) {
  const dependencies = {
    ...createHeartbeatRunState(db),
    ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(),
    budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  return createHeartbeatLifecycle(db, dependencies);
}

describe("detectUnconfiguredGitHubAuthFailureInEvents", () => {
  it.each([
    [
      "HTTPS private clone with disabled prompts",
      toolExecutionEvent({
        output: "Cloning into 'private-repo'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
    [
      // paperclip:allow-git-push: synthetic command output fixture testing GitHub auth detection
      "HTTPS git push authentication failed",
      toolExecutionEvent({
        // paperclip:allow-git-push: synthetic command fixture testing GitHub auth detection
        name: "git push origin main",
        output: "fatal: Authentication failed for 'https://github.com/acme/private-repo.git/'\n",
      }),
    ],
    [
      "HTTPS git clone 403",
      toolExecutionEvent({
        output: "fatal: unable to access 'https://github.com/acme/private-repo.git/': The requested URL returned error: 403\n",
      }),
    ],
    [
      "HTTPS private repository not found",
      toolExecutionEvent({
        output: "remote: Repository not found.\nfatal: repository 'https://github.com/acme/private-repo.git/' not found\n",
      }),
    ],
    [
      "SSH permission denied against github.com",
      commandItemEvent({
        command: "git clone git@github.com:acme/private-repo.git",
        output: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
      }),
    ],
    [
      "gh CLI not logged in",
      toolExecutionEvent({
        name: "gh pr create --fill",
        exitCode: 4,
        output: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
      }),
    ],
    [
      "gh CLI not logged into any GitHub hosts",
      commandItemEvent({
        command: "gh repo view acme/private-repo",
        exitCode: 1,
        output: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
      }),
    ],
    [
      "OpenCode generic bash tool without command text",
      toolExecutionEvent({
        name: "bash",
        output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
    [
      "timeout-wrapped git clone",
      toolExecutionEvent({
        name: "timeout 60 git clone https://github.com/acme/private-repo.git",
        output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
    [
      "timeout-wrapped bash -lc compound git clone",
      toolExecutionEvent({
        name: "timeout -k 5 60 bash -lc 'cd /workspace && git clone https://github.com/acme/private-repo.git'",
        output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
    [
      "sudo-wrapped git clone",
      toolExecutionEvent({
        name: "sudo -u runner git clone https://github.com/acme/private-repo.git",
        output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
  ])("detects unambiguous GitHub auth failure: %s", (_label, event) => {
    expect(detectUnconfiguredGitHubAuthFailureInEvents([event])).toBe(true);
  });

  it.each([
    [
      "successful command quoting error text",
      toolExecutionEvent({
        exitCode: 0,
        status: "completed",
        output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
    [
      "assistant prose quoting error text",
      {
        eventType: "item.completed",
        payload: {
          prpEvent: {
            schema: "paperclip.prp.event.v1",
            eventType: "item.completed",
            payload: {
              kind: "agentMessage",
              text: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            },
          },
        },
      },
    ],
    [
      "non-GitHub HTTPS remote (GitLab)",
      toolExecutionEvent({
        name: "git clone https://gitlab.com/acme/private.git",
        output: "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled\n",
      }),
    ],
    [
      "non-GitHub SSH remote",
      commandItemEvent({
        command: "git clone git@gitlab.com:acme/private.git",
        output: "git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
      }),
    ],
    [
      "transient GitHub 503 outage",
      toolExecutionEvent({
        output: "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 503\n",
      }),
    ],
    [
      "local non-auth git error",
      toolExecutionEvent({
        name: "git status",
        output: "fatal: not a git repository (or any of the parent directories): .git\n",
      }),
    ],
    [
      "unrelated command printing git auth error text",
      toolExecutionEvent({
        name: "vitest run server/src/__tests__/auth.test.ts",
        output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      }),
    ],
  ])("ignores non-matching or non-GitHub failure: %s", (_label, event) => {
    expect(detectUnconfiguredGitHubAuthFailureInEvents([event])).toBe(false);
  });

  it("clears detection only on matching authenticated recovery, not unrelated/local/other-repo commands", () => {
    const authFailure = toolExecutionEvent({
      name: "git clone https://github.com/acme/private-repo.git",
      output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
    });
    const localGitStatus = toolExecutionEvent({
      name: "git status",
      exitCode: 0,
      status: "completed",
      output: "On branch main\n",
    });
    const ghSubcommandHelp = toolExecutionEvent({
      name: "gh pr create --help",
      exitCode: 0,
      status: "completed",
      output: "Create a pull request on GitHub\n",
    });
    const echoCommand = toolExecutionEvent({
      name: "echo gh auth status",
      exitCode: 0,
      status: "completed",
      output: "gh auth status\n",
    });
    const gitlabLsRemote = toolExecutionEvent({
      name: "git ls-remote https://gitlab.com/team/public.git",
      exitCode: 0,
      status: "completed",
      output: "abc123\tHEAD\n",
    });
    const differentPublicRepoClone = toolExecutionEvent({
      name: "git clone https://github.com/acme/public-mirror.git",
      exitCode: 0,
      status: "completed",
      output: "Cloning into 'public-mirror'...\n",
    });
    const recoveredSameRepoClone = toolExecutionEvent({
      name: "git -C /workspace clone https://github.com/acme/private-repo.git",
      exitCode: 0,
      status: "completed",
      output: "Cloning into 'private-repo'...\n",
    });
    const recoveredGitPush = toolExecutionEvent({
      // paperclip:allow-git-push: synthetic command fixture testing recovery detection
      name: "git -C /workspace push origin main",
      exitCode: 0,
      status: "completed",
      output: "To https://github.com/acme/private-repo.git\n",
    });

    const recoveredQuietGitPush = toolExecutionEvent({
      // paperclip:allow-git-push: synthetic command fixture testing recovery detection
      name: "git -C /workspace push origin main",
      exitCode: 0,
      status: "completed",
      output: "Everything up-to-date\n",
    });

    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, localGitStatus])).toBe(true);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, ghSubcommandHelp])).toBe(true);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, echoCommand])).toBe(true);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, gitlabLsRemote])).toBe(true);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, differentPublicRepoClone])).toBe(true);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, recoveredSameRepoClone])).toBe(false);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, recoveredGitPush])).toBe(false);
    expect(detectUnconfiguredGitHubAuthFailureInEvents([authFailure, recoveredQuietGitPush])).toBe(false);
  });
});

describe("isGitHubWorkspaceCloneAuthFailure", () => {
  it("detects structured git clone authentication failures targeting github.com", () => {
    expect(isGitHubWorkspaceCloneAuthFailure({
      resultJson: {
        connectionFailure: { schemaVersion: 1, provider: "git", operation: "clone", reason: "authentication_failed" },
      },
      contextSnapshot: { workspaceRepoUrl: "https://github.com/acme/private-repo.git" },
    })).toBe(true);
    expect(isGitHubWorkspaceCloneAuthFailure({
      resultJson: {
        workspaceValidation: {
          materializationFailures: [{
            repoUrl: "git@github.com:acme/private-repo.git",
            connectionFailure: { schemaVersion: 1, provider: "git", operation: "clone", reason: "repository_unavailable" },
          }],
        },
      },
    })).toBe(true);
  });

  it("ignores non-GitHub remotes and non-auth transport errors", () => {
    expect(isGitHubWorkspaceCloneAuthFailure({
      resultJson: {
        connectionFailure: { schemaVersion: 1, provider: "git", operation: "clone", reason: "authentication_failed" },
      },
      contextSnapshot: { workspaceRepoUrl: "https://example.test/team/repo.git" },
    })).toBe(false);
    expect(isGitHubWorkspaceCloneAuthFailure({
      resultJson: {
        connectionFailure: { schemaVersion: 1, provider: "git", operation: "clone", reason: "dns_failure" },
      },
      contextSnapshot: { workspaceRepoUrl: "https://github.com/acme/private-repo.git" },
    })).toBe(false);
  });
});

describe("classifyRunLiveness with githubConnectionRequested", () => {
  it("marks runs with an auto-attached GitHub connection card as blocked waiting for user", () => {
    for (const runStatus of ["failed", "succeeded"] as const) {
      expect(classifyRunLiveness({
        runStatus,
        issue: { status: "in_progress", title: "Clone private repo", description: null },
        stdoutExcerpt: "I could not clone the private repo without GitHub access.",
        githubConnectionRequested: true,
      })).toMatchObject({
        livenessState: "blocked",
        livenessReason: "Waiting for GitHub connection",
        nextAction: "Complete the connection request to continue this task",
      });
    }
  });
});

describeEmbeddedPostgres("automatic GitHub connection card on unconfigured git auth failure", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  const userId = `git-auto-user-${randomUUID()}`;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-git-auto-connect-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({
      id: userId,
      name: "Beta Tester",
      email: "beta@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await cleanup?.();
  });

  async function seedTaskAndRun(options: {
    status: "succeeded" | "failed";
    contextSnapshot?: Record<string, unknown>;
    resultJson?: Record<string, unknown>;
    events?: Array<{ eventType: string; payload: Record<string, unknown> }>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GitHub Auto Connect Test",
      issuePrefix: `G${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Clone and push code",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Engineer",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Clone private repo",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: options.status,
      runtimeMode: "native",
      nativeIssueId: issueId,
      responsibleUserId: userId,
      contextSnapshot: {
        issueId,
        githubAuthenticationMode: "managed",
        ...(options.contextSnapshot ?? {}),
      },
      resultJson: options.resultJson ?? null,
      stdoutExcerpt: "I tried to clone the repo but GitHub credentials are not configured.",
    }).returning();

    for (const [idx, ev] of (options.events ?? []).entries()) {
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId,
        agentId,
        seq: idx + 1,
        eventType: ev.eventType,
        stream: "system",
        level: "info",
        payload: ev.payload,
      });
    }
    return { companyId, agentId, issueId, runId, run: run! };
  }

  it("creates a pending GitHub connection card in the task feed when an agent fails git clone/push without GitHub configured", async () => {
    const { companyId, agentId, issueId, runId, run } = await seedTaskAndRun({
      status: "succeeded",
      events: [
        toolExecutionEvent({
          name: "git clone https://github.com/acme/private-repo.git",
          output: "Cloning into 'private-repo'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        }),
      ],
    });

    const lifecycle = createTestLifecycle(db);
    const updatedRun = await lifecycle.classifyAndPersistRunLiveness(run);
    expect(updatedRun?.livenessState).toBe("blocked");
    expect(updatedRun?.livenessReason).toBe("Waiting for GitHub connection");

    const cards = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.kind, "connection_intent"),
    ));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "connection_intent",
      status: "pending",
      sourceRunId: runId,
      addresseeUserId: userId,
      payload: expect.objectContaining({
        serviceSlug: "github",
        serviceName: "GitHub",
        requestingAgentId: agentId,
        phase: "requested",
      }),
    });

    // Calling again reuses the pending card without creating a duplicate and keeps liveness blocked.
    const repeated = await connectionIntentService(db).requestForRunGitHubAuthFailure(runId);
    expect(repeated?.interactionId).toBe(cards[0]!.id);
    const recheckedRun = await lifecycle.classifyAndPersistRunLiveness(run);
    expect(recheckedRun?.livenessState).toBe("blocked");
    const afterRepeat = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.kind, "connection_intent"),
    ));
    expect(afterRepeat).toHaveLength(1);
  });

  it("creates a GitHub connection card when workspace setup fails to clone a private GitHub repository", async () => {
    const { companyId, issueId, run } = await seedTaskAndRun({
      status: "failed",
      contextSnapshot: { workspaceRepoUrl: "https://github.com/acme/private-repo.git" },
      resultJson: {
        connectionFailure: {
          schemaVersion: 1,
          provider: "git",
          operation: "clone",
          reason: "authentication_failed",
        },
      },
    });

    const lifecycle = createTestLifecycle(db);
    const updatedRun = await lifecycle.classifyAndPersistRunLiveness(run);
    expect(updatedRun?.livenessState).toBe("blocked");

    const cards = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.kind, "connection_intent"),
    ));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.payload).toMatchObject({ serviceSlug: "github", serviceName: "GitHub" });
  });

  it("does not create a second card after the user declines the GitHub connection request", async () => {
    const first = await seedTaskAndRun({
      status: "succeeded",
      events: [
        toolExecutionEvent({
          // paperclip:allow-git-push: synthetic command fixture testing GitHub auth detection
          name: "git push origin main",
          output: "fatal: Authentication failed for 'https://github.com/acme/private-repo.git/'\n",
        }),
      ],
    });
    const created = await connectionIntentService(db).requestForRunGitHubAuthFailure(first.runId);
    expect(created?.interactionId).toBeTruthy();

    await connectionIntentService(db).decline(created!.interactionId!, userId, "Not right now");

    const continuationRunId = randomUUID();
    const [continuationRun] = await db.insert(heartbeatRuns).values({
      id: continuationRunId,
      companyId: first.companyId,
      agentId: first.agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: first.issueId,
      responsibleUserId: userId,
      contextSnapshot: {
        issueId: first.issueId,
        githubAuthenticationMode: "managed",
        interactionId: created!.interactionId!,
      },
      stdoutExcerpt: "Understood, skipping GitHub push.",
    }).returning();
    await db.insert(heartbeatRunEvents).values({
      companyId: first.companyId,
      runId: continuationRunId,
      agentId: first.agentId,
      seq: 1,
      eventType: "tool.execution.completed",
      stream: "system",
      level: "info",
      payload: toolExecutionEvent({
        // paperclip:allow-git-push: synthetic command fixture testing GitHub auth detection
        name: "git push origin main",
        output: "fatal: Authentication failed for 'https://github.com/acme/private-repo.git/'\n",
      }).payload,
    });

    const retried = await connectionIntentService(db).requestForRunGitHubAuthFailure(continuationRun!.id);
    expect(retried).toBeNull();
    const cards = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, first.companyId),
      eq(issueThreadInteractions.issueId, first.issueId),
      eq(issueThreadInteractions.kind, "connection_intent"),
    ));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.status).toBe("rejected");
  });

  it("does not create a card when GitHub is already usable for the agent or when using host credentials", async () => {
    const hostRun = await seedTaskAndRun({
      status: "succeeded",
      contextSnapshot: { githubAuthenticationMode: "host" },
      events: [
        toolExecutionEvent({
          output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        }),
      ],
    });
    expect(await connectionIntentService(db).requestForRunGitHubAuthFailure(hostRun.runId)).toBeNull();

    const connected = await seedTaskAndRun({
      status: "succeeded",
      events: [
        toolExecutionEvent({
          output: "fatal: Authentication failed for 'https://github.com/acme/other-repo.git/'\n",
        }),
      ],
    });
    const [application] = await db.insert(toolApplications).values({
      companyId: connected.companyId,
      applicationKey: randomUUID(),
      name: "GitHub",
      type: "mcp_http",
      metadata: { sourceTemplateKey: "github" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: connected.companyId,
      applicationId: application!.id,
      uid: `github-test-${randomUUID()}`,
      name: "GitHub",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      enabled: true,
      status: "active",
      healthStatus: "ok",
      config: { sourceTemplateKey: "github" },
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: connected.companyId,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: userId,
      status: "active",
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: connected.companyId,
      connectionId: connection!.id,
      targetType: "company",
      targetId: connected.companyId,
    });
    await db.insert(toolCatalogEntries).values({
      companyId: connected.companyId,
      connectionId: connection!.id,
      name: "get_me",
      toolName: "get_me",
      riskLevel: "read",
      versionHash: "v1",
      entryKind: "tool",
      status: "active",
    });

    expect(await connectionIntentService(db).requestForRunGitHubAuthFailure(connected.runId)).toBeNull();
  });
});
