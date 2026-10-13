#!/usr/bin/env bash
# Publish the unencrypted browser to an S3 bucket restricted to Emory's address space.
#
#   infra/s3site/deploy_s3.sh [bucket]
#
# The allowlist is Emory's announced address space (AS3512), plus any per-machine exceptions
# in allowed_extra.txt. Note that an S3 bucket policy matches the client's PUBLIC address:
# Emory's VPN is split-tunnel, so a VPN session reaches AWS from its own ISP and is not inside
# these ranges. This bucket therefore serves on-campus clients and named exceptions only.
#
# HTTPS via the REST endpoint rather than S3 website hosting, which is HTTP-only. `base: './'`
# in the Vite config is what makes that work - every asset and data path is relative.
#
# The JSON is uploaded pre-compressed with Content-Encoding: gzip, since S3 does not compress
# on the fly.
set -euo pipefail

BUCKET="${1:-censv-site-025066258128}"
REGION="${AWS_REGION:-us-east-1}"
# Windows path, for the same reason the policy file needs one: every aws invocation
# below is a Windows binary being handed a path by an MSYS shell.
DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../web/dist" && pwd)"
DIST="$(cygpath -w "$DIST" 2>/dev/null || echo "$DIST")"
export MSYS_NO_PATHCONV=1

# Emory's announced address space (AS3512, via RIPEstat). The /17s that source also lists
# are subsets of the /16s and are omitted.
EMORY='"163.246.0.0/16","170.140.0.0/16","206.3.42.0/24","206.57.72.0/21"'

# Extra addresses, one CIDR per line in this file, "#" comments allowed.
#
# This exists because Emory's VPN is SPLIT-TUNNEL: it routes Emory-internal traffic through
# the tunnel and sends everything else - including anything bound for AWS - straight out the
# member's own ISP. So a laptop with the VPN connected still reaches S3 from a home address,
# and being "on the VPN" does not put you inside the ranges above. Confirmed on the author's
# machine: VPN up, egress still 168.92.228.134, owned by a residential ISP.
#
# Each line here is therefore a named exception rather than an institutional range, and they
# rot - a residential address changes. Re-run this script to refresh the policy.
ALLOWFILE="$(dirname "${BASH_SOURCE[0]}")/allowed_extra.txt"
EXTRA=""
if [ -f "$ALLOWFILE" ]; then
  while read -r line; do
    cidr=$(echo "$line" | sed 's/#.*//' | tr -d '[:space:]')
    [ -z "$cidr" ] && continue
    EXTRA="$EXTRA,\"$cidr\""
  done < "$ALLOWFILE"
fi
[ -n "$EXTRA" ] && echo "==> extra allowed CIDRs:$(echo "$EXTRA" | tr ',' ' ')"

echo "==> bucket $BUCKET in $REGION"
aws s3api create-bucket --bucket "$BUCKET" >/dev/null 2>&1 || echo "    (exists)"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled >/dev/null
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

# ACLs stay blocked. Only the POLICY route to public is opened, because the policy is the
# thing that carries the IP condition - an ACL cannot express one.
echo "==> public access block: ACLs blocked, policy permitted"
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false" >/dev/null

# Allow, then an explicit Deny for everything outside the ranges. The Deny is redundant
# against this Allow and is here on purpose: if a later edit widens the Allow by accident,
# the Deny still holds, and in IAM an explicit Deny cannot be overridden.
echo "==> bucket policy: Emory public ranges only, with an explicit deny"
cat > /tmp/censv_bucket_policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadFromEmory",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/*",
      "Condition": { "IpAddress": { "aws:SourceIp": [$EMORY$EXTRA] } }
    },
    {
      "Sid": "DenyEverywhereElse",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/*",
      "Condition": { "NotIpAddress": { "aws:SourceIp": [$EMORY$EXTRA] } }
    }
  ]
}
POLICY
# The AWS CLI here is a WINDOWS binary, so it cannot open an MSYS "/tmp/..." path -
# it reports "No such file or directory" on a file that plainly exists. cygpath hands
# it the form it can actually read.
POLFILE=$(cygpath -w /tmp/censv_bucket_policy.json 2>/dev/null || echo /tmp/censv_bucket_policy.json)
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://${POLFILE}"

echo "==> uploading $DIST"
# Everything except the JSON, with real content types. --delete so a stale asset from an
# earlier build cannot be served alongside a new index.html that does not reference it.
aws s3 sync "$DIST" "s3://$BUCKET" --delete --exclude "data/*" --no-progress >/dev/null

# S3 does not compress on the fly the way nginx does, and catalog.json is 3.8 MB. Each JSON
# is uploaded pre-compressed with Content-Encoding: gzip, which every browser handles and
# which is the same seven-fold saving the container's nginx config was asserted on.
echo "==> uploading data/ pre-gzipped"
TMP=$(mktemp -d)
for f in "$(cygpath -u "$DIST" 2>/dev/null || echo "$DIST")"/data/*.json; do
  n=$(basename "$f")
  gzip -9 -c "$f" > "$TMP/$n"
  TMPW=$(cygpath -w "$TMP/$n" 2>/dev/null || echo "$TMP/$n")
  aws s3 cp "$TMPW" "s3://$BUCKET/data/$n" \
    --content-type application/json --content-encoding gzip \
    --cache-control "public, max-age=300" --no-progress >/dev/null
  printf "    %-22s %7s -> %7s\n" "$n" "$(wc -c < "$f")" "$(wc -c < "$TMP/$n")"
done
rm -rf "$TMP"

echo
echo "URL: https://${BUCKET}.s3.${REGION}.amazonaws.com/index.html"
