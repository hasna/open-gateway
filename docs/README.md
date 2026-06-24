# Hasna Gateway Docs

Read these documents before implementation:

1. [Product requirements](product-requirements.md)
2. [Architecture](architecture.md)
3. [API contract](api-contract.md)
4. [Provider adapters](provider-adapters.md)
5. [2026 provider references](provider-references.md)
6. [Routing and policy](routing-and-policy.md)
7. [Gateway MCP server](mcp.md)
8. [Open-core boundary](open-core-boundary.md)
9. [Security and compliance](security-compliance.md)
10. [Implementation plan](implementation-plan.md)
11. [Publishing and release](publishing-and-release.md)
12. [Hasna app migration plan](migration-plan.md)
13. [Codewith handoff prompt](handoff-prompt.md)

## Current Decision

The gateway should be open source as a self-hostable core. The commercial Hasna product should be a hosted wrapper that adds one Hasna API key, billing, pooled provider keys, discounts, dashboards, and enterprise controls.

## Build Contract

The first implementation should prioritize a small working gateway over broad incomplete abstractions:

- A working CLI server.
- A stdio MCP server for safe local gateway inspection, route explanation, budget maintenance, and ledger summaries.
- OpenAI-compatible chat completions.
- OpenAI-compatible provider adapter.
- Config validation.
- Model aliases.
- Fallback routing.
- Explicit provider policy.
- Streaming.
- Usage normalization.
- Tests.

Provider breadth should come after the request lifecycle is reliable.
