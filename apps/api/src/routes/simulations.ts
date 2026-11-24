import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db, executionRequestContextsTable, executionsTable, integrationCredentialsTable, simulationsTable } from "@workspace/db";
import { canAccessTeam, ensureUser, getAccessibleSimulation, requireUserId, simulationAccess } from "../lib/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { createSimulationExecutor } from "../engine/execute.js";
import { createDrizzleEngineDatabase } from "../engine/drizzleDatabase.js";
import { reproduceExecution } from "../engine/replay.js";
import { proxyHeaders } from "../lib/proxy-headers.js";
import { sendUpstreamTimeout } from "../lib/proxy-response.js";
import { validateTargetUrl } from "../lib/target-url.js";
import { deriveSeed, generateSeed } from "../engine/prng.js";
import { capturedProxyPath, capturedUpstreamQuery, decryptRequestContext, encryptRequestContext, requestContextExpiry } from "../lib/recovery-context.js";
import { capturedAuthenticationHeaders, mergeCapturedAuthenticationHeaders } from "../lib/captured-auth.js";
import { toFailureType, toHttpMethod, toProxyHttpMethod, type RequestOverrides, type RunOverrides } from "../engine/types.js";

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

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

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

async function resolveAuthenticationContext(userId: string, executionId: number) {
  const source = await getExecution(userId, executionId);
  if (!source || source.source !== "external") return { error: "not_found" as const };
  const [contextRow] = await db.select().from(executionRequestContextsTable)
    .where(eq(executionRequestContextsTable.executionId, source.id)).limit(1);
  if (!contextRow) return { error: "expired" as const };
  if (contextRow.expiresAt <= now()) return { error: "expired" as const };
  let context: RequestOverrides & { targetUrl: string };
  try { context = decryptRequestContext(source.id, contextRow.encryptedContext); }
  catch { return { error: "unavailable" as const }; }
  const headers = capturedAuthenticationHeaders(context.headers);
  if (!headers.cookie && !headers.authorization) return { error: "no_credentials" as const };
  return { context, headers, expiresAt: contextRow.expiresAt };
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
  await ensureUser(requireUserId(req), req.userEmail);
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
  await ensureUser(requireUserId(req), req.userEmail);
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
      dashboardRequestPath: data.dashboardRequestPath ?? null,
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

router.get("/auth-contexts", async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = requireUserId(req);
  const nowAt = now();
  const executions = await db.select({ execution: executionsTable, simulationName: simulationsTable.name })
    .from(executionsTable)
    .innerJoin(simulationsTable, eq(executionsTable.simulationId, simulationsTable.id))
    .where(and(simulationAccess(userId), gt(executionsTable.createdAt, new Date(nowAt.getTime() - 16 * 60 * 1000))))
    .orderBy(desc(executionsTable.createdAt));
  const contexts = await Promise.all(executions.filter(({ execution }) => execution.source === "external").map(async ({ execution, simulationName }) => {
    const [context] = await db.select().from(executionRequestContextsTable)
      .where(eq(executionRequestContextsTable.executionId, execution.id)).limit(1);
    let contextStatus: "available" | "expired" | "unavailable" = !context ? "expired"
      : context.expiresAt <= nowAt ? "expired" : "available";
    let hasAuthentication = false;
    let authFingerprint: string | null = null;
    if (context && context.expiresAt > nowAt) {
      try {
        const secureContext = decryptRequestContext(execution.id, context.encryptedContext);
        const headers = capturedAuthenticationHeaders(secureContext.headers);
        hasAuthentication = Boolean(headers.cookie || headers.authorization);
        if (hasAuthentication) authFingerprint = createHmac("sha256", process.env.SUPABASE_JWT_SECRET ?? "")
          .update(JSON.stringify(headers)).digest("hex");
        else contextStatus = "unavailable";
      } catch { contextStatus = "unavailable"; }
    }
    let path = execution.url;
    try { path = new URL(execution.url).pathname; } catch { path = execution.url.split("?")[0] ?? ""; }
    return { id: execution.id, simulationName, method: execution.method, path, createdAt: execution.createdAt,
      contextStatus, expiresAt: context?.expiresAt ?? null, hasAuthentication, authFingerprint };
  }));
  contexts.sort((a, b) => Number(b.contextStatus === "available" && b.hasAuthentication) - Number(a.contextStatus === "available" && a.hasAuthentication)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const seenAuthentication = new Set<string>();
  const visibleContexts = contexts.filter((context) => {
    if (!context.authFingerprint) return true;
    if (seenAuthentication.has(context.authFingerprint)) return false;
    seenAuthentication.add(context.authFingerprint);
    return true;
  }).map(({ authFingerprint: _fingerprint, ...context }) => context);
  res.json(visibleContexts);
});

router.get("/simulations/:id/captured-requests", async (req: AuthenticatedRequest, res): Promise<void> => {
  const simulation = await getSimulation(requireUserId(req), Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const executions = await db.select().from(executionsTable)
    .where(eq(executionsTable.simulationId, simulation.id))
    .orderBy(desc(executionsTable.createdAt)).limit(100);
  const nowAt = now();
  const captured = await Promise.all(executions.filter((execution) => execution.source === "external").map(async (execution) => {
    const [context] = await db.select().from(executionRequestContextsTable)
      .where(eq(executionRequestContextsTable.executionId, execution.id)).limit(1);
    const authExpected = execution.tokenAuthenticated || Object.keys(execution.requestHeaders ?? {}).some((name) => ["cookie", "authorization"].includes(name.toLowerCase()));
    let contextStatus: "available" | "expired" | "unavailable" = !context ? (authExpected ? "expired" : "unavailable")
      : context.expiresAt <= nowAt ? "expired" : "available";
    let hasAuthentication = Object.keys(execution.requestHeaders ?? {}).some((name) => ["cookie", "authorization"].includes(name.toLowerCase()));
    if (context && context.expiresAt > nowAt) {
      try {
        const secureContext = decryptRequestContext(execution.id, context.encryptedContext);
        hasAuthentication = hasAuthentication || Boolean(secureContext.headers?.cookie?.trim() || secureContext.headers?.authorization?.trim());
      } catch {
        contextStatus = "unavailable";
      }
    }
    let path = execution.url;
    try { path = new URL(execution.url).pathname; } catch { path = execution.url.split("?")[0] ?? ""; }
    return { id: execution.id, method: execution.method, path, createdAt: execution.createdAt,
      contextStatus, expiresAt: context?.expiresAt ?? null, hasAuthentication };
  }));
  res.json(captured);
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
  const pathSuffix = parsed.data.pathSuffix?.trim();
  if (parsed.data.sourceExecutionId !== undefined) {
    const userId = requireUserId(req);
    const sourceExecution = await getExecution(userId, parsed.data.sourceExecutionId);
    if (!sourceExecution || sourceExecution.simulationId !== params.data.id || sourceExecution.source !== "external") {
      res.status(404).json({ error: "Captured request not found for this simulation" }); return;
    }
    const [contextRow] = await db.select().from(executionRequestContextsTable)
      .where(eq(executionRequestContextsTable.executionId, sourceExecution.id)).limit(1);
    if (!contextRow || contextRow.expiresAt <= now()) {
      res.status(410).json({ error: "Captured request context expired or is unavailable. Send a new authenticated request through the proxy, then select it here." }); return;
    }
    let captured: RequestOverrides & { targetUrl: string };
    try { captured = decryptRequestContext(sourceExecution.id, contextRow.encryptedContext); }
    catch { res.status(410).json({ error: "Captured request context is unavailable. Send a new authenticated request through the proxy, then select it here." }); return; }
    const simulation = await getSimulation(userId, params.data.id);
    if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
    const capturedPath = capturedProxyPath(captured.pathSuffix, captured.queryParams?.path, simulation.id);
    if (!capturedPath) { res.status(422).json({ error: "The captured request does not include a valid API path." }); return; }
    const requestOverrides: RequestOverrides = {
      method: captured.method,
      headers: captured.headers,
      queryParams: captured.queryParams ? capturedUpstreamQuery(captured.queryParams, simulation.id) : {},
      requestBody: captured.requestBody,
      pathSuffix: capturedPath,
      source: "dashboard",
      tokenAuthenticated: sourceExecution.tokenAuthenticated,
    };
    const execution = await executeSimulation(simulation, {}, requestOverrides, { forceUpstream: true });
    res.status(201).json(RunSimulationResponse.parse(execution));
    return;
  }
  if (!pathSuffix) {
    res.status(400).json({ error: "An API request path is required for Dashboard Run now." });
    return;
  }
  if (/^[a-z][a-z\\d+.-]*:\/\//i.test(pathSuffix) || pathSuffix.includes("?")) {
    res.status(400).json({ error: "Enter a relative API path, such as /api/task/addtask, without a query string." });
    return;
  }
  const simulation = await getSimulation(requireUserId(req), params.data.id);
  if (!simulation) {
    res.status(404).json({ error: "Simulation not found" });
    return;
  }
  let configuredHeaders = simulation.headers;
  if (parsed.data.attachCapturedAuthentication) {
    const authExecutionId = parsed.data.authSourceExecutionId;
    if (!authExecutionId) {
      res.status(400).json({ error: "Select a captured authentication context before running this request." }); return;
    }
    const resolved = await resolveAuthenticationContext(requireUserId(req), authExecutionId);
    if (resolved.error === "not_found") { res.status(404).json({ error: "Captured authentication context not found." }); return; }
    if (resolved.error === "expired") { res.status(410).json({ error: "Authentication context expired before execution. Capture a fresh authenticated request, then try again." }); return; }
    if (resolved.error === "unavailable") { res.status(410).json({ error: "Authentication context is unavailable. Capture a fresh authenticated request, then try again." }); return; }
    if (resolved.error === "no_credentials") { res.status(422).json({ error: "The selected context has no reusable cookie or authorization header." }); return; }
    if (resolved.expiresAt <= now()) { res.status(410).json({ error: "Authentication context expired before execution. Capture a fresh authenticated request, then try again." }); return; }
    configuredHeaders = mergeCapturedAuthenticationHeaders(simulation.headers, resolved.headers);
  }
  const execution = await executeSimulation(simulation, {}, {
    pathSuffix,
    headers: configuredHeaders,
    queryParams: capturedUpstreamQuery(simulation.queryParams ?? {}, simulation.id),
  }, parsed.data.attachCapturedAuthentication ? { forceUpstream: true } : undefined);
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
  const userId = requireUserId(req);
  const simulation = await getSimulation(userId, Number(req.params.id));
  if (!simulation) { res.status(404).json({ error: "Simulation not found" }); return; }
  const pathSuffix = simulation.dashboardRequestPath?.trim();
  if (!pathSuffix || !pathSuffix.startsWith("/") || pathSuffix.startsWith("//") || /[?#\\\\]/.test(pathSuffix)) {
    res.status(422).json({ error: "Set a valid Dashboard Request Path in the selected simulation before starting a recovery workflow." }); return;
  }
  const workflow = Array.isArray(req.body?.workflow) ? req.body.workflow : simulation.workflow;
  const requestedSeed = Number(req.body?.seed);
  const baseSeed = Number.isInteger(requestedSeed) && requestedSeed >= 0 && requestedSeed <= 0xffffffff ? requestedSeed : generateSeed();
  let requestOverrides: RequestOverrides = { pathSuffix };
  const attachAuthentication = req.body?.attachCapturedAuthentication === true;
  let authSourceExecutionId: number | undefined;
  if (attachAuthentication) {
    authSourceExecutionId = Number(req.body?.authSourceExecutionId);
    if (!Number.isInteger(authSourceExecutionId) || authSourceExecutionId <= 0) {
      res.status(400).json({ error: "Select a captured authentication context before starting the recovery workflow." }); return;
    }
    const resolved = await resolveAuthenticationContext(userId, authSourceExecutionId);
    if (resolved.error === "not_found") { res.status(404).json({ error: "Captured authentication context not found." }); return; }
    if (resolved.error === "expired") { res.status(410).json({ error: "Authentication context expired before execution. Capture a fresh authenticated request, then try again." }); return; }
    if (resolved.error === "unavailable") { res.status(410).json({ error: "Authentication context is unavailable. Capture a fresh authenticated request, then try again." }); return; }
    if (resolved.error === "no_credentials") { res.status(422).json({ error: "The selected context has no reusable cookie or authorization header." }); return; }
    requestOverrides = { pathSuffix, headers: mergeCapturedAuthenticationHeaders(simulation.headers, resolved.headers) };
  }
  let attemptIndex = 0;
  const executions = [];
  for (const step of workflow ?? []) {
    const attempts = Math.max(1, Math.min(100, Number(step.attempts ?? 1)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attachAuthentication && authSourceExecutionId) {
        const currentContext = await resolveAuthenticationContext(userId, authSourceExecutionId);
        if (currentContext.error) {
          const reason = currentContext.error === "expired" ? "expired" : currentContext.error === "not_found" ? "no longer accessible" : "unavailable";
          res.status(currentContext.error === "not_found" ? 404 : currentContext.error === "no_credentials" ? 422 : 410).json({
            error: `Authentication context became ${reason} during the recovery workflow; remaining attempts were not run.`, executions,
          });
          return;
        }
        if (currentContext.expiresAt <= now()) {
          res.status(410).json({ error: "Authentication context expired during the recovery workflow; remaining attempts were not run.", executions });
          return;
        }
        requestOverrides = { pathSuffix, headers: mergeCapturedAuthenticationHeaders(simulation.headers, currentContext.headers) };
      }
      executions.push(await executeSimulation(simulation, {
        ...step,
        failureType: toFailureType(step.failureType),
        workflow: [{ ...step, failureType: toFailureType(step.failureType), attempts: 1 }],
        seed: deriveSeed(baseSeed, attemptIndex++),
      }, requestOverrides));
    }
  }
  const finalExecution = executions.at(-1);
  const finalTimeline = Array.isArray(finalExecution?.timeline) ? finalExecution.timeline : [];
  const finalUpstreamResponse = finalTimeline.find((event: { label?: string }) => event.label?.startsWith("Upstream responded with HTTP "));
  const authenticationFailure = finalUpstreamResponse?.label === "Upstream responded with HTTP 401";
  const upstreamSucceeded = finalExecution?.status === "success" && /^Upstream responded with HTTP 2\d\d$/.test(finalUpstreamResponse?.label ?? "");
  res.status(201).json({
    executions,
    recovered: upstreamSucceeded,
    ...(authenticationFailure ? { authenticationFailure: true, message: "The upstream rejected the selected credentials (HTTP 401). Refresh the source app session and capture a new request." } : {}),
  });
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
  const snapshotPath = (execution.configSnapshot as { request?: { pathSuffix?: string } } | null)?.request?.pathSuffix;
  const originalPath = new URL(execution.url).pathname;
  let requestOverrides: RequestOverrides = {
    method: toHttpMethod(execution.method),
    headers: execution.requestHeaders,
    queryParams: execution.requestQuery,
    requestBody: execution.requestBody,
    pathSuffix: snapshotPath || originalPath,
  };
  const mode = parsed.data.mode ?? "reproduce";
  if (mode === "reexecute" && execution.source === "external") {
    const [contextRow] = await db.select().from(executionRequestContextsTable).where(and(
      eq(executionRequestContextsTable.executionId, execution.id),
      gt(executionRequestContextsTable.expiresAt, now()),
    )).limit(1);
    const hasRedactedCredentials = [execution.requestHeaders.cookie, execution.requestHeaders.authorization]
      .some((value) => value === "[REDACTED]");
    if (!contextRow && (execution.tokenAuthenticated || hasRedactedCredentials)) {
      res.status(410).json({ error: "The captured authentication context expired or is unavailable. Capture a new authenticated request before reexecuting." });
      return;
    }
    if (contextRow) {
      try {
        const captured = decryptRequestContext(execution.id, contextRow.encryptedContext);
        requestOverrides = {
          ...captured,
          targetUrl: simulation.targetUrl,
          method: toHttpMethod(execution.method),
          pathSuffix: snapshotPath || captured.pathSuffix || originalPath,
          queryParams: captured.queryParams ?? execution.requestQuery,
          requestBody: captured.requestBody ?? execution.requestBody,
        };
      } catch {
        res.status(410).json({ error: "The captured authentication context is unavailable. Capture a new authenticated request before reexecuting." });
        return;
      }
    }
  }
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
    const allowedHeaderNames = new Set(["accept", "authorization", "content-type", "user-agent", "x-request-id", "x-faultline-token"]);
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
  const suffix = capturedProxyPath(typeof req.params[1] === "string" ? req.params[1] : undefined, queryParams.path, simulation.id) ?? "";
  const upstreamQueryParams = capturedUpstreamQuery(queryParams, simulation.id);
  const body = req.body && typeof req.body === "object" ? JSON.stringify(req.body) : typeof req.body === "string" ? req.body : null;
  const capturedRequest = {
    method: toProxyHttpMethod(req.method),
    headers,
    queryParams: upstreamQueryParams,
    requestBody: body,
    pathSuffix: suffix,
    source: dashboardSession ? "dashboard" as const : "external" as const,
    tokenAuthenticated: !dashboardSession,
    requestIp: clientIp(req),
  };
  const execution = await executeSimulation(simulation, {}, capturedRequest, { preserveRawResponseHeaders: true });
  if (!dashboardSession) {
    try {
      const context = { ...capturedRequest, targetUrl: simulation.targetUrl };
      const encryptedContext = encryptRequestContext(execution.id, context);
      const expiresAt = requestContextExpiry();
      await db.delete(executionRequestContextsTable).where(lt(executionRequestContextsTable.expiresAt, now()));
      await db.insert(executionRequestContextsTable).values({ executionId: execution.id, encryptedContext, expiresAt }).onConflictDoUpdate({
        target: executionRequestContextsTable.executionId,
        set: { encryptedContext, expiresAt },
      });
    } catch {
      // Request execution must not fail if the optional short-lived replay context cannot be saved.
    }
  }
  if (execution.status === "timeout" && execution.failureType === "none") {
    sendUpstreamTimeout(res);
    return;
  }
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
