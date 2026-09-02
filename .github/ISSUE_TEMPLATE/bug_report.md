---
name: Bug report
about: Something isn't working as described in the README
title: "[bug] "
labels: bug
---

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Steps to reproduce the behavior. Include the smallest possible `curl` or code snippet.

```bash
curl -X POST http://127.0.0.1:4098/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"free-best","messages":[{"role":"user","content":"hi"}]}'
```

## Expected behavior

A clear and concise description of what you expected to happen.

## Actual behavior

What actually happened. Include any error messages, response codes, or `/diagnostics` output (sanitized — never include `Authorization` headers, which the router doesn't log anyway).

## Environment

- Free Best Router version (shown in the `npm start` log):
- Node.js version (`node --version`):
- Operating system:
- Provider keys configured (OpenRouter / Groq / Cerebras / Mistral / OpenCode / DeepSeek / none):
- Output of `GET /diagnostics` (JSON, sanitized):

## Additional context

Any other context about the problem. Links to related issues or PRs.
