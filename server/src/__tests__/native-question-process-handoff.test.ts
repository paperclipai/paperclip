import { expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDb, companies, agents, issues, heartbeatRuns, authUsers, companyMemberships, issueQuestionResponseDeliveries } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { deliverNativeQuestionResponse, projectNativeRuntimeRequest } from "../services/native-runtime/native-question-bridge.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { deploymentNotifications } from "../services/deployment-notifications.js";
it("delivers a B-to-A native answer promptly after a competing claim and becomes idle after settlement", async () => {
  const database = await startEmbeddedPostgresTestDatabase("question-handoff-");
  const db = createDb(database.connectionString),
    companyId = randomUUID(),
    agentId = randomUUID(),
    issueId = randomUUID(),
    runId = randomUUID(),
    userId = randomUUID(),
    sessionId = randomUUID(),
    runnerId = randomUUID();
  const child = fork(new URL("./helpers/native-question-owner.mjs", import.meta.url), [], {
    execArgv: ["--import", import.meta.resolve("tsx")],
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  type Message = {
    type: string;
    commandType?: string;
    commandId?: string;
    payload?: {
      response: unknown;
    };
    requestId?: string;
    sweeps?: number;
    inspections?: number;
  };
  const messages: Message[] = [];
  const waiters = new Set<() => void>();
  child.on("message", value => {
    const message = value as Message;
    messages.push(message);
    for (const check of waiters) check();
  });
  function wait(type: string, timeout = 45000, requestId?: string) {
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeout);
      function check() {
        const m = messages.find(m => m.type === type && (!requestId || m.requestId === requestId) || m.type === "error");
        if (m) {
          clearTimeout(timer);
          waiters.delete(check);
          m.type === "error" ? reject(new Error("Owner process failed")) : resolve(m);
        }
      }
      waiters.add(check);
      check();
    });
  }
  const errors: unknown[] = [];
  const coordinator = createDeliveryWorkCoordinator({
      owner: db,
      canRun: () => true,
      onError: error => errors.push(error)
    }),
    bridge = deploymentNotifications(db, coordinator, {
      directDatabaseUrl: database.connectionString
    });
  try {
    await bridge.ready();
    await db.insert(companies).values({
      id: companyId,
      name: "Question handoff proof",
      issuePrefix: "QHO"
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Operator",
      email: `${userId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member"
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Handoff fixture",
      adapterType: "paperclip_runner",
      status: "running",
      adapterConfig: {
        provider: "codex"
      }
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Answer across processes",
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: userId
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId: runnerId,
      driverKind: "codex",
      contextSnapshot: {
        issueId
      }
    });
    const createQuestion = (requestId: string) => projectNativeRuntimeRequest({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        normalizedSessionId: sessionId,
        runnerSourceInstanceId: runnerId
      },
      event: {
        schema: "paperclip.prp.event.v1",
        sourceEventId: requestId,
        sourceSeq: 1,
        sourceInstanceId: runnerId,
        sourceKind: "runner",
        runId,
        normalizedSessionId: sessionId,
        eventType: "runtime_request.created",
        schemaVersion: 1,
        priority: 0,
        emittedAt: new Date().toISOString(),
        payload: {
          request: {
            schema: "paperclip.runtime_request.v2",
            requestKind: "runtime",
            requestId,
            type: "input",
            status: "pending",
            input: {
              schema: "paperclip.question_set.v1",
              questions: [{
                id: "color",
                prompt: "Which color?",
                required: true,
                answerMode: "single_select",
                options: [{
                  id: "green",
                  label: "Green"
                }]
              }]
            }
          }
        }
      }
    });
    const interaction = await createQuestion("question-1");
    child.send({
      type: "init",
      url: database.connectionString,
      binding: {
        companyId,
        issueId,
        runId,
        agentId
      }
    });
    await wait("ready");
    await issueThreadInteractionService(db).answerQuestions({
      id: issueId,
      companyId,
      status: "in_progress"
    }, interaction!.id, {
      answers: [{
        questionId: "color",
        optionIds: ["green"]
      }]
    }, {
      userId
    });
    const service = questionResponseDeliveryService(db, {
      heartbeat: {
        wakeup: async () => {
          throw new Error("Unexpected fallback");
        },
        cancelRun: async () => {
          throw new Error("Unexpected cancellation");
        }
      },
      resolveNativeQuestion: async interaction => {
        // B has claimed the delivery. A must observe that claim before B
        // discovers it lacks the native target and releases the row for retry.
        child.send({
          type: "start-worker"
        });
        await wait("worker-ready");
        return deliverNativeQuestionResponse(db, interaction);
      }
    });
    const started = Date.now();
    const immediate = await service.deliver(interaction!.id);
    const command = await wait("command", 5000);
    expect(immediate).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(command).toMatchObject({
      commandType: "request.resolve",
      commandId: `question_${interaction!.id}`,
      payload: {
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            color: {
              selectedOptionIds: ["green"]
            }
          }
        }
      }
    });
    await expect.poll(async () => (await db.select().from(issueQuestionResponseDeliveries))[0]?.status).toBe("delivered");
    const snapshot = async () => {
      const requestId = randomUUID();
      child.send({
        type: "snapshot",
        requestId
      });
      return wait("snapshot", 5000, requestId);
    };
    await delay(1500);
    const settled = await snapshot();
    await delay(2500);
    const idle = await snapshot();
    expect({
      sweeps: idle.sweeps,
      inspections: idle.inspections
    }).toEqual({
      sweeps: settled.sweeps,
      inspections: settled.inspections
    });
    expect(messages.filter(m => m.type === "command")).toHaveLength(1);
    // A has become idle. The next real producer on B must wake it through
    // PostgreSQL without a test-owned sweep or another child control message.
    const next = await createQuestion("question-2");
    await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId, status: "in_progress" }, next!.id,
      { answers: [{ questionId: "color", optionIds: ["green"] }] }, { userId });
    expect(await wait("command", 5_000, `question_${next!.id}`)).toMatchObject({ commandType: "request.resolve" });
    await expect.poll(async () => (await db.select().from(issueQuestionResponseDeliveries)).every(row => row.status === "delivered")).toBe(true);
    expect(messages.filter(m => m.type === "command")).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    if (child.connected) child.send({
      type: "stop"
    });
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await bridge.stop();
    await coordinator.stop();
    await db.$client.end({
      timeout: 1
    });
    await database.cleanup();
  }
}, 90000);
