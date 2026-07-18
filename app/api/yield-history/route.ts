const source = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";
const fields = { "1-year": "BC_1YEAR", "10-year": "BC_10YEAR", "30-year": "BC_30YEAR" } as const;

function tag(entry: string, name: string) { return entry.match(new RegExp(`<d:${name}[^>]*>([^<]+)`, "i"))?.[1] ?? ""; }

function weekClose<T extends { date: string }>(points: T[]) {
  const closes = new Map<string, T>();
  for (const point of points) { const date = new Date(`${point.date}T12:00:00Z`); const monday = new Date(date); monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); closes.set(monday.toISOString().slice(0, 10), point); }
  return [...closes.entries()].map(([date, point]) => ({ ...point, date }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const term = searchParams.get("term") as keyof typeof fields | null; const period = searchParams.get("period") === "year" ? "year" : "month";
  if (!term || !(term in fields)) return Response.json({ error: "Choose a supported Treasury term." }, { status: 400 });
  try {
    const current = new Date().getUTCFullYear(); const responses = await Promise.all([current - 1, current].map((year) => fetch(`${source}?data=daily_treasury_yield_curve&field_tdr_date_value=${year}&page=0`, { headers: { Accept: "application/xml" } })));
    if (responses.some((response) => !response.ok)) throw new Error("Treasury request failed");
    const documents = await Promise.all(responses.map((response) => response.text())); const points = documents.flatMap((document) => (document.match(/<entry>[\s\S]*?<\/entry>/gi) ?? []).map((entry) => ({ date: tag(entry, "NEW_DATE").slice(0, 10), rate: Number(tag(entry, fields[term])) })).filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.rate))).sort((a, b) => a.date.localeCompare(b.date));
    const window = period === "month" ? points.slice(-31) : weekClose(points).slice(-53);
    return Response.json({ points: window, source }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Treasury history is temporarily unavailable.", source }, { status: 503 }); }
}
