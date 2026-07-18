import { asc, ne } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";

export async function GET(request: Request) {
  const expected = (env as unknown as { RATE_INGEST_TOKEN?: string }).RATE_INGEST_TOKEN;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const records = await getDb().select({ email: subscribers.email, zipCode: subscribers.zipCode }).from(subscribers).where(ne(subscribers.zipCode, "")).orderBy(asc(subscribers.id));
    return Response.json({ subscribers: records });
  } catch {
    return Response.json({ error: "Subscriber delivery list is unavailable." }, { status: 503 });
  }
}
