# Emory account 025066258128, region us-east-1.
# VPC and subnet IDs carried over from the UKB browser deployment, which runs in this
# same account and VPC.

aws_region  = "us-east-1"
app_name    = "censv"
environment = "prod"

vpc_id = "vpc-00c062dceba87c953"

public_subnet_ids = [
  "subnet-0f247eb4f33d60bd6", # us-east-1a
  "subnet-0f0c2662ea7596be0", # us-east-1b
]

# Public subnets, deliberately: the tasks need a route to ECR and the account has no NAT
# gateway. Their security group still admits only the load balancer.
task_subnet_ids = [
  "subnet-0f247eb4f33d60bd6",
  "subnet-0f0c2662ea7596be0",
]

# Emory internal ranges ONLY. The stack this was adapted from also allowed 0.0.0.0/0;
# that is removed while the manuscript is unpublished. Widen here to publish.
allowed_cidr_blocks = [
  "10.0.0.0/8",
  "172.16.0.0/12",
]

container_port = 8080
cpu            = 256
memory         = 512
desired_count  = 1

github_repository = "weinstocklab/CenSV"

# Set to false if token.actions.githubusercontent.com already exists in the account -
# AWS permits only one OIDC provider per URL and apply will fail with EntityAlreadyExists.
create_github_oidc_provider = true
