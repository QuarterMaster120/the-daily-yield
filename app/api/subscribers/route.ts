import { asc, ne } from "drizzle-orm";
import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";
import { hasIngestToken } from "../collector-auth";

export async function GET(request: Request) {
  if (!await hasIngestToken(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const records = await getDb().select({ email: subscribers.email, zipCode: subscribers.zipCode, bankSelections: subscribers.bankSelections, treasurySelections: subscribers.treasurySelections }).from(subscribers).where(ne(subscribers.zipCode, "")).orderBy(asc(subscribers.id));
    return Response.json({ subscribers: records }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Subscriber delivery list is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
