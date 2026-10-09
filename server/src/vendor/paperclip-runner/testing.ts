/**
 * Source-mode test shim for the runner package's explicit testing surface.
 *
 * Server tests do not build workspace dependencies first, so values load the
 * package source dynamically. Keep the static type boundary on the package
 * export, which the server build prepares before compiling, so TypeScript does
 * not pull the runner source tree outside the server's rootDir.
 */
type RunnerTestingModule = typeof import("@paperclipai/paperclip-runner/testing");

export type {
  CapabilityCommandEnvelope,
  CapabilityCommandOutcome,
  CapabilityCommandResult,
  CapabilityFixtureState,
  CapabilityRunContext,
  CapabilitySemanticCommand,
  SemanticConformanceAdapter,
  SemanticConformanceObservation,
  SemanticConformanceVector,
} from "@paperclipai/paperclip-runner/testing";

const sourceUrl = new URL(
  "../../../../packages/paperclip-runner/src/testing.ts",
  import.meta.url,
);
const runnerTesting = await import(sourceUrl.href) as RunnerTestingModule;

export const CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS:
  RunnerTestingModule["CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS"] =
  runnerTesting.CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS;
export const CAPABILITY_SEMANTIC_CONFORMANCE_IDS:
  RunnerTestingModule["CAPABILITY_SEMANTIC_CONFORMANCE_IDS"] =
  runnerTesting.CAPABILITY_SEMANTIC_CONFORMANCE_IDS;
export const CapabilityMockSemanticConformanceAdapter:
  RunnerTestingModule["CapabilityMockSemanticConformanceAdapter"] =
  runnerTesting.CapabilityMockSemanticConformanceAdapter;
export const CapabilitySemanticDispatcher:
  RunnerTestingModule["CapabilitySemanticDispatcher"] =
  runnerTesting.CapabilitySemanticDispatcher;
export const CONTROL_PLANE_CONFORMANCE_OPEN =
  runnerTesting.CONTROL_PLANE_CONFORMANCE_OPEN;
export const CONTROL_PLANE_CONFORMANCE_RESULT =
  runnerTesting.CONTROL_PLANE_CONFORMANCE_RESULT;
export const CONTROL_PLANE_CONFORMANCE_TERMINAL =
  runnerTesting.CONTROL_PLANE_CONFORMANCE_TERMINAL;
export const createCapabilityFixtureState:
  RunnerTestingModule["createCapabilityFixtureState"] =
  runnerTesting.createCapabilityFixtureState;
export const normalizeCapabilitySemanticObservation:
  RunnerTestingModule["normalizeCapabilitySemanticObservation"] =
  runnerTesting.normalizeCapabilitySemanticObservation;
export const runControlPlanePortConformance =
  runnerTesting.runControlPlanePortConformance;
export const runSemanticConformanceKit:
  RunnerTestingModule["runSemanticConformanceKit"] =
  runnerTesting.runSemanticConformanceKit;
