import { asc, eq, ne } from "drizzle-orm";
import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";
import { hasCollectorToken, hasIngestToken } from "../collector-auth";

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
  const canWriteSelections = await hasCollectorToken(request, "RATE_COLLECTION_WRITE_TOKEN");
  if (!canWriteSelections && !await hasIngestToken(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const action = await request.json().catch(() => null) as { email?: unknown; removeBank?: unknown; addFirstAmericanToMissingSubscriber?: unknown } | null;
    if (action?.addFirstAmericanToMissingSubscriber === true) {
      if (!canWriteSelections) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      const records = await getDb().select({ email: subscribers.email, bankSelections: subscribers.bankSelections }).from(subscribers).where(ne(subscribers.zipCode, ""));
      const missing = records.flatMap((record) => {
        try {
          const selections = JSON.parse(record.bankSelections);
          return Array.isArray(selections) && !selections.includes("First American Bank") ? [{ ...record, selections: selections.filter((bank): bank is string => typeof bank === "string") }] : [];
        } catch { return [{ ...record, selections: [] as string[] }]; }
      });
      if (missing.length !== 1) return Response.json({ error: "Expected exactly one subscription without First American Bank.", updated: 0 }, { status: 409, headers: { "Cache-Control": "no-store" } });
      const target = missing[0];
      await getDb().update(subscribers).set({ bankSelections: JSON.stringify([...new Set([...target.selections, "First American Bank"])]) }).where(eq(subscribers.email, target.email));
      return Response.json({ ok: true, updated: 1 }, { headers: { "Cache-Control": "no-store" } });
    }
    if (typeof action?.email === "string" && typeof action.removeBank === "string") {
      const email = action.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || action.removeBank !== "First American Bank") return Response.json({ error: "Invalid subscriber update." }, { status: 400, headers: { "Cache-Control": "no-store" } });
      const record = await getDb().select({ bankSelections: subscribers.bankSelections }).from(subscribers).where(eq(subscribers.email, email)).get();
      if (!record) return Response.json({ ok: true, updated: 0 }, { headers: { "Cache-Control": "no-store" } });
      let selections: string[];
      try { const parsed = JSON.parse(record.bankSelections); selections = Array.isArray(parsed) ? parsed.filter((bank): bank is string => typeof bank === "string") : []; }
      catch { selections = []; }
      const next = selections.filter((bank) => bank !== action.removeBank);
      if (next.length === selections.length) return Response.json({ ok: true, updated: 0 }, { headers: { "Cache-Control": "no-store" } });
      await getDb().update(subscribers).set({ bankSelections: JSON.stringify(next) }).where(eq(subscribers.email, email));
      return Response.json({ ok: true, updated: 1 }, { headers: { "Cache-Control": "no-store" } });
    }
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
