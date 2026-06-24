# Gateway MCP Server

`@hasna/gateway` includes a stdio MCP server for non-interactive gateway operations. It is intended for agents and local automation that need to inspect or maintain gateway configuration without starting the HTTP gateway or sending traffic to providers.

## Run

```bash
gateway-mcp --config gateway.config.json
```

The server binds tools to the startup config path by default. Per-call `config_path` overrides are rejected unless the server is started with:

```bash
gateway-mcp --config gateway.config.json --allow-config-path-overrides
```

For local development before package installation:

```bash
bun src/mcp/index.ts --config gateway.config.json
```

The package also exports the server builder:

```ts
import { buildServer } from "@hasna/gateway/mcp";

const server = buildServer({ defaultConfigPath: "gateway.config.json" });
```

## Tools

- `gateway_health`: returns the MCP server version, default config path, and tool list.
- `gateway_validate_config`: validates a gateway config JSON file and can resolve `${ENV_VAR}` placeholders before validation.
- `gateway_inspect_config`: lists server/auth/storage policy, providers, models, routes, budgets, provider presets, model aliases, and whether required environment variables are present. Secret values are never returned.
- `gateway_explain_route`: dry-runs route selection for an OpenAI-compatible chat request. It uses real environment variable presence by default, or an `env_present` list for simulation, but never calls providers.
- `gateway_budget_list`: lists budget definitions from config.
- `gateway_budget_remaining`: calculates remaining budget for an optional gateway key fingerprint, tenant, model, and budget id.
- `gateway_budget_add`: adds a budget definition in the selected config file. Non-dry-run writes require `confirm_write: true`; replacing an existing id also requires `replace: true`.
- `gateway_budget_reset`: updates `resetAt` for one budget in the selected config file. Non-dry-run writes require `confirm_write: true`, and future reset timestamps are rejected.
- `gateway_usage_summary`: summarizes the configured local JSONL usage ledger without exposing request or response bodies.

Budget mutation tools also support `dry_run: true` to validate and preview a write without modifying the config file.

## CLI-Only Surfaces

The long-running HTTP gateway remains the `gateway serve` CLI command. Live provider smoke checks also remain CLI-only because they intentionally contact configured provider APIs. The MCP server exposes only bounded local operations and route simulation.
