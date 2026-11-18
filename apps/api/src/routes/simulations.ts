import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db, executionsTable, integrationCredentialsTable, simulationsTable } from "@workspace/db";
import { canAccessTeam, ensureUser, getAccessibleSimulation, requireUserId, simulationAccess } from "../lib/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { createSimulationExecutor } from "../engine/execute.js";
import { createDrizzleEngineDatabase } from "../engine/drizzleDatabase.js";
import { reproduceExecution } from "../engine/replay.js";
import { proxyHeaders } from "../lib/proxy-headers.js";
import { validateTargetUrl } from "../lib/target-url.js";
import { deriveSeed, generateSeed } from "../engine/prng.js";
import { toFailureType, toHttpMethod, toProxyHttpMethod, type RunOverrides } from "../engine/types.js";

import {
  CreateSimulationBody,
  CreateSimulationResponse,
  DeleteSimulationParams,
  GetDashboardSummaryResponse,
  GetExecutionParams,
  GetExecutionResponse,
  GetSimulationParams,
  GetSimulationResponse,
  ListExecutionsParams,
  ListExecutionsResponse,
  ListSimulationsResponse,
  ReplayExecutionBody,
  ReplayExecutionParams,
  ReplayExecutionResponse,
  RunSimulationBody,
  RunSimulationParams,
  RunSimulationResponse,
  UpdateSimulationBody,
  UpdateSimulationParams,
  UpdateSimulationResponse,
} from "@workspace/api-zod";

const router = Router();

const now = () => new Date();
const executeSimulation = createSimulationExecutor({ db: createDrizzleEngineDatabase(db) });

function parseId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function endpointFor(id: number): string {
  return `/api/proxy/simulations/${id}`;
}

function createExecutionToken(): string {
  return `ft_live_${randomBytes(32).toString("base64url")}`;
}

function clientIp(req: Request): string | null {
  const forwarded = req.header("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
}

function credentialSummary(credential: typeof integrationCredentialsTable.$inferSelect | undefined) {
  if (!credential || credential.revokedAt) return null;
  return { id: credential.id, keyPrefix: credential.keyPrefix, createdAt: credential.createdAt, expiresAt: credential.expiresAt, revokedAt: credential.revokedAt, lastUsedAt: credential.lastUsedAt, lastUsedIp: credential.lastUsedIp };
}

function tokenFromRequest(req: Request): string | null {
  const header = req.header("x-faultline-token") ?? req.header("x-execution-token");
  if (header) return header.trim();
  return null;
}

function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin || allowedOrigins.length === 0) return true;
  return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}

const proxyMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const proxyAllowedHeaders = "Accept, Content-Type, User-Agent, X-Request-Id, X-Faultline-Token";
const developmentProxyOrigin = "http://localhost:5173";

