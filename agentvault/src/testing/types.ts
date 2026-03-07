/**
 * Types for local test runner
 */

/** Test type */
export type TestType = 'unit' | 'integration' | 'load-test';

/** Test result status */
export type TestStatus = 'passed' | 'failed' | 'skipped';

/** Individual test case result */
export interface TestCase {
  /** Test name */
  name: string;
  /** Test status */
  status: TestStatus;
  /** Duration in milliseconds */
  duration: number;
  /** Error message if failed */
  error?: string;
  /** Error stack if failed */
  stack?: string;
}

/** Test suite result */
export interface TestSuite {
  /** Suite name */
  name: string;
  /** Total number of tests */
  total: number;
  /** Number of passed tests */
  passed: number;
  /** Number of failed tests */
  failed: number;
  /** Number of skipped tests */
  skipped: number;
  /** Duration in milliseconds */
  duration: number;
  /** Individual test cases */
  tests: TestCase[];
}

/** Test runner options */
export interface TestRunnerOptions {
  /** Agent name to test */
  agentName: string;
  /** Network to run tests against */
  network: string;
  /** Test type */
  testType: TestType;
  /** Enable watch mode */
  watch?: boolean;
  /** Load test concurrency */
  concurrency?: number;
  /** Load test duration in seconds */
  loadDuration?: number;
  /** Output format */
  outputFormat?: 'json' | 'junit' | 'html';
  /** Verbose output */
  verbose?: boolean;
}

/** Load test configuration */
export interface LoadTestConfig {
  /** Number of concurrent requests */
  concurrency: number;
  /** Test duration in seconds */
  duration: number;
  /** Target canister ID */
  canisterId: string;
  /** Method to call */
  method: string;
  /** Request arguments (Candid format) */
  args?: string;
  /** Ramp-up time in seconds */
  rampUp?: number;
}

/** Load test result */
export interface LoadTestResult {
  /** Total requests sent */
  totalRequests: number;
  /** Successful requests */
  successfulRequests: number;
  /** Failed requests */
  failedRequests: number;
  /** Requests per second */
  requestsPerSecond: number;
  /** Average response time in milliseconds */
  avgResponseTime: number;
  /** Minimum response time in milliseconds */
  minResponseTime: number;
  /** Maximum response time in milliseconds */
  maxResponseTime: number;
  /** Percentiles */
  percentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** Error breakdown */
  errors: Record<string, number>;
}
