import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { encryptRequestContext } from "../lib/recovery-context.js";

const mocks = vi.hoisted(() => ({
  sourceExecution: null as any,
  contextRow: null as any,
  simulation: null as any,
  executeSimulation: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => values,
  desc: (value: unknown) => value,
  eq: (...values: unknown[]) => values,
  gt: (...values: unknown[]) => values,
  isNull: (value: unknown) => value,
  lt: (...values: unknown[]) => values,
}));

vi.mock("@workspace/db", () => {
  const table = (name: string) => new Proxy({ tableName: name }, {
    get(target, property) {
      if (property === "tableName") return target.tableName;
      return { tableName: name, columnName: String(property) };
    },
  });
  const executionsTable = table("executions");
  const executionRequestContextsTable = table("execution_request_contexts");
  const simulationsTable = table("simulations");
  const integrationCredentialsTable = table("integration_credentials");
  const db = {
    select: () => {
      let selectedTable: { tableName?: string } | undefined;
      const query: Record<string, any> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        query[method] = (value: { tableName?: string }) => {
          if (method === "from") selectedTable = value;
          return query;
        };
      }
      query.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(
        selectedTable?.tableName === "executions" && mocks.sourceExecution
          ? [{ execution: mocks.sourceExecution }]
          : selectedTable?.tableName === "execution_request_contexts" && mocks.contextRow
            ? [mocks.contextRow]
            : [],
      ).then(resolve, reject);
      return query;
    },
    delete: (target: { tableName?: string }) => ({
      where: () => ({
        returning: async () => {
          if (target.tableName !== "execution_request_contexts" || !mocks.contextRow) return [];
          const row = mocks.contextRow;
          mocks.contextRow = null;
          return [row];
        },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: vi.fn() }) }),
    update: () => ({ set: () => ({ where: vi.fn() }) }),
  };
  return { db, executionsTable, executionRequestContextsTable, simulationsTable, integrationCredentialsTable };
});

vi.mock("../engine/execute.js", () => ({ createSimulationExecutor: () => mocks.executeSimulation }));
vi.mock("../engine/drizzleDatabase.js", () => ({ createDrizzleEngineDatabase: vi.fn() }));
vi.mock("../lib/workspace.js", () => ({
  canAccessTeam: vi.fn(),
  ensureUser: vi.fn(),
  getAccessibleSimulation: vi.fn(async () => mocks.simulation),
  requireUserId: (request: { userId?: string }) => request.userId,
  simulationAccess: vi.fn(() => ({})),
}));

import router from "./simulations.js";

const app = express();
app.use(express.json());
app.use((req, _res, next) => { Object.assign(req, { userId: "owner-1" }); next(); });
app.use(router);
let server: ReturnType<typeof app.listen>;
let baseUrl: string;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = "test-only-encryption-key";
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  mocks.simulation = { id: 20, targetUrl: "https://tasks.example.test/", workflow: [] };
  mocks.sourceExecution = { id: 642, simulationId: 20, source: "external" };
  mocks.contextRow = {
    executionId: 642,
    encryptedContext: encryptRequestContext(642, {
      method: "GET",
      targetUrl: "https://tasks.example.test/",
      pathSuffix: "",
      queryParams: { path: "proxy/simulations/20/api/task/send/alltask" },
      headers: { cookie: "session=do-not-leak", accept: "application/json" },
      requestBody: null,
      source: "external",
      tokenAuthenticated: true,
    }),
    expiresAt: new Date(Date.now() + 60_000),
  };
  mocks.executeSimulation.mockReset();
  mocks.executeSimulation.mockImplementation(async (_simulation, overrides, request) => ({
    id: 700 + mocks.executeSimulation.mock.calls.length,
    simulationId: 20,
    method: request.method ?? "GET",
    url: `${request.targetUrl ?? "https://tasks.example.test"}${request.pathSuffix}`,
    requestHeaders: { cookie: "[REDACTED]" },
    requestQuery: request.queryParams ?? {},
    requestBody: request.requestBody,
    failureType: overrides.failureType ?? "none",
    seed: 1,
    simulatedStatus: overrides.failureType === "http_400" ? 400 : 200,
    status: overrides.failureType === "http_400" ? "failure" : "success",
    responseBody: "{}",
    responseHeaders: {},
    actualLatencyMs: 1,
    source: request.source ?? "dashboard",
    tokenAuthenticated: request.tokenAuthenticated ?? false,
    requestIp: request.requestIp ?? null,
    createdAt: new Date().toISOString(),
    timeline: [{ label: overrides.failureType === "none" ? "Upstream responded with HTTP 200" : "Upstream not called", timestamp: new Date().toISOString(), tone: "success" }],
  }));
});