function applyProxyCors(req: Request, res: Response, simulation: typeof simulationsTable.$inferSelect): boolean {
  const origin = req.header("origin");
  if (!origin) return true;

  const configuredOrigins = Array.isArray(simulation.allowedOrigins) ? simulation.allowedOrigins : [];
  const allowedOrigins = new Set([developmentProxyOrigin, ...configuredOrigins.filter((value) => value !== "*")]);
  if (!allowedOrigins.has(origin)) {
    res.status(403).json({ error: "cors_origin_not_allowed" });
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", proxyMethods);
  res.setHeader("Access-Control-Allow-Headers", proxyAllowedHeaders);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Expose-Headers", "content-type, x-simulator-rule");
  return true;
}

function mapSimulation(simulation: typeof simulationsTable.$inferSelect) {
  return {
    ...simulation,
    endpoint: endpointFor(simulation.id),
  };
}

async function seedIfEmpty(userId: string, email?: string): Promise<void> {
  await ensureUser(userId, email);
  const existing = await db.select({ id: simulationsTable.id }).from(simulationsTable).where(eq(simulationsTable.ownerId, userId)).limit(1);
  if (existing.length > 0) return;

  await db.insert(simulationsTable).values([
    {
      ownerId: userId,
      teamId: null,
      name: "Payments · upstream 500",
      description: "Exercise retry and customer messaging when the payments provider is unavailable.",
      targetUrl: "https://api.stripe.com/v1/payment_intents",
      method: "POST",
      headers: { "content-type": "application/json", "x-client-version": "2026.09" },
      queryParams: {},
      requestBody: JSON.stringify({ amount: 2400, currency: "usd" }, null, 2),
      failureType: "http_500",
      statusCode: 500,
      responseBody: JSON.stringify({ error: { type: "api_error", message: "The upstream service is unavailable." } }, null, 2),
      latencyMs: 820,
      timeoutMs: 5000,
      probability: 100,
      forwardRequest: true,
      forwardTimeoutMs: 3500,
      preserveHeaders: true,
      executionToken: null,
      allowedOrigins: [],
      enabled: true,
      requestCount: 48,
      failedCount: 37,
      successCount: 11,
    },
    {
      ownerId: userId,
      teamId: null,
      name: "Search · rate limit",
      description: "Check that the search client backs off and respects Retry-After.",
      targetUrl: "https://api.acme-search.dev/v2/query",
      method: "GET",
      headers: { accept: "application/json" },
      queryParams: { q: "reliability", limit: "20" },
      requestBody: null,
      failureType: "http_429",
      statusCode: 429,
      responseBody: JSON.stringify({ error: "rate_limited", retryAfter: 30 }, null, 2),
      latencyMs: 120,
      timeoutMs: 3000,
      probability: 65,
      forwardRequest: false,
      forwardTimeoutMs: 3000,
      preserveHeaders: true,
      executionToken: null,
      allowedOrigins: [],
      enabled: true,
      requestCount: 19,
      failedCount: 13,
      successCount: 6,
    },
    {
      ownerId: userId,
      teamId: null,
      name: "Profile · timeout recovery",
      description: "Validate request cancellation and recovery when a profile service stalls.",
      targetUrl: "https://profiles.internal.example/v1/me",
      method: "GET",
      headers: { accept: "application/json", authorization: "Bearer <token>" },
      queryParams: {},
      requestBody: null,
      failureType: "timeout",
      statusCode: null,
      responseBody: null,
      latencyMs: 0,
      timeoutMs: 8000,
      probability: 100,
      forwardRequest: false,
      forwardTimeoutMs: 5000,
      preserveHeaders: false,
      enabled: false,
      requestCount: 7,
      failedCount: 7,
      successCount: 0,
    },
  ]);
}


async function getSimulation(userId: string, id: number) {
  return getAccessibleSimulation(userId, id);
}

async function getExecution(userId: string, id: number) {
  const [execution] = await db.select({ execution: executionsTable }).from(executionsTable).innerJoin(simulationsTable, eq(executionsTable.simulationId, simulationsTable.id)).where(and(eq(executionsTable.id, id), simulationAccess(userId))).limit(1);
  return execution?.execution;
}

router.get("/dashboard/executions", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const beforeId = Number(req.query.beforeId);
  if (!Number.isSafeInteger(beforeId) || beforeId < 1) {
    res.status(400).json({ error: "beforeId must be a positive integer" });
    return;
  }
  const userId = requireUserId(req);
  const older = await db
    .select({ execution: executionsTable })
    .from(executionsTable)
    .innerJoin(simulationsTable, eq(executionsTable.simulationId, simulationsTable.id))
    .where(and(simulationAccess(userId), lt(executionsTable.id, beforeId)))
    .orderBy(desc(executionsTable.id))
    .limit(25)
    .then((rows) => rows.map((row) => row.execution));
  res.json(ListExecutionsResponse.parse(older));
});

