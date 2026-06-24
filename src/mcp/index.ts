#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  interpolateEnvPlaceholders,
  loadGatewayConfig,
  validateConfig,
} from "../config";
import { GatewayHttpError, redactSensitiveText } from "../errors";
import { getBudgetStatuses } from "../budget";
import type { GatewayBudgetStatus } from "../budget";
import { modelPresets, providerPresets } from "../presets";
import { resolveRoute } from "../router";
import type {
  ChatMessage,
  GatewayBudgetConfig,
  GatewayConfig,
  GatewayConfigInput,
  GatewayUsage,
  OpenAIChatCompletionRequest,
} from "../types";
import { gatewayVersion } from "../version";

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

type LedgerRecord = {
  timestamp?: string;
  provider?: string;
  model?: string;
  status?: "success" | "error" | string;
  usage?: Partial<GatewayUsage>;
  estimatedCostUsd?: number;
};

type LedgerTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

const DEFAULT_CONFIG_PATH = "gateway.config.json";
const SECRET_ENV_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)/i;

const configPathSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Path to gateway.config.json. Defaults to the server --config value or gateway.config.json.");

const chatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "developer"]),
    content: z.unknown().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();

const routeRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).default([{ role: "user", content: "Route diagnostic." }]),
    stream: z.boolean().optional(),
    tools: z.array(z.unknown()).optional(),
    gateway: z.record(z.unknown()).optional(),
  })
  .passthrough();

const budgetWindowSchema = z.enum(["per-request", "daily", "monthly", "lifetime"]);
const budgetModeSchema = z.enum(["hard", "soft"]);

type GatewayMcpServerOptions = {
  defaultConfigPath?: string;
  allowConfigPathOverrides?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  const payload =
    error instanceof GatewayHttpError
      ? {
          ok: false,
          error: {
            message: redactMcpString(error.message),
            type: error.type,
            code: error.code,
            status: error.status,
            retryable: error.retryable,
            raw: redactMcpValue(error.raw),
          },
        }
      : {
          ok: false,
          error: {
            message: redactMcpString(error instanceof Error ? error.message : String(error)),
          },
        };
  return { ...jsonResult(payload), isError: true };
}

