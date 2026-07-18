import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { env } from "cloudflare:workers";

type Quote = { term: string; months: number; apy: number };

const banks = {
  "Ally Bank": { url: "https://www.ally.com/bank/cd-rates/", local: false },
  "American Express": { url: "https://www.americanexpress.com/en-us/banking/online-savings/cd-account/", local: false },
  "Bank of America": { url: "https://www.bankofamerica.com/deposits/bank-cds/cd-accounts/", local: true },
  BMO: { url: "https://www.bmo.com/en-us/main/personal/savings-and-cds/certificates-of-deposit/", local: true },
  "Capital One": { url: "https://www.capitalone.com/bank/cds/online-cds/", local: false },
  Chase: { url: "https://www.chase.com/personal/savings/bank-cd", local: true },
  "Citizens Bank": { url: "https://www.citizensbank.com/savings/certificates-of-deposit.aspx", local: true },
  "Fifth Third": { url: "https://www.53.com/content/fifth-third/en/personal-banking/bank/savings/cds.html", local: true },
  Huntington: { url: "https://www.huntington.com/Personal/savings/cds", local: true },
  "Morgan Stanley": { url: "https://www.morganstanley.com/what-we-do/wealth-management/cd-savings", local: true },
  PNC: { url: "https://www.pnc.com/en/personal-banking/banking/savings/certificate-of-deposits.html", local: true },
  Regions: { url: "https://www.regions.com/personal-banking/savings-and-cds/cds", local: true },
  "Synchrony Bank": { url: "https://www.synchronybank.com/banking/cd-rates/", local: false },
  "TD Bank": { url: "https://www.td.com/us/en/personal-banking/certificates-of-deposit", local: true },
  Truist: { url: "https://www.truist.com/savings/certificate-of-deposit", local: true },
  "U.S. Bank": { url: "https://www.usbank.com/bank-accounts/savings-accounts/certificate-of-deposit.html", local: true },
  "Wells Fargo": { url: "https://www.wellsfargo.com/savings-cds/rates/", local: true },
} as const;

const browserHeaders = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36",
};

const browserBinding = (env as unknown as { BROWSER?: BrowserWorker }).BROWSER;

type PublicFetchInit = RequestInit & { cf?: { cacheTtl?: number } };

async function readPublicText(url: string, init: PublicFetchInit, timeoutMs: number) {
  const controller = new AbortController();
  const request = fetch(url, { ...init, signal: controller.signal })
    .then((response) => response.ok ? response.text() : "")
    .catch(() => "");
  const deadline = new Promise<string>((resolve) => setTimeout(() => {
    controller.abort();
    resolve("");
  }, timeoutMs));
  try {
    return await Promise.race([request, deadline]);
  } finally {
    controller.abort();
  }
}

function term(label: string) {
  const match = label.toLowerCase().replace("-", " ").match(/(\d{1,2}(?:\.5)?)\s*(month|mo|year|yr)/);
  if (!match) return null;
  const number = Number(match[1]); const months = /year|yr/.test(match[2]) ? Math.round(number * 12) : Math.round(number);
  return months >= 1 && months <= 120 ? { months, term: `${number} ${months === 1 ? (/year|yr/.test(match[2]) ? "Year" : "Month") : (/year|yr/.test(match[2]) ? "Years" : "Months")}` } : null;
}

