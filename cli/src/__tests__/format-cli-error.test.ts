import { describe, expect, it } from "vitest";
import { formatCliError, markCauseRedacted } from "../format-cli-error.js";
import { redactTestDriveText } from "../commands/test-drive.js";

describe("formatCliError", () => {
  it("never renders an empty AggregateError as blank", () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:54329`), { code: "ECONNREFUSED" });
    const err = new AggregateError([refused("::1"), refused("127.0.0.1")], "");

    const text = formatCliError(err);

    expect(text).toContain("AggregateError");
    expect(text).toContain("connect ECONNREFUSED ::1:54329");
    expect(text).toContain("connect ECONNREFUSED 127.0.0.1:54329");
  });

  it("keeps update rollback reasons that live only in the cause", () => {
    // Shape thrown by rollbackAfterServiceValidationFailure when the restart also fails.
    const err = new Error(
      "paperclipai 2.0.0 failed service validation and was rolled back to 1.9.0, but the rolled-back service also failed to restart.",
      { cause: new AggregateError([new Error("health check timed out"), new Error("port 3100 in use")]) },
    );

    const text = formatCliError(err);

    expect(text).toContain("rolled back to 1.9.0");
    expect(text).toContain("health check timed out");
    expect(text).toContain("port 3100 in use");
  });

  it("does not repeat a cause the message already contains", () => {
    const inner = new Error("spawn npm ENOENT");
    const err = new Error(`${inner.message}\nnpm not found`, { cause: inner });
    expect(formatCliError(err)).toBe("spawn npm ENOENT\nnpm not found");
  });

  it("never prints the cause chain of an error marked as redacted", () => {
    const apiKey = "sk-test-1234567890abcdef";
    const raw = new Error(`provider rejected key ${apiKey}`);
    const wrapped = markCauseRedacted(new Error(redactTestDriveText(raw.message, [apiKey]), { cause: raw }));

    const text = formatCliError(wrapped);

    expect(text).toBe("provider rejected key [REDACTED]");
    expect(text).not.toContain(apiKey);
  });

  it("renders non-Error throwables", () => {
    expect(formatCliError("boom")).toBe("boom");
    expect(formatCliError({ reason: "x" })).toBe('{"reason":"x"}');
  });
});
