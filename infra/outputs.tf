output "browser_url" {
  description = "Where the browser is reachable (Emory network only)"
  value       = "http://${aws_lb.main.dns_name}"
}

output "ecr_repository_url" {
  description = "Push target for CI"
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "ecs_service_name" { value = aws_ecs_service.app.name }
output "log_group" { value = aws_cloudwatch_log_group.app.name }

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE repository variable in GitHub"
  value       = aws_iam_role.github_deploy.arn
}
