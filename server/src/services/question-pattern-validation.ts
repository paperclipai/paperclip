import { Worker } from "node:worker_threads";

interface PatternCheck { questionId: string; pattern: string; text: string }

const MAX_WORKERS = 4;
const DEADLINE_MS = 1_000;
let activeWorkers = 0;

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const invalid = workerData.find(check => !new RegExp(check.pattern).test(check.text));
parentPort.postMessage(invalid ? invalid.questionId : null);
`;

/** Keep caller-supplied regex execution outside the request-serving thread. */
export async function validateQuestionPatterns(checks: readonly PatternCheck[]): Promise<void> {
  if (checks.length === 0) return;
  if (activeWorkers >= MAX_WORKERS) throw new Error("Question format validation is busy; try again");
  activeWorkers += 1;
  let worker: Worker;
  try {
    worker = new Worker(workerSource, {
      eval: true,
      workerData: checks,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
  } catch (error) {
    activeWorkers -= 1;
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release the slot after the worker actually stops, including timeouts.
      void worker.terminate().then(() => {
        activeWorkers -= 1;
        if (error) reject(error); else resolve();
      }, (terminationError: unknown) => {
        activeWorkers -= 1;
        reject(error ?? terminationError);
      });
    };
    const timer = setTimeout(() => finish(new Error("Question format validation exceeded its time limit")), DEADLINE_MS);
    worker.once("message", (questionId: string | null) => finish(questionId === null ? undefined
      : new Error(`Question ${questionId} does not match the required format`)));
    worker.once("error", finish);
    worker.once("exit", () => finish(new Error("Question format validation stopped before completion")));
  });
}