async function safeTool(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

function resolveConfigPath(path: string | undefined, defaultConfigPath: string, allowOverrides: boolean): string {
  if (!path) return defaultConfigPath;
  if (resolvePath(path) === resolvePath(defaultConfigPath)) return path;
  if (!allowOverrides) {
    throw new Error(
      "Per-call config_path overrides are disabled for this MCP server. Start gateway-mcp with --allow-config-path-overrides to enable them.",
    );
  }
  return path;
}

async function readConfigInput(path: string): Promise<GatewayConfigInput> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config ${path} must contain a JSON object.`);
  }
  return parsed as GatewayConfigInput;
}

async function writeConfigInput(path: string, config: GatewayConfigInput): Promise<void> {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new Error(result.errors.join(" "));
  }
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

function redactMcpString(value: string): string {
  let output = redactSensitiveText(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8 || !SECRET_ENV_NAME_PATTERN.test(name)) continue;
    output = output.split(secret).join(`[redacted-env:${name}]`);
  }
  return output;
}

function redactMcpValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[redacted-depth-limit]";
  if (typeof value === "string") return redactMcpString(value);
  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redactMcpString(key),
      redactMcpValue(item, depth + 1),
    ]),
  );
}

function safeString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactMcpString(value);
}

function safeBudgetContext(context: {
  gatewayKey?: string;
  tenant?: string;
  requestedModel?: string;
  selectedModel?: string;
}): Record<string, unknown> {
  return {
    ...(context.gatewayKey ? { gatewayKeyConfigured: true } : {}),
    ...(context.tenant ? { tenant: safeString(context.tenant) } : {}),
    ...(context.requestedModel ? { requestedModel: safeString(context.requestedModel) } : {}),
    ...(context.selectedModel ? { selectedModel: safeString(context.selectedModel) } : {}),
  };
}

function safeBudgetSummary(budget: GatewayBudgetConfig): Record<string, unknown> {
  return {
    id: safeString(budget.id),
    scope: safeBudgetContext({
      gatewayKey: budget.scope?.gatewayKey,
      tenant: budget.scope?.tenant,
      requestedModel: budget.scope?.modelAlias,
    }),
    window: budget.window,
    mode: budget.mode,
    ...(budget.maxUsd === undefined ? {} : { maxUsd: budget.maxUsd }),
    ...(budget.maxInputTokens === undefined ? {} : { maxInputTokens: budget.maxInputTokens }),
    ...(budget.maxOutputTokens === undefined ? {} : { maxOutputTokens: budget.maxOutputTokens }),
    ...(budget.maxTotalTokens === undefined ? {} : { maxTotalTokens: budget.maxTotalTokens }),
    ...(budget.warningThreshold === undefined ? {} : { warningThreshold: budget.warningThreshold }),
    ...(budget.resetAt === undefined ? {} : { resetAt: budget.resetAt }),
  };
}

function safeBudgetStatus(status: GatewayBudgetStatus): Record<string, unknown> {
  return {
    budget: safeBudgetSummary(status.budget),
    context: safeBudgetContext(status.context),
    windowStart: status.windowStart,
    spent: status.spent,
    remaining: status.remaining,
    exhausted: status.exhausted,
    exceeded: status.exceeded,
    warnings: status.warnings.map(redactMcpString),
  };
}

function safeDataPolicy(policy: GatewayConfig["policy"] | NonNullable<GatewayConfig["providers"][number]["dataPolicy"]> | undefined): Record<string, unknown> | undefined {
  if (!policy) return undefined;
  return {
    allowTraining: policy.allowTraining,
    allowLogging: policy.allowLogging,
    allowedRegions: policy.allowedRegions?.map(redactMcpString),
    blockedRegions: policy.blockedRegions?.map(redactMcpString),
    allowedProviders: policy.allowedProviders?.map(redactMcpString),
    blockedProviders: policy.blockedProviders?.map(redactMcpString),
    zeroDataRetentionRequired: policy.zeroDataRetentionRequired,
    allowChineseProviders: policy.allowChineseProviders,
    byokOnly: policy.byokOnly,
    ...("allowRequestPolicyExpansion" in policy
      ? { allowRequestPolicyExpansion: policy.allowRequestPolicyExpansion }
      : {}),
    ...("zeroDataRetentionAvailable" in policy
      ? { zeroDataRetentionAvailable: policy.zeroDataRetentionAvailable }
      : {}),
  };
}

function safeConfigSummary(config: GatewayConfig): Record<string, unknown> {
  return {
    server: {
      host: safeString(config.server.host),
      port: config.server.port,
      requestTimeoutMs: config.server.requestTimeoutMs,
      maxRequestBodyBytes: config.server.maxRequestBodyBytes,
      includeGatewayMetadata: config.server.includeGatewayMetadata,
      maxFallbackAttempts: config.server.maxFallbackAttempts,
    },
    auth: {
      apiKeyEnv: safeString(config.auth.apiKeyEnv),
      required: config.auth.required,
      gatewayKeyPresent: Boolean(process.env[config.auth.apiKeyEnv]),
    },
    storage: {
      usageLedgerPath: safeString(config.storage.usageLedgerPath),
    },
    policy: safeDataPolicy(config.policy),
    providers: config.providers.map((provider) => ({
      id: safeString(provider.id),
      displayName: safeString(provider.displayName),
      kind: provider.kind,
      baseUrl: safeString(provider.baseUrl),
      apiKeyEnv: safeString(provider.apiKeyEnv),
      enabled: provider.enabled,
      regions: provider.regions?.map(redactMcpString),
      jurisdiction: safeString(provider.jurisdiction),
      dataPolicy: safeDataPolicy(provider.dataPolicy),
      apiKeyPresent: provider.apiKeyEnv ? Boolean(process.env[provider.apiKeyEnv]) : false,
    })),
    models: config.models.map((model) => ({
      id: safeString(model.id),
      providerId: safeString(model.providerId),
      providerModel: safeString(model.providerModel),
      aliases: model.aliases?.map(redactMcpString),
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      inputUsdPerMillionTokens: model.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: model.outputUsdPerMillionTokens,
    })),
    routes: config.routes.map((route) => ({
      id: safeString(route.id),
      mode: route.mode,
      modelAliases: route.modelAliases?.map(redactMcpString),
      providerAllowlist: route.providerAllowlist?.map(redactMcpString),
      providerBlocklist: route.providerBlocklist?.map(redactMcpString),
      maxInputUsdPerMillionTokens: route.maxInputUsdPerMillionTokens,
      maxOutputUsdPerMillionTokens: route.maxOutputUsdPerMillionTokens,
      maxLatencyMs: route.maxLatencyMs,
      fallbackModelIds: route.fallbackModelIds?.map(redactMcpString),
      dataPolicy: safeDataPolicy(route.dataPolicy),
    })),
    budgets: config.budgets.map(safeBudgetSummary),
    presets: {
      providers: Object.keys(providerPresets),
      modelAliases: [...new Set(modelPresets.flatMap((model) => model.aliases ?? []))].sort(),
    },
  };
}

function envForRoute(config: GatewayConfig, input: { env_present?: string[]; use_process_env?: boolean }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = input.use_process_env === false ? {} : { ...process.env };
  for (const name of input.env_present ?? []) {
    env[name] = env[name] ?? "present";
  }
  for (const provider of config.providers) {
    if (provider.apiKeyEnv && input.env_present?.includes(provider.apiKeyEnv)) {
      env[provider.apiKeyEnv] = env[provider.apiKeyEnv] ?? "present";
    }
  }
  return env;
}

function explainRoute(
  config: GatewayConfig,
  request: OpenAIChatCompletionRequest,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  try {
    const result = resolveRoute({ config, env }, request);
    return {
      ok: true,
      selected: result.decision.selected,
      candidates: result.candidates.map((candidate) => ({
        provider: candidate.provider.id,
        model: candidate.model.id,
        providerModel: candidate.model.providerModel,
      })),
      decision: result.decision,
    };
  } catch (error) {
    if (error instanceof GatewayHttpError) {
      return {
        ok: false,
        error: {
          message: redactMcpString(error.message),
          type: error.type,
          code: error.code,
          status: error.status,
        },
        decision: redactMcpValue(error.raw),
      };
    }
    throw error;
  }
}

async function summarizeUsageLedger(config: GatewayConfig, limit: number): Promise<Record<string, unknown>> {
  const path = config.storage.usageLedgerPath;
  if (!path) {
    return {
      configured: false,
      records: 0,
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      recent: [],
    };
  }

  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {
      configured: true,
      path: safeString(path),
      records: 0,
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      recent: [],
    };
  }

  const records = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LedgerRecord];
      } catch {
        return [];
      }
    });

  const totals = records.reduce<LedgerTotals>(
    (acc, record) => ({
      inputTokens: acc.inputTokens + (record.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (record.usage?.outputTokens ?? 0),
      totalTokens: acc.totalTokens + (record.usage?.totalTokens ?? 0),
      estimatedCostUsd: acc.estimatedCostUsd + (record.estimatedCostUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
  );

  return {
    configured: true,
    path: safeString(path),
    records: records.length,
    success: records.filter((record) => record.status === "success").length,
    error: records.filter((record) => record.status === "error").length,
    totals: {
      ...totals,
      estimatedCostUsd: Number(totals.estimatedCostUsd.toFixed(12)),
    },
    recent: records.slice(-limit).map((record) => ({
      timestamp: record.timestamp,
      provider: safeString(record.provider),
      model: safeString(record.model),
      status: record.status,
      usage: record.usage,
      estimatedCostUsd: record.estimatedCostUsd,
    })),
  };
}

function parseMcpArgs(argv: string[]): { configPath: string; allowConfigPathOverrides: boolean } {
  const configIndex = argv.indexOf("--config");
  const allowConfigPathOverrides =
    argv.includes("--allow-config-path-overrides") || process.env.GATEWAY_MCP_ALLOW_CONFIG_PATH_OVERRIDES === "1";
  if (configIndex >= 0 && argv[configIndex + 1]) {
    return { configPath: argv[configIndex + 1]!, allowConfigPathOverrides };
  }
  return { configPath: process.env.GATEWAY_CONFIG_PATH ?? DEFAULT_CONFIG_PATH, allowConfigPathOverrides };
}

export function buildServer(options: GatewayMcpServerOptions = {}): McpServer {
  const defaultConfigPath = options.defaultConfigPath ?? DEFAULT_CONFIG_PATH;
  const allowConfigPathOverrides = options.allowConfigPathOverrides ?? false;
  const server = new McpServer({
    name: "gateway",
    version: gatewayVersion,
  });

  server.tool("gateway_health", "Return gateway MCP server health and default config path.", {}, async () =>
    safeTool(() => ({
      ok: true,
      name: "gateway-mcp",
      version: gatewayVersion,
      defaultConfigPath: safeString(defaultConfigPath),
      tools: [
        "gateway_validate_config",
        "gateway_inspect_config",
        "gateway_explain_route",
        "gateway_budget_list",
        "gateway_budget_remaining",
        "gateway_budget_add",
        "gateway_budget_reset",
        "gateway_usage_summary",
      ],
    })),
  );

  server.tool(
    "gateway_validate_config",
    "Validate a gateway config file without starting the HTTP gateway or contacting providers.",
    {
      config_path: configPathSchema,
      interpolate_env: z.boolean().default(true).describe("Resolve ${ENV_VAR} placeholders before validation."),
    },
    async ({ config_path, interpolate_env }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        const raw = await readConfigInput(path);
        const input = interpolate_env ? (interpolateEnvPlaceholders(raw) as GatewayConfigInput) : raw;
        const result = validateConfig(input);
        if (!result.ok) {
          return {
            path: safeString(path),
            ok: false,
            errors: result.errors.map(redactMcpString),
            warnings: result.warnings.map(redactMcpString),
          };
        }
        return {
          path: safeString(path),
          ok: true,
          warnings: result.warnings.map(redactMcpString),
          counts: {
            providers: result.config.providers.length,
            models: result.config.models.length,
            routes: result.config.routes.length,
            budgets: result.config.budgets.length,
          },
        };
      }),
  );

  server.tool(
    "gateway_inspect_config",
    "Inspect configured providers, models, routes, budgets, presets, and runtime key presence without returning secret values.",
    { config_path: configPathSchema },
    async ({ config_path }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        const config = await loadGatewayConfig(path);
        return {
          path: safeString(path),
          ...safeConfigSummary(config),
        };
      }),
  );

  server.tool(
    "gateway_explain_route",
    "Dry-run gateway route selection for a chat request without sending provider traffic.",
    {
      config_path: configPathSchema,
      request: routeRequestSchema,
      env_present: z
        .array(z.string().min(1))
        .optional()
        .describe("Environment variable names to treat as present for routing simulation."),
      use_process_env: z
        .boolean()
        .default(true)
        .describe("Use real environment variable presence while never returning secret values."),
    },
    async ({ config_path, request, env_present, use_process_env }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        const config = await loadGatewayConfig(path);
        return {
          path: safeString(path),
          ...explainRoute(
            config,
            {
              ...(request as OpenAIChatCompletionRequest),
              messages: (request.messages ?? [{ role: "user", content: "Route diagnostic." }]) as ChatMessage[],
            },
            envForRoute(config, { env_present, use_process_env }),
          ),
        };
      }),
  );

  server.tool(
    "gateway_budget_list",
    "List configured budget definitions.",
    { config_path: configPathSchema },
    async ({ config_path }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        const config = await loadGatewayConfig(path);
        return { path: safeString(path), budgets: config.budgets.map(safeBudgetSummary) };
      }),
  );

  server.tool(
    "gateway_budget_remaining",
    "Calculate remaining budget for an optional tenant/model/gateway-key context using the local usage ledger.",
    {
      config_path: configPathSchema,
      id: z.string().min(1).optional(),
      tenant: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      gateway_key_fingerprint: z.string().min(1).optional(),
    },
    async ({ config_path, id, tenant, model, gateway_key_fingerprint }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        const config = await loadGatewayConfig(path);
        const statuses = await getBudgetStatuses(
          config,
          { tenant, requestedModel: model, gatewayKey: gateway_key_fingerprint },
          { budgetId: id },
        );
        return { path: safeString(path), statuses: statuses.map(safeBudgetStatus) };
      }),
  );

  server.tool(
    "gateway_budget_add",
    "Add or replace a budget definition in a gateway config file.",
    {
      config_path: configPathSchema,
      id: z.string().min(1),
      window: budgetWindowSchema.default("lifetime"),
      mode: budgetModeSchema.default("hard"),
      tenant: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      gateway_key_fingerprint: z.string().min(1).optional(),
      max_usd: z.number().nonnegative().optional(),
      max_input_tokens: z.number().int().nonnegative().optional(),
      max_output_tokens: z.number().int().nonnegative().optional(),
      max_total_tokens: z.number().int().nonnegative().optional(),
      warning_threshold: z.number().min(0).max(1).optional(),
      replace: z.boolean().default(false).describe("Required when replacing an existing budget id."),
      dry_run: z.boolean().default(false).describe("Validate and preview the write without modifying the config file."),
      confirm_write: z.boolean().default(false).describe("Must be true for non-dry-run writes."),
    },
    async (input) =>
      safeTool(async () => {
        const path = resolveConfigPath(input.config_path, defaultConfigPath, allowConfigPathOverrides);
        if (!input.dry_run && !input.confirm_write) {
          throw new Error("gateway_budget_add requires confirm_write=true unless dry_run=true.");
        }
        const raw = await readConfigInput(path);
        const existing = raw.budgets?.find((item) => item.id === input.id);
        if (existing && !input.replace) {
          throw new Error(`Budget '${input.id}' already exists. Pass replace=true to replace it.`);
        }
        const budget: GatewayBudgetConfig = {
          id: input.id,
          window: input.window,
          mode: input.mode,
          scope: {
            ...(input.tenant ? { tenant: input.tenant } : {}),
            ...(input.model ? { modelAlias: input.model } : {}),
            ...(input.gateway_key_fingerprint ? { gatewayKey: input.gateway_key_fingerprint } : {}),
          },
          ...(input.max_usd === undefined ? {} : { maxUsd: input.max_usd }),
          ...(input.max_input_tokens === undefined ? {} : { maxInputTokens: input.max_input_tokens }),
          ...(input.max_output_tokens === undefined ? {} : { maxOutputTokens: input.max_output_tokens }),
          ...(input.max_total_tokens === undefined ? {} : { maxTotalTokens: input.max_total_tokens }),
          ...(input.warning_threshold === undefined ? {} : { warningThreshold: input.warning_threshold }),
        };
        const normalizedScope = Object.keys(budget.scope ?? {}).length ? budget.scope : undefined;
        const next = {
          ...raw,
          budgets: [...(raw.budgets ?? []).filter((item) => item.id !== budget.id), { ...budget, scope: normalizedScope }],
        };
        if (input.dry_run) {
          const result = validateConfig(next);
          if (!result.ok) throw new Error(result.errors.join(" "));
        } else {
          await writeConfigInput(path, next);
        }
        return {
          path: safeString(path),
          dryRun: input.dry_run,
          budget: safeBudgetSummary({ ...budget, scope: normalizedScope }),
        };
      }),
  );

  server.tool(
    "gateway_budget_reset",
    "Reset a configured budget window by updating resetAt in the config file.",
    {
      config_path: configPathSchema,
      id: z.string().min(1),
      reset_at: z.string().datetime().optional(),
      dry_run: z.boolean().default(false).describe("Validate and preview the reset without modifying the config file."),
      confirm_write: z.boolean().default(false).describe("Must be true for non-dry-run writes."),
    },
    async ({ config_path, id, reset_at, dry_run, confirm_write }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        if (!dry_run && !confirm_write) {
          throw new Error("gateway_budget_reset requires confirm_write=true unless dry_run=true.");
        }
        const raw = await readConfigInput(path);
        const budgets = [...(raw.budgets ?? [])];
        const budget = budgets.find((item) => item.id === id);
        if (!budget) throw new Error(`Budget not found: ${id}`);
        const nextResetAt = reset_at ?? new Date().toISOString();
        if (new Date(nextResetAt).getTime() > Date.now() + 1000) {
          throw new Error("reset_at cannot be in the future.");
        }
        budget.resetAt = nextResetAt;
        const next = { ...raw, budgets };
        if (dry_run) {
          const result = validateConfig(next);
          if (!result.ok) throw new Error(result.errors.join(" "));
        } else {
          await writeConfigInput(path, next);
        }
        return { path: safeString(path), dryRun: dry_run, budget: safeBudgetSummary(budget) };
      }),
  );

  server.tool(
    "gateway_usage_summary",
    "Summarize the configured local JSONL usage ledger without exposing request or response bodies.",
    {
      config_path: configPathSchema,
      limit: z.number().int().min(0).max(100).default(20),
    },
    async ({ config_path, limit }) =>
      safeTool(async () => {
        const path = resolveConfigPath(config_path, defaultConfigPath, allowConfigPathOverrides);
        const config = await loadGatewayConfig(path);
        return {
          configPath: safeString(path),
          ...(await summarizeUsageLedger(config, limit)),
        };
      }),
  );

  return server;
}

export async function startMcpServer(options: GatewayMcpServerOptions = {}): Promise<void> {
  const server = buildServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gateway MCP server running on stdio");
}

if (import.meta.main) {
  const { configPath, allowConfigPathOverrides } = parseMcpArgs(process.argv.slice(2));
  await startMcpServer({ defaultConfigPath: configPath, allowConfigPathOverrides });
}