router.get("/dashboard", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await seedIfEmpty(requireUserId(req), (req as AuthenticatedRequest).userEmail);
  const userId = requireUserId(req);
  const simulations = await db.select().from(simulationsTable).where(simulationAccess(userId));
  const recent = await db.select({ execution: executionsTable }).from(executionsTable).innerJoin(simulationsTable, eq(executionsTable.simulationId, simulationsTable.id)).where(simulationAccess(userId)).orderBy(desc(executionsTable.createdAt)).limit(8).then(rows => rows.map(row => row.execution));
  const payload = {
    totalSimulations: simulations.length,
    activeSimulations: simulations.filter((item) => item.enabled).length,
    requestsExecuted: simulations.reduce((sum, item) => sum + item.requestCount, 0),
    failedRequests: simulations.reduce((sum, item) => sum + item.failedCount, 0),
    successfulRequests: simulations.reduce((sum, item) => sum + item.successCount, 0),
    recentRuns: recent,
  };
  res.json(GetDashboardSummaryResponse.parse(payload));
});

router.get("/simulations", async (req: AuthenticatedRequest, res): Promise<void> => {
  await seedIfEmpty(requireUserId(req), (req as AuthenticatedRequest).userEmail);
  const simulations = await db.select().from(simulationsTable).where(simulationAccess(requireUserId(req))).orderBy(desc(simulationsTable.updatedAt));
  res.json(ListSimulationsResponse.parse(simulations.map(mapSimulation)));
});

router.post("/simulations", async (req: AuthenticatedRequest, res): Promise<void> => {
  const parsed = CreateSimulationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  try {
    await validateTargetUrl(data.targetUrl);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "target_url_not_allowed" });
    return;
  }
  const teamId = typeof req.body?.teamId === "number" ? req.body.teamId : null;
  if (teamId !== null && !(await canAccessTeam(requireUserId(req), teamId))) {
    res.status(403).json({ error: "You are not a member of that team." });
    return;
  }
  const [simulation] = await db
    .insert(simulationsTable)
    .values({
      ownerId: requireUserId(req),
      teamId,
      name: data.name,
      description: data.description ?? null,
      targetUrl: data.targetUrl,
      method: data.method,
      headers: data.headers ?? {},
      queryParams: data.queryParams ?? {},
      requestBody: data.requestBody ?? null,
      failureType: data.failureType ?? "http_500",
      statusCode: data.statusCode ?? 500,
      responseBody: data.responseBody ?? null,
      latencyMs: data.latencyMs ?? 0,
      timeoutMs: data.timeoutMs ?? 5000,
      probability: data.probability ?? 100,
      conditions: data.conditions ?? {},
      workflow: data.workflow ?? [],
      forwardRequest: data.forwardRequest ?? false,
      forwardTimeoutMs: data.forwardTimeoutMs ?? 10000,
      preserveHeaders: data.preserveHeaders ?? true,
      executionToken: null,
      allowedOrigins: [],
      enabled: data.enabled ?? true,
    })
    .returning();
  res.status(201).json(CreateSimulationResponse.parse(mapSimulation(simulation)));
});

router.get("/simulations/:id", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = GetSimulationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const simulation = await getSimulation(requireUserId(req), params.data.id);
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  const executions = await db
    .select()
    .from(executionsTable)
    .where(eq(executionsTable.simulationId, simulation.id))
    .orderBy(desc(executionsTable.createdAt))
    .limit(20);
  res.json(GetSimulationResponse.parse({ ...mapSimulation(simulation), executions }));
});

async function findCredential(simulationId: number) {
  const [credential] = await db.select().from(integrationCredentialsTable).where(eq(integrationCredentialsTable.simulationId, simulationId)).orderBy(desc(integrationCredentialsTable.createdAt)).limit(1);
  return credential;
}

