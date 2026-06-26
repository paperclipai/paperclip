# Loader Events Terraform

This module wires the canonical telemetry archive bucket to the raw loader queue:

`S3 ObjectCreated -> RawLoaderQueue -> LoaderFunction (added separately)`

## Managed-service choice

This uses managed AWS S3 bucket notifications and SQS because the source data is already in S3 and the next consumer is a Lambda event-source mapping. Alternatives considered:

- EventBridge S3 notifications: useful for richer routing, but adds another managed service and rule surface we do not need for one bucket/prefix to one queue.
- Kinesis: higher-throughput stream semantics, but the loader needs durable batch retry and DLQ behavior, which SQS provides directly with lower operational overhead.
- Self-managed queue/worker broker: rejected because SQS gives retention, redrive, IAM integration, and AWS-native S3 delivery without operating infrastructure.

Estimated idle cost is near zero. SQS charges per request and S3 notifications have no separate per-notification infrastructure to operate.

## Apply

Copy `terraform.tfvars.example` to `terraform.tfvars` and set the canonical bucket details:

```sh
terraform init
terraform plan
terraform apply
```

The `raw_loader_queue_arn` output is consumed by the later loader Lambda deployment and event-source mapping task.

Provider lockfile note: this repo does not currently commit Terraform provider
lockfiles for infra modules. This environment has OpenTofu but not Terraform;
the OpenTofu-generated lockfile uses the OpenTofu registry address and is
therefore intentionally not committed for this Terraform-oriented module.

## Rollback

Rollback is a Terraform destroy or targeted removal of this module. Removing `aws_s3_bucket_notification.canonical_to_raw_loader` stops new S3 events from entering the queue. Removing the queues deletes any in-flight and retained messages, including DLQ messages, so inspect or drain both queues before destroying them in production.
