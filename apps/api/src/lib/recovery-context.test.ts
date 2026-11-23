import { afterEach, describe, expect, it } from "vitest";
import { decryptRequestContext, encryptRequestContext, requestContextExpiry } from "./recovery-context.js";

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
});
