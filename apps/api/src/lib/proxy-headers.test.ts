import { describe, expect, it } from "vitest";
import { proxyHeaders } from "./proxy-headers.js";
import { redactExecutionData } from "./target-url.js";

describe("proxy header policy", () => {
  it("combines configured headers only with the incoming allowlist", () => {
    const headers = proxyHeaders(
      {
        Authorization: "Bearer configured-secret",
        Cookie: "configured=session",
        "x-faultline-internal": "configured-internal",
        "x-service-key": "configured-key",
      },
      {
        authorization: "Bearer caller-secret",
        cookie: "caller=session",
        "x-faultline-token": "ft_live_caller-token",
        "x-execution-token": "caller-token-alias",
        host: "127.0.0.1",
        "content-type": "application/json",
        accept: "application/problem+json",
        "user-agent": "test-agent",
        "x-request-id": "request-123",
      },
    );

    expect(headers).toEqual({
      accept: "application/problem+json",
      authorization: "Bearer configured-secret",
      cookie: "configured=session",
      "content-type": "application/json",
      "user-agent": "test-agent",
      "x-faultline-internal": "configured-internal",
      "x-request-id": "request-123",
      "x-service-key": "configured-key",
    });
    expect(Object.values(headers)).not.toContain("Bearer caller-secret");
    expect(Object.values(headers)).not.toContain("caller=session");
  });

  it("redacts sensitive header values in persisted execution data and config snapshots", () => {
    const persisted = redactExecutionData({
      requestHeaders: {
        Authorization: "Bearer request-secret",
        Cookie: "session=request-secret",
        "X-FaultLine-Token": "ft_live_internal-secret",
        accept: "application/json",
      },
      responseHeaders: {
        "Set-Cookie": "session=response-secret",
        "x-faultline-debug": "internal-secret",
        "content-type": "application/json",
      },
      configSnapshot: {
        simulation: {
          headers: {
            authorization: "Bearer config-secret",
            "x-faultline-key": "internal-secret",
          },
        },
        request: { headers: { Cookie: "request=session-secret" } },
      },
    });

    expect(persisted).toEqual({
      requestHeaders: {
        Authorization: "[REDACTED]",
        Cookie: "[REDACTED]",
        "X-FaultLine-Token": "[REDACTED]",
        accept: "application/json",
      },
      responseHeaders: {
        "Set-Cookie": "[REDACTED]",
        "x-faultline-debug": "[REDACTED]",
        "content-type": "application/json",
      },
      configSnapshot: {
        simulation: {
          headers: {
            authorization: "[REDACTED]",
            "x-faultline-key": "[REDACTED]",
          },
        },
        request: { headers: { Cookie: "[REDACTED]" } },
      },
    });
  });
});
