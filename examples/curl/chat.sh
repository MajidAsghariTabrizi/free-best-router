#!/usr/bin/env bash
# Example: chat completion via curl
# Requires the router to be running: `npm start` in another terminal.
set -euo pipefail

curl -sS http://127.0.0.1:4098/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-best",
    "messages": [
      {"role": "system", "content": "You are a concise assistant."},
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "max_tokens": 64,
    "stream": false
  }' | jq .
