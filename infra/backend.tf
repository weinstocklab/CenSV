/**
 * Remote state.
 *
 * GitHub Actions cannot use local state, so the backend lives in S3 with a DynamoDB lock
 * table. Both are created by infra/bootstrap, which uses local state because it is the
 * thing that creates the remote backend - the one place a local .tfstate is correct.
 *
 * Values are supplied at init rather than hardcoded:
 *   terraform init -backend-config=backend.hcl
 */
terraform {
  backend "s3" {}
}
