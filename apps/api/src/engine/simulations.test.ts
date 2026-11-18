import { describe, expect, it } from "vitest";
import type { Execution, Simulation } from "@workspace/db";
import { decideFailure } from "./decide.js";
import { createSimulationExecutor, type EngineDatabase } from "./execute.js";
import { legacySeededRandom } from "./legacySeededRandom.test-helper.js";
import { deriveSeed, mulberry32 } from "./prng.js";
import { toProxyHttpMethod } from "./types.js";
import { reproduceExecution } from "./replay.js";
import { proxyHeaders } from "../lib/proxy-headers.js";
import { createSafeFetch, MAX_UPSTREAM_BODY_BYTES } from "../lib/target-url.js";

// At p=50%, 1,000 trials have a 1.58pp standard error; a 5pp bound is about 3.2 standard errors.
const INJECTION_RATE_TOLERANCE = 0.05;
const EXECUTIONS_PER_RATE = 1000;

function injectionCount(id: number, probability: number, useNewEngine: boolean): number {
  return Array.from({ length: EXECUTIONS_PER_RATE }, (_, iteration) => {
    const random = useNewEngine
      ? mulberry32(deriveSeed(id, iteration))()
      : legacySeededRandom(id)();
    return random * 100 < probability ? 1 : 0;
  }).reduce((total, injected) => total + injected, 0);
}

