import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createConnectionLookup,
  createSafeFetch,
  isBlockedAddress,
  privateTargetsAllowed,
  readCappedBody,
  validateTargetUrl,
} from "./target-url.js";

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];

const blockedTargets = [
  "http://127.0.0.1",
  "http://127.1",
  "http://2130706433",
  "http://0x7f000001",
  "http://0177.0.0.1",
  "http://017700000001",
  "http://0x7f.1",
  "http://10.0.0.1",
  "http://172.16.0.1",
  "http://172.31.255.255",
  "http://192.168.1.1",
  "http://169.254.169.254",
  "http://100.64.0.1",
  "http://localhost",
  "http://api.localhost",
  "http://[::1]",
  "http://[fc00::1]",
  "http://[fdff::1]",
  "http://[fe80::1]",
  "http://[::ffff:127.0.0.1]",
  "http://[::ffff:7f00:1]",
  "http://[::ffff:10.0.0.1]",
  "http://[::ffff:169.254.169.254]",
  "http://0.0.0.0",
  "http://[::]",
  "http://224.0.0.1",
  "http://240.0.0.1",
];

describe("target URL policy", () => {
  it.each(blockedTargets)(
    "blocks private or non-routable target %s",
    async (target) => {
      await expect(
        validateTargetUrl(target, false),
      ).rejects.toThrow("target_url_private_address_not_allowed");
    },
  );

  it("blocks hostnames that resolve to private addresses", async () => {
    const fakeResolver = async () => [
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(validateTargetUrl("https://metadata.test/", false)).resolves.toBeInstanceOf(URL);
    await expect(
      createSafeFetch({ resolver: fakeResolver, allowPrivate: false })("https://metadata.test/"),
    ).rejects.toThrow("target_url_private_address_not_allowed");
  });

  it("allows unresolved seeded hostnames without DNS and rejects bad schemes", async () => {
    await expect(validateTargetUrl("https://profile-service.example.test/v1/me", false)).resolves.toBeInstanceOf(URL);
    await expect(
      validateTargetUrl("https://public.test/resource", false),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      validateTargetUrl("http://public.test/resource", false),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      validateTargetUrl("ftp://public.test/resource", false),
    ).rejects.toThrow("target_url_protocol_not_allowed");
  });

  it("re-validates redirects before requesting the next target", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      });
    };
    const safeFetch = createSafeFetch({
      fetch: fakeFetch,
      resolver: publicResolver,
      allowPrivate: false,
    });

    await expect(safeFetch("https://public.test/start")).rejects.toThrow(
      "target_url_private_address_not_allowed",
    );
    expect(calls).toBe(1);
  });

  it("does not forward configured credentials across redirect origins", async () => {
    const receivedHeaders: Headers[] = [];
    let calls = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      receivedHeaders.push(new Headers(init?.headers));
      calls += 1;
      return calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://other.test/next" },
          })
        : new Response("done");
    };
    const safeFetch = createSafeFetch({
      fetch: fakeFetch,
      resolver: publicResolver,
      allowPrivate: false,
    });
    await safeFetch("https://public.test/start", {
      headers: {
        authorization: "Bearer configured-secret",
        cookie: "session=configured",
      },
    });

    expect(receivedHeaders[0].get("authorization")).toBe(
      "Bearer configured-secret",
    );
    expect(receivedHeaders[1].get("authorization")).toBeNull();
    expect(receivedHeaders[1].get("cookie")).toBeNull();
  });

  it("reads only the configured body limit and marks extra bytes as truncated", async () => {
    const response = new Response(new TextEncoder().encode("123456"));
    const result = await readCappedBody(response, 4);
    expect(result).toEqual({ body: "1234", truncated: true });
  });

  it("blocks private DNS answers at the CONNECT lookup even after a public pre-check", async () => {
    const lookup = createConnectionLookup(
      async () => [{ address: "10.0.0.8", family: 4 }],
      false,
    );
    const result = await new Promise<{
      error: NodeJS.ErrnoException | null;
      address?: string;
    }>((resolve) => {
      lookup("rebinding.test", {}, (error, address) =>
        resolve({
          error,
          address: typeof address === "string" ? address : undefined,
        }),
      );
    });
    expect(result.error?.code).toBe("EACCES");
    expect(result.address).toBe("");
  });

  it("does not enable private targets outside local development", () => {
    expect(
      privateTargetsAllowed({
        NODE_ENV: "test",
        ALLOW_PRIVATE_TARGETS: "true",
      }),
    ).toBe(false);
    expect(privateTargetsAllowed({ NODE_ENV: "development" })).toBe(false);
  });

  it("blocks a DNS rebinding answer at connection time without reaching loopback", async () => {
    let connections = 0;
    let resolutions = 0;
    const resolver = async () => {
      resolutions += 1;
      return [
        { address: resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
      ];
    };
    const server = createServer(() => {
      connections += 1;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP listener");

    try {
      const safeFetch = createSafeFetch({ resolver, allowPrivate: false });
      await expect(
        safeFetch(`http://rebind.test:${address.port}/secret`),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolutions).toBeGreaterThanOrEqual(2);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not connect to a loopback listener for an SSRF target", async () => {
    let connections = 0;
    const server = createServer(() => {
      connections += 1;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP listener");

    try {
      const safeFetch = createSafeFetch({ allowPrivate: false });
      await expect(
        safeFetch(`http://127.0.0.1:${address.port}/secret`),
      ).rejects.toThrow("target_url_private_address_not_allowed");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("recognizes blocked IP literals after WHATWG URL normalization", () => {
    for (const address of [
      "127.0.0.1",
      "[::ffff:7f00:1]",
      "[fc00::1]",
      "[fe80::1]",
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });
});
