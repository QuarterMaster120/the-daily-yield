import { asc, ne } from "drizzle-orm";
import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";
import { hasCollectorToken } from "../collector-auth";

// Desktop collectors are deliberately opt-in by source. This prevents a local
// browser from retrieving a bank that has a working, server-side official feed.
const desktopBanks = new Set(["Citizens Bank", "Fifth Third", "First American Bank", "PNC"]);

export async function GET(request: Request) {
  if (!await hasCollectorToken(request, "RATE_COLLECTION_READ_TOKEN")) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const records = await getDb().select({ zipCode: subscribers.zipCode, bankSelections: subscribers.bankSelections }).from(subscribers).where(ne(subscribers.zipCode, "")).orderBy(asc(subscribers.id));
    const requests = new Map<string, { bank: string; zipCode: string }>();
    for (const record of records) {
      if (!/^\d{5}$/.test(record.zipCode)) continue;
      let selected: unknown;
      try { selected = JSON.parse(record.bankSelections); } catch { continue; }
      if (!Array.isArray(selected)) continue;
      for (const bank of selected) if (typeof bank === "string" && desktopBanks.has(bank)) requests.set(`${bank}:${record.zipCode}`, { bank, zipCode: record.zipCode });
    }
    return Response.json({ requests: [...requests.values()] }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Collection plan is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
