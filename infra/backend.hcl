# terraform init -backend-config=backend.hcl
bucket         = "censv-tfstate-025066258128"
key            = "censv/prod/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "censv-tfstate-lock"
encrypt        = true
