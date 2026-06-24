# Hasna Gateway

Hasna Gateway is the open-source AI gateway core for Hasna apps and self-hosted teams. It exposes one stable OpenAI-compatible API while routing requests across OpenAI-compatible providers, including OpenAI, OpenRouter, DeepSeek, Qwen/DashScope, Kimi/Moonshot, Z.AI/GLM, and SiliconFlow.

The open-source package is useful on its own. Anyone can run it locally or on their own server, bring their own provider keys, define routing policy, and point applications at one endpoint. The hosted Hasna gateway can build on the same core while keeping accounts, billing, pooled provider contracts, discounts, tenant policy, and hosted observability private.

## Product Shape

- OpenAI-compatible HTTP API first, starting with `/v1/chat/completions`.
- One gateway key for clients, many provider keys behind the gateway.
- Bring-your-own-key mode for self-hosted users.
- Routing by model alias, provider allowlist/blocklist, region policy, price ceilings, fallback, and capability.
- Explicit China/provider policy so requests are never silently routed to a region or provider class the caller did not allow.
- Usage normalization, estimated cost hooks, route decision metadata, and optional local JSONL usage ledger.
- Hard or soft budgets by gateway key, tenant, and model alias across USD plus input/output/total tokens.
- Local-first defaults: no hosted Hasna calls unless explicitly configured.

## Quick Start

```bash
bun install
cp .env.example .env
cp gateway.config.example.json gateway.config.json
```

Set `GATEWAY_API_KEY` and at least one provider key in your environment, then run:

```bash
bun run build
bun dist/cli/index.js serve --config gateway.config.json
```

Call the gateway with any OpenAI-compatible client or curl:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Say hello."}]}'
```

## Commands

```bash
bun run typecheck
bun test
bun run build
bun dist/cli/index.js validate --config gateway.config.example.json
bun dist/cli/index.js smoke --config gateway.config.example.json --model fast
bun dist/cli/index.js smoke --config gateway.config.example.json --all
bun dist/cli/index.js budget-add --config gateway.config.json --id team-daily --window daily --tenant acme --model fast --max-usd 5 --max-total-tokens 100000
bun dist/cli/index.js budget-remaining --config gateway.config.json --id team-daily --json
```

After installation as a package, the CLI binary is `gateway`:

```bash
gateway serve --config gateway.config.json
gateway-mcp --config gateway.config.json
```

`gateway-mcp` is a stdio MCP server for local agents. It validates and inspects config, explains route choices without provider calls, manages budget definitions, checks remaining budgets, and summarizes the local usage ledger. Long-running `serve` and live `smoke` checks stay CLI-only. See [Gateway MCP server](docs/mcp.md).

## Configuration

Required config examples:

- `gateway.config.example.json`: mixed provider routes with explicit China-allowed aliases.
- `gateway.config.no-china.example.json`: OpenAI/OpenRouter-only policy with `cn` blocked.
- `gateway.config.china.example.json`: Chinese provider routes with explicit `cn`/`sg` allowance.

Provider keys are loaded from environment variables only. Do not put provider secrets in config files.

Budgets live in the same JSON config and spend is calculated from the local usage ledger. Daily, monthly, and lifetime budgets require `storage.usageLedgerPath`; per-request budgets can run without cumulative storage. Use `mode: "hard"` to block exhausted budgets with an OpenAI-compatible `402` error, or `mode: "soft"` to keep serving while exposing warnings in gateway metadata and ledger records.

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api-contract.md)
- [Provider adapters](docs/provider-adapters.md)
- [2026 provider references](docs/provider-references.md)
- [Routing and policy](docs/routing-and-policy.md)
- [Gateway MCP server](docs/mcp.md)
- [Open-core boundary](docs/open-core-boundary.md)
- [Security and compliance](docs/security-compliance.md)
- [Implementation plan](docs/implementation-plan.md)
- [Publishing and release](docs/publishing-and-release.md)
- [Hasna app migration plan](docs/migration-plan.md)
- [Agent handoff prompt](docs/handoff-prompt.md)

## Status

The gateway core is implemented and locally verified for the first release surface: CLI server, MCP server, health/models/chat endpoints, OpenAI-compatible provider adapter, provider presets, routing policy, fallbacks, streaming, usage normalization, optional local ledger, examples, tests, build, and package dry-run.

Publication is gated on a passing live smoke check with valid provider credentials.
