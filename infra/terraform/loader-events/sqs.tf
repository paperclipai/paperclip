resource "aws_sqs_queue" "raw_loader_dlq" {
  name                      = "${var.name_prefix}-raw-loader-dlq-${var.environment}"
  message_retention_seconds = var.dlq_message_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue_redrive_allow_policy" "raw_loader_dlq" {
  queue_url = aws_sqs_queue.raw_loader_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.raw_loader.arn]
  })
}

resource "aws_sqs_queue" "raw_loader" {
  name                       = "${var.name_prefix}-raw-loader-${var.environment}"
  message_retention_seconds  = var.raw_queue_message_retention_seconds
  visibility_timeout_seconds = var.raw_queue_visibility_timeout_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.raw_loader_dlq.arn
    maxReceiveCount     = var.raw_queue_max_receive_count
  })
}

data "aws_iam_policy_document" "raw_loader_from_s3" {
  statement {
    sid     = "AllowCanonicalBucketObjectCreatedNotifications"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    resources = [aws_sqs_queue.raw_loader.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [data.aws_s3_bucket.canonical.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "raw_loader_from_s3" {
  queue_url = aws_sqs_queue.raw_loader.id
  policy    = data.aws_iam_policy_document.raw_loader_from_s3.json
}

resource "aws_s3_bucket_notification" "canonical_to_raw_loader" {
  bucket = data.aws_s3_bucket.canonical.id

  queue {
    id            = "raw-loader-object-created-${var.environment}"
    queue_arn     = aws_sqs_queue.raw_loader.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = var.canonical_object_prefix
    filter_suffix = var.canonical_object_suffix
  }

  depends_on = [aws_sqs_queue_policy.raw_loader_from_s3]
}