async function runRecovery(
  workflow: Array<{ failureType: string; attempts: number }>,
  request?: { pathSuffix?: string },
) {
  return fetch(`${baseUrl}/simulations/20/recovery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceExecutionId: 642, workflow, request }),
  });
}

describe("dashboard execution paths", () => {
  it("rejects Run now without an API path instead of calling the backend root", async () => {
    const response = await fetch(`${baseUrl}/simulations/20/executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const payload: any = await response.json();
    expect(payload.error).toContain("API request path is required");
    expect(mocks.executeSimulation).not.toHaveBeenCalled();
  });

  it("passes an explicit relative API path to Dashboard Run now", async () => {
    const response = await fetch(`${baseUrl}/simulations/20/executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pathSuffix: "/api/task/addtask" }),
    });

    const payload: any = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(201);
    expect((mocks.executeSimulation.mock.calls[0] as any)[2].pathSuffix).toBe("/api/task/addtask");
  });

  it("reuses the selected encrypted request context without returning credentials", async () => {
    mocks.sourceExecution = { id: 642, simulationId: 20, source: "external", tokenAuthenticated: true };
    const response = await fetch(`${baseUrl}/simulations/20/executions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceExecutionId: 642 }),
    });
    const payload: any = await response.json();
    const [simulation, overrides, request, options] = mocks.executeSimulation.mock.calls[0] as any;

    expect(response.status, JSON.stringify(payload)).toBe(201);
    expect(request).toMatchObject({ method: "GET", pathSuffix: "/api/task/send/alltask", queryParams: {}, requestBody: null, source: "dashboard", tokenAuthenticated: true });
    expect(request.headers.cookie).toBe("session=do-not-leak");
    expect(simulation.targetUrl).toBe("https://tasks.example.test/");
    expect(options).toEqual({ forceUpstream: true });
    expect(JSON.stringify(payload)).not.toContain("session=do-not-leak");
  });

  it("does not accept a captured execution from another simulation", async () => {
    mocks.sourceExecution = { id: 642, simulationId: 21, source: "external", tokenAuthenticated: true };
    const response = await fetch(`${baseUrl}/simulations/20/executions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceExecutionId: 642 }),
    });
    expect(response.status).toBe(404);
    expect(mocks.executeSimulation).not.toHaveBeenCalled();
  });

  it("rejects expired dashboard request context explicitly", async () => {
    mocks.sourceExecution = { id: 642, simulationId: 20, source: "external", tokenAuthenticated: true };
    mocks.contextRow.expiresAt = new Date(Date.now() - 1000);
    const response = await fetch(`${baseUrl}/simulations/20/executions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceExecutionId: 642 }),
    });
    expect(response.status).toBe(410);
    expect((await response.json() as any).error).toContain("Send a new authenticated request");
    expect(mocks.executeSimulation).not.toHaveBeenCalled();
  });
});

