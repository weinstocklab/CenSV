/**
 * Container registry.
 *
 * NEW FILE. The stack this was adapted from referenced aws_ecr_repository.app throughout
 * but never defined it, so `terraform plan` failed before it reached any AWS call.
 */

resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "MUTABLE" # the service tracks :latest; immutable tags are also pushed

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${local.name}-ecr" }
}

/**
 * Every deploy pushes two tags: the commit SHA and `latest`. Untagged layers are orphaned
 * immediately by the next push of the same tag, so they are expired aggressively; SHA tags
 * are the rollback path and are kept far longer.
 */
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 30 most recent commit-tagged images for rollback"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}
