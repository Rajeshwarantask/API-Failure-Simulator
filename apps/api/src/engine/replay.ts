import type { Execution, Simulation } from "@workspace/db";
import type { createSimulationExecutor } from "./execute.js";
import { toFailureType, toHttpMethod, type RequestOverrides, type RunOverrides } from "./types.js";

export type SimulationExecutor = ReturnType<typeof createSimulationExecutor>;

export function reproduceExecution(
  execution: Execution,
  currentSimulation: Simulation,
  overrides: RunOverrides,
  execute: SimulationExecutor,
) {
  if (execution.seed === null || execution.configSnapshot === null) {
    throw new Error("This execution predates deterministic replay. Select reexecute mode instead.");
  }

  const snapshot = execution.configSnapshot;
  const simulation: Simulation = { ...currentSimulation, ...snapshot.simulation };
  const savedWorkflow = snapshot.overrides.workflow?.map(({ failureType, ...step }) => ({
    ...step,
    failureType: toFailureType(failureType),
  }));
  const savedOverrides: RunOverrides = {
    ...snapshot.overrides,
    failureType: snapshot.overrides.failureType ? toFailureType(snapshot.overrides.failureType) : undefined,
    workflow: savedWorkflow,
  };
  const request: RequestOverrides = {
    ...snapshot.request,
    method: snapshot.request.method ? toHttpMethod(snapshot.request.method) : undefined,
  };

  return execute(
    simulation,
    { ...savedOverrides, ...overrides, seed: execution.seed },
    request,
    { allowUpstream: false },
  );
}
