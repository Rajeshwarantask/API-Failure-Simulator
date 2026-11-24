const internalHeaderName = /^(?:x-faultline-[\w-]*|x-execution-token)$/i;

export function capturedAuthenticationHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const authentication: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if ((normalizedName === "cookie" || normalizedName === "authorization") && value.trim()) {
      authentication[normalizedName] = value.trim();
    }
  }
  return authentication;
}

export function mergeCapturedAuthenticationHeaders(
  customHeaders: Record<string, string> | undefined,
  capturedHeaders: Record<string, string>,
): Record<string, string> {
  const merged = new Headers();
  for (const [name, value] of Object.entries(customHeaders ?? {})) {
    if (!internalHeaderName.test(name)) merged.set(name, value);
  }

  const customAuthorization = merged.has("authorization");
  const capturedCookie = capturedHeaders.cookie;
  const capturedAuthorization = capturedHeaders.authorization;

  if (capturedCookie) merged.set("cookie", capturedCookie);
  if (capturedAuthorization && !customAuthorization) merged.set("authorization", capturedAuthorization);

  return Object.fromEntries(merged.entries());
}
