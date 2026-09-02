#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$PACKAGE_DIR/infra/aws-agentcore-paperclip.yaml"
STACK_DESCRIPTION="Paperclip proof-of-concept Amazon Bedrock AgentCore Harness and least-privilege invocation roles."
LOCAL_DIR="$PACKAGE_DIR/.paperclip-local"
ENV_FILE="$LOCAL_DIR/aws-agentcore.env"
ACTIVE_FILE="$LOCAL_DIR/aws-agentcore-lab.pid"
ACTION="${1:-}"
if [[ -n "$ACTION" ]]; then shift; fi

AWS_PROFILE_NAME="${AWS_PROFILE:-default}"
AWS_REGION_NAME="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AWS_PROFILE_EXPLICIT=false
AWS_REGION_EXPLICIT=false
DEPLOYMENT_MODE="development"
STACK_NAME="paperclip-agentcore-development"
STACK_NAME_EXPLICIT=false
ENDPOINT_NAME="paperclip"
MODEL_ID="global.anthropic.claude-sonnet-4-6"
MARKETPLACE_PRODUCT_ID="prod-ffvjxvh4ltq64"
MARKETPLACE_PRODUCT_ID_EXPLICIT=false
TRUSTED_PRINCIPAL=""
CONTEXT_PREFIX=""
DRY_RUN=false
FORCE=false
YES=false
REPLACE_FAILED_STACK=false

usage() {
  printf '%s\n' \
    "Usage: aws-agentcore.sh <provision|probe|lab|destroy> [options]" \
    "  --aws-profile NAME   AWS CLI v2 profile (default: $AWS_PROFILE_NAME)" \
    "  --region REGION      commercial AWS region (default: $AWS_REGION_NAME)" \
    "  --mode MODE          development or private" \
    "  --stack-name NAME    CloudFormation stack name" \
    "  --model MODEL_ID     Bedrock-native model ID" \
    "  --marketplace-product-id ID  exact AWS Marketplace product ID for the model" \
    "  --principal ARN      stable IAM role/user trusted to assume runner role" \
    "  --context-prefix PFX S3 prefix dedicated to this qualified profile" \
    "  --dry-run            validate and print changes without deployment" \
    "  --replace-failed-stack  explicitly replace an owned ROLLBACK_COMPLETE stack" \
    "  --yes                confirm destructive replacement or teardown" \
    "  --force              destroy even when a recorded Lab process is active"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --aws-profile) AWS_PROFILE_NAME="$2"; AWS_PROFILE_EXPLICIT=true; shift 2 ;;
    --region) AWS_REGION_NAME="$2"; AWS_REGION_EXPLICIT=true; shift 2 ;;
    --mode) DEPLOYMENT_MODE="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; STACK_NAME_EXPLICIT=true; shift 2 ;;
    --model) MODEL_ID="$2"; shift 2 ;;
    --marketplace-product-id) MARKETPLACE_PRODUCT_ID="$2"; MARKETPLACE_PRODUCT_ID_EXPLICIT=true; shift 2 ;;
    --principal) TRUSTED_PRINCIPAL="$2"; shift 2 ;;
    --context-prefix) CONTEXT_PREFIX="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --replace-failed-stack) REPLACE_FAILED_STACK=true; shift ;;
    --force) FORCE=true; shift ;;
    --yes) YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$ACTION" != "provision" && "$ACTION" != "probe" && "$ACTION" != "lab" && "$ACTION" != "destroy" ]]; then
  usage >&2
  exit 2
fi
if [[ "$DEPLOYMENT_MODE" != "development" && "$DEPLOYMENT_MODE" != "private" ]]; then
  printf 'Mode must be development or private.\n' >&2
  exit 2
fi
if [[ ! "$AWS_PROFILE_NAME" =~ ^[A-Za-z0-9_.@+-]+$ ]]; then
  printf 'AWS profile contains unsupported characters.\n' >&2
  exit 2
fi
if [[ ! "$AWS_REGION_NAME" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ || "$AWS_REGION_NAME" == cn-* || "$AWS_REGION_NAME" == us-gov-* ]]; then
  printf 'This proof of concept currently supports commercial AWS regions only.\n' >&2
  exit 2
