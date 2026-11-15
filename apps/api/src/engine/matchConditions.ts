import type { Conditions, RequestOverrides } from "./types.js";

export function matchConditions(
  conditions: Conditions | null | undefined,
  request: Pick<RequestOverrides, "method" | "headers" | "queryParams" | "requestBody">,
  targetUrl: string,
): boolean {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  if (conditions.method && conditions.method.toUpperCase() !== request.method) return false;
  if (conditions.path) {
    const configuredPath = conditions.path.trim().replace(/\/$/, "") || "/";
    const requestPath = new URL(targetUrl).pathname.replace(/\/$/, "") || "/";
    if (requestPath !== configuredPath) return false;
  }
  for (const [key, value] of Object.entries(conditions.headers ?? {})) {
    if ((request.headers ?? {})[key.toLowerCase()] !== value && (request.headers ?? {})[key] !== value) return false;
  }
  for (const [key, value] of Object.entries(conditions.queryParams ?? {})) {
    if ((request.queryParams ?? {})[key] !== value) return false;
  }
  if (conditions.bodyContains && !(request.requestBody ?? "").includes(conditions.bodyContains)) return false;
  return true;
}
