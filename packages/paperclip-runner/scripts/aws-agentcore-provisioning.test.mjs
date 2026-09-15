import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const templateUrl = new URL("../infra/aws-agentcore-paperclip.yaml", import.meta.url);
const wrapperUrl = new URL("./aws-agentcore.sh", import.meta.url);
const labServerUrl = new URL("./capability-issue-thread-server.mjs", import.meta.url);
const liveSessionUrl = new URL("../src/live/live-session.ts", import.meta.url);

function parameterAllowedPattern(source, parameterName) {
  const marker = `  ${parameterName}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${parameterName} parameter`);
  const remaining = source.slice(start + marker.length);
  const nextMatch = /\n  \S/.exec(remaining);
  const nextParameter = nextMatch ? start + marker.length + nextMatch.index : -1;
  const block = source.slice(start, nextParameter === -1 ? undefined : nextParameter);
  const match = block.match(/AllowedPattern: "([^"]+)"/);
  assert.ok(match, `missing ${parameterName} AllowedPattern`);
  return new RegExp(match[1]);
}

test("AgentCore template has closed development/private resources and explicit command denial", async () => {
  const source = await readFile(templateUrl, "utf8");
  for (const resource of [
    "AWS::BedrockAgentCore::Harness",
    "AWS::BedrockAgentCore::Memory",
    "AWS::S3::Bucket",
    "AWS::KMS::Key",
    "AWS::EC2::VPC",
    "com.amazonaws.${AWS::Region}.ecr.api",
    "com.amazonaws.${AWS::Region}.ecr.dkr",
    "com.amazonaws.${AWS::Region}.s3",
    "com.amazonaws.${AWS::Region}.bedrock-runtime",
  ]) assert.match(source, new RegExp(resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /AllowedValues: \[development, private\]/);
  assert.match(source, /Effect: Deny\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/g);
  assert.doesNotMatch(source, /Effect: Allow\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/);
  assert.doesNotMatch(source, /AWS::EC2::NatGateway|AWS::EC2::InternetGateway/);
  assert.match(source, /EventExpiryDuration: 90/);
  assert.match(source, /MaxIterations: 8/);
  assert.match(source, /MaxTokens: 4096/);
  assert.match(source, /TimeoutSeconds: 300/);
  assert.match(source, /AllowedTools:\s+- "@\*\/pc_\*"/);
  assert.match(source, /Tools: \[\]/);
  assert.match(source, /Skills: \[\]/);
  assert.doesNotMatch(source, /BedrockModelResourceArn:\s+[\s\S]{0,100}Default: "\*"/);
  assert.match(source, /BedrockModelId:[\s\S]*AllowedPattern: "\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}\$"/);
  assert.match(source, /BedrockModelResourceArn:[\s\S]*AllowedPattern:[^\n]+inference-profile[^\n]+\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}/);
  assert.match(source, /BedrockFoundationModelResourceArn:[\s\S]*AllowedPattern:[^\n]+foundation-model\/\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}/);
  const modelIdPattern = parameterAllowedPattern(source, "BedrockModelId");
  assert.match("global.anthropic.claude-sonnet-4-6", modelIdPattern);
  assert.match("anthropic.claude-3-5-sonnet-20241022-v2:0", modelIdPattern);
  for (const unsafeModelId of ["custom/model", "custom*", "custom?", "arn:aws:bedrock:us-east-1::foundation-model/custom"]) {
    assert.doesNotMatch(unsafeModelId, modelIdPattern);
  }
  const inferenceProfilePattern = parameterAllowedPattern(source, "BedrockModelResourceArn");
  assert.match("arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6", inferenceProfilePattern);
  assert.doesNotMatch("arn:aws:bedrock:us-east-1:123456789012:inference-profile/*", inferenceProfilePattern);
  assert.doesNotMatch("arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom/model", inferenceProfilePattern);
  const foundationModelPattern = parameterAllowedPattern(source, "BedrockFoundationModelResourceArn");
  assert.match("arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6", foundationModelPattern);
  assert.doesNotMatch("arn:aws:bedrock:*::foundation-model/*", foundationModelPattern);
  assert.doesNotMatch("arn:aws:bedrock:*::foundation-model/custom/model", foundationModelPattern);
  assert.match(source, /BedrockFoundationModelResourceArn/);
  assert.match(source, /HarnessEndpointName/);
  assert.match(source, /ContextPrefix/);
  assert.match(source, /BucketOwnerEnforced/);
  assert.match(source, /SSEAlgorithm: aws:kms/);
  assert.match(source, /EnableKeyRotation: true/);
  assert.match(source, /Sid: DenyInsecureTransport/);
  assert.match(source, /Sid: DenyUnencryptedContextUploads/);
  assert.match(source, /Sid: DenyContextUploadsWithAnotherKey/);
  assert.match(source, /Sid: WriteAndVerifyPinnedRuntimeContext[\s\S]*s3:GetObject[\s\S]*s3:PutObject[\s\S]*s3:DeleteObject[\s\S]*Resource: !Sub \$\{ContextBucket\.Arn\}\/\$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EncryptPinnedRuntimeContext[\s\S]*kms:Encrypt[\s\S]*kms:GenerateDataKey[\s\S]*Resource: !GetAtt ContextEncryptionKey\.Arn/);
  assert.match(source, /Sid: ReadPinnedRuntimeContext[\s\S]*Action: s3:GetObject[\s\S]*Resource: !Sub \$\{ContextBucket\.Arn\}\/\$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EnumeratePinnedRuntimeContext[\s\S]*Action: s3:ListBucket[\s\S]*Resource: !GetAtt ContextBucket\.Arn[\s\S]*s3:prefix: !Sub \$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EnumeratePinnedRuntimeContextForTeardown[\s\S]*Action: s3:ListBucket[\s\S]*Resource: !GetAtt ContextBucket\.Arn[\s\S]*s3:prefix: !Sub \$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: DecryptPinnedRuntimeContext[\s\S]*Action: kms:Decrypt[\s\S]*Resource: !GetAtt ContextEncryptionKey\.Arn/);
  const invocationRole = source.slice(source.indexOf("RunnerInvocationRole:"), source.indexOf("PrivateVpc:"));
  assert.doesNotMatch(invocationRole, /Action:\s+(?:-\s+)?(?:s3|kms):\*/);
  assert.match(invocationRole, /Action: sts:AssumeRoleWithWebIdentity/);
  assert.match(invocationRole, /token\.actions\.githubusercontent\.com:aud["']?: sts\.amazonaws\.com/);
  assert.match(invocationRole, /token\.actions\.githubusercontent\.com:sub["']?: !Sub repo:\$\{GitHubRepository\}:environment:\$\{GitHubEnvironment\}/);
  assert.doesNotMatch(invocationRole, /repo:\*|environment:\*/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/harness-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/runtime-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /BedrockMarketplaceProductId/);
  assert.match(source, /Sid: ViewMarketplaceSubscriptionsForModelAccess[\s\S]*Action: aws-marketplace:ViewSubscriptions[\s\S]*Sid: SubscribePinnedMarketplaceModel[\s\S]*Action: aws-marketplace:Subscribe[\s\S]*aws-marketplace:ProductId: !Ref BedrockMarketplaceProductId/);
  assert.doesNotMatch(source, /aws-marketplace:Unsubscribe/);
});

test("AgentCore wrapper is valid shell and writes only nonsecret profile metadata", async () => {
  execFileSync("bash", ["-n", wrapperUrl.pathname]);
  const source = await readFile(wrapperUrl, "utf8");
  const generatedBlock = source.slice(source.lastIndexOf('"AWS_PROFILE=$AWS_PROFILE_NAME"'), source.lastIndexOf('>"$tmp"'));
  const teardownBlock = source.slice(source.indexOf("write_teardown_metadata()"), source.indexOf("assume_runner_role()"));
  assert.ok(generatedBlock.length > 0);
  assert.ok(teardownBlock.length > 0);
  assert.doesNotMatch(generatedBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.doesNotMatch(teardownBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.match(teardownBlock, /PAPERCLIP_AWS_AGENTCORE_STACK_NAME=\$STACK_NAME/);
  assert.match(teardownBlock, /chmod 600 "\$tmp"/);
  assert.match(source, /chmod 600 "\$tmp"/);
  assert.match(source, /printf '%q\\n'/);
  assert.match(source, /printf 'AWS_CONFIG_FILE=%q\\n'/);
  assert.match(source, /AWS_PROFILE_EXPLICIT=true/);
  assert.match(source, /AWS_REGION_EXPLICIT=true/);
  assert.match(source, /STACK_NAME_EXPLICIT=true/);
  assert.equal((source.match(/local requested_profile=/g) ?? []).length, 1);
  assert.equal((source.match(/requested_region=/g) ?? []).length, 1);
  assert.equal((source.match(/requested_stack=/g) ?? []).length, 1);
  const destroyBlock = source.slice(source.indexOf("destroy()"), source.indexOf('case "$ACTION"'));
  assert.ok(destroyBlock.indexOf("load_local_env") < destroyBlock.indexOf("stack_output HarnessId"));
  assert.match(source, /cloudformation deploy/);
  const provisionBlock = source.slice(source.indexOf("provision()"), source.indexOf("lab()"));
  assert.ok(provisionBlock.indexOf("cloudformation deploy") < provisionBlock.indexOf("write_teardown_metadata"));
  assert.ok(provisionBlock.indexOf("write_teardown_metadata") < provisionBlock.indexOf("stack_output HarnessId"));
  assert.ok(provisionBlock.indexOf("write_teardown_metadata") < provisionBlock.indexOf("wait_for_harness_status"));
  assert.match(source, /CAPABILITY_NAMED_IAM/);
  assert.match(source, /--\) shift ;;/);
  assert.match(source, /iam get-role --role-name "\$role_name"/);
  assert.doesNotMatch(source, /printf 'arn:%s:iam::%s:role\/%s/);
  assert.match(source, /existing_status.*ROLLBACK_COMPLETE/s);
  assert.match(source, /--replace-failed-stack/);
  assert.match(provisionBlock, /existing_description.*STACK_DESCRIPTION/s);
  assert.match(provisionBlock, /existing_owned.*paperclip:owned/s);
  assert.match(provisionBlock, /existing_environment.*paperclip:environment/s);
  assert.match(provisionBlock, /existing_cost_center.*paperclip:cost-center/s);
  assert.ok(provisionBlock.indexOf("ownership tags or template provenance") < provisionBlock.indexOf("cloudformation delete-stack"));
  assert.ok(provisionBlock.indexOf("REPLACE_FAILED_STACK") < provisionBlock.indexOf("cloudformation delete-stack"));
  assert.match(provisionBlock, /Unable to verify whether stack .* exists and is owned by Paperclip/);
  assert.match(source, /cloudformation wait stack-delete-complete/);
  assert.match(source, /--query harness\.status/);
  assert.match(source, /AgentCore tool allowlist drift/);
  assert.match(source, /--query memory\.status/);
  assert.match(source, /--query endpoint\.status/);
  assert.match(source, /o\.endpoint\?\.arn/);
  assert.match(source, /--marketplace-product-id/);
  assert.match(source, /--github-oidc-provider-arn/);
  assert.match(source, /GitHubOidcProviderArn=\$GITHUB_OIDC_PROVIDER_ARN/);
  assert.match(source, /BedrockMarketplaceProductId=\$MARKETPLACE_PRODUCT_ID/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET=\$context_bucket/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX=\$context_prefix/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN=\$context_kms_key_arn/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_EXECUTION_ROLE_ARN=\$role_arn/);
  assert.match(source, /ContextPrefix=\$CONTEXT_PREFIX/);
  assert.match(source, /s3 rm "s3:\/\/\$context_bucket\/\$context_prefix\/assets\/" --recursive/);
  assert.ok(source.indexOf("delete-harness-endpoint") < source.lastIndexOf("cloudformation delete-stack"));
});

test("AgentCore wrapper rejects unsafe model IDs before AWS access", () => {
  const result = spawnSync("bash", [
    wrapperUrl.pathname,
    "provision",
    "--model",
    "custom/model/*",
    "--marketplace-product-id",
    "prod-safe123",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not contain ARN, path, glob, or wildcard syntax/);
});

test("AgentCore wrapper never implicitly deletes a colliding failed stack", async () => {
  const temp = await mkdtemp(join(tmpdir(), "paperclip-agentcore-test-"));
  const fakeAws = join(temp, "aws");
  const commandLog = join(temp, "aws.log");
  await writeFile(fakeAws, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$MOCK_AWS_LOG"
if [[ " $* " == *" --version "* || "$1" == "--version" ]]; then
  printf 'aws-cli/2.31.0 Python/3.13.0\\n'
elif [[ " $* " == *" sts get-caller-identity "* ]]; then
  printf '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:role/paperclip-test"}\\n'
elif [[ " $* " == *" cloudformation describe-stacks "* ]]; then
  printf '{"Stacks":[{"StackStatus":"ROLLBACK_COMPLETE","Description":"%s","Tags":[{"Key":"paperclip:owned","Value":"%s"},{"Key":"paperclip:environment","Value":"development"},{"Key":"paperclip:cost-center","Value":"runner-lab"}]}]}\\n' "\${MOCK_STACK_DESCRIPTION}" "\${MOCK_STACK_OWNED}"
elif [[ " $* " == *" cloudformation deploy "* ]]; then
  exit 42
fi
`, { mode: 0o700 });
  await chmod(fakeAws, 0o700);
  const baseEnv = {
    ...process.env,
    PATH: `${temp}:${process.env.PATH}`,
    MOCK_AWS_LOG: commandLog,
    MOCK_STACK_DESCRIPTION: "Paperclip proof-of-concept Amazon Bedrock AgentCore Harness and least-privilege invocation roles.",
    MOCK_STACK_OWNED: "true",
  };
  try {
    const implicit = spawnSync("bash", [wrapperUrl.pathname, "provision"], { encoding: "utf8", env: baseEnv });
    assert.equal(implicit.status, 1);
    assert.match(implicit.stderr, /--replace-failed-stack/);
    assert.doesNotMatch(await readFile(commandLog, "utf8"), /cloudformation delete-stack/);

    await writeFile(commandLog, "");
    const foreign = spawnSync("bash", [wrapperUrl.pathname, "provision", "--replace-failed-stack", "--yes"], {
      encoding: "utf8",
      env: { ...baseEnv, MOCK_STACK_OWNED: "false" },
    });
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /ownership tags or template provenance do not match/);
    assert.doesNotMatch(await readFile(commandLog, "utf8"), /cloudformation delete-stack/);

    await writeFile(commandLog, "");
    const explicit = spawnSync("bash", [wrapperUrl.pathname, "provision", "--replace-failed-stack", "--yes"], {
      encoding: "utf8",
      env: baseEnv,
    });
    assert.equal(explicit.status, 42);
    const explicitLog = await readFile(commandLog, "utf8");
    assert.match(explicitLog, /cloudformation delete-stack/);
    assert.ok(explicitLog.indexOf("cloudformation delete-stack") < explicitLog.indexOf("cloudformation deploy"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Runner Lab accepts and resolves the complete qualified AgentCore profile", async () => {
  const source = await readFile(labServerUrl, "utf8");
  assert.match(source, /provider !== "aws_agentcore"/);
  assert.match(source, /AWS AgentCore requires exact model global\.anthropic\.claude-sonnet-4-6/);
  assert.match(source, /function resolveAgentCoreProfile\(configuration\)/);
  for (const field of [
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN",
  ]) assert.match(source, new RegExp(field));
  assert.match(source, /agentCoreProfile: resolveAgentCoreProfile\(configuration\)/);
  assert.match(source, /agentCoreProfileId: snapshot\.config\.agentCoreProfile\.profileId/);
  assert.match(source, /configuration\.provider === "aws_agentcore" \? "remote_service"/);
});

test("Runner Lab qualifies Claude Managed and exposes remote governance for both remote providers", async () => {
  const source = await readFile(labServerUrl, "utf8");
  const liveSessionSource = await readFile(liveSessionUrl, "utf8");
  assert.match(source, /provider !== "claude_managed"/);
  assert.match(source, /Claude Managed requires exact model claude-sonnet-5/);
  assert.match(source, /function resolveManagedProfile\(configuration\)/);
  for (const field of [
    "PAPERCLIP_CLAUDE_MANAGED_PROFILE_ID",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MANAGED_AGENT_ID",
    "ANTHROPIC_MANAGED_AGENT_VERSION",
    "ANTHROPIC_MANAGED_ENVIRONMENT_ID",
  ]) assert.match(source, new RegExp(field));
  assert.match(source, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(source, /BigInt\(agentVersion\) <= 2_147_483_647n/);
  assert.match(source, /managedProfile: resolveManagedProfile\(configuration\)/);
  assert.match(source, /managedProfileId: snapshot\.config\.managedProfile\.profileId/);
  assert.match(source, /route === "managed-budget"/);
  assert.match(source, /entry\.session\.increaseManagedSessionBudget\(nextCap\)/);
  assert.match(source, /entry\.configuration\?\.provider === "claude_managed"/);
  assert.match(source, /entry\.configuration\?\.provider === "aws_agentcore"/);
  assert.match(source, /route === "managed-session-delete"/);
  assert.match(source, /body\.confirm !== true/);
  assert.match(source, /entry\.session\.deleteManagedRemoteSession\(\)/);
  assert.match(liveSessionSource, /async increaseManagedSessionBudget\(/);
  assert.match(liveSessionSource, /this\.#transport\.request\("session\/budget\/increase"/);
  assert.match(liveSessionSource, /async deleteManagedRemoteSession\(\)/);
  assert.match(liveSessionSource, /this\.#transport\.request\("session\/destroy"/);
});
