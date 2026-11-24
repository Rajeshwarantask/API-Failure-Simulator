import type { Execution, ExecutionConfigSnapshot, NewExecution, Simulation } from "@workspace/db";
import { deriveResponseBody, decideFailure } from "./decide.js";
import { matchConditions } from "./matchConditions.js";
import { generateSeed } from "./prng.js";
import { buildUpstreamUrl, capStoredBody, createSafeFetch, readCappedBody, redactExecutionData } from "../lib/target-url.js";
import { toFailureType, toHttpMethod, type FailureType, type HttpMethod, type RequestOverrides, type RunOverrides } from "./types.js";

export type ExecutionInsert = NewExecution;
export type SimulationCounters = Pick<Simulation, "requestCount" | "failedCount" | "successCount" | "lastExecutedAt" | "updatedAt">;

export type EngineDatabase = {
  persistExecution: (values: ExecutionInsert) => Promise<Execution>;
  updateSimulationCounters: (simulationId: number, values: SimulationCounters) => Promise<void>;
};

export type EngineDependencies = {
  db: EngineDatabase;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  createSeed?: () => number;
};

const defaultDependencies = {
  fetch: createSafeFetch(),
  sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date(),
  createSeed: generateSeed,
};

export function buildUrl(targetUrl: string, query: Record<string, string>, requestPath = "/"): string {
  return buildUpstreamUrl(targetUrl, requestPath, query);
}

function createTimeline(
  type: FailureType,
  baseTime: Date,
  details: { conditionsMatched: boolean; injected: boolean; upstreamStatus: number | null; upstreamAttempted: boolean },
) {
  const received = new Date(baseTime.getTime());
  const injected = new Date(baseTime.getTime() + 8);
  const generated = new Date(baseTime.getTime() + 18);
  const completed = new Date(baseTime.getTime() + 28);
  return [
    { label: "Request received", timestamp: received.toISOString(), tone: "neutral" as const },
    { label: details.conditionsMatched ? "Request conditions matched" : "Request conditions did not match", timestamp: injected.toISOString(), tone: details.conditionsMatched ? "success" as const : "warning" as const },
    { label: details.injected ? "Failure injected" : "No failure injected", timestamp: injected.toISOString(), tone: details.injected ? "danger" as const : "success" as const },
    ...(details.upstreamAttempted
      ? [{ label: details.upstreamStatus === null ? "Upstream request failed" : `Upstream responded with HTTP ${details.upstreamStatus}`, timestamp: generated.toISOString(), tone: details.upstreamStatus !== null && details.upstreamStatus < 400 ? "success" as const : "warning" as const }]
      : [{ label: "Upstream not called", timestamp: generated.toISOString(), tone: "neutral" as const }]),
    { label: `Recovery outcome: ${type === "none" ? "pass-through" : type.replaceAll("_", " ")}`, timestamp: generated.toISOString(), tone: type === "none" ? "success" as const : "danger" as const },
    { label: "Request completed", timestamp: completed.toISOString(), tone: "neutral" as const },
  ];
}

function createConfigSnapshot(
  simulation: Simulation,
  overrides: RunOverrides,
  request: RequestOverrides,
): ExecutionConfigSnapshot {
  return redactExecutionData({
    simulation: {
      targetUrl: simulation.targetUrl,
      method: simulation.method,
      headers: simulation.headers,
      queryParams: simulation.queryParams,
      requestBody: capStoredBody(simulation.requestBody),
      failureType: simulation.failureType,
      statusCode: simulation.statusCode,
      responseBody: capStoredBody(simulation.responseBody),
      latencyMs: simulation.latencyMs,
      timeoutMs: simulation.timeoutMs,
      probability: simulation.probability,
      conditions: simulation.conditions,
      workflow: simulation.workflow,
      enabled: simulation.enabled,
      forwardRequest: simulation.forwardRequest,
      forwardTimeoutMs: simulation.forwardTimeoutMs,
      preserveHeaders: simulation.preserveHeaders,
    },
    overrides: {
      failureType: overrides.failureType,
      statusCode: overrides.statusCode,
      latencyMs: overrides.latencyMs,
      responseBody: overrides.responseBody === undefined ? undefined : capStoredBody(overrides.responseBody) ?? undefined,
      workflow: overrides.workflow,
    },
    request: { ...request, requestBody: capStoredBody(request.requestBody) },
  });
}