describe("captured execution replay", () => {
  it("replays the original endpoint and restores unexpired captured authentication", async () => {
    mocks.sourceExecution = {
      id: 642,
      simulationId: 20,
      source: "external",
      tokenAuthenticated: true,
      method: "POST",
      url: "https://tasks.example.test/api/task/addtask?tag=one",
      requestHeaders: { cookie: "[REDACTED]" },
      requestQuery: { tag: "one" },
      requestBody: '{"task":"saved"}',
      configSnapshot: { request: { pathSuffix: "/api/task/addtask" } },
      seed: 7,
    };
    mocks.contextRow = {
      executionId: 642,
      encryptedContext: encryptRequestContext(642, {
        method: "POST",
        targetUrl: "https://old-target.example.test/api/task/send/alltask",
        pathSuffix: "/api/task/addtask",
        queryParams: { tag: "one" },
        headers: { cookie: "session=replay-secret" },
        requestBody: '{"task":"saved"}',
      }),
      expiresAt: new Date(Date.now() + 60_000),
    };

    const response = await fetch(`${baseUrl}/executions/642/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "reexecute" }),
    });

    expect(response.status).toBe(201);
    const request = (mocks.executeSimulation.mock.calls[0] as any)[2];
    expect(request.pathSuffix).toBe("/api/task/addtask");
    expect(request.targetUrl).toBe("https://tasks.example.test/");
    expect(request.headers.cookie).toBe("session=replay-secret");
  });
});

describe("captured request recovery", () => {
  it("reuses the same authenticated request context for every attempt and redacts it from the response", async () => {
    const response = await runRecovery([
      { failureType: "http_400", attempts: 1 },
      { failureType: "none", attempts: 1 },
    ]);
    const result: any = await response.json();

    expect(response.status).toBe(201);
    expect(result.recovered).toBe(true);
    expect(result.executions.map((execution: any) => execution.simulatedStatus)).toEqual([400, 200]);
    expect(mocks.executeSimulation).toHaveBeenCalledTimes(2);
    expect(mocks.executeSimulation.mock.calls[0][1].failureType).toBe("http_400");
    expect(mocks.executeSimulation.mock.calls[1][1].failureType).toBe("none");
    const firstRequest = mocks.executeSimulation.mock.calls[0][2];
    const secondRequest = mocks.executeSimulation.mock.calls[1][2];
    expect(firstRequest).toEqual(secondRequest);
    expect(firstRequest.headers.cookie).toBe("session=do-not-leak");
    expect(firstRequest.method).toBe("GET");
    expect(firstRequest.pathSuffix).toBe("/api/task/send/alltask");
    expect(firstRequest.queryParams).toEqual({});
    expect(JSON.stringify(result)).not.toContain("session=do-not-leak");
    expect(mocks.contextRow).toBeNull();
  });

  it("lets the recovery API path override the captured path while keeping captured authentication", async () => {
    const response = await runRecovery(
      [{ failureType: "none", attempts: 1 }],
      { pathSuffix: "/api/task/custom" },
    );
    const result: any = await response.json();
    const request = mocks.executeSimulation.mock.calls[0][2];

    expect(response.status).toBe(201);
    expect(result.recovered).toBe(true);
    expect(request.pathSuffix).toBe("/api/task/custom");
    expect(request.headers.cookie).toBe("session=do-not-leak");
  });

  it("reports an expired captured context without attempting recovery", async () => {
    mocks.contextRow = null;
    const response = await runRecovery([{ failureType: "none", attempts: 1 }]);
    const result: any = await response.json();

    expect(response.status).toBe(410);
    expect(result.error).toContain("expired or was already used");
    expect(mocks.executeSimulation).not.toHaveBeenCalled();
  });

  it("reports a captured request with no authentication credentials", async () => {
    mocks.contextRow.encryptedContext = encryptRequestContext(642, {
      method: "GET",
      targetUrl: "https://tasks.example.test/",
      pathSuffix: "/api/task/send/alltask",
      headers: { accept: "application/json" },
      queryParams: {},
      requestBody: null,
      source: "external",
    });
    const response = await runRecovery([{ failureType: "none", attempts: 1 }]);
    const result: any = await response.json();

    expect(response.status).toBe(422);
    expect(result.error).toContain("no cookie or authorization header");
    expect(mocks.executeSimulation).not.toHaveBeenCalled();
  });

  it("does not call a synthetic 200 without an upstream response recovered", async () => {
    mocks.executeSimulation.mockImplementation(async () => ({
      id: 703,
      status: "success",
      simulatedStatus: 200,
      timeline: [{ label: "Upstream not called" }],
    }));
    const response = await runRecovery([{ failureType: "none", attempts: 1 }]);
    const result: any = await response.json();

    expect(response.status).toBe(201);
    expect(result.recovered).toBe(false);
  });

  it("clearly reports an upstream 401 as an authentication failure", async () => {
    mocks.executeSimulation.mockImplementation(async () => ({
      id: 702,
      status: "failure",
      simulatedStatus: 401,
      responseBody: '{"message":"Please Login"}',
      timeline: [{ label: "Upstream responded with HTTP 401" }],
    }));
    const response = await runRecovery([{ failureType: "none", attempts: 1 }]);
    const result: any = await response.json();

    expect(response.status).toBe(201);
    expect(result.recovered).toBe(false);
    expect(result.authenticationFailure).toBe(true);
    expect(result.message).toContain("upstream rejected the captured credentials");
  });
});
