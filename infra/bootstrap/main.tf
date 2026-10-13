/**
 * State backend bootstrap — run ONCE, by hand, before anything in infra/.
 *
 * This is the one place a local .tfstate is correct: it is the stack that creates the
 * remote backend, so it cannot store its state in the backend it has not made yet. The
 * resulting terraform.tfstate is small and can be committed or kept locally; if it is
 * lost, `terraform import` recovers both resources in a minute.
 *
 *   cd infra/bootstrap
 *   terraform init && terraform apply
 *
 * Then, in infra/:
 *   terraform init -backend-config=backend.hcl
 */

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "bucket_name" {
  type    = string
  default = "censv-tfstate-025066258128"
}

variable "lock_table_name" {
  type    = string
  default = "censv-tfstate-lock"
}

resource "aws_s3_bucket" "state" {
  bucket = var.bucket_name

  # State is the record of what exists. Losing it means adopting live infrastructure by
  # hand, so deletion is blocked at the provider.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "CenSV terraform state"
    Application = "censv"
    ManagedBy   = "terraform"
  }
}

# Versioning is what makes a bad apply recoverable: the previous state is one restore away.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# State can contain resource identifiers and occasionally secrets. It is never public.
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Old state versions accumulate forever otherwise; 90 days is well past any useful rollback.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

/**
 * Lock table. Without it, a CI apply racing a local apply can interleave writes and
 * corrupt state. PAY_PER_REQUEST because this table sees a handful of writes a month.
 */
resource "aws_dynamodb_table" "lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name        = "CenSV terraform state lock"
    Application = "censv"
    ManagedBy   = "terraform"
  }
}

output "backend_config" {
  description = "Paste-ready contents of infra/backend.hcl"
  value       = <<-EOT
    bucket         = "${aws_s3_bucket.state.id}"
    key            = "censv/prod/terraform.tfstate"
    region         = "${var.aws_region}"
    dynamodb_table = "${aws_dynamodb_table.lock.name}"
    encrypt        = true
  EOT
}
