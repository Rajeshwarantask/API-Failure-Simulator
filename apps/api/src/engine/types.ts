import type { Simulation } from "@workspace/db";

export type FailureType =
  | "none"
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_500"
  | "http_502"
  | "http_503"
  | "timeout"
  | "latency"
  | "connection_failure"
  | "malformed_json"
  | "empty_response"
  | "duplicate_response";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Conditions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyContains?: string;
};

export type WorkflowStep = {
  failureType: FailureType;
  statusCode?: number;
  attempts?: number;
  latencyMs?: number;
};

export type RunOverrides = {
  failureType?: FailureType;
  statusCode?: number;
  latencyMs?: number;
  responseBody?: string;
  seed?: number;
  workflow?: WorkflowStep[];
};

export type RequestOverrides = {
  method?: HttpMethod;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  requestBody?: string | null;
  pathSuffix?: string;
  source?: "dashboard" | "external";
  tokenAuthenticated?: boolean;
  requestIp?: string | null;
};

export type EngineSimulation = Simulation;

export function isFailureType(value: string): value is FailureType {
  return [
    "none", "http_400", "http_401", "http_403", "http_404", "http_429",
    "http_500", "http_502", "http_503", "timeout", "latency",
    "connection_failure", "malformed_json", "empty_response", "duplicate_response",
  ].includes(value);
}

export function toFailureType(value: string): FailureType {
  return isFailureType(value) ? value : "none";
}

function isHttpMethod(value: string): value is HttpMethod {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
}

export function toHttpMethod(value: string): HttpMethod {
  return isHttpMethod(value) ? value : "GET";
}

export function toProxyHttpMethod(value: string): HttpMethod {
  return isHttpMethod(value) ? value : "POST";
}
