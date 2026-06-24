import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/index";
import { testConfig } from "./helpers";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function writeConfig(path: string): Promise<void> {
  const config = testConfig();
  config.storage.usageLedgerPath = join(tempDir(), "usage.jsonl");
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function connectClient(
  defaultConfigPath: string,
  options: { allowConfigPathOverrides?: boolean } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ defaultConfigPath, allowConfigPathOverrides: options.allowConfigPathOverrides });
  const client = new Client({ name: "gateway-mcp-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "{}");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway MCP server", () => {
  test("registers expected tools and validates config", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);
    const { client, close } = await connectClient(configPath);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("gateway_validate_config");

      const result = parseToolText(await client.callTool({ name: "gateway_validate_config", arguments: {} }));
      expect(result.ok).toBe(true);
      expect(result.path).toBe(configPath);
    } finally {
      await close();
    }
  });

  test("inspects config and dry-runs route selection without provider traffic", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);
    const { client, close } = await connectClient(configPath);
    try {
      const inspect = parseToolText(await client.callTool({ name: "gateway_inspect_config", arguments: {} }));
      expect(inspect.providers.map((provider: { id: string }) => provider.id)).toContain("openai");
      expect(inspect.providers[0]).not.toHaveProperty("apiKey");

      const route = parseToolText(
        await client.callTool({
          name: "gateway_explain_route",
          arguments: {
            request: { model: "coding", messages: [{ role: "user", content: "hello" }] },
            env_present: ["OPENAI_API_KEY", "DEEPSEEK_API_KEY"],
            use_process_env: false,
          },
        }),
      );
      expect(route.ok).toBe(true);
      expect(route.selected).toBe("openai/gpt-4.1-mini");
    } finally {
      await close();
    }
  });

  test("redacts passthrough secrets from config validation and inspection", async () => {
    const previousSecret = process.env.MCP_REVIEW_SECRET;
    process.env.MCP_REVIEW_SECRET = "review-secret-value";
    const configPath = join(tempDir(), "gateway.config.json");
    const config = testConfig() as any;
    config.providers[0].apiKey = "${MCP_REVIEW_SECRET}";
    config.providers[0].headers = { authorization: "Bearer ${MCP_REVIEW_SECRET}" };
    config.routes[0].dataPolicy = {
      ...config.routes[0].dataPolicy,
      secretToken: "${MCP_REVIEW_SECRET}",
    };
    config.budgets = [
      {
        id: "key-budget",
        window: "per-request",
        mode: "hard",
        scope: { gatewayKey: "${MCP_REVIEW_SECRET}", tenant: "acme" },
        maxTotalTokens: 100,
      },
    ];
    config.storage.usageLedgerPath = join(tempDir(), "${MCP_REVIEW_SECRET}.jsonl");
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { client, close } = await connectClient(configPath);
    try {
      const validationText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_validate_config", arguments: {} })),
      );
      const inspectionText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_inspect_config", arguments: {} })),
      );
      const budgetText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_budget_list", arguments: {} })),
      );
      const usageText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_usage_summary", arguments: {} })),
      );
      expect(validationText).not.toContain("review-secret-value");
      expect(inspectionText).not.toContain("review-secret-value");
      expect(budgetText).not.toContain("review-secret-value");
      expect(usageText).not.toContain("review-secret-value");
      expect(inspectionText).not.toContain("secretToken");
    } finally {
      await close();
      if (previousSecret === undefined) delete process.env.MCP_REVIEW_SECRET;
      else process.env.MCP_REVIEW_SECRET = previousSecret;
    }
  });

  test("redacts secrets from invalid config errors", async () => {
    const previousSecret = process.env.MCP_REVIEW_SECRET;
    process.env.MCP_REVIEW_SECRET = "review-secret-value";
    const configPath = join(tempDir(), "gateway.config.json");
    const config = testConfig() as any;
    config.providers[0].id = "${MCP_REVIEW_SECRET}";
    delete config.providers[0].baseUrl;
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { client, close } = await connectClient(configPath);
    try {
      for (const name of ["gateway_validate_config", "gateway_inspect_config", "gateway_budget_list", "gateway_budget_remaining"]) {
        const result = await client.callTool({ name, arguments: {} });
        const text = JSON.stringify(parseToolText(result));
        expect(result.isError === true || text.includes('"ok":false')).toBe(true);
        expect(text).not.toContain("review-secret-value");
      }
    } finally {
      await close();
      if (previousSecret === undefined) delete process.env.MCP_REVIEW_SECRET;
      else process.env.MCP_REVIEW_SECRET = previousSecret;
    }
  });

  test("denies per-call config path overrides by default", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    const otherConfigPath = join(tempDir(), "other-gateway.config.json");
    await writeConfig(configPath);
    await writeConfig(otherConfigPath);

    const { client, close } = await connectClient(configPath);
    try {
      const result = await client.callTool({
        name: "gateway_validate_config",
        arguments: { config_path: otherConfigPath },
      });
      const payload = parseToolText(result);
      expect(result.isError).toBe(true);
      expect(payload.error.message).toContain("config_path overrides are disabled");
    } finally {
      await close();
    }
  });

  test("adds, checks, resets budgets, and summarizes usage ledger", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);
    const { client, close } = await connectClient(configPath);
    try {
      const added = parseToolText(
        await client.callTool({
          name: "gateway_budget_add",
          arguments: {
            id: "team-daily",
            window: "daily",
            tenant: "acme",
            model: "fast",
            max_total_tokens: 1000,
            confirm_write: true,
          },
        }),
      );
      expect(added.budget.id).toBe("team-daily");

      const duplicate = await client.callTool({
        name: "gateway_budget_add",
        arguments: {
          id: "team-daily",
          window: "daily",
          tenant: "acme",
          model: "fast",
          max_total_tokens: 2000,
          confirm_write: true,
        },
      });
      expect(duplicate.isError).toBe(true);

      const replaced = parseToolText(
        await client.callTool({
          name: "gateway_budget_add",
          arguments: {
            id: "team-daily",
            window: "daily",
            tenant: "acme",
            model: "fast",
            max_total_tokens: 1000,
            replace: true,
            confirm_write: true,
          },
        }),
      );
      expect(replaced.budget.id).toBe("team-daily");

      const remaining = parseToolText(
        await client.callTool({
          name: "gateway_budget_remaining",
          arguments: { id: "team-daily", tenant: "acme", model: "fast" },
        }),
      );
      expect(remaining.statuses[0].remaining.totalTokens).toBe(1000);

      const reset = parseToolText(
        await client.callTool({
          name: "gateway_budget_reset",
          arguments: { id: "team-daily", reset_at: "2026-06-24T00:00:00.000Z", confirm_write: true },
        }),
      );
      expect(reset.budget.resetAt).toBe("2026-06-24T00:00:00.000Z");

      const futureReset = await client.callTool({
        name: "gateway_budget_reset",
        arguments: {
          id: "team-daily",
          reset_at: new Date(Date.now() + 86_400_000).toISOString(),
          confirm_write: true,
        },
      });
      expect(futureReset.isError).toBe(true);

      const config = JSON.parse(await Bun.file(configPath).text()) as { storage: { usageLedgerPath: string } };
      await Bun.write(
        config.storage.usageLedgerPath,
        `${JSON.stringify({
          timestamp: "2026-06-24T00:01:00.000Z",
          provider: "openai",
          model: "openai/gpt-4.1-mini",
          status: "success",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          estimatedCostUsd: 0.00001,
        })}\n`,
      );

      const summary = parseToolText(await client.callTool({ name: "gateway_usage_summary", arguments: { limit: 1 } }));
      expect(summary.records).toBe(1);
      expect(summary.totals.totalTokens).toBe(15);
    } finally {
      await close();
    }
  });
});