router.get("/simulations/:id/integration", async (req: AuthenticatedRequest, res): Promise<void> => {
  const simulation = await getSimulation(requireUserId(req), Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  res.json({ credential: credentialSummary(await findCredential(simulation.id)), allowedOrigins: simulation.allowedOrigins ?? [] });
});

router.put("/simulations/:id/integration/origins", async (req: AuthenticatedRequest, res): Promise<void> => {
  const ownerId = requireUserId(req);
  const simulation = await getSimulation(ownerId, Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const requestedOrigins: unknown[] = Array.isArray(req.body?.origins) ? req.body.origins : [];
  const origins = [...new Set(requestedOrigins.map((origin) => String(origin).trim()).filter((origin) => origin.length > 0))];
  await db.update(simulationsTable).set({ allowedOrigins: origins, updatedAt: now() }).where(and(eq(simulationsTable.id, simulation.id), eq(simulationsTable.ownerId, ownerId)));
  res.json({ allowedOrigins: origins });
});

router.post("/simulations/:id/integration/token", async (req: AuthenticatedRequest, res): Promise<void> => {
  const ownerId = requireUserId(req);
  const simulation = await getSimulation(ownerId, Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const token = createExecutionToken();
  await db.update(integrationCredentialsTable).set({ revokedAt: now() }).where(and(eq(integrationCredentialsTable.simulationId, simulation.id), eq(integrationCredentialsTable.ownerId, ownerId), isNull(integrationCredentialsTable.revokedAt)));
  const [credential] = await db.insert(integrationCredentialsTable).values({ simulationId: simulation.id, ownerId, keyPrefix: token.slice(0, 12), keyHash: await bcrypt.hash(token, 12), expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) }).returning();
  res.status(201).json({ token, credential: credentialSummary(credential) });
});

router.post("/simulations/:id/integration/token/regenerate", async (req: AuthenticatedRequest, res): Promise<void> => {
  const ownerId = requireUserId(req);
  const simulation = await getSimulation(ownerId, Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const token = createExecutionToken();
  await db.update(integrationCredentialsTable).set({ revokedAt: now() }).where(and(eq(integrationCredentialsTable.simulationId, simulation.id), eq(integrationCredentialsTable.ownerId, ownerId), isNull(integrationCredentialsTable.revokedAt)));
  const [credential] = await db.insert(integrationCredentialsTable).values({ simulationId: simulation.id, ownerId, keyPrefix: token.slice(0, 12), keyHash: await bcrypt.hash(token, 12), expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) }).returning();
  res.status(201).json({ token, credential: credentialSummary(credential) });
});

router.post("/simulations/:id/integration/token/revoke", async (req: AuthenticatedRequest, res): Promise<void> => {
  const ownerId = requireUserId(req);
  const simulation = await getSimulation(ownerId, Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  await db.update(integrationCredentialsTable).set({ revokedAt: now() }).where(and(eq(integrationCredentialsTable.simulationId, simulation.id), eq(integrationCredentialsTable.ownerId, ownerId), isNull(integrationCredentialsTable.revokedAt)));
  res.status(204).end();
});

router.patch("/simulations/:id", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = UpdateSimulationParams.safeParse(req.params);
  const parsed = UpdateSimulationBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.targetUrl) {
    try {
      await validateTargetUrl(parsed.data.targetUrl);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "target_url_not_allowed" });
      return;
    }
  }
  const userId = requireUserId(req);
  const existing = await getSimulation(userId, params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  const [simulation] = await db
    .update(simulationsTable)
    .set({ ...parsed.data, updatedAt: now() })
    .where(eq(simulationsTable.id, existing.id))
    .returning();
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  res.json(UpdateSimulationResponse.parse(mapSimulation(simulation)));
});