function parseRates(html: string, requireCdContext = true): Quote[] {
  const text = html.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#x3D;/gi, " ").replace(/\s+/g, " ");
  const patterns = [
    /(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?).{0,160}?(\d(?:\.\d{1,3})?\s*%\s*(?:annual percentage yield\s*\(?apy\)?|apy))/gi,
    /(\d(?:\.\d{1,3})?\s*%\s*(?:annual percentage yield\s*\(?apy\)?|apy)).{0,160}?(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?)/gi,
    /(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?).{0,120}?(\d(?:\.\d{1,3})?\s*%)/gi,
    /(\d(?:\.\d{1,3})?\s*%).{0,120}?(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?)/gi,
  ];
  const result = new Map<string, Quote>();
  for (const [index, pattern] of patterns.entries()) for (const match of text.matchAll(pattern)) {
    if (requireCdContext && !/\b(cd|certificate)\b/i.test(match[0])) continue;
    const termFirst = index === 0 || index === 2;
    const parsed = term(termFirst ? match[1] : match[2]);
    const apyText = termFirst ? match[2] : match[1]; const rate = Number(apyText.match(/\d(?:\.\d{1,3})?/)?.[0]);
    if (parsed && Number.isFinite(rate)) result.set(`${parsed.months}-${rate}`, { ...parsed, apy: rate });
  }
  return [...result.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

function parseAvailableTerms(text: string): Quote[] {
  const sections = [...text.matchAll(/available terms?([\s\S]{0,1000})/gi)]; const result = new Map<string, Quote>();
  for (const section of sections) {
    const body = section[1]; const terms = [...body.matchAll(/\b\d{1,2}(?:\.5)?\s*(?:month|mo|year|yr)s?\b/gi)].map((match) => term(match[0])).filter((value): value is NonNullable<ReturnType<typeof term>> => Boolean(value));
    const apys = [...body.matchAll(/\b\d(?:\.\d{1,3})?\s*%\s*(?:annual percentage yield\s*\(?apy\)?|apy)\b/gi)].map((match) => Number(match[0].match(/\d(?:\.\d{1,3})?/)?.[0]));
    for (let index = 0; index < Math.min(terms.length, apys.length); index++) if (Number.isFinite(apys[index])) result.set(`${terms[index].months}-${apys[index]}`, { ...terms[index], apy: apys[index] });
  }
  return [...result.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

function parseAdjacentRateTerms(text: string): Quote[] {
  const result = new Map<string, Quote>();
  const add = (termText: string, rateText: string) => {
    const parsed = term(termText); const apy = Number(rateText);
    if (parsed && Number.isFinite(apy)) result.set(`${parsed.months}-${apy}`, { ...parsed, apy });
  };
  for (const match of text.matchAll(/\|\s*(\d{1,2}(?:\.5)?\s*(?:month|mo|year|yr)s?)\s*\|\s*(\d(?:\.\d{1,3})?)%/gi)) add(match[1], match[2]);
  for (const match of text.matchAll(/(\d(?:\.\d{1,3})?)%\s*(?:APY)?\s*\r?\n+\s*(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?)\s*(?:term)?\b/gi)) add(match[2], match[1]);
  for (const match of text.matchAll(/(\d{1,2}(?:\.5)?[\s-]*(?:month|mo|year|yr)s?)\s*(?:term)?\s*\r?\n+\s*(\d(?:\.\d{1,3})?)%\s*(?:APY)?/gi)) add(match[1], match[2]);
  return [...result.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

async function readPublicRatePage(url: string, zipCode: string) {
  {
    const directText = await readPublicText(`${url}${url.includes("?") ? "&" : "?"}zip=${zipCode}`, { headers: browserHeaders, cf: { cacheTtl: 0 } }, 12_000);
    if (directText) {
    const directRates = [...parseRates(directText), ...parseAvailableTerms(directText)];
    if (directRates.length) return { rates: directRates, retrieval: "direct" };
    const directFallback = [...parseAdjacentRateTerms(directText), ...parseRates(directText, false)];
    const directUnique = new Map(directFallback.map((rate) => [`${rate.months}-${rate.apy}`, rate]));
    if (directUnique.size) return { rates: [...directUnique.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12), retrieval: "direct" };
    }
  }
  const renderedRates = await readRenderedRatePage(url, zipCode);
  if (renderedRates.length) return { rates: renderedRates, retrieval: "rendered-public-page" };

  let readerText = "";
  {
    const readerSource = addZipParameter(url, zipCode).replace(/^https?:\/\//, "");
    readerText = await readPublicText(`https://r.jina.ai/http://${readerSource}`, { headers: { Accept: "text/plain" }, cf: { cacheTtl: 300 } }, 12_000);
    if (!readerText) return { rates: [], retrieval: "unavailable" };
  }
  const strictRates = [...parseRates(readerText), ...parseAvailableTerms(readerText)];
  const adjacentRates = parseAdjacentRateTerms(readerText);
  const rates = strictRates.length ? strictRates : (adjacentRates.length ? adjacentRates : parseRates(readerText, false));
  const unique = new Map(rates.map((rate) => [`${rate.months}-${rate.apy}`, rate]));
  return { rates: [...unique.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12), retrieval: "public-reader" };
}

function addZipParameter(url: string, zipCode: string) {
  const source = new URL(url);
  source.searchParams.set("zip", zipCode);
  return source.toString();
}

function publicRatesFromText(text: string): Quote[] {
  const strictRates = [...parseRates(text), ...parseAvailableTerms(text)];
  const adjacentRates = parseAdjacentRateTerms(text);
  const rates = strictRates.length ? strictRates : (adjacentRates.length ? adjacentRates : parseRates(text, false));
  const unique = new Map(rates.map((rate) => [`${rate.months}-${rate.apy}`, rate]));
  return [...unique.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

async function readRenderedRatePage(url: string, zipCode: string): Promise<Quote[]> {
  return Promise.race([
    readRenderedRatePageInternal(url, zipCode),
    new Promise<Quote[]>((resolve) => setTimeout(() => resolve([]), 18_000)),
  ]);
}

async function readRenderedRatePageInternal(url: string, zipCode: string): Promise<Quote[]> {
  if (!browserBinding) return [];
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch(browserBinding);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    // Some bank pages keep analytics connections open; a navigation timeout
    // does not mean their public rate table failed to render.
    await page.goto(addZipParameter(url, zipCode), { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    const [html, visibleText] = await Promise.all([
      page.content(),
      page.evaluate(() => document.body?.innerText ?? ""),
    ]);
    const rendered = `${html.slice(0, 500_000)}\n${visibleText.slice(0, 500_000)}`;
    // Do not attempt to defeat a challenge page or any other access control.
    if (/captcha|verify you are human|unusual traffic/i.test(rendered)) return [];
    return publicRatesFromText(rendered);
  } catch {
    return [];
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
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
    const quote = bank === "Synchrony Bank" ? { rates: await synchronyRates(), retrieval: "official-feed" } : await readPublicRatePage(source.url, zipCode);
    const rates = quote.rates;
    if (!rates.length) return Response.json({ error: "The bank did not return a usable public CD quote for this ZIP. Use the official link to confirm availability.", source: source.url, locationSensitive: source.local, retrieval: quote.retrieval }, { status: 424 });
    return Response.json({ bank, zipCode, rates, source: source.url, locationSensitive: source.local, retrieval: quote.retrieval, retrievedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The live bank quote is temporarily unavailable.", source: source.url, locationSensitive: source.local }, { status: 503 });
  }
}
