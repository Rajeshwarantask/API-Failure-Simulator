import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type TcpNetConnectOpts } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export const MAX_REDIRECTS = 3;
export const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024;
export const MAX_STORED_BODY_BYTES = 1024 * 1024;

const internalQueryKeys = new Set(["__faultline_path", "__faultline_simulation"]);

function isInternalRoutingQuery(key: string, value: string): boolean {
  return internalQueryKeys.has(key.toLowerCase()) || (
    key.toLowerCase() === "path" && /^\/?(?:api\/)?proxy\/simulations\/\d+(?:\/|$)/.test(value)
  );
}

export function buildUpstreamUrl(
  baseTargetUrl: string,
  requestPath: string | undefined,
  query: Record<string, string> = {},
): string {
  const url = new URL(baseTargetUrl);
  const path = requestPath?.trim();
  if (path && /^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
    throw new Error("request_path_must_be_relative");
  }
  if (path?.includes("?")) throw new Error("request_path_must_not_include_query");
  if (!path) throw new Error("request_path_required");
  url.pathname = `/${path.replace(/^\/+/, "").split("/").filter(Boolean).join("/")}`;
  const configuredQuery = [...url.searchParams.entries()];
  url.search = "";
  for (const [key, value] of configuredQuery) {
    if (!isInternalRoutingQuery(key, value)) url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(query)) {
    if (!isInternalRoutingQuery(key, value)) url.searchParams.set(key, value);
  }
  return url.toString();
}

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

const resolveAllAddresses: AddressResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export function privateTargetsAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "development" && env.ALLOW_PRIVATE_TARGETS === "true";
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part)))
    return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function ipv4InRange(
  address: number[],
  first: number[],
  prefix: number,
): boolean {
  const toInteger = (parts: number[]) =>
    parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
  const shift = BigInt(32 - prefix);
  return toInteger(address) >> shift === toInteger(first) >> shift;
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const ranges: Array<[number[], number]> = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24],
    [[192, 0, 2, 0], 24],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24],
    [[224, 0, 0, 0], 4],
    [[240, 0, 0, 0], 4],
  ];
  return ranges.some(([first, prefix]) => ipv4InRange(octets, first, prefix));
}

