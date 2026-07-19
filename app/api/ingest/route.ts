import { getDb } from "../../../db";
import { rateObservations } from "../../../db/schema";
import { hasIngestToken } from "../collector-auth";

type IncomingRate = { series?: string; observedOn?: string; rate?: number };
export async function POST(request: Request) {
  if (!await hasIngestToken(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  let rates: IncomingRate[] | undefined;
  try { ({ rates } = await request.json() as { rates?: IncomingRate[] }); }
  catch { return Response.json({ error: "Invalid JSON." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  const valid = (rates ?? []).filter((rate) => rate.series && /^\d{4}-\d{2}-\d{2}$/.test(rate.observedOn ?? "") && typeof rate.rate === "number");
  if (!valid.length) return Response.json({ error: "No valid rate observations." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  await getDb().batch(valid.map((rate) => getDb().insert(rateObservations).values({ series: rate.series!, observedOn: rate.observedOn!, rate: rate.rate! }).onConflictDoUpdate({ target: [rateObservations.series, rateObservations.observedOn], set: { rate: rate.rate! } })));
  return Response.json({ stored: valid.length }, { headers: { "Cache-Control": "no-store" } });
}
