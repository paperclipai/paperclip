import fs from "node:fs";
import { describe, expect, it } from "vitest";

function assertReadOnlyInteractionsGet(source: string) {
  const start = source.search(
    /router\.get\(\s*["']\/issues\/:id\/interactions["']/,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const followingRoutes = source.slice(start);
  const end = followingRoutes.search(
    /router\.post\(\s*["']\/issues\/:id\/interactions["']/,
  );
  expect(end).toBeGreaterThan(0);
  const handler = followingRoutes.slice(0, end);

  expect(handler).toContain("listForIssue");
  expect(handler).not.toContain("expireRequestConfirmations");
  expect(handler).not.toContain("expirePendingInteractions");
  expect(handler).not.toContain("logActivity");
}

describe("issue interactions GET contract", () => {
  it("does not perform expiry sweeps or activity writes", () => {
    const source = fs.readFileSync(
      new URL("../routes/issues.ts", import.meta.url),
      "utf8",
    );
    assertReadOnlyInteractionsGet(source);
  });

  it.each(["", "\n    "])(
    "accepts a read-only GET with route whitespace %j",
    (whitespace) => {
      assertReadOnlyInteractionsGet(`
      router.get(${whitespace}"/issues/:id/interactions", async (req, res) => {
        res.json(await service.listForIssue(req.params.id));
      });
      router.post(${whitespace}"/issues/:id/interactions", async () => {
        await service.expirePendingInteractions();
        await logActivity();
      });
    `);
    },
  );

  it.each([
    "expireRequestConfirmations",
    "expirePendingInteractions",
    "logActivity",
  ])("still rejects %s inside a formatted GET", (mutation) => {
    expect(() =>
      assertReadOnlyInteractionsGet(`
        router.get(
          "/issues/:id/interactions", async (req, res) => {
            await service.${mutation}();
            res.json(await service.listForIssue(req.params.id));
          },
        );
        router.post(
          "/issues/:id/interactions", async () => {},
        );
      `),
    ).toThrow();
  });

  it.each(["get", "post"])(
    "fails closed if the %s boundary is missing",
    (missingMethod) => {
      const routes = ["get", "post"]
        .filter((method) => method !== missingMethod)
        .map(
          (method) =>
            `router.${method}("/issues/:id/interactions", () => service.listForIssue());`,
        )
        .join("\n");
      expect(() => assertReadOnlyInteractionsGet(routes)).toThrow();
    },
  );
});