function ipv6ToBigInt(address: string): bigint | null {
  let input = address.toLowerCase().split("%")[0];
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = parseIpv4(input.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    input = `${input.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return null;
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function isBlockedIpv6(address: string): boolean {
  const parsed = ipv6ToBigInt(address);
  if (parsed === null) return true;
  if (parsed === 0n || parsed === 1n) return true;

  const mappedPrefix = parsed >> 32n;
  if (mappedPrefix === 0xffffn) {
    const ipv4 = [24n, 16n, 8n, 0n].map((shift) =>
      Number((parsed >> shift) & 255n),
    );
    return isBlockedIpv4(ipv4.join("."));
  }

  if (parsed >> 121n === 0x7en) return true;
  if (parsed >> 118n === 0x3fan) return true;
  if (parsed >> 32n === 0n) return true;
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  return false;
}

function targetError(reason: string): Error {
  return new Error(`target_url_${reason}`);
}

function parseTargetUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw targetError("invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw targetError("protocol_not_allowed");
  }
  if (url.username || url.password)
    throw targetError("credentials_not_allowed");
  return url;
}

export async function validateTargetUrl(
  input: string,
  allowPrivate = privateTargetsAllowed(),
): Promise<URL> {
  const url = parseTargetUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowPrivate) return url;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain"
  ) {
    throw targetError("private_address_not_allowed");
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw targetError("private_address_not_allowed");
  }
  if (!/^[a-z0-9.-]+$/i.test(hostname)) throw targetError("invalid_hostname");
  return url;
}

async function validateResolvedTargetUrl(
  input: string,
  resolver: AddressResolver,
  allowPrivate: boolean,
): Promise<URL> {
  const url = await validateTargetUrl(input, allowPrivate);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowPrivate || isIP(hostname)) return url;

  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw targetError("dns_resolution_failed");
  }
  if (addresses.length === 0) throw targetError("dns_resolution_failed");
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw targetError("private_address_not_allowed");
  }
  return url;
}

export function createConnectionLookup(
  resolver: AddressResolver = resolveAllAddresses,
  allowPrivate = privateTargetsAllowed(),
): NonNullable<TcpNetConnectOpts["lookup"]> {
  const safeLookup: NonNullable<TcpNetConnectOpts["lookup"]> = (
    hostname,
    options,
    callback,
  ) => {
    void resolver(hostname)
      .then((addresses) => {
        if (addresses.length === 0) throw targetError("dns_resolution_failed");
        if (
          !allowPrivate &&
          addresses.some(({ address }) => isBlockedAddress(address))
        ) {
          throw targetError("private_address_not_allowed");
        }
        const family = typeof options === "number" ? options : options.family;
        const candidates = family
          ? addresses.filter((item) => item.family === family)
          : addresses;
        if (candidates.length === 0) throw targetError("dns_resolution_failed");
        if (typeof options !== "number" && options.all) {
          callback(null, candidates);
        } else {
          callback(null, candidates[0].address, candidates[0].family);
        }
      })
      .catch((error: Error) => {
        callback(Object.assign(error, { code: "EACCES" }), "", 0);
      });
  };
  return safeLookup;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

type SafeFetchOptions = {
  fetch?: typeof globalThis.fetch;
  resolver?: AddressResolver;
  allowPrivate?: boolean;
};

export function createSafeFetch(
  options: SafeFetchOptions = {},
): typeof globalThis.fetch {
  const resolver = options.resolver ?? resolveAllAddresses;
  const allowPrivate = options.allowPrivate ?? privateTargetsAllowed();
  const dispatcher = new Agent({
    maxOrigins: 100,
    connect: { lookup: createConnectionLookup(resolver, allowPrivate) },
  });
  const fetcher =
    options.fetch ?? (undiciFetch as unknown as typeof globalThis.fetch);

  return async (input, init = {}) => {
    let url = parseTargetUrl(
      input instanceof Request ? input.url : String(input),
    );
    let method =
      init.method ?? (input instanceof Request ? input.method : "GET");
    let body = init.body ?? (input instanceof Request ? input.body : undefined);
    let headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    for (let redirects = 0; ; redirects += 1) {
      await validateResolvedTargetUrl(url.toString(), resolver, allowPrivate);
      const response = await fetcher(url, {
        ...init,
        method,
        headers,
        body,
        redirect: "manual",
        dispatcher,
      } as RequestInit);
      const location = response.headers.get("location");
      if (!redirectStatuses.has(response.status) || !location) return response;
      if (redirects >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new Error("upstream_redirect_limit_exceeded");
      }

      const nextUrl = new URL(location, url);
      await validateResolvedTargetUrl(nextUrl.toString(), resolver, allowPrivate);
      await response.body?.cancel();
      if (nextUrl.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
        headers.delete("content-encoding");
      }
      url = nextUrl;
    }
  };
}

export async function readCappedBody(
  response: Response,
  byteLimit = MAX_UPSTREAM_BODY_BYTES,
): Promise<{ body: string | null; truncated: boolean }> {
  if (!response.body) return { body: null, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = byteLimit - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        totalBytes += Math.max(0, remaining);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    body: new TextDecoder().decode(bytes, { stream: truncated }),
    truncated,
  };
}

export function capStoredBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength <= MAX_STORED_BODY_BYTES) return body;
  return new TextDecoder().decode(bytes.slice(0, MAX_STORED_BODY_BYTES), {
    stream: true,
  });
}

const sensitiveHeaderName = /^(authorization|cookie|set-cookie)$/i;
const internalHeaderName = /^x-faultline-/i;

export function redactExecutionData<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((item) => redactExecutionData(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveHeaderName.test(key) || internalHeaderName.test(key)
        ? "[REDACTED]"
        : redactExecutionData(item),
    ]),
  ) as T;
}
