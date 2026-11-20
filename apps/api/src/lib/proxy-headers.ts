const allowedIncomingHeaders = [
  "accept",
  "content-type",
  "cookie",
  "user-agent",
  "x-request-id",
] as const;

export function proxyHeaders(
  configured: Record<string, string> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, string> {
  const outgoing = new Headers(configured ?? {});
  const received = new Headers();

  for (const [key, value] of Object.entries(incoming)) {
    if (
      allowedIncomingHeaders.includes(
        key.toLowerCase() as (typeof allowedIncomingHeaders)[number],
      ) &&
      (typeof value === "string" || (key.toLowerCase() === "cookie" && Array.isArray(value)))
    ) {
      received.set(key, Array.isArray(value) ? value.join("; ") : value);
    }
  }

  for (const name of allowedIncomingHeaders) {
    const value = received.get(name);
    if (value !== null) outgoing.set(name, value);
  }

  return Object.fromEntries(outgoing.entries());
}
