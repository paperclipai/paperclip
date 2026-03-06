import {
  extractIssueIdFromDeepLink,
  parseIssueWakePayload,
} from "../src/notification-contract.ts";

type TestCase = {
  name: string;
  run: () => void;
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const cases: TestCase[] = [
  {
    name: "assignment payload via eventType",
    run: () => {
      const parsed = parseIssueWakePayload({
        eventType: "issue_assignment",
        issueId: "abc-123",
        issueIdentifier: "OTTAAA-16",
        deepLink: "paperclip-mobile://issue/abc-123",
      });
      assert(parsed?.kind === "assignment", "expected assignment kind");
      assert(parsed?.issueId === "abc-123", "expected issueId");
      assert(parsed?.issueIdentifier === "OTTAAA-16", "expected issueIdentifier");
    },
  },
  {
    name: "mention payload via reason alias",
    run: () => {
      const parsed = parseIssueWakePayload({
        reason: "mention",
        issueId: "def-456",
        url: "paperclip-mobile://open?issueId=def-456",
      });
      assert(parsed?.kind === "mention", "expected mention kind");
      assert(parsed?.deepLink === "paperclip-mobile://open?issueId=def-456", "expected url fallback");
    },
  },
  {
    name: "unknown payload ignored",
    run: () => {
      const parsed = parseIssueWakePayload({
        eventType: "heartbeat",
        issueId: "zzz",
      });
      assert(parsed === null, "expected null for unsupported payload");
    },
  },
  {
    name: "deep link path extraction",
    run: () => {
      const issueId = extractIssueIdFromDeepLink("paperclip-mobile://issue/xyz-789");
      assert(issueId === "xyz-789", "expected issueId from path link");
    },
  },
  {
    name: "deep link query extraction",
    run: () => {
      const issueId = extractIssueIdFromDeepLink("paperclip-mobile://open?issueId=qwe-111");
      assert(issueId === "qwe-111", "expected issueId from query link");
    },
  },
];

function main(): void {
  const startedAt = new Date().toISOString();
  console.log(`# Notification Contract Verification`);
  console.log(`Started: ${startedAt}`);

  let passed = 0;
  for (const testCase of cases) {
    testCase.run();
    passed += 1;
    console.log(`PASS: ${testCase.name}`);
  }

  const finishedAt = new Date().toISOString();
  console.log(`Summary: ${passed}/${cases.length} cases passed`);
  console.log(`Finished: ${finishedAt}`);
}

main();
