const url = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";

function tag(entry: string, name: string) { return entry.match(new RegExp(`<d:${name}[^>]*>([^<]+)`, "i"))?.[1] ?? ""; }

export async function GET() {
  try {
    const response = await fetch(`${url}?data=daily_treasury_yield_curve&field_tdr_date_value=${new Date().getUTCFullYear()}&page=0`, { headers: { Accept: "application/xml" } });
    if (!response.ok) throw new Error("Treasury request failed");
    const entries = (await response.text()).match(/<entry>[\s\S]*?<\/entry>/gi) ?? [];
    const latest = entries.map((entry) => ({ date: tag(entry, "NEW_DATE"), oneYear: Number(tag(entry, "BC_1YEAR")), tenYear: Number(tag(entry, "BC_10YEAR")), thirtyYear: Number(tag(entry, "BC_30YEAR")) })).filter((row) => row.date && Number.isFinite(row.oneYear) && Number.isFinite(row.tenYear) && Number.isFinite(row.thirtyYear)).at(-1);
    if (!latest) throw new Error("Treasury returned no usable values");
    return Response.json(latest, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Treasury data is temporarily unavailable." }, { status: 503 }); }
}
