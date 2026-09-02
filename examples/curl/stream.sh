#!/usr/bin/env bash
# Example: streaming chat completion via curl
set -euo pipefail

curl -sN http://127.0.0.1:4098/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-best",
    "messages": [
      {"role": "user", "content": "Write a haiku about open-source software."}
    ],
    "max_tokens": 64,
    "stream": true
  }'
