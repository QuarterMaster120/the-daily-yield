import { asc, eq, ne } from "drizzle-orm";
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

export async function POST(request: Request) {
  if (!await hasIngestToken(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const records = await getDb().select({ email: subscribers.email, bankSelections: subscribers.bankSelections }).from(subscribers).where(ne(subscribers.zipCode, ""));
    let updated = 0;
    for (const record of records) {
      let selections: string[];
      try {
        const parsed = JSON.parse(record.bankSelections);
        selections = Array.isArray(parsed) ? parsed.filter((bank): bank is string => typeof bank === "string") : [];
      } catch { selections = []; }
      const next = [...new Set([...selections.filter((bank) => bank !== "Bank of America"), "First American Bank"])];
      if (JSON.stringify(next) === JSON.stringify(selections)) continue;
      await getDb().update(subscribers).set({ bankSelections: JSON.stringify(next) }).where(eq(subscribers.email, record.email));
      updated += 1;
    }
    return Response.json({ ok: true, updated }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Subscriber preferences could not be updated." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
