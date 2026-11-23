import { afterEach, describe, expect, it } from "vitest";
import { capturedProxyPath, capturedUpstreamQuery, decryptRequestContext, encryptRequestContext, requestContextExpiry } from "./recovery-context.js";

const originalSecret = process.env.SUPABASE_JWT_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = originalSecret;
});

describe("encrypted captured request contexts", () => {
  it("round-trips authenticated request data without persisting the cookie in plaintext", () => {
    process.env.SUPABASE_JWT_SECRET = "test-only-encryption-key";
    const context = {
      method: "GET" as const,
      targetUrl: "https://tasks.example.test/",
      pathSuffix: "/api/task/send/alltask",
      queryParams: { page: "3" },
      headers: { cookie: "session=do-not-store-in-plaintext" },
      requestBody: null,
      source: "external" as const,
    };

    const encrypted = encryptRequestContext(642, context);

    expect(encrypted).not.toContain("session=do-not-store-in-plaintext");
    expect(decryptRequestContext(642, encrypted)).toEqual(context);
    expect(() => decryptRequestContext(643, encrypted)).toThrow();
  });

  it("expires captured contexts after the short replay window", () => {
    expect(requestContextExpiry(1000).getTime()).toBe(901000);
  });

  it("recovers the upstream API path from proxy-routing metadata without forwarding that metadata", () => {
    const routingPath = "proxy/simulations/20/api/task/send/alltask";
    expect(capturedProxyPath(undefined, routingPath, 20)).toBe("/api/task/send/alltask");
    expect(capturedProxyPath("/api/task/send/alltask", routingPath, 20)).toBe("/api/task/send/alltask");
    expect(capturedUpstreamQuery({ path: routingPath, page: "3" }, 20)).toEqual({ page: "3" });
  });

  it("keeps legitimate query parameters named path", () => {
    expect(capturedUpstreamQuery({ path: "/task/search", page: "3" }, 20)).toEqual({ path: "/task/search", page: "3" });
    expect(capturedProxyPath(undefined, "/task/search", 20)).toBeUndefined();
  });
});
