import { env } from "cloudflare:workers";

const encoder = new TextEncoder();

export async function hasCollectorToken(request: Request, binding: "RATE_COLLECTION_READ_TOKEN" | "RATE_COLLECTION_WRITE_TOKEN") {
  const expected = (env as unknown as Partial<Record<"RATE_COLLECTION_READ_TOKEN" | "RATE_COLLECTION_WRITE_TOKEN" | "RATE_INGEST_TOKEN", string>>)[binding];
  const supplied = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!expected || !supplied) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(expectedHash), new Uint8Array(suppliedHash));
}

export async function hasIngestToken(request: Request) {
  const expected = (env as unknown as { RATE_INGEST_TOKEN?: string }).RATE_INGEST_TOKEN;
  const supplied = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!expected || !supplied) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(expectedHash), new Uint8Array(suppliedHash));
}
