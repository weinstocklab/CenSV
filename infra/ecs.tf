/**
 * Fargate service.
 */

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled" # a static site does not justify the per-metric cost
  }

  tags = { Name = "${local.name}-cluster" }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
  tags              = { Name = "${local.name}-logs" }
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  # The EXECUTION role is unavoidable: Fargate uses it to pull the image from a private ECR
  # repository and to write the log stream, both before the container exists.
  execution_role_arn = aws_iam_role.ecs_execution.arn

  # No TASK role, deliberately. A task role is what the container itself uses to call AWS,
  # and this container is nginx serving files baked into its own image - it makes no AWS call
  # of any kind. Attaching one bought nothing and doubled the iam:PassRole grant this stack
  # needs, from one ARN to two, on the single permission that is holding up the deployment.
  # aws_iam_role.ecs_task is left defined but unattached, for a future that needs it.

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = "${aws_ecr_repository.app.repository_url}:latest"
      essential = true

      portMappings = [{
        containerPort = var.container_port
        protocol      = "tcp"
      }]

      readonlyRootFilesystem = false # nginx writes its pid and temp paths

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }

      # Asks for the data file, not the index page: a container serving an index with no
      # catalog behind it is broken, and a check on / would call that healthy.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${var.container_port}/data/meta.json || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
    }
  ])

  tags = { Name = "${local.name}-task" }
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Zero-downtime redeploys with a single task: allow a second one up before the old goes.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30

  network_configuration {
    security_groups = [aws_security_group.tasks.id]
    subnets         = var.task_subnet_ids
    # Required to reach ECR: the account has no NAT gateway. The task is still unreachable
    # from outside - its security group admits only the load balancer.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  # CI updates the task definition on each deploy; Terraform must not revert it on the
  # next infrastructure apply.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.http]

  tags = { Name = "${local.name}-service" }
}
