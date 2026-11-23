import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { RequestOverrides } from "../engine/types.js";

const CONTEXT_VERSION = "v1";
const CONTEXT_TTL_MS = 15 * 60 * 1000;

type CapturedRequestContext = RequestOverrides & { targetUrl: string };

function encryptionKey(): Buffer {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("recovery_context_encryption_unavailable");
  return createHmac("sha256", secret).update("faultline:recovery-request-context:v1").digest();
}

export function encryptRequestContext(executionId: number, context: CapturedRequestContext): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`execution:${executionId}:${CONTEXT_VERSION}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(context), "utf8"), cipher.final()]);
  return [CONTEXT_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptRequestContext(executionId: number, value: string): CapturedRequestContext {
  const [version, encodedIv, encodedTag, encodedPayload] = value.split(".");
  if (version !== CONTEXT_VERSION || !encodedIv || !encodedTag || !encodedPayload) {
    throw new Error("recovery_context_invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAAD(Buffer.from(`execution:${executionId}:${CONTEXT_VERSION}`));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encodedPayload, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as CapturedRequestContext;
}

export function requestContextExpiry(now = Date.now()): Date {
  return new Date(now + CONTEXT_TTL_MS);
}
