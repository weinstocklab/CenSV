/**
 * CenSV browser infrastructure.
 *
 * Adapted from the UKB somatic-variation browser stack, with three deliberate changes:
 *
 *  1. ecr.tf and iam.tf are NEW. The stack this was derived from referenced
 *     aws_ecr_repository.app, aws_iam_role.ecs_execution_role and aws_iam_role.ecs_task_role
 *     without ever defining them, so it could not `terraform plan`.
 *
 *  2. The NLB, its Elastic IP and the ACM/HTTPS listeners are GONE. They existed to give a
 *     public service a static IP and a certificate. This browser is reachable from the Emory
 *     network only and has no custom domain, so an ALB alone is the whole story. Adding a
 *     hostname later is an aws_lb_listener plus a certificate - it does not need the NLB back.
 *
 *  3. Ingress is Emory CIDRs only. The original opened 80 and 443 to 0.0.0.0/0; that is not
 *     appropriate for unpublished results.
 *
 * The VPC and subnets are Emory-managed and are read, never created.
 */

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Application = var.app_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "weinstocklab/CenSV"
    }
  }
}

# ----------------------------------------------------------------------------- variables
variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Application name; prefixes every resource"
  type        = string
  default     = "censv"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "prod"
}

variable "vpc_id" {
  description = "Emory-managed VPC to deploy into"
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets for the load balancer (at least two AZs)"
  type        = list(string)
  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "An ALB requires subnets in at least two availability zones."
  }
}

variable "task_subnet_ids" {
  description = <<-EOT
    Subnets for the Fargate tasks. These need a route to the internet to pull the image
    from ECR. The account has no NAT gateway, so public subnets with assign_public_ip are
    used - the tasks are still unreachable except through the load balancer security group.
  EOT
  type        = list(string)
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks permitted to reach the browser. Emory ranges only."
  type        = list(string)
}

variable "container_port" {
  description = "Port the container listens on. 8080 because nginx runs unprivileged."
  type        = number
  default     = 8080
}

variable "cpu" {
  description = "Fargate CPU units. The site is static files; 256 is ample."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate memory (MiB)"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of running tasks"
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch log retention"
  type        = number
  default     = 30
}

variable "github_repository" {
  description = "owner/repo permitted to assume the deploy role via OIDC"
  type        = string
  default     = "weinstocklab/CenSV"
}

variable "create_github_oidc_provider" {
  description = <<-EOT
    Create the GitHub OIDC provider. An AWS account can hold only one provider per URL, so
    set this false if token.actions.githubusercontent.com already exists in the account -
    otherwise apply fails with EntityAlreadyExists.
  EOT
  type        = bool
  default     = true
}

# ------------------------------------------------------------------------------- context
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_vpc" "main" {
  id = var.vpc_id
}

locals {
  name = "${var.app_name}-${var.environment}"
}

# A second AWS provider with NO default_tags, used by exactly one resource.
#
# The account's SERVICE CONTROL POLICY denies iam:TagOpenIDConnectProvider. That is an
# organisation-level guardrail, not an identity-policy gap an account admin can widen, so
# waiting for a permission grant would not fix it. default_tags above makes terraform tag
# every resource it creates, so creating the GitHub OIDC provider failed on the tag call
# rather than on the create itself - the provider is a per-URL singleton whose tags are
# cosmetic. This alias drops the default tags for that one resource; everything else keeps
# them, which is why it is an alias rather than deleting default_tags outright.
provider "aws" {
  alias  = "untagged"
  region = var.aws_region
}
