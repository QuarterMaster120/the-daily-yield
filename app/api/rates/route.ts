import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { rateObservations } from "../../../db/schema";

function lastCloseOfWeek<T extends { observedOn: string }>(rows: T[]) { const weeks = new Map<string, T>(); for (const row of rows) { const date = new Date(`${row.observedOn}T12:00:00Z`); const monday = new Date(date); monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); weeks.set(monday.toISOString().slice(0, 10), row); } return [...weeks.entries()].map(([date, row]) => ({ ...row, observedOn: date })); }

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const series = searchParams.get("series") ?? "Treasury 1 Year"; const period = searchParams.get("period") === "year" ? "year" : "month";
  try { const rows = await getDb().select().from(rateObservations).where(eq(rateObservations.series, series)).orderBy(asc(rateObservations.observedOn)); const window = period === "month" ? rows.slice(-31) : lastCloseOfWeek(rows).slice(-53); return Response.json({ points: window.map((row) => ({ date: row.observedOn, rate: row.rate })) }); }
  catch { return Response.json({ points: [] }); }
}