fi
if [[ ! "$MODEL_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$ ]]; then
  printf 'Bedrock model ID must not contain ARN, path, glob, or wildcard syntax.\n' >&2
  exit 2
fi
if [[ "$MODEL_ID" != "global.anthropic.claude-sonnet-4-6" && "$MARKETPLACE_PRODUCT_ID_EXPLICIT" != true ]]; then
  printf 'A custom --model requires its exact --marketplace-product-id so subscription authority remains model-scoped.\n' >&2
  exit 2
fi
if [[ ! "$MARKETPLACE_PRODUCT_ID" =~ ^prod-[a-z0-9]+$ ]]; then
  printf 'Marketplace product ID must use the AWS prod-* form.\n' >&2
  exit 2
fi
if [[ -z "$CONTEXT_PREFIX" ]]; then CONTEXT_PREFIX="paperclip/agentcore/$STACK_NAME"; fi
if [[ ! "$CONTEXT_PREFIX" =~ ^[a-z0-9][a-z0-9/_-]{1,127}$ || "$CONTEXT_PREFIX" == /* || "$CONTEXT_PREFIX" == */ || "$CONTEXT_PREFIX" == *//* || "/$CONTEXT_PREFIX/" == */./* || "/$CONTEXT_PREFIX/" == */../* ]]; then
  printf 'Context prefix must be a safe, relative S3 key prefix.\n' >&2
  exit 2
fi

aws_cli() {
  aws --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION_NAME" --no-cli-pager "$@"
}

require_aws() {
  command -v aws >/dev/null || { printf 'AWS CLI v2 is required.\n' >&2; exit 1; }
  local version
  version="$(aws --version 2>&1)"
  [[ "$version" == aws-cli/2.* ]] || { printf 'AWS CLI v2 is required; found %s\n' "$version" >&2; exit 1; }
}

json_field() {
  local key="$1"
  node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(0,"utf8"));let v=o;for(const k of process.argv[1].split("."))v=v?.[k];if(v!==undefined&&v!==null)process.stdout.write(String(v));' "$key"
}

stack_tag_value() {
  local key="$1"
  node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(0,"utf8"));const tag=o.Stacks?.[0]?.Tags?.find((candidate)=>candidate.Key===process.argv[1]);if(tag?.Value)process.stdout.write(tag.Value);' "$key"
}

stack_output() {
  local key="$1"
  aws_cli cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" --output text
}

wait_for_harness_status() {
  local harness_id="$1" harness_version="$2" status=""
  for _ in {1..60}; do
    status="$(aws_cli bedrock-agentcore-control get-harness --harness-id "$harness_id" --harness-version "$harness_version" --query harness.status --output text 2>/dev/null || true)"
    if [[ "$status" == "READY" ]]; then return 0; fi
    if [[ "$status" == "FAILED" || "$status" == "CREATE_FAILED" || "$status" == "UPDATE_FAILED" ]]; then
      printf 'Harness %s entered terminal status %s.\n' "$harness_id" "$status" >&2
      return 1
    fi
    sleep 5
  done
  printf 'Timed out waiting for Harness %s (last status: %s).\n' "$harness_id" "${status:-unknown}" >&2
  return 1
}

wait_for_memory_status() {
  local memory_id="$1" status=""
  for _ in {1..60}; do
    status="$(aws_cli bedrock-agentcore-control get-memory --memory-id "$memory_id" --query memory.status --output text 2>/dev/null || true)"
    [[ "$status" == "ACTIVE" ]] && return 0
    [[ "$status" == "FAILED" ]] && { printf 'Memory %s entered FAILED.\n' "$memory_id" >&2; return 1; }
    sleep 5
  done
  printf 'Timed out waiting for Memory %s (last status: %s).\n' "$memory_id" "${status:-unknown}" >&2
  return 1
}

wait_for_endpoint_status() {
  local harness_id="$1" endpoint_name="$2" status=""
  for _ in {1..60}; do
    status="$(aws_cli bedrock-agentcore-control get-harness-endpoint --harness-id "$harness_id" --endpoint-name "$endpoint_name" --query endpoint.status --output text 2>/dev/null || true)"
    [[ "$status" == "READY" ]] && return 0
    [[ "$status" == "FAILED" ]] && { printf 'Harness endpoint %s entered FAILED.\n' "$endpoint_name" >&2; return 1; }
    sleep 5
  done
  printf 'Timed out waiting for Harness endpoint %s (last status: %s).\n' "$endpoint_name" "${status:-unknown}" >&2
  return 1
}

normalize_principal() {
  local arn="$1"
  if [[ "$arn" =~ ^arn:(aws[^:]*):sts::([0-9]{12}):assumed-role/(.+)/[^/]+$ ]]; then
    # STS omits an IAM role's path from assumed-role ARNs. This matters for
    # Identity Center roles, whose canonical ARN lives under
    # /aws-reserved/sso.amazonaws.com/. Resolve it instead of constructing a
    # role ARN that may not exist.
    local role_name canonical_arn
    role_name="${BASH_REMATCH[3]##*/}"
    canonical_arn="$(aws_cli iam get-role --role-name "$role_name" --query Role.Arn --output text)"
    [[ "$canonical_arn" =~ ^arn:(aws[^:]*):iam::[0-9]{12}:role/.+$ ]] || {
      printf 'Could not resolve the canonical IAM role ARN for %s.\n' "$role_name" >&2
      exit 1
    }
    printf '%s\n' "$canonical_arn"
  elif [[ "$arn" =~ ^arn:(aws[^:]*):iam::[0-9]{12}:(role|user)/.+$ ]]; then
    printf '%s\n' "$arn"
  else
    printf 'The caller ARN cannot be normalized to a stable IAM role/user: %s\n' "$arn" >&2
    exit 1
  fi
}

load_local_env() {
  [[ -f "$ENV_FILE" ]] || { printf 'Missing %s; run aws-agentcore:provision first.\n' "$ENV_FILE" >&2; exit 1; }
  local requested_profile="$AWS_PROFILE_NAME" requested_region="$AWS_REGION_NAME" requested_stack="$STACK_NAME"
  # This file is generated locally, mode 0600, and contains nonsecret metadata only.
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  if $AWS_PROFILE_EXPLICIT; then AWS_PROFILE_NAME="$requested_profile"; else AWS_PROFILE_NAME="${AWS_PROFILE:-$requested_profile}"; fi
  if $AWS_REGION_EXPLICIT; then AWS_REGION_NAME="$requested_region"; else AWS_REGION_NAME="${AWS_REGION:-$requested_region}"; fi
  if $STACK_NAME_EXPLICIT; then STACK_NAME="$requested_stack"; else STACK_NAME="${PAPERCLIP_AWS_AGENTCORE_STACK_NAME:-$requested_stack}"; fi
  export AWS_PROFILE="$AWS_PROFILE_NAME"
  export AWS_REGION="$AWS_REGION_NAME"
  export AWS_DEFAULT_REGION="$AWS_REGION_NAME"
  export PAPERCLIP_AWS_AGENTCORE_STACK_NAME="$STACK_NAME"
}

write_teardown_metadata() {
  mkdir -p "$LOCAL_DIR"
  umask 077
  local tmp="$ENV_FILE.tmp.$$"
  printf '%q\n' \
    "AWS_PROFILE=$AWS_PROFILE_NAME" \
    "AWS_REGION=$AWS_REGION_NAME" \
    "AWS_DEFAULT_REGION=$AWS_REGION_NAME" \
    "PAPERCLIP_AWS_AGENTCORE_STACK_NAME=$STACK_NAME" >"$tmp"
  if [[ -n "${AWS_CONFIG_FILE:-}" ]]; then
    printf 'AWS_CONFIG_FILE=%q\n' "$AWS_CONFIG_FILE" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

assume_runner_role() {
  local role_arn="$1"
  local response access secret token
  if ! response="$(aws_cli sts assume-role --role-arn "$role_arn" --role-session-name paperclip-agentcore-probe --duration-seconds 900 --output json 2>&1)"; then
    local caller
    caller="$(aws_cli sts get-caller-identity --query Arn --output text 2>/dev/null || printf '<caller-arn>')"
    printf 'Cannot assume %s. Add this statement to the caller policy for %s:\n' "$role_arn" "$caller" >&2
    printf '{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"%s"}\n' "$role_arn" >&2
    printf '%s\n' "$response" | sed -E 's/(ASIA|AKIA)[A-Z0-9]+/[REDACTED]/g' >&2
    return 1
  fi
  access="$(printf '%s' "$response" | json_field Credentials.AccessKeyId)"
  secret="$(printf '%s' "$response" | json_field Credentials.SecretAccessKey)"
  token="$(printf '%s' "$response" | json_field Credentials.SessionToken)"
  export AWS_ACCESS_KEY_ID="$access" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token"
  unset AWS_PROFILE
}

probe() {
  load_local_env
  local profile_save="$AWS_PROFILE_NAME" harness_json
  assume_runner_role "$PAPERCLIP_AWS_AGENTCORE_INVOCATION_ROLE_ARN"
  AWS_PROFILE_NAME=""
  harness_json="$(aws --region "$AWS_REGION_NAME" --no-cli-pager bedrock-agentcore-control get-harness \
    --harness-id "$PAPERCLIP_AWS_AGENTCORE_HARNESS_ID" \
    --harness-version "$PAPERCLIP_AWS_AGENTCORE_HARNESS_VERSION" --output json)"
  printf '%s' "$harness_json" | node -e '
    const fs = require("fs");
    const h = JSON.parse(fs.readFileSync(0, "utf8")).harness;
    const expectedModel = process.env.PAPERCLIP_AWS_AGENTCORE_MODEL;
    if (!h || h.model?.bedrockModelConfig?.modelId !== expectedModel) throw new Error("AgentCore model drift");
    if (JSON.stringify(h.allowedTools) !== JSON.stringify(["@*/pc_*"])) throw new Error("AgentCore tool allowlist drift");
    if (!Array.isArray(h.tools) || h.tools.length !== 0) throw new Error("AgentCore persistent tool drift");
    if (!Array.isArray(h.skills) || h.skills.length !== 0) throw new Error("AgentCore skill drift");
  '
  aws --region "$AWS_REGION_NAME" --no-cli-pager bedrock-agentcore-control get-harness-endpoint \
    --harness-id "$PAPERCLIP_AWS_AGENTCORE_HARNESS_ID" \
    --endpoint-name "$PAPERCLIP_AWS_AGENTCORE_ENDPOINT_QUALIFIER" >/dev/null
  aws --region "$AWS_REGION_NAME" --no-cli-pager bedrock-agentcore-control get-memory \
    --memory-id "$PAPERCLIP_AWS_AGENTCORE_MEMORY_ID" --view full >/dev/null
  [[ -n "$PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET" && -n "$PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX" && -n "$PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN" ]] || {
    printf 'AWS AgentCore profile is missing its qualified S3/KMS runtime context.\n' >&2
    exit 1
  }
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  AWS_PROFILE_NAME="$profile_save"
  printf 'AWS AgentCore profile qualified: %s (%s, Harness %s, Memory %s; 90-day retention).\n' \
    "$PAPERCLIP_AWS_AGENTCORE_PROFILE_ID" "$AWS_REGION_NAME" \
    "$PAPERCLIP_AWS_AGENTCORE_HARNESS_VERSION" "$PAPERCLIP_AWS_AGENTCORE_MEMORY_ID"
}

provision() {
  require_aws
  local identity caller_arn account_id partition model_resource_arn foundation_model_id foundation_model_resource_arn
  identity="$(aws_cli sts get-caller-identity --output json)"
  caller_arn="$(printf '%s' "$identity" | json_field Arn)"
  account_id="$(printf '%s' "$identity" | json_field Account)"
  partition="$(printf '%s' "$caller_arn" | cut -d: -f2)"
  model_resource_arn="arn:$partition:bedrock:$AWS_REGION_NAME:$account_id:inference-profile/$MODEL_ID"
  foundation_model_id="$(printf '%s' "$MODEL_ID" | sed -E 's/^(global|us|eu|apac)\.//')"
  foundation_model_resource_arn="arn:$partition:bedrock:*::foundation-model/$foundation_model_id"
  if [[ -z "$TRUSTED_PRINCIPAL" ]]; then TRUSTED_PRINCIPAL="$(normalize_principal "$caller_arn")"; fi
  if [[ "$DEPLOYMENT_MODE" == "private" ]]; then
    aws_cli bedrock-agentcore-control list-harnesses --max-results 1 >/dev/null || {
      printf 'Private mode is unavailable because AgentCore Harness is not enabled in %s.\n' "$AWS_REGION_NAME" >&2
      exit 1
    }
    local services
    services="$(aws_cli ec2 describe-vpc-endpoint-services --query 'ServiceNames' --output text)"
    for service in "com.amazonaws.$AWS_REGION_NAME.ecr.api" "com.amazonaws.$AWS_REGION_NAME.ecr.dkr" "com.amazonaws.$AWS_REGION_NAME.s3" "com.amazonaws.$AWS_REGION_NAME.bedrock-runtime"; do
      [[ " $services " == *" $service "* ]] || { printf 'Private mode is unavailable: missing VPC endpoint service %s\n' "$service" >&2; exit 1; }
    done
  fi
  aws_cli cloudformation validate-template --template-body "file://$TEMPLATE" >/dev/null
  printf 'Stack: %s\nRegion: %s\nMode: %s\nModel: %s\nTrusted principal: %s\n' \
    "$STACK_NAME" "$AWS_REGION_NAME" "$DEPLOYMENT_MODE" "$MODEL_ID" "$TRUSTED_PRINCIPAL"
  printf 'Expected charges: Bedrock model tokens, AgentCore Runtime active time, Memory storage/requests, and (private mode) VPC endpoints.\n'
  if $DRY_RUN; then
    printf 'Dry run complete; the template is syntactically valid and no resources were changed.\n'
    return
  fi
  local existing_stack="" existing_status=""
  if existing_stack="$(aws_cli cloudformation describe-stacks --stack-name "$STACK_NAME" --output json 2>&1)"; then
    local existing_description existing_owned existing_environment existing_cost_center
    existing_status="$(printf '%s' "$existing_stack" | json_field Stacks.0.StackStatus)"
    existing_description="$(printf '%s' "$existing_stack" | json_field Stacks.0.Description)"
    existing_owned="$(printf '%s' "$existing_stack" | stack_tag_value paperclip:owned)"
    existing_environment="$(printf '%s' "$existing_stack" | stack_tag_value paperclip:environment)"
    existing_cost_center="$(printf '%s' "$existing_stack" | stack_tag_value paperclip:cost-center)"
    if [[ -z "$existing_status" || "$existing_description" != "$STACK_DESCRIPTION" || "$existing_owned" != "true" || "$existing_environment" != "development" || "$existing_cost_center" != "runner-lab" ]]; then
      printf 'Refusing to modify stack %s: Paperclip ownership tags or template provenance do not match. Inspect or remove it manually, or choose another --stack-name.\n' "$STACK_NAME" >&2
      exit 1
    fi
  elif [[ "$existing_stack" == *"(ValidationError)"* && "$existing_stack" == *"does not exist"* ]]; then
    existing_stack=""
  else
    printf 'Unable to verify whether stack %s exists and is owned by Paperclip; refusing to provision.\n' "$STACK_NAME" >&2
    exit 1
  fi
  if [[ "$existing_status" == "ROLLBACK_COMPLETE" ]]; then
    if ! $REPLACE_FAILED_STACK; then
      printf 'Stack %s is ROLLBACK_COMPLETE. Re-run with --replace-failed-stack to explicitly authorize deleting this verified Paperclip stack.\n' "$STACK_NAME" >&2
      exit 1
    fi
    if ! $YES; then
      printf 'Delete verified Paperclip stack %s before retrying provisioning? [y/N] ' "$STACK_NAME"
      read -r answer || true
      [[ "$answer" == y || "$answer" == Y ]] || { printf 'Cancelled.\n'; return; }
    fi
    printf 'Removing verified failed Paperclip stack %s before retrying provisioning.\n' "$STACK_NAME"
    aws_cli cloudformation delete-stack --stack-name "$STACK_NAME"
    aws_cli cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
  fi
  aws_cli cloudformation deploy \
    --template-file "$TEMPLATE" \
    --stack-name "$STACK_NAME" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "EnvironmentName=development" "DeploymentMode=$DEPLOYMENT_MODE" \
      "HarnessEndpointName=$ENDPOINT_NAME" \
      "ContextPrefix=$CONTEXT_PREFIX" \
      "TrustedRunnerPrincipalArn=$TRUSTED_PRINCIPAL" "BedrockModelId=$MODEL_ID" \
      "BedrockModelResourceArn=$model_resource_arn" \
      "BedrockFoundationModelResourceArn=$foundation_model_resource_arn" \
      "BedrockMarketplaceProductId=$MARKETPLACE_PRODUCT_ID" \
    --tags paperclip:owned=true paperclip:environment=development paperclip:cost-center=runner-lab
  # CloudFormation has created the billable resources at this point. Persist
  # the nonsecret coordinates needed by `destroy` before any qualification
  # API call can fail, then replace this checkpoint with the full qualified
  # profile only after every resource is ready.
  write_teardown_metadata
  local harness_id harness_arn harness_version runtime_arn memory_id memory_arn role_arn context_bucket context_prefix context_kms_key_arn qualification_revision
  harness_id="$(stack_output HarnessId)"
  harness_arn="$(stack_output HarnessArn)"
  harness_version="$(stack_output HarnessVersion)"
  runtime_arn="$(stack_output AgentRuntimeArn)"
  memory_id="$(stack_output MemoryId)"
  memory_arn="$(stack_output MemoryArn)"
  role_arn="$(stack_output RunnerInvocationRoleArn)"
  context_bucket="$(stack_output ContextBucketName)"
  context_prefix="$(stack_output ContextPrefix)"
  context_kms_key_arn="$(stack_output ContextKmsKeyArn)"
  qualification_revision="$(stack_output QualificationRevision)"
  wait_for_harness_status "$harness_id" "$harness_version"
  wait_for_memory_status "$memory_id"
  if aws_cli bedrock-agentcore-control get-harness-endpoint --harness-id "$harness_id" --endpoint-name "$ENDPOINT_NAME" >/dev/null 2>&1; then
    aws_cli bedrock-agentcore-control update-harness-endpoint --harness-id "$harness_id" --endpoint-name "$ENDPOINT_NAME" \
      --target-version "$harness_version" --description "Paperclip pinned Harness endpoint" \
      --client-token "paperclip-update-$harness_id-$harness_version" >/dev/null
  else
    aws_cli bedrock-agentcore-control create-harness-endpoint --harness-id "$harness_id" --endpoint-name "$ENDPOINT_NAME" \
      --target-version "$harness_version" --description "Paperclip pinned Harness endpoint" \
      --client-token "paperclip-create-$harness_id-$harness_version" \
      --tags paperclip:owned=true,paperclip:environment=development >/dev/null
  fi
  wait_for_endpoint_status "$harness_id" "$ENDPOINT_NAME"
  local endpoint_json endpoint_arn
  endpoint_json="$(aws_cli bedrock-agentcore-control get-harness-endpoint --harness-id "$harness_id" --endpoint-name "$ENDPOINT_NAME" --output json)"
  endpoint_arn="$(printf '%s' "$endpoint_json" | node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(o.endpoint?.arn||o.harnessEndpointArn||o.endpointArn||o.arn||"")')"
  [[ -n "$endpoint_arn" ]] || endpoint_arn="$harness_arn/endpoint/$ENDPOINT_NAME"
  mkdir -p "$LOCAL_DIR"
  umask 077
  local tmp="$ENV_FILE.tmp.$$"
  printf '%q\n' \
    "AWS_PROFILE=$AWS_PROFILE_NAME" \
    "AWS_REGION=$AWS_REGION_NAME" \
    "AWS_DEFAULT_REGION=$AWS_REGION_NAME" \
    "PAPERCLIP_AWS_AGENTCORE_STACK_NAME=$STACK_NAME" \
    "PAPERCLIP_AWS_AGENTCORE_PROFILE_ID=$STACK_NAME" \
    "PAPERCLIP_AWS_AGENTCORE_ACCOUNT_ID=$account_id" \
    "PAPERCLIP_AWS_AGENTCORE_HARNESS_ARN=$harness_arn" \
    "PAPERCLIP_AWS_AGENTCORE_HARNESS_ID=$harness_id" \
    "PAPERCLIP_AWS_AGENTCORE_HARNESS_VERSION=$harness_version" \
    "PAPERCLIP_AWS_AGENTCORE_ENDPOINT_ARN=$endpoint_arn" \
    "PAPERCLIP_AWS_AGENTCORE_ENDPOINT_QUALIFIER=$ENDPOINT_NAME" \
    "PAPERCLIP_AWS_AGENTCORE_RUNTIME_ARN=$runtime_arn" \
    "PAPERCLIP_AWS_AGENTCORE_MEMORY_ARN=$memory_arn" \
    "PAPERCLIP_AWS_AGENTCORE_MEMORY_ID=$memory_id" \
    "PAPERCLIP_AWS_AGENTCORE_INVOCATION_ROLE_ARN=$role_arn" \
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET=$context_bucket" \
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX=$context_prefix" \
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN=$context_kms_key_arn" \
    "PAPERCLIP_AWS_AGENTCORE_MODEL=$MODEL_ID" \
    "PAPERCLIP_AWS_AGENTCORE_QUALIFICATION_REVISION=$qualification_revision" \
    "PAPERCLIP_AWS_AGENTCORE_EVENT_EXPIRY_DAYS=90" >"$tmp"
  if [[ -n "${AWS_CONFIG_FILE:-}" ]]; then
    printf 'AWS_CONFIG_FILE=%q\n' "$AWS_CONFIG_FILE" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  probe
  printf 'Wrote nonsecret local profile metadata to %s (0600).\n' "$ENV_FILE"
}

lab() {
  load_local_env
  if [[ -f "$ACTIVE_FILE" ]] && kill -0 "$(cat "$ACTIVE_FILE")" 2>/dev/null; then
    printf 'Runner Lab is already active as PID %s.\n' "$(cat "$ACTIVE_FILE")" >&2
    exit 1
  fi
  printf '%s\n' "$$" >"$ACTIVE_FILE"
  chmod 600 "$ACTIVE_FILE"
  trap 'rm -f "$ACTIVE_FILE"' EXIT INT TERM
  cd "$PACKAGE_DIR"
  pnpm console:issue-thread
}

destroy() {
  require_aws
  load_local_env
  if [[ -f "$ACTIVE_FILE" ]] && kill -0 "$(cat "$ACTIVE_FILE")" 2>/dev/null && ! $FORCE; then
    printf 'Runner Lab PID %s is active; stop it or pass --force.\n' "$(cat "$ACTIVE_FILE")" >&2
    exit 1
  fi
  if ! $YES; then
    printf 'Delete the pinned AgentCore endpoint and CloudFormation stack %s? [y/N] ' "$STACK_NAME"
    read -r answer
    [[ "$answer" == y || "$answer" == Y ]] || { printf 'Cancelled.\n'; return; }
  fi
  local harness_id context_bucket context_prefix profile_save
  harness_id="$(stack_output HarnessId)"
  context_bucket="$(stack_output ContextBucketName)"
  context_prefix="$(stack_output ContextPrefix)"
  aws_cli bedrock-agentcore-control delete-harness-endpoint --harness-id "$harness_id" --endpoint-name "$ENDPOINT_NAME" \
    --client-token "paperclip-delete-$harness_id-$ENDPOINT_NAME" >/dev/null 2>&1 || true
  profile_save="$AWS_PROFILE_NAME"
  assume_runner_role "$(stack_output RunnerInvocationRoleArn)"
  aws --region "$AWS_REGION_NAME" --no-cli-pager s3 rm "s3://$context_bucket/$context_prefix/assets/" --recursive >/dev/null
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  AWS_PROFILE_NAME="$profile_save"
  aws_cli cloudformation delete-stack --stack-name "$STACK_NAME"
  aws_cli cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
  rm -f "$ENV_FILE" "$ACTIVE_FILE"
  printf 'Deleted AgentCore endpoint and stack. Local profile metadata was removed.\n'
}

case "$ACTION" in
  provision) provision ;;
  probe) require_aws; probe ;;
  lab) lab ;;
  destroy) destroy ;;
esac
