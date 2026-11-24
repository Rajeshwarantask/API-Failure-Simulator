import { describe, expect, it } from "vitest";
import { capturedAuthenticationHeaders, mergeCapturedAuthenticationHeaders } from "./captured-auth.js";

describe("captured authentication header handling", () => {
  it("extracts only captured cookies and authorization headers", () => {
    expect(capturedAuthenticationHeaders({
      Cookie: "accessToken=fixture-access; refreshToken=fixture-refresh",
      Authorization: "Bearer fixture-token",
      accept: "text/plain",
      "x-faultline-token": "fixture-internal-token",
    })).toEqual({ cookie: "accessToken=fixture-access; refreshToken=fixture-refresh", authorization: "Bearer fixture-token" });
  });

  it("preserves custom headers and complete captured cookies without duplicate cookie fields", () => {
    const merged = mergeCapturedAuthenticationHeaders(
      { Accept: "application/json", "X-Request-Mode": "custom", Cookie: "old=session", Authorization: "Bearer custom" },
      { cookie: "accessToken=fixture-access; refreshToken=fixture-refresh", authorization: "Bearer captured" },
    );

    expect(merged.accept).toBe("application/json");
    expect(merged["x-request-mode"]).toBe("custom");
    expect(merged.cookie).toBe("accessToken=fixture-access; refreshToken=fixture-refresh");
    expect(merged.authorization).toBe("Bearer custom");
    expect(Object.keys(merged).filter((name) => name.toLowerCase() === "cookie")).toHaveLength(1);
  });

  it("attaches captured authorization when custom authorization is absent and strips internal routing headers", () => {
    const merged = mergeCapturedAuthenticationHeaders(
      { accept: "*/*", "x-faultline-token": "fixture-internal", "x-execution-token": "fixture-internal" },
      { authorization: "Bearer fixture-token" },
    );

    expect(merged.authorization).toBe("Bearer fixture-token");
    expect(merged.accept).toBe("*/*");
    expect(merged).not.toHaveProperty("x-faultline-token");
    expect(merged).not.toHaveProperty("x-execution-token");
  });
});
