import { eq } from "drizzle-orm";
import { db as database, executionsTable, simulationsTable } from "@workspace/db";
import type { Simulation } from "@workspace/db";
import { deriveResponseBody, decideFailure } from "./decide.js";
import { matchConditions } from "./matchConditions.js";
import { toFailureType, toHttpMethod, type FailureType, type HttpMethod, type RequestOverrides, type RunOverrides } from "./types.js";

export type EngineDependencies = {
  db: typeof database;
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
};

const defaultDependencies: EngineDependencies = {
  db: database,
  fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date(),
};

export function buildUrl(targetUrl: string, query: Record<string, string>): string {
  const url = new URL(targetUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function createTimeline(type: FailureType, baseTime: Date) {
  const received = new Date(baseTime.getTime());
  const injected = new Date(baseTime.getTime() + 8);
  const generated = new Date(baseTime.getTime() + 18);
  const completed = new Date(baseTime.getTime() + 28);
  return [
    { label: "Request received", timestamp: received.toISOString(), tone: "neutral" as const },
    ...(type !== "none"
      ? [{ label: "Failure rule evaluated", timestamp: injected.toISOString(), tone: "warning" as const }]
      : []),
    { label: "Response generated", timestamp: generated.toISOString(), tone: type === "none" ? ("success" as const) : ("danger" as const) },
    { label: "Request completed", timestamp: completed.toISOString(), tone: "neutral" as const },
  ];
}

export function createSimulationExecutor(dependencies: Partial<EngineDependencies> = {}) {
  const engine = { ...defaultDependencies, ...dependencies };

  return async function executeSimulation(
    simulation: Simulation,
    overrides: RunOverrides = {},
    requestOverrides: RequestOverrides = {},
  ) {
    const startedAt = engine.now();
    const method: HttpMethod = requestOverrides.method ?? toHttpMethod(simulation.method);
    const requestHeaders = requestOverrides.headers ?? simulation.headers;
    const requestQuery = requestOverrides.queryParams ?? simulation.queryParams;
    const requestBody = requestOverrides.requestBody === undefined ? simulation.requestBody : requestOverrides.requestBody;
    const baseUrl = new URL(simulation.targetUrl);
    if (requestOverrides.pathSuffix) {
      const suffix = requestOverrides.pathSuffix.startsWith("/") ? requestOverrides.pathSuffix : `/${requestOverrides.pathSuffix}`;
      baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}${suffix}`;
    }
    const effectiveTargetUrl = baseUrl.toString();
    const request = { method, headers: requestHeaders, queryParams: requestQuery, requestBody };
    const conditionsMatch = matchConditions(simulation.conditions, request, effectiveTargetUrl);
    const workflow = overrides.workflow ?? simulation.workflow ?? [];
    const workflowStep = workflow.find((step) => (step.attempts ?? 1) > 0);
    const configuredFailure = workflowStep
      ? toFailureType(workflowStep.failureType)
      : overrides.failureType ?? (simulation.enabled && conditionsMatch ? toFailureType(simulation.failureType) : "none");
    const probability = simulation.enabled && conditionsMatch ? simulation.probability : 0;
    const decision = decideFailure(configuredFailure, probability, overrides.seed ?? simulation.id, overrides.statusCode ?? simulation.statusCode);
    const failureType = decision.failureType;
    const isTimeout = failureType === "timeout";
    const isFailure = failureType !== "none" && failureType !== "latency";
    const configuredLatency = Math.max(0, overrides.latencyMs ?? simulation.latencyMs ?? 0);
    const responseBody = deriveResponseBody(failureType, simulation.responseBody, overrides.responseBody);
    let responseHeaders: Record<string, string | string[]> = { "content-type": "application/json" };
    let actualLatencyMs = 0;
    let status: "success" | "failure" | "timeout" = isTimeout ? "timeout" : isFailure ? "failure" : "success";
    let finalStatus = decision.statusCode;
    let finalBody = responseBody;

    if (failureType === "connection_failure") {
      finalStatus = null;
      finalBody = null;
    } else if (failureType === "timeout") {
      finalStatus = null;
      finalBody = null;
      actualLatencyMs = Math.max(0, simulation.timeoutMs ?? 0);
      await engine.sleep(actualLatencyMs);
    } else if (failureType === "duplicate_response") {
      // HTTP permits one response per request, so model a duplicate write as one diagnostic 502.
      finalStatus = 502;
      finalBody = JSON.stringify({
        error: "duplicate_response",
        message: "The simulator detected an attempted duplicate response.",
        attemptedStatus: decision.statusCode ?? 200,
      });
      responseHeaders["x-faultline-duplicate-response"] = "true";
      status = "failure";
      actualLatencyMs = Math.max(0, engine.now().getTime() - startedAt.getTime());
    } else {
      if (configuredLatency > 0) await engine.sleep(configuredLatency);

      const shouldForward = simulation.forwardRequest || requestOverrides.source === "external";
      if ((failureType === "none" || failureType === "latency") && shouldForward) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(0, simulation.forwardTimeoutMs ?? 10000));
        try {
          const upstream = await engine.fetch(buildUrl(effectiveTargetUrl, requestQuery), {
            method,
            headers: requestHeaders,
            body: ["GET", "HEAD"].includes(method) ? undefined : requestBody ?? undefined,
            signal: controller.signal,
          });
          finalStatus = upstream.status;
          finalBody = await upstream.text();
          responseHeaders = {};
          upstream.headers.forEach((value, key) => {
            if (key !== "set-cookie" && (simulation.preserveHeaders || key === "content-type")) responseHeaders[key] = value;
          });
          const headersWithCookies = upstream.headers as Headers & { getSetCookie?: () => string[] };
          const upstreamCookies = typeof headersWithCookies.getSetCookie === "function" ? headersWithCookies.getSetCookie() : [];
          if (simulation.preserveHeaders && upstreamCookies.length > 0) responseHeaders["set-cookie"] = upstreamCookies;
          status = upstream.ok ? "success" : "failure";
        } catch (error) {
          status = error instanceof Error && error.name === "AbortError" ? "timeout" : "failure";
          finalStatus = null;
          finalBody = null;
        } finally {
          clearTimeout(timer);
        }
      } else if (failureType === "none" || failureType === "latency") {
        finalStatus = 200;
        finalBody = null;
      }
      actualLatencyMs = Math.max(0, engine.now().getTime() - startedAt.getTime());
    }
    if (failureType === "timeout" || failureType === "connection_failure") {
      actualLatencyMs = Math.max(actualLatencyMs, engine.now().getTime() - startedAt.getTime());
    }

    const [execution] = await engine.db.insert(executionsTable).values({
      ownerId: simulation.ownerId,
      teamId: simulation.teamId,
      simulationId: simulation.id,
      method,
      url: buildUrl(effectiveTargetUrl, requestQuery),
      requestHeaders,
      requestQuery,
      requestBody,
      failureType,
      simulatedStatus: finalStatus,
      responseHeaders: { ...responseHeaders, "x-simulator-rule": failureType },
      responseBody: finalBody,
      actualLatencyMs,
      status,
      source: requestOverrides.source ?? "dashboard",
      tokenAuthenticated: requestOverrides.tokenAuthenticated ?? false,
      requestIp: requestOverrides.requestIp ?? null,
      timeline: createTimeline(failureType, startedAt),
      createdAt: startedAt,
    }).returning();
    await engine.db.update(simulationsTable).set({
      requestCount: simulation.requestCount + 1,
      failedCount: simulation.failedCount + (isFailure || status === "timeout" ? 1 : 0),
      successCount: simulation.successCount + (isFailure || status === "timeout" ? 0 : 1),
      lastExecutedAt: startedAt,
      updatedAt: startedAt,
    }).where(eq(simulationsTable.id, simulation.id));
    return execution;
  };
}

export type { FailureType, HttpMethod, RequestOverrides, RunOverrides } from "./types.js";
