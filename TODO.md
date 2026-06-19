# Open Gateway Task Plan

This file mirrors Todos plan `66caee8d-d526-4fa7-86da-cdfebedc112e`. The Todos CLI is the source of truth.

## Current Status

- Implementation: complete for the first open-source core release surface.
- Local verification: passing with 38 unit/integration tests, typecheck, build, built CLI config validation, package dry run, `npm publish --dry-run`, and mock-provider smoke coverage.
- Live provider smoke: blocked by external credentials. Available OpenAI, DashScope/Qwen, and Moonshot/Kimi keys are rejected by their providers; no DeepSeek, OpenRouter, Z.AI, or SiliconFlow key is set in the environment.
- Publication: not performed because the release gate requires a passing live smoke check with real provider credentials. npm auth is present (`npm whoami` succeeds), so the remaining blocker is provider credentials, not npm authentication.
- GitHub: published at `https://github.com/hasna/open-gateway` with `main` pushed.
- npm: `npm view @hasna/gateway` currently returns 404. npm publish is intentionally deferred until live provider smoke passes.

## Milestones

1. Scaffold package and docs. Done.
2. Implement local gateway server. Done.
3. Implement OpenAI-compatible provider family. Done.
4. Implement routing, policy, and fallbacks. Done.
5. Add Chinese provider presets. Done.
6. Add streaming, usage, cost, and errors. Done.
7. Add examples and migration notes. Done.
8. Verify and publish. Local verification and GitHub publication are done; npm publish task remains pending in Todos with tag `blocked-live-provider-credentials`.

## Build Tasks

- [x] Review gateway docs and lock initial release scope.
- [x] Create CLI entry point and HTTP server.
- [x] Add Zod config schema, env interpolation, validation, and examples.
- [x] Implement gateway auth and request limits.
- [x] Implement model registry and alias resolution.
- [x] Implement provider adapter contract.
- [x] Implement OpenAI-compatible adapter.
- [x] Add provider presets for OpenAI, OpenRouter, DeepSeek, DashScope/Qwen, Kimi, Z.AI, and SiliconFlow.
- [x] Implement non-streaming chat completions.
- [x] Implement SSE streaming.
- [x] Implement fail-closed policy engine for regions, China opt-in, training, logging, BYOK, zero data retention, cost, and capabilities.
- [x] Implement fallback router and route decisions.
- [x] Implement retryable error taxonomy and timeouts.
- [x] Implement usage normalization.
- [x] Add cost estimation hooks compatible with external pricing data.
- [x] Add local metrics and usage ledger.
- [x] Add tests.
- [x] Add examples and operator docs.
- [x] Add Hasna app migration plan.
- [x] Run local verification, publish dry-run, and live provider smoke attempts.
- [x] Publish GitHub repository.
- [ ] Publish npm package. Blocked by failing live provider smoke credentials.