export function createSimulationExecutor(dependencies: EngineDependencies) {
  const engine = { ...defaultDependencies, ...dependencies };

  return async function executeSimulation(
    simulation: Simulation,
    overrides: RunOverrides = {},
    requestOverrides: RequestOverrides = {},
    options: { allowUpstream?: boolean; forceUpstream?: boolean; preserveRawResponseHeaders?: boolean } = {},
  ) {
    const startedAt = engine.now();
    const seed = overrides.seed ?? engine.createSeed();
    const configSnapshot = createConfigSnapshot(simulation, overrides, requestOverrides);
    const method: HttpMethod = requestOverrides.method ?? toHttpMethod(simulation.method);
    const requestHeaders = requestOverrides.headers ?? simulation.headers;
    const requestQuery = requestOverrides.queryParams ?? simulation.queryParams;
    const requestBody = requestOverrides.requestBody === undefined ? simulation.requestBody : requestOverrides.requestBody;
    const effectiveTargetUrl = buildUpstreamUrl(
      requestOverrides.targetUrl ?? simulation.targetUrl,
      requestOverrides.pathSuffix ?? "/",
      {},
    );
    const request = { method, headers: requestHeaders, queryParams: requestQuery, requestBody };
    const conditionsMatch = matchConditions(simulation.conditions, request, effectiveTargetUrl);
    const workflow = overrides.workflow ?? simulation.workflow ?? [];
    const workflowStep = workflow.find((step) => (step.attempts ?? 1) > 0);
    const configuredFailure = workflowStep
      ? toFailureType(workflowStep.failureType)
      : overrides.failureType ?? (simulation.enabled && conditionsMatch ? toFailureType(simulation.failureType) : "none");
    const probability = workflowStep ? 100 : simulation.enabled && conditionsMatch ? simulation.probability : 0;
    const decision = decideFailure(configuredFailure, probability, seed, overrides.statusCode ?? simulation.statusCode);
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
    let upstreamStatus: number | null = null;
    let upstreamAttempted = false;

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

      const shouldForward = options.allowUpstream !== false && (options.forceUpstream === true || simulation.forwardRequest || requestOverrides.source === "external");
      if ((failureType === "none" || failureType === "latency") && shouldForward) {
        upstreamAttempted = true;
        const controller = new AbortController();
        const forwardTimeoutMs = simulation.forwardTimeoutMs ?? 10000;
        const timer = forwardTimeoutMs > 0
          ? setTimeout(() => controller.abort(), forwardTimeoutMs)
          : undefined;
        try {
          const upstream = await engine.fetch(buildUrl(effectiveTargetUrl, requestQuery, requestOverrides.pathSuffix ?? "/"), {
            method,
            headers: requestHeaders,
            body: ["GET", "HEAD"].includes(method) ? undefined : requestBody ?? undefined,
            signal: controller.signal,
          });
          finalStatus = upstream.status;
          upstreamStatus = upstream.status;
          const upstreamBody = await readCappedBody(upstream);
          finalBody = upstreamBody.body;
          responseHeaders = {};
          upstream.headers.forEach((value, key) => {
            if (key !== "set-cookie" && (simulation.preserveHeaders || key === "content-type")) responseHeaders[key] = value;
          });
          const headersWithCookies = upstream.headers as Headers & { getSetCookie?: () => string[] };
          const upstreamCookies = typeof headersWithCookies.getSetCookie === "function" ? headersWithCookies.getSetCookie() : [];
          if (simulation.preserveHeaders && upstreamCookies.length > 0) responseHeaders["set-cookie"] = upstreamCookies;
          if (upstreamBody.truncated) responseHeaders["x-simulator-truncated"] = "true";
          status = upstream.ok ? "success" : "failure";
        } catch (error) {
          status = error instanceof Error && error.name === "AbortError" ? "timeout" : "failure";
          finalStatus = null;
          finalBody = null;
        } finally {
          if (timer) clearTimeout(timer);
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

    const proxyResponseHeaders = { ...responseHeaders, "x-simulator-rule": failureType };
    const execution = await engine.db.persistExecution({
      ownerId: simulation.ownerId,
      teamId: simulation.teamId,
      simulationId: simulation.id,
      seed,
      configSnapshot: redactExecutionData(configSnapshot),
      method,
      url: buildUrl(effectiveTargetUrl, requestQuery, requestOverrides.pathSuffix ?? "/"),
      requestHeaders: redactExecutionData(requestHeaders),
      requestQuery,
      requestBody: capStoredBody(requestBody),
      failureType,
      simulatedStatus: finalStatus,
      responseHeaders: redactExecutionData(proxyResponseHeaders),
      responseBody: capStoredBody(finalBody),
      actualLatencyMs,
      status,
      source: requestOverrides.source ?? "dashboard",
      tokenAuthenticated: requestOverrides.tokenAuthenticated ?? false,
      requestIp: requestOverrides.requestIp ?? null,
      timeline: createTimeline(failureType, startedAt, {
        conditionsMatched: conditionsMatch,
        injected: decision.injected,
        upstreamStatus,
        upstreamAttempted,
      }),
      createdAt: startedAt,
    });
    await engine.db.updateSimulationCounters(simulation.id, {
      requestCount: simulation.requestCount + 1,
      failedCount: simulation.failedCount + (isFailure || status === "timeout" ? 1 : 0),
      successCount: simulation.successCount + (isFailure || status === "timeout" ? 0 : 1),
      lastExecutedAt: startedAt,
      updatedAt: startedAt,
    });
    return options.preserveRawResponseHeaders
      ? { ...execution, proxyResponseHeaders }
      : execution;
  };
}

export type { FailureType, HttpMethod, RequestOverrides, RunOverrides } from "./types.js";
