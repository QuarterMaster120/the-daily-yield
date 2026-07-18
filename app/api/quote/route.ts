type Quote = { term: string; months: number; apy: number };

const banks = {
  "Ally Bank": { url: "https://www.ally.com/bank/cd-rates/", local: false },
  "American Express": { url: "https://www.americanexpress.com/en-us/banking/online-savings/cd-account/", local: false },
  "Bank of America": { url: "https://www.bankofamerica.com/deposits/bank-cds/cd-accounts/", local: true },
  "Capital One": { url: "https://www.capitalone.com/bank/cds/online-cds/", local: false },
  Chase: { url: "https://www.chase.com/personal/savings/bank-cd", local: true },
  "Fifth Third": { url: "https://www.53.com/content/fifth-third/en/personal-banking/bank/savings/cds.html", local: true },
  "Marcus by Goldman Sachs": { url: "https://www.marcus.com/us/en/savings/high-yield-cds", local: false },
  Regions: { url: "https://www.regions.com/personal-banking/savings-and-cds/cds", local: true },
  "Synchrony Bank": { url: "https://www.synchronybank.com/banking/cd-rates/", local: false },
} as const;

function term(label: string) {
  const match = label.toLowerCase().replace("-", " ").match(/(\d{1,2}(?:\.5)?)\s*(month|mo|year|yr)/);
  if (!match) return null;
  const number = Number(match[1]); const months = /year|yr/.test(match[2]) ? Math.round(number * 12) : Math.round(number);
  return months >= 1 && months <= 120 ? { months, term: `${number} ${months === 1 ? (/year|yr/.test(match[2]) ? "Year" : "Month") : (/year|yr/.test(match[2]) ? "Years" : "Months")}` } : null;
}

function parseRates(html: string): Quote[] {
  const text = html.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#x3D;/gi, " ").replace(/\s+/g, " ");
  const patterns = [
    /(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?).{0,160}?(\d(?:\.\d{1,3})?\s*%\s*(?:annual percentage yield\s*\(?apy\)?|apy))/gi,
    /(\d(?:\.\d{1,3})?\s*%\s*(?:annual percentage yield\s*\(?apy\)?|apy)).{0,160}?(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?)/gi,
  ];
  const result = new Map<string, Quote>();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    if (!/\b(cd|certificate)\b/i.test(match[0])) continue;
    const parsed = term(patterns.indexOf(pattern) === 0 ? match[1] : match[2]);
    const apyText = patterns.indexOf(pattern) === 0 ? match[2] : match[1]; const rate = Number(apyText.match(/\d(?:\.\d{1,3})?/)?.[0]);
    if (parsed && Number.isFinite(rate)) result.set(`${parsed.months}-${rate}`, { ...parsed, apy: rate });
  }
  return [...result.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

async function synchronyRates(): Promise<Quote[]> {
  const response = await fetch("https://api.syf.com/v1/retailBank/products?serviceLevel=0000000", { headers: { Accept: "application/json", Referer: banks["Synchrony Bank"].url } });
  if (!response.ok) return [];
  const data = await response.json() as { productTypes?: { products?: { displayCode?: string; terms?: (number | string)[] }[]; terms?: { id?: number | string; term?: number; termUnits?: string; rateMatrices?: { apy?: string }[] }[] } };
  const productTypes = data.productTypes; const cd = productTypes?.products?.find((product) => product.displayCode === "CD");
  const ids = new Set((cd?.terms ?? []).map(String));
  return (productTypes?.terms ?? []).flatMap((item) => {
    if (!ids.has(String(item.id)) || !item.term || !item.termUnits) return [];
    const parsed = term(`${item.term} ${item.termUnits}`); const apy = Number(item.rateMatrices?.[0]?.apy?.match(/\d+(?:\.\d+)?/)?.[0]);
    return parsed && Number.isFinite(apy) ? [{ ...parsed, apy }] : [];
  }).sort((a, b) => a.months - b.months).slice(0, 12);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const bank = searchParams.get("bank") ?? ""; const zipCode = searchParams.get("zipCode") ?? "";
  if (!(bank in banks)) return Response.json({ error: "Choose a supported bank." }, { status: 400 });
  if (!/^\d{5}$/.test(zipCode)) return Response.json({ error: "Enter a five-digit U.S. ZIP code." }, { status: 400 });
  const source = banks[bank as keyof typeof banks];
  try {
    const rates = bank === "Synchrony Bank" ? await synchronyRates() : parseRates(await (await fetch(`${source.url}${source.url.includes("?") ? "&" : "?"}zip=${zipCode}`, { headers: { Accept: "text/html" }, cf: { cacheTtl: 0 } })).text());
    if (!rates.length) return Response.json({ error: "The bank did not return a usable public CD quote for this ZIP. Use the official link to confirm availability.", source: source.url, locationSensitive: source.local }, { status: 424 });
    return Response.json({ bank, zipCode, rates, source: source.url, locationSensitive: source.local, retrievedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The live bank quote is temporarily unavailable.", source: source.url, locationSensitive: source.local }, { status: 503 });
  }
}
