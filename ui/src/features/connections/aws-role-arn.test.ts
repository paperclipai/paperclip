import { describe, expect, it } from "vitest";
import { ROLE_ARN_PATTERN, roleArnFromAgentSummary } from "./aws-role-arn";

const roleName = "paperclip-c41a8e57-0f3b-4b6e-9d22-7a1e5c3f8b90";
const arn = `arn:aws:iam::123456789012:role/${roleName}`;

describe("roleArnFromAgentSummary", () => {
  it("reads this connection's role ARN from the agent's finish summary", () => {
    expect(roleArnFromAgentSummary(`Role ARN: ${arn}`, roleName)).toBe(arn);
    expect(roleArnFromAgentSummary(`Done. The role is ${arn}.`, roleName)).toBe(arn);
    expect(roleArnFromAgentSummary(`Role ARN: arn:aws:iam::123456789012:role/team/${roleName}`, roleName))
      .toBe(`arn:aws:iam::123456789012:role/team/${roleName}`);
  });

  it("never accepts another role, a longer name, or a malformed account", () => {
    expect(roleArnFromAgentSummary("Role ARN: arn:aws:iam::123456789012:role/admin", roleName)).toBeNull();
    expect(roleArnFromAgentSummary(`Role ARN: ${arn}-copy`, roleName)).toBeNull();
    expect(roleArnFromAgentSummary(`Role ARN: ${arn}/other`, roleName)).toBeNull();
    expect(roleArnFromAgentSummary(`Role ARN: ${arn}./other`, roleName)).toBeNull();
    expect(roleArnFromAgentSummary(`Role ARN: arn:aws:iam::12345:role/${roleName}`, roleName)).toBeNull();
    expect(roleArnFromAgentSummary("Stopped: no permission to create the role.", roleName)).toBeNull();
    expect(roleArnFromAgentSummary(null, roleName)).toBeNull();
  });

  it("only returns ARNs the connection's own validation accepts", () => {
    expect(ROLE_ARN_PATTERN.test(roleArnFromAgentSummary(`Role ARN: ${arn}`, roleName)!)).toBe(true);
    expect(ROLE_ARN_PATTERN.test("arn:aws:s3:::some-bucket")).toBe(false);
    expect(ROLE_ARN_PATTERN.test(`arn:aws:iam::123456789012:user/${roleName}`)).toBe(false);
  });
});
