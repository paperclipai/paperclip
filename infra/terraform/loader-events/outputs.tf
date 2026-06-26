output "raw_loader_queue_arn" {
  description = "ARN of the raw loader SQS queue for the loader Lambda event-source mapping."
  value       = aws_sqs_queue.raw_loader.arn
}

output "raw_loader_queue_name" {
  description = "Name of the raw loader SQS queue."
  value       = aws_sqs_queue.raw_loader.name
}

output "raw_loader_queue_url" {
  description = "URL of the raw loader SQS queue."
  value       = aws_sqs_queue.raw_loader.url
}

output "raw_loader_dlq_arn" {
  description = "ARN of the raw loader dead-letter queue."
  value       = aws_sqs_queue.raw_loader_dlq.arn
}

output "raw_loader_dlq_name" {
  description = "Name of the raw loader dead-letter queue."
  value       = aws_sqs_queue.raw_loader_dlq.name
}

