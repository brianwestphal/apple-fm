#!/usr/bin/env bash
# AFM-KAGR8Y: invalid schemas fail before the on-device model is needed.
set -euo pipefail

helper="$1"

reject_schema() {
  local schema="$1" expected="$2" output
  if output=$(printf '{"prompt":"test","schema":%s}\n' "$schema" | "$helper" --generate); then
    echo "Expected unsupportedSchema for $schema" >&2
    return 1
  fi
  jq -e --arg expected "$expected" '
    .type == "error" and .code == "unsupportedSchema" and (.message | contains($expected))
  ' <<< "$output" >/dev/null
}

reject_schema '{"type":"integer","minimum":1e30}' 'supported integer range'
reject_schema '{"type":"integer","minimum":2.5,"maximum":2.6}' 'greater than maximum'
reject_schema '{"type":"number","maximum":"5"}' 'finite number'
reject_schema '{"type":"array","items":{"type":"string"},"minItems":2.5}' 'not an integer'
reject_schema '{"type":"array","items":{"type":"string"},"minItems":-1}' 'non-negative'
reject_schema '{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":1}' 'ordered'
reject_schema '{"type":"object","properties":{},"required":[false]}' 'unique names'
reject_schema '{"type":"object","properties":{},"required":["missing"]}' 'declared in properties'
reject_schema '{"type":"string","enum":[]}' 'non-empty'
reject_schema '{"type":"string","oneOf":[{"type":"string"}]}' 'oneOf'
reject_schema '{"type":"object","properties":{},"additionalProperties":{"type":"string"}}' 'additionalProperties'

# AFM-KFY32V: reject oversized input before decoding or loading the model.
if output=$(head -c 4194305 /dev/zero | "$helper" --generate); then
  echo 'Expected oversized native request to fail' >&2
  exit 1
fi
jq -e '.type == "error" and .code == "badRequest" and (.message | contains("4 MiB"))' <<< "$output" >/dev/null
