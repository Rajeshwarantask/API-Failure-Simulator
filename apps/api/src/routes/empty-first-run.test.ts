import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  GetDashboardSummaryResponse,
  ListExecutionsResponse,
  ListSimulationsResponse,
} from "@workspace/api-zod";

const mocks = vi.hoisted(() => ({
  insertedTables: [] as string[],
  ensuredUsers: [] as string[],
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  desc: (column: unknown) => column,
  eq: (...conditions: unknown[]) => conditions,
  isNull: (column: unknown) => column,
  lt: (...conditions: unknown[]) => conditions,
}));

vi.mock("@workspace/db", () => {
  const table = (name: string) => new Proxy({ tableName: name }, {
    get(target, property) {
      if (property === "tableName") return target.tableName;
      return { tableName: name, columnName: String(property) };
    },
  });
  const emptyQuery = () => {
    const query: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
      query[method] = () => query;
    }
    query.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return query;
  };
  return {
    db: {
      select: vi.fn(emptyQuery),
      insert: vi.fn((target: { tableName: string }) => {
        mocks.insertedTables.push(target.tableName);
        return { values: () => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }) };
      }),
      update: vi.fn(emptyQuery),
      delete: vi.fn(emptyQuery),
    },
    usersTable: table("faultline_users"),
    teamsTable: table("teams"),
    teamMembersTable: table("team_members"),
    simulationsTable: table("simulations"),
    executionsTable: table("executions"),
    integrationCredentialsTable: table("integration_credentials"),
  };
});

vi.mock("../engine/drizzleDatabase.js", () => ({
  createDrizzleEngineDatabase: vi.fn(() => ({
    persistExecution: vi.fn(),
    updateSimulationCounters: vi.fn(),
  })),
}));

vi.mock("../lib/workspace.js", () => ({
  canAccessTeam: vi.fn(),
  ensureUser: vi.fn(async (userId: string) => { mocks.ensuredUsers.push(userId); }),
  getAccessibleSimulation: vi.fn(),
  requireUserId: (request: { userId?: string }) => request.userId,
  simulationAccess: vi.fn(() => undefined),
  hashTeamCodeValue: vi.fn(),
}));

import simulationsRouter from "./simulations.js";
import workspaceRouter from "./workspace.js";

const newUserId = "1ca3493e-b2ad-44c8-84f3-f03f6a3ef12a";
const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { userId: newUserId, userEmail: "first-run@example.test" });
  next();
});
app.use(simulationsRouter);
app.use(workspaceRouter);

let server: ReturnType<typeof app.listen>;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("clean first-run API", () => {
  it("returns schema-valid empty data and creates no simulation or execution rows, including concurrent first reads", async () => {
    const [dashboardResponse, simulationsResponse] = await Promise.all([
      fetch(`${baseUrl}/dashboard`),
      fetch(`${baseUrl}/simulations`),
    ]);
    expect(dashboardResponse.status).toBe(200);
    expect(simulationsResponse.status).toBe(200);

    const dashboard = GetDashboardSummaryResponse.parse(await dashboardResponse.json());
    const simulations = ListSimulationsResponse.parse(await simulationsResponse.json());
    expect(dashboard).toMatchObject({
      totalSimulations: 0,
      activeSimulations: 0,
      requestsExecuted: 0,
      failedRequests: 0,
      successfulRequests: 0,
      recentRuns: [],
    });
    expect(simulations).toEqual([]);

    const executionsResponse = await fetch(`${baseUrl}/dashboard/executions?beforeId=1`);
    expect(executionsResponse.status).toBe(200);
    expect(ListExecutionsResponse.parse(await executionsResponse.json())).toEqual([]);

    const workspaceResponse = await fetch(`${baseUrl}/workspace`);
    expect(workspaceResponse.status).toBe(200);
    expect(await workspaceResponse.json()).toMatchObject({
      userId: newUserId,
      email: "first-run@example.test",
      teams: [],
    });

    expect(mocks.ensuredUsers).toContain(newUserId);
    expect(mocks.insertedTables).not.toContain("simulations");
    expect(mocks.insertedTables).not.toContain("executions");
  });
});
