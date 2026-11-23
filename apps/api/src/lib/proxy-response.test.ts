import { describe, expect, it, vi } from "vitest";
import { sendUpstreamTimeout } from "./proxy-response.js";

describe("upstream timeout responses", () => {
  it("returns 504 without removing CORS headers already set for the allowed origin", () => {
    const headers: Record<string, string> = {
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-credentials": "true",
    };
    const res = {
      status: vi.fn(),
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      json: vi.fn(),
    };

    sendUpstreamTimeout(res as never);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({ error: "upstream_timeout" });
    expect(headers).toMatchObject({
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-credentials": "true",
      "x-simulator-rule": "none",
    });
  });
});