function fixtureSimulation(id: number): Simulation {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    ownerId: "00000000-0000-4000-8000-000000000001",
    teamId: null,
    name: `scenario-${id}`,
    description: null,
    targetUrl: "https://upstream.example.test/resource",
    method: "POST",
    headers: {},
    queryParams: {},
    requestBody: null,
    failureType: "http_503",
    statusCode: 503,
    responseBody: '{"error":"frozen"}',
    latencyMs: 0,
    timeoutMs: 5000,
    probability: 100,
    conditions: {},
    workflow: [],
    forwardRequest: true,
    forwardTimeoutMs: 10000,
    preserveHeaders: true,
    executionToken: null,
    allowedOrigins: [],
    enabled: true,
    requestCount: 0,
    failedCount: 0,
    successCount: 0,
    lastExecutedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeDatabase() {
  let nextId = 1;
  const db: EngineDatabase = {
    async persistExecution(values) {
      const execution: Execution = {
        id: nextId++,
        ownerId: values.ownerId,
        teamId: values.teamId ?? null,
        simulationId: values.simulationId,
        seed: values.seed ?? null,
        configSnapshot: values.configSnapshot ?? null,
        method: values.method,
        url: values.url,
        requestHeaders: values.requestHeaders ?? {},
        requestQuery: values.requestQuery ?? {},
        requestBody: values.requestBody ?? null,
        source: values.source ?? "dashboard",
        tokenAuthenticated: values.tokenAuthenticated ?? false,
        requestIp: values.requestIp ?? null,
        failureType: values.failureType,
        simulatedStatus: values.simulatedStatus ?? null,
        responseHeaders: values.responseHeaders ?? {},
        responseBody: values.responseBody ?? null,
        actualLatencyMs: values.actualLatencyMs ?? 0,
        status: values.status,
        timeline: values.timeline ?? [],
        createdAt: values.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
      };
      return execution;
    },
    async updateSimulationCounters() {},
  };
  return db;
}

describe("deterministic execution engine", () => {
  it("preserves the proxy POST fallback for unsupported incoming methods", () => {
    expect(toProxyHttpMethod("HEAD")).toBe("POST");
    expect(toProxyHttpMethod("GET")).toBe("GET");
  });

  it("does not resolve target hosts when forwarding is disabled", async () => {
    let resolutions = 0;
    const fetch = createSafeFetch({
      resolver: async () => {
        resolutions += 1;
        return [{ address: "8.8.8.8", family: 4 }];
      },
      fetch: async () => new Response("upstream"),
      allowPrivate: false,
    });
    const execute = createSimulationExecutor({
      db: fakeDatabase(),
      fetch,
      createSeed: () => 7,
    });

    await execute({ ...fixtureSimulation(1), failureType: "none", forwardRequest: false });

    expect(resolutions).toBe(0);
  });

  it("documents the old simulation-id seed bug", () => {
    expect(injectionCount(1, 30, false)).toBe(1000);
    expect(injectionCount(1, 20, false)).toBe(0);
  });

  it("keeps the new engine rate within five percentage points and prints a before/after table", () => {
    const ids = [1, 100, 1000];
    const probabilities = [10, 30, 50, 75];
    const rows = ["id probability old_rate new_rate"];

    for (const id of ids) {
      for (const probability of probabilities) {
        const oldRate = injectionCount(id, probability, false) / EXECUTIONS_PER_RATE;
        const newRate = injectionCount(id, probability, true) / EXECUTIONS_PER_RATE;
        rows.push(`${id} ${probability}% ${(oldRate * 100).toFixed(1)}% ${(newRate * 100).toFixed(1)}%`);
        expect(Math.abs(newRate - probability / 100)).toBeLessThanOrEqual(INJECTION_RATE_TOLERANCE);
      }
    }

    process.stdout.write(`\nBefore/after empirical injection rates (1,000 runs per cell; ±5pp tolerance):\n${rows.join("\n")}\n`);
  });

  it("never injects at zero percent and always injects at one hundred percent", () => {
    for (const seed of [0, 1, 100, 1000, 0xffffffff]) {
      expect(decideFailure("http_503", 0, seed).injected).toBe(false);
      expect(decideFailure("http_503", 100, seed).injected).toBe(true);
    }
  });

  it("repeats the same random sequence for one seed and changes it for another", () => {
    const sequence = (seed: number) => {
      const random = mulberry32(seed);
      return Array.from({ length: 8 }, () => random());
    };

    expect(sequence(123)).toEqual(sequence(123));
    expect(sequence(123)).not.toEqual(sequence(124));
  });

  it("redacts persisted headers and snapshots while retaining raw proxy response headers", async () => {
    let outgoingHeaders: Record<string, string> = {};
    const execute = createSimulationExecutor({
      db: fakeDatabase(),
      fetch: async (_input, init) => {
        outgoingHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response("upstream", {
          status: 200,
          headers: {
            "set-cookie": "session=response-secret",
            "x-faultline-debug": "internal-secret",
            "content-type": "application/json",
          },
        });
      },
      sleep: async () => {},
      createSeed: () => 456,
    });
    const simulation: Simulation = {
      ...fixtureSimulation(102),
      failureType: "none",
      headers: {
        authorization: "Bearer config-secret",
        cookie: "session=config-secret",
        "x-faultline-key": "internal-secret",
      },
    };
    const execution = await execute(
      simulation,
      {},
      {
        source: "external",
        headers: proxyHeaders(simulation.headers, {
          authorization: "Bearer caller-secret",
          cookie: "session=caller-secret",
          "x-faultline-token": "caller-token",
          accept: "application/json",
        }),
      },
      { preserveRawResponseHeaders: true },
    );

    expect(outgoingHeaders.authorization).toBe("Bearer config-secret");
    expect(outgoingHeaders.cookie).toBe("session=config-secret");
    expect(outgoingHeaders["x-faultline-token"]).toBeUndefined();
    expect(execution.requestHeaders).toMatchObject({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      accept: "application/json",
    });
    expect(execution.requestHeaders).not.toHaveProperty("x-faultline-token");
    expect(execution.responseHeaders).toMatchObject({
      "set-cookie": "[REDACTED]",
      "x-faultline-debug": "[REDACTED]",
    });
    expect(execution.configSnapshot?.simulation.headers).toMatchObject({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "x-faultline-key": "[REDACTED]",
    });
    expect(execution.configSnapshot?.request.headers).toMatchObject({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
    });
    expect(execution.configSnapshot?.request.headers).not.toHaveProperty("x-faultline-token");
    const rawProxyResponseHeaders = (execution as typeof execution & {
      proxyResponseHeaders?: Record<string, string | string[]>;
    }).proxyResponseHeaders;
    expect(rawProxyResponseHeaders?.["set-cookie"]).toEqual(["session=response-secret"]);
  });

  it("caps upstream response bytes and persists a truncation marker", async () => {
    const body = new Uint8Array(MAX_UPSTREAM_BODY_BYTES + 8).fill(97);
    const execute = createSimulationExecutor({
      db: fakeDatabase(),
      fetch: async () => new Response(body),
      sleep: async () => {},
      createSeed: () => 456,
    });
    const simulation: Simulation = { ...fixtureSimulation(103), failureType: "none" };
    const execution = await execute(simulation);

    expect(new TextEncoder().encode(execution.responseBody ?? "").byteLength).toBe(MAX_UPSTREAM_BODY_BYTES);
    expect(execution.responseHeaders).toMatchObject({ "x-simulator-truncated": "true" });
  });

  it("reproduces the stored decision and response after live config changes without upstream calls", async () => {
    let upstreamCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response("upstream", { status: 200 });
    };
    const execute = createSimulationExecutor({
      db: fakeDatabase(),
      fetch,
      sleep: async () => {},
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSeed: () => 456,
    });
    const original = await execute(fixtureSimulation(100), { seed: 987654321 });
    const changedSimulation: Simulation = {
      ...fixtureSimulation(100),
      failureType: "none",
      probability: 0,
      responseBody: "changed response",
    };
    const reproduced = await reproduceExecution(original, changedSimulation, {}, execute);

    expect(reproduced.seed).toBe(original.seed);
    expect(reproduced.failureType).toBe(original.failureType);
    expect(reproduced.responseBody).toBe(original.responseBody);
    expect(reproduced.simulatedStatus).toBe(original.simulatedStatus);
    expect(upstreamCalls).toBe(0);
  });
});
