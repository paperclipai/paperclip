resource "aws_ecr_repository" "app" {
  name                 = var.ecr_repo_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(var.tags, { Name = var.ecr_repo_name })
}
