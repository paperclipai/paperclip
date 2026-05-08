import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, DescribeInstanceInformationCommand } from "@aws-sdk/client-ssm";
import { HttpError } from "../errors.js";
import { buildSsmProxyCommand, resolveSsmInstanceByTag } from "../services/aws-ssm.js";

const ssmMock = mockClient(SSMClient);

describe("aws-ssm helpers", () => {
  beforeEach(() => {
    ssmMock.reset();
  });
  afterEach(() => {
    ssmMock.reset();
  });

  describe("buildSsmProxyCommand", () => {
    it("builds the AWS-StartSSHSession ProxyCommand without --profile when awsProfile is null", () => {
      const cmd = buildSsmProxyCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-0123abc",
      });
      expect(cmd).toBe(
        "aws ssm start-session --target i-0123abc --document-name AWS-StartSSHSession --parameters portNumber=%p --region us-east-1",
      );
    });

    it("includes --profile when awsProfile is set", () => {
      const cmd = buildSsmProxyCommand({
        region: "us-east-1",
        awsProfile: "prod",
        instanceId: "i-0123abc",
      });
      expect(cmd).toContain("--profile prod");
    });

    it("preserves the literal %p so OpenSSH expands it at connect time", () => {
      const cmd = buildSsmProxyCommand({
        region: "eu-west-1",
        awsProfile: null,
        instanceId: "i-xyz",
      });
      expect(cmd).toContain("portNumber=%p");
    });
  });

  describe("resolveSsmInstanceByTag", () => {
    const baseInput = {
      region: "us-east-1",
      awsProfile: null,
      tagKey: "Paperclip",
      tagValue: "runner-prod",
    } as const;

    it("returns the single matching online instance", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          {
            InstanceId: "i-deadbeef",
            PingStatus: "Online",
            PlatformType: "Linux",
            ComputerName: "ip-10-0-0-1",
          },
        ],
      });

      const resolved = await resolveSsmInstanceByTag(baseInput);
      expect(resolved.instanceId).toBe("i-deadbeef");
      expect(resolved.platformType).toBe("Linux");
      expect(resolved.pingStatus).toBe("Online");
    });

    it("filters by tag and PingStatus=Online", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).callsFake((input) => {
        const filters = input.Filters ?? [];
        const tagFilter = filters.find((f: { Key?: string }) => f.Key === "tag:Paperclip");
        const pingFilter = filters.find((f: { Key?: string }) => f.Key === "PingStatus");
        expect(tagFilter?.Values).toEqual(["runner-prod"]);
        expect(pingFilter?.Values).toEqual(["Online"]);
        return {
          InstanceInformationList: [
            { InstanceId: "i-only", PingStatus: "Online" },
          ],
        };
      });

      const resolved = await resolveSsmInstanceByTag(baseInput);
      expect(resolved.instanceId).toBe("i-only");
    });

    it("rejects with unprocessable when no instances match", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [],
      });

      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toBeInstanceOf(HttpError);
      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("No online SSM-managed instance"),
      });
    });

    it("rejects with unprocessable when multiple instances match", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          { InstanceId: "i-aaa", PingStatus: "Online" },
          { InstanceId: "i-bbb", PingStatus: "Online" },
        ],
      });

      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("Multiple SSM-managed instances"),
      });
    });

    it("rejects when tagKey or tagValue is empty", async () => {
      await expect(
        resolveSsmInstanceByTag({ ...baseInput, tagKey: "" }),
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        resolveSsmInstanceByTag({ ...baseInput, tagValue: "   " }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("wraps SDK errors in unprocessable with context", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).rejects(new Error("AccessDenied"));
      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("Failed to query AWS SSM"),
      });
    });
  });
});
