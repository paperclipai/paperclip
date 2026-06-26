variable "aws_region" {
  description = "AWS region for SQS and the canonical S3 bucket."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment: dev, staging, or prod."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix."
  type        = string
  default     = "paperclip-telemetry"
}

variable "canonical_bucket_name" {
  description = "Existing canonical telemetry archive bucket that emits ObjectCreated events."
  type        = string
}

variable "canonical_object_prefix" {
  description = "Canonical object key prefix to notify on. Use the Firehose success prefix, not error output."
  type        = string
  default     = "year="
}

variable "raw_queue_visibility_timeout_seconds" {
  description = "Visibility timeout for raw loader messages. T6 should keep the loader Lambda timeout below this value."
  type        = number
  default     = 300

  validation {
    condition     = var.raw_queue_visibility_timeout_seconds >= 30 && var.raw_queue_visibility_timeout_seconds <= 43200
    error_message = "Visibility timeout must be between 30 seconds and 12 hours."
  }
}

variable "raw_queue_message_retention_seconds" {
  description = "Retention period for raw loader queue messages."
  type        = number
  default     = 345600

  validation {
    condition     = var.raw_queue_message_retention_seconds >= 60 && var.raw_queue_message_retention_seconds <= 1209600
    error_message = "Raw queue retention must be between 60 seconds and 14 days."
  }
}

variable "dlq_message_retention_seconds" {
  description = "Retention period for raw loader DLQ messages."
  type        = number
  default     = 1209600

  validation {
    condition     = var.dlq_message_retention_seconds >= 60 && var.dlq_message_retention_seconds <= 1209600
    error_message = "DLQ retention must be between 60 seconds and 14 days."
  }
}

variable "raw_queue_max_receive_count" {
  description = "Number of failed receives before SQS moves a message to the DLQ."
  type        = number
  default     = 5

  validation {
    condition     = var.raw_queue_max_receive_count >= 2 && var.raw_queue_max_receive_count <= 20
    error_message = "Max receive count must be between 2 and 20."
  }
}

variable "tags" {
  description = "Tags applied to all AWS resources."
  type        = map(string)
  default = {
    Project   = "paperclip"
    Component = "telemetry-loader"
    ManagedBy = "terraform"
  }
}