router.delete("/simulations/:id", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = DeleteSimulationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const existing = await getSimulation(requireUserId(req), params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  const [simulation] = await db
    .delete(simulationsTable)
    .where(eq(simulationsTable.id, existing.id))
    .returning();
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/simulations/:id/executions", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = ListExecutionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const simulation = await getSimulation(requireUserId(req), params.data.id);
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const executions = await db
    .select()
    .from(executionsTable)
    .where(eq(executionsTable.simulationId, simulation.id))
    .orderBy(desc(executionsTable.createdAt))
    .limit(100);
  res.json(ListExecutionsResponse.parse(executions));
});

router.post("/simulations/:id/executions", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = RunSimulationParams.safeParse(req.params);
  const parsed = RunSimulationBody.safeParse(req.body ?? {});
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const simulation = await getSimulation(requireUserId(req), params.data.id);
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  const execution = await executeSimulation(simulation, parsed.data);
  res.status(201).json(RunSimulationResponse.parse(execution));
});

router.get("/executions/:id", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = GetExecutionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const execution = await getExecution(requireUserId(req), params.data.id);
  if (!execution) {
    res.status(404).json({ error: "Execution not found" });
    return;
  }
  res.json(GetExecutionResponse.parse(execution));
});

router.post("/executions/:id/compare", async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = requireUserId(req);
  const original = await getExecution(userId, Number(req.params.id));
  const replay = await getExecution(userId, Number(req.body?.replayExecutionId));
  if (!original || !replay) { res.status(404).json({ error: "Execution not found" }); return; }
  res.json({ original, replay, differences: {
    status: original.status !== replay.status,
    latencyMs: replay.actualLatencyMs - original.actualLatencyMs,
    failureType: original.failureType !== replay.failureType,
    response: original.responseBody !== replay.responseBody,
    timeline: JSON.stringify(original.timeline) !== JSON.stringify(replay.timeline),
  }});
});

