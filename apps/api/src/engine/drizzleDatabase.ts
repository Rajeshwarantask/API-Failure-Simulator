import { eq } from "drizzle-orm";
import { executionsTable, simulationsTable } from "@workspace/db/schema";
import type { db } from "@workspace/db";
import type { EngineDatabase } from "./execute.js";

export function createDrizzleEngineDatabase(database: typeof db): EngineDatabase {
  return {
    async persistExecution(values) {
      const [execution] = await database.insert(executionsTable).values(values).returning();
      return execution;
    },
    async updateSimulationCounters(simulationId, values) {
      await database.update(simulationsTable).set(values).where(eq(simulationsTable.id, simulationId));
    },
  };
}
