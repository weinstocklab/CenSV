/**
 * Load balancer and security groups.
 *
 * HTTP only, Emory CIDRs only, no certificate. The stack this was adapted from carried an
 * NLB with an Elastic IP in front of the ALB so a public service could have a static
 * address and an ACM certificate; with no custom domain and no public access, that whole
 * layer is unused complexity and is gone.
 *
 * To publish later: request a certificate for the hostname, add an HTTPS listener here,
 * redirect 80 to 443, and widen `allowed_cidr_blocks`. None of it needs the NLB back.
 */

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  vpc_id      = var.vpc_id
  description = "CenSV load balancer: HTTP from the Emory network only"

  ingress {
    description = "HTTP from permitted networks"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    description = "To the tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb-sg" }

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "tasks" {
  name_prefix = "${local.name}-tasks-"
  vpc_id      = var.vpc_id
  description = "CenSV tasks: reachable only from the load balancer"

  ingress {
    description     = "App port from the ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Outbound is open because the task must pull its image from ECR over the internet;
  # there is no NAT gateway or VPC endpoint in this account.
  egress {
    description = "Image pull and log shipping"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-tasks-sg" }

  lifecycle { create_before_destroy = true }
}

resource "aws_lb" "main" {
  name = substr(local.name, 0, 32)

  # INTERNAL. This was `false` and that was the bug, not the CIDR list beside it.
  #
  # An internet-facing ALB publishes a DNS name that resolves to PUBLIC addresses. A client
  # on Emory's VPN sends that traffic out its own default route - Emory's VPN is
  # split-tunnel - so it arrives from a home ISP address and the security group below, which
  # admits 10.0.0.0/8, drops it. The load balancer was unreachable from precisely the
  # audience it was built for, and the security group looked like the thing at fault.
  #
  # Internal, its DNS name resolves to the private addresses it already holds in these
  # subnets - 10.65.248.232 and its partner - and 10.65.0.0/16 is one of the 477 routes
  # Emory's VPN client installs. Measured, not assumed: from a home connection with the VPN
  # up, http://10.65.248.232/ returns `Server: awselb/2.0` in 5 ms, and the traceroute runs
  # vpnws-internal.emory.net -> Emory core -> bcloudcox1 (the Direct Connect) -> the VPC.
  # The source address on arrival is the VPN-assigned 10.110.67.97, which the group admits.
  #
  # So this one word is the difference between a URL that works for anyone on the VPN
  # anywhere in the world, and a URL that works for nobody.
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  drop_invalid_header_fields = true
  idle_timeout               = 60

  tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name        = substr("${local.name}-tg", 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  # Same reasoning as the container health check: ask for the data, not the index page.
  health_check {
    enabled             = true
    path                = "/data/meta.json"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = { Name = "${local.name}-tg" }

  lifecycle { create_before_destroy = true }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