router.post("/simulations/:id/recovery", async (req: AuthenticatedRequest, res): Promise<void> => {
  const simulation = await getSimulation(requireUserId(req), Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const workflow = Array.isArray(req.body?.workflow) ? req.body.workflow : simulation.workflow;
  const requestedSeed = Number(req.body?.seed);
  const baseSeed = Number.isInteger(requestedSeed) && requestedSeed >= 0 && requestedSeed <= 0xffffffff ? requestedSeed : generateSeed();
  let attemptIndex = 0;
  const executions = [];
  for (const step of workflow ?? []) {
    const attempts = Math.max(1, Math.min(100, Number(step.attempts ?? 1)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      executions.push(await executeSimulation(simulation, {
        ...step,
        failureType: toFailureType(step.failureType),
        seed: deriveSeed(baseSeed, attemptIndex++),
      }));
    }
  }
  res.status(201).json({ executions, recovered: executions.at(-1)?.status === "success" });
});

router.post("/executions/:id/replay", async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = ReplayExecutionParams.safeParse(req.params);
  const parsed = ReplayExecutionBody.safeParse(req.body ?? {});
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const execution = await getExecution(requireUserId(req), params.data.id);
  if (!execution) {
    res.status(404).json({ error: "Execution not found" });
    return;
  }
  const simulation = await getSimulation(requireUserId(req), execution.simulationId);
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  const replayOverrides: RunOverrides = {
    failureType: parsed.data.failureType,
    statusCode: parsed.data.statusCode,
    latencyMs: parsed.data.latencyMs,
    responseBody: parsed.data.responseBody,
    seed: parsed.data.seed,
  };
  const requestOverrides = {
    method: toHttpMethod(execution.method),
    headers: execution.requestHeaders,
    queryParams: execution.requestQuery,
    requestBody: execution.requestBody,
  };
  const mode = parsed.data.mode ?? "reproduce";
  if (mode === "reproduce" && (execution.seed === null || execution.configSnapshot === null)) {
    res.status(409).json({ error: "Deterministic replay is unavailable for this older execution. Select reexecute mode." });
    return;
  }
  const replay = mode === "reproduce"
    ? await reproduceExecution(execution, simulation, {}, executeSimulation)
    : await executeSimulation(simulation, replayOverrides, requestOverrides);
  res.status(201).json(ReplayExecutionResponse.parse(replay));
});

async function handleProxy(req: Request, res: import("express").Response): Promise<void> {
  const id = parseId(req.params.id ?? req.params[0]);
  if (!id) {
    res.status(400).json({ error: "Invalid simulation id" });
    return;
  }
  const [simulation] = await db.select().from(simulationsTable).where(eq(simulationsTable.id, id)).limit(1);
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  if (!applyProxyCors(req, res, simulation)) return;
  if (req.method === "OPTIONS") {
    const requestedMethod = req.header("access-control-request-method");
    const requestedHeaders = (req.header("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    const allowedHeaderNames = new Set(["accept", "content-type", "user-agent", "x-request-id", "x-faultline-token"]);
    const methodAllowed = !requestedMethod || proxyMethods.split(", ").includes(requestedMethod.toUpperCase());
    const headersAllowed = requestedHeaders.every((header) => allowedHeaderNames.has(header));
    if (!methodAllowed || !headersAllowed) {
      res.status(405).json({ error: "cors_preflight_not_allowed" });
      return;
    }
    res.status(204).end();
    return;
  }
  const dashboardSession = typeof (req as AuthenticatedRequest).userId === "string";
  const suppliedToken = tokenFromRequest(req);
  if (!dashboardSession) {
    if (!suppliedToken) {
      res.status(401).json({ error: "token_required", message: "Integration token required" });
      return;
    }
    const credential = await findCredential(simulation.id);
    if (!credential) {
      res.status(401).json({ error: "invalid_token", message: "Invalid integration token" });
      return;
    }
    if (credential.revokedAt) {
      res.status(401).json({ error: "token_revoked", message: "Integration token has been revoked" });
      return;
    }
    if (credential.expiresAt.getTime() <= Date.now()) {
      res.status(401).json({ error: "token_expired", message: "Integration token has expired" });
      return;
    }
    if (!(await bcrypt.compare(suppliedToken, credential.keyHash))) {
      res.status(401).json({ error: "invalid_token", message: "Invalid integration token" });
      return;
    }
    await db.update(integrationCredentialsTable).set({ lastUsedAt: now(), lastUsedIp: clientIp(req) }).where(eq(integrationCredentialsTable.id, credential.id));
  }
  const headers = proxyHeaders(simulation.headers, req.headers);
  const queryParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") queryParams[key] = value;
  }
  const suffix = typeof req.params[1] === "string" ? req.params[1] : "";
  const body = req.body && typeof req.body === "object" ? JSON.stringify(req.body) : typeof req.body === "string" ? req.body : null;
  const execution = await executeSimulation(simulation, {}, {
    method: toProxyHttpMethod(req.method),
    headers,
    queryParams,
    requestBody: body,
    pathSuffix: suffix,
    source: dashboardSession ? "dashboard" : "external",
    tokenAuthenticated: !dashboardSession,
    requestIp: clientIp(req),
  }, { preserveRawResponseHeaders: true });
  if (execution.status === "timeout" || execution.failureType === "connection_failure") {
    res.destroy();
    return;
  }
  const responseHeaders = ((execution as typeof execution & { proxyResponseHeaders?: Record<string, string | string[]> }).proxyResponseHeaders ?? execution.responseHeaders) as Record<string, string | string[]>;
  const setCookie = responseHeaders["set-cookie"];
  res.status(execution.simulatedStatus ?? 502);
  for (const [key, value] of Object.entries(responseHeaders)) {
    if (key !== "set-cookie") res.setHeader(key, value);
  }
  if (setCookie) res.setHeader("set-cookie", setCookie);
  res.send(execution.responseBody ?? "");
}

router.all(/^\/proxy\/simulations\/(\d+)(\/.*)?$/, handleProxy);

export default router;
