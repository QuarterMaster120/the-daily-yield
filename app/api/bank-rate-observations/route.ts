import { getDb } from "../../../db";
import { bankRateObservations } from "../../../db/schema";
import { hasCollectorToken } from "../collector-auth";

const sources = {
  "Citizens Bank": "https://www.citizensbank.com/assets/CB_resources/json/rates/ODS.json",
  "Fifth Third": "https://openonline.53.com/apps/oc/rates.html?productType=cd",
  PNC: "https://www.pnc.com/en/personal-banking/banking/savings/certificate-of-deposits.html",
} as const;
type IncomingRate = { term?: unknown; months?: unknown; apy?: unknown };
type IncomingObservation = { bank?: unknown; zipCode?: unknown; rates?: unknown };

function easternDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const item = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${item("year")}-${item("month")}-${item("day")}`;
}

function validRates(value: unknown): { term: string; months: number; apy: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return [];
  const result = new Map<number, { term: string; months: number; apy: number }>();
  for (const entry of value as IncomingRate[]) {
    const term = typeof entry.term === "string" ? entry.term.trim().slice(0, 64) : "";
    const months = typeof entry.months === "number" ? entry.months : NaN;
    const apy = typeof entry.apy === "number" ? entry.apy : NaN;
    if (!term || !Number.isInteger(months) || months < 1 || months > 120 || !Number.isFinite(apy) || apy < 0 || apy > 20) return [];
    result.set(months, { term, months, apy });
  }
  return [...result.values()];
}

export async function POST(request: Request) {
  if (!await hasCollectorToken(request, "RATE_COLLECTION_WRITE_TOKEN")) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 100_000) return Response.json({ error: "Payload is too large." }, { status: 413, headers: { "Cache-Control": "no-store" } });
  let observations: IncomingObservation[] | undefined;
  try { ({ observations } = await request.json() as { observations?: IncomingObservation[] }); }
  catch { return Response.json({ error: "Invalid JSON." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > 50) return Response.json({ error: "Send between one and fifty observations." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const observedAt = new Date(); const observedOn = easternDate(observedAt);
  const rows: { bank: keyof typeof sources; zipCode: string; rates: { term: string; months: number; apy: number }[] }[] = [];
  for (const observation of observations) {
    const bank = typeof observation.bank === "string" && observation.bank in sources ? observation.bank as keyof typeof sources : null;
    const zipCode = typeof observation.zipCode === "string" ? observation.zipCode : "";
    const rates = validRates(observation.rates);
    if (!bank || !/^\d{5}$/.test(zipCode) || !rates.length) return Response.json({ error: "One or more observations is invalid." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    rows.push({ bank, zipCode, rates });
  }
  const writes = rows.flatMap(({ bank, zipCode, rates }) => rates.map((rate) => getDb().insert(bankRateObservations).values({ bank, zipCode, termMonths: rate.months, term: rate.term, apy: rate.apy, observedAt: observedAt.toISOString(), observedOn, source: sources[bank], retrieval: "desktop-public-page" }).onConflictDoUpdate({ target: [bankRateObservations.bank, bankRateObservations.zipCode, bankRateObservations.termMonths, bankRateObservations.observedOn], set: { term: rate.term, apy: rate.apy, observedAt: observedAt.toISOString(), source: sources[bank], retrieval: "desktop-public-page" } })));
  await getDb().batch(writes);
  return Response.json({ stored: writes.length, observedOn }, { headers: { "Cache-Control": "no-store" } });
}
