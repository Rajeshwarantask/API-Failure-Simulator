import { seededRandom } from "./prng.js";
import type { FailureType } from "./types.js";

export const failureStatuses: Partial<Record<FailureType, number>> = {
  http_400: 400,
  http_401: 401,
  http_403: 403,
  http_404: 404,
  http_429: 429,
  http_500: 500,
  http_502: 502,
  http_503: 503,
};

export type FailureDecision = {
  failureType: FailureType;
  statusCode: number | null;
  injected: boolean;
};

export function decideFailure(
  configuredFailure: FailureType,
  probability: number,
  seed: number,
  statusCodeOverride?: number | null,
): FailureDecision {
  const boundedProbability = Math.max(0, Math.min(100, probability));
  const random = seededRandom(seed);
  const injected = configuredFailure !== "none" && (
    boundedProbability >= 100 ||
    (boundedProbability > 0 && random() * 100 < boundedProbability)
  );
  const failureType = injected ? configuredFailure : "none";
  const statusCode = failureStatuses[failureType] ?? (
    failureType === "none" ? null : statusCodeOverride ?? 503
  );
  return { failureType, statusCode, injected };
}

export function deriveResponseBody(
  failureType: FailureType,
  configuredBody: string | null,
  overrideBody?: string,
): string | null {
  if (overrideBody !== undefined) return overrideBody;
  if (failureType === "empty_response") return "";
  if (failureType === "malformed_json") return '{"error":"unterminated"';
  if (failureType === "none" || failureType === "latency") return null;
  return configuredBody ?? defaultFailureBody(failureType);
}

export function defaultFailureBody(type: FailureType): string {
  const bodies: Partial<Record<FailureType, unknown>> = {
    http_400: { error: "bad_request", message: "Invalid request" },
    http_401: { error: "unauthorized", message: "Authentication required" },
    http_403: { error: "forbidden", message: "Access denied" },
    http_404: { error: "not_found", message: "Resource not found" },
    http_429: { error: "rate_limit_exceeded", message: "Too many requests", retry_after: 60 },
    http_500: { error: "internal_server_error", message: "An unexpected error occurred" },
    http_502: { error: "bad_gateway", message: "Upstream service unavailable" },
    http_503: { error: "service_unavailable", message: "Service temporarily unavailable" },
  };
  return JSON.stringify(bodies[type] ?? { error: type, status: failureStatuses[type] ?? 500 });
}
