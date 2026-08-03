import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { and, desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../db";
import { bankRateObservations } from "../../../db/schema";

type Quote = { term: string; months: number; apy: number; balance?: string };
type BankSource = {
  url: string;
  local: boolean;
  browserRequired?: boolean;
  zipInput?: string;
  zipSubmit?: string;
  adapter?: "bank-of-america" | "chase" | "citizens" | "fifth-third" | "first-american" | "pnc" | "wells-fargo";
};

const banks: Record<string, BankSource> = {
  "Bank of America": { url: "https://www.bankofamerica.com/deposits/bank-cds/cd-accounts/", local: true, adapter: "bank-of-america" },
  Chase: { url: "https://www.chase.com/digital/disclosures-and-interest-rates-personal", local: true, adapter: "chase" },
  "Citizens Bank": { url: "https://www.citizensbank.com/savings/cds-certificates-of-deposit/online-certificate-of-deposit.page", local: true, adapter: "citizens" },
  "Fifth Third": { url: "https://openonline.53.com/apps/oc/rates.html?productType=cd", local: true, browserRequired: true, adapter: "fifth-third", zipInput: "#enter-zip", zipSubmit: "form.zip-form button" },
  "First American Bank": { url: "https://www.firstambank.com/Personal/Explore/Rates/Deposit-Rates", local: true, adapter: "first-american" },
  "Morgan Stanley": { url: "https://www.morganstanley.com/what-we-do/wealth-management/cd-savings", local: true },
  PNC: { url: "https://www.pnc.com/en/personal-banking/banking/savings/certificate-of-deposits.html", local: true, browserRequired: true, adapter: "pnc", zipInput: "#zip-overlay #zipCodeUpdate, #zip-overlay-01 #zipCode", zipSubmit: "#form-button-1275034976, #form-button-1195175473" },
  "Synchrony Bank": { url: "https://www.synchronybank.com/banking/cd-rates/", local: false },
  "TD Bank": { url: "https://www.td.com/us/en/personal-banking/certificates-of-deposit", local: true },
  Truist: { url: "https://www.truist.com/savings/certificate-of-deposit", local: true },
  "U.S. Bank": { url: "https://www.usbank.com/bank-accounts/savings-accounts/certificate-of-deposit.html", local: true },
  "Wells Fargo": { url: "https://www.wellsfargo.com/savings-cds/rates/", local: true, browserRequired: true, adapter: "wells-fargo" },
};

const browserHeaders = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36",
};

const browserBinding = (env as unknown as { BROWSER?: BrowserWorker }).BROWSER;

type PublicFetchInit = RequestInit & { cf?: { cacheTtl?: number } };

async function readBoundedText(response: Response, maximumBytes = 1_000_000) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return "";
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder(); let received = 0; let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > maximumBytes) { await reader.cancel(); return ""; }
    text += decoder.decode(value, { stream: true });
  }
}

async function readPublicText(url: string, init: PublicFetchInit, timeoutMs: number, maximumBytes = 1_000_000) {
  const controller = new AbortController();
  const request = fetch(url, { ...init, signal: controller.signal })
    .then((response) => response.ok ? readBoundedText(response, maximumBytes) : "")
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

function firstAmericanRates(text: string): Quote[] {
  const cdSection = text.match(/Certificates of Deposit[\s\S]*?(?:Get Started|$)/i)?.[0] ?? text;
  const rates = new Map<string, Quote>();
  for (const match of cdSection.matchAll(/\|\s*(\d{1,2}(?:\.5)?\s*(?:month|mo|year|yr)s?)\s*\|\s*\d+(?:\.\d+)?%\s*\|\s*(\d+(?:\.\d+)?)%/gi)) {
    const parsed = term(match[1]);
    const apy = Number(match[2]);
    if (parsed && Number.isFinite(apy)) rates.set(`${parsed.months}-${apy}`, { ...parsed, apy });
  }
  return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

async function readPublicRatePage(source: BankSource, zipCode: string) {
  const { url } = source;
  if (source.adapter === "bank-of-america") {
    const rates = await bankOfAmericaRates(zipCode);
    return { rates, retrieval: rates.length ? "official-feed" : "unavailable" };
  }
  if (source.adapter === "first-american") {
    const readerUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
    const readerText = await readPublicText(readerUrl, { headers: { Accept: "text/plain" }, cf: { cacheTtl: 300 } }, 12_000);
    const rates = firstAmericanRates(readerText);
    return { rates, retrieval: rates.length ? "official-page" : "unavailable" };
  }
  if (source.adapter === "chase") {
    const rates = await chaseRates(zipCode);
    return { rates, retrieval: rates.length ? "official-feed" : "unavailable" };
  }
  if (source.adapter === "citizens") {
    const rates = await citizensRates(zipCode);
    return { rates, retrieval: rates.length ? "official-feed" : "unavailable" };
  }
  if (source.adapter === "wells-fargo") {
    const rates = await wellsFargoDirectRates(zipCode);
    return { rates, retrieval: rates.length ? "official-feed" : "official-source-unavailable" };
  }
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

  // A public reader cannot complete a bank's market-specific ZIP flow. Only
  // invoke Browser Run for sources with a documented browser-side ZIP gate.
  if (source.browserRequired) {
    const rendered = await readRenderedRatePage(source, zipCode);
    if (rendered.rates.length) return { rates: rendered.rates, retrieval: "rendered-public-page" };
    return { rates: [], retrieval: rendered.reason === "rate-limited" ? "browser-rate-limited" : "unavailable", retryAfter: rendered.reason === "rate-limited" ? secondsUntilNextUtcDay() : undefined };
  }

  // Do not substitute a public-reader response for a market-specific rate.
  if (source.local && source.adapter !== "first-american") return { rates: [], retrieval: "unavailable" };

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

function secondsUntilNextUtcDay() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1_000));
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

async function publicJsonThroughReader(url: string, timeoutMs: number, maximumBytes: number) {
  const text = await readPublicText(`https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`, { headers: { Accept: "text/plain" }, cf: { cacheTtl: 300 } }, timeoutMs, maximumBytes);
  const marker = "Markdown Content:\n";
  const offset = text.indexOf(marker);
  return offset >= 0 ? text.slice(offset + marker.length) : text;
}

async function chaseRates(zipCode: string): Promise<Quote[]> {
  const response = await fetch("https://www.chase.com/bin/services/cdRate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Referer: banks.Chase.url },
    body: new URLSearchParams({ zipcode: zipCode, type: "CD", language: "en" }).toString(),
  }).catch(() => null);
  if (!response?.ok) return [];
  const data = await response.json() as { ratesData?: { rates?: Record<string, string[]>; cdTermLabels?: string[] } };
  const rates = new Map<string, Quote>();
  for (const [label, values] of Object.entries(data.ratesData?.rates ?? {})) {
    const months = Number(label.match(/^(\d+)-Month$/i)?.[1]);
    // Chase's 5- and 8-month standard CDs are intentionally not reported.
    if (months === 5 || months === 8) continue;
    const tiers = values.map((value, index) => ({ apy: Number(value.match(/\d+(?:\.\d+)?/)?.[0]), balance: data.ratesData?.cdTermLabels?.[index + 1] ?? "" })).filter((tier) => Number.isFinite(tier.apy));
    const best = tiers.reduce<(typeof tiers)[number] | null>((current, tier) => !current || tier.apy > current.apy ? tier : current, null);
    if (Number.isFinite(months) && best) rates.set(`${months}-${best.apy}`, { months, term: `${months} ${months === 1 ? "Month" : "Months"}`, apy: best.apy, balance: best.balance });
  }
  return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

const BANK_OF_AMERICA_EPCS = [
  "FSDPTDZZC1078F3F8A1", "FSDPTDZZC1078F33P71", "FSDPTDZZC1078F33ZA1", "FSDPTDZZC1078F34B11", "FSDPTDZZC1078F34MS1",
  "FSDPTDZZC1078F34XD1", "FSDPTDZZC1078F355Z1", "FSDPTDZZC1078F35FW1", "FSDPTDZZC1078F35O21", "FSDPTDZZC1078F35Y21", "FSDPTDZZC1078F36A71",
].join(",");

async function stateForZip(zipCode: string) {
  const url = new URL("https://www.bankofamerica.com/salesservices/getCountiesByFlowType");
  url.searchParams.set("zipCode", zipCode);
  url.searchParams.set("flowType", "consumer");
  const text = await readPublicText(url.toString(), { headers: { Accept: "application/json", Referer: banks["Bank of America"].url }, cf: { cacheTtl: 86_400 } }, 8_000, 50_000);
  try {
    const payload = JSON.parse(text) as { state?: unknown }[];
    const state = payload[0]?.state;
    return typeof state === "string" && /^[A-Z]{2}$/.test(state) ? state : "";
  } catch { return ""; }
}

function parseBankOfAmericaRates(text: string): Quote[] {
  try {
    const payload = JSON.parse(text) as Record<string, { displayName?: unknown; cdProductAttributes?: { standardApy?: unknown; minimumOpeningBalance?: unknown; minimumTermMonths?: unknown; maxTermMonths?: unknown } }>;
    const rates = new Map<string, Quote>();
    for (const product of Object.values(payload)) {
      const attributes = product.cdProductAttributes;
      const min = Number(attributes?.minimumTermMonths);
      const max = Number(attributes?.maxTermMonths);
      const apy = rateFromUnknown(attributes?.standardApy);
      if (apy === null || !Number.isFinite(max) || max < 1) continue;
      const term = Number.isFinite(min) && min > 0 && min !== max ? `${min}–${max} Months` : `${max} ${max === 1 ? "Month" : "Months"}`;
      const opening = typeof attributes?.minimumOpeningBalance === "string" ? attributes.minimumOpeningBalance : "";
      rates.set(`${min}-${max}-${apy}`, { term, months: min > 0 ? min : max, apy, balance: opening ? `Min. ${opening}` : undefined });
    }
    return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
  } catch { return []; }
}

async function bankOfAmericaRates(zipCode: string): Promise<Quote[]> {
  const state = await stateForZip(zipCode);
  if (!state || !browserBinding) return [];
  const url = new URL("https://www.bankofamerica.com/salesservices/getProductDetailsForEpcs");
  url.searchParams.set("epcCode", BANK_OF_AMERICA_EPCS);
  url.searchParams.set("state", state);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const limits = await puppeteer.limits(browserBinding);
    if (limits.allowedBrowserAcquisitions < 1) return [];
    browser = await puppeteer.launch(browserBinding);
    const page = await browser.newPage();
    await page.goto(banks["Bank of America"].url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const text = await page.evaluate(async (endpoint) => {
      const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
      return response.ok ? response.text() : "";
    }, url.toString());
    return parseBankOfAmericaRates(text);
  } catch { return []; }
  finally { await browser?.close().catch(() => undefined); }
}

function citizensQuote(label: string, apy: unknown): Quote | null {
  const parsed = term(label); const rate = rateFromUnknown(apy);
  return parsed && rate !== null ? { ...parsed, apy: rate } : null;
}

async function citizensRates(zipCode: string): Promise<Quote[]> {
  // Citizens blocks Cloudflare worker egress for these public JSON endpoints.
  // Read-only Jina access preserves the banks' document unchanged and keeps the
  // site on the same free, official-source data path.
  const regionTexts = await Promise.all([
    publicJsonThroughReader(`https://services.citizensbank.com/regionalization/api/query?zipcode=${zipCode}`, 20_000, 10_000),
    publicJsonThroughReader(`https://www.citizensbank.com/apps/ApiProxy/RegionalizationApi/api/region/GetRegion?ZipCode=${zipCode}`, 20_000, 10_000),
  ]);
  const region = regionTexts.flatMap((regionalText) => {
    try {
      const data = JSON.parse(regionalText) as { Region?: string; region?: string; RegionZipCodeMapping?: { Region?: string }[] };
      return [data.RegionZipCodeMapping?.[0]?.Region, data.Region, data.region].filter((value): value is string => typeof value === "string" && value.length > 0);
    } catch { return []; }
  })[0] ?? "";
  if (!region) return [];
  const ratesText = await publicJsonThroughReader("https://www.citizensbank.com/assets/CB_resources/json/rates/ODS.json", 30_000, 2_000_000);
  let data: unknown;
  try { data = JSON.parse(ratesText); } catch { return []; }
  const source = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
  const brands = source.filter((item): item is { Brand?: string; BrandData?: { RegionCode?: string; RegionData?: { ProductSetData?: { Product?: string; ProductOptions?: Record<string, unknown>[] }[] } }[] } => Boolean(item) && typeof item === "object");
  const rates = new Map<string, Quote>();
  for (const brand of brands) if (brand.Brand === "citizensbank") for (const regionData of brand.BrandData ?? []) if (regionData.RegionCode === region) for (const set of regionData.RegionData?.ProductSetData ?? []) if (set.Product === "CD") for (const option of set.ProductOptions ?? []) {
    if (option.customerType !== "CONSUMER" || option.ProductLevelCode !== "NOR") continue;
    const quote = citizensQuote(String(option.ProductName ?? ""), option.CurrentAPY);
    const existing = quote ? rates.get(String(quote.months)) : undefined;
    if (quote && (!existing || quote.apy > existing.apy)) rates.set(String(quote.months), quote);
  }
  return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy);
}

function fifthThirdRates(text: string): Quote[] {
  const promotionalSection = text.split(/Standard CD Interest Rates/i)[0];
  const rates = new Map<string, Quote>();
  for (const match of promotionalSection.matchAll(/(\d{1,2})\s*Month\s+CD\s+Promo[\s\S]{0,120}?(\d(?:\.\d+)?)%\s*(\d(?:\.\d+)?)%/gi)) {
    const months = Number(match[1]); const apy = Number(match[3]);
    if (Number.isFinite(months) && Number.isFinite(apy)) rates.set(`${months}-${apy}`, { months, term: `${months} ${months === 1 ? "Month" : "Months"}`, apy });
  }
  return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

async function savedCollectedRates(bank: string, zipCode: string): Promise<{ rates: Quote[]; retrievedAt?: string }> {
  if (bank !== "Citizens Bank" && bank !== "Fifth Third" && bank !== "First American Bank" && bank !== "PNC") return { rates: [] };
  const rows = await getDb().select({ term: bankRateObservations.term, termMonths: bankRateObservations.termMonths, apy: bankRateObservations.apy, observedAt: bankRateObservations.observedAt }).from(bankRateObservations).where(and(eq(bankRateObservations.bank, bank), eq(bankRateObservations.zipCode, zipCode))).orderBy(desc(bankRateObservations.observedAt)).limit(12);
  const latest = rows[0]?.observedAt;
  if (!latest) return { rates: [] };
  const rates = rows.filter((row) => row.observedAt === latest).map((row) => ({ term: row.term, months: row.termMonths, apy: row.apy })).sort((a, b) => a.months - b.months || a.apy - b.apy);
  return { rates, retrievedAt: latest };
}

type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;

async function applyZipCode(page: BrowserPage, source: BankSource, zipCode: string) {
  const genericZipInput = 'input[autocomplete="postal-code"], input[name*="zip" i], input[id*="zip" i], input[aria-label*="zip" i], input[placeholder*="zip" i]';
  const zipInput = await page.$(source.zipInput ?? genericZipInput);
  if (!zipInput) return;
  await zipInput.click({ clickCount: 3 });
  await page.keyboard.press("Control+A");
  await zipInput.type(zipCode);
  const submit = source.zipSubmit ? await page.$(source.zipSubmit) : null;
  if (submit) await submit.click(); else await page.keyboard.press("Enter");
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => undefined);
  if (source.url.includes("openonline.53.com")) {
    // The ZIP form is replaced asynchronously by Fifth Third's rate table.
    await page.waitForFunction(() => {
      const text = document.body?.innerText ?? "";
      return /(?:APY|annual percentage yield)/i.test(text) && /\b\d+\s*(?:month|mo|year|yr)/i.test(text);
    }, { timeout: 10_000 }).catch(() => undefined);
  }
}

function rateFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function structuredRates(value: unknown): Quote[] {
  const rates = new Map<string, Quote>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const fields = Object.entries(record);
    const termValue = fields.find(([key]) => /^(term|termDescription|termLabel|maturityTerm)$/i.test(key))?.[1];
    const apyValue = fields.find(([key]) => /apy|annual.*yield/i.test(key))?.[1];
    const parsedTerm = typeof termValue === "number" ? term(`${termValue} months`) : term(String(termValue ?? ""));
    const apy = rateFromUnknown(apyValue);
    if (parsedTerm && apy !== null) rates.set(`${parsedTerm.months}-${apy}`, { ...parsedTerm, apy });
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

async function wellsFargoRates(page: BrowserPage, zipCode: string): Promise<Quote[]> {
  const payload = await page.evaluate(async (zip) => {
    const requestId = () => crypto.randomUUID();
    const common = () => ({
      "X-REQUEST-ID": requestId(),
      "X-CORRELATION-ID": requestId(),
      "X-WF-REQUEST-DATE": new Date().toISOString(),
      "X-WF-CLIENT-ID": "WU",
    });
    await fetch(`/locator/zipState/${zip}`, { headers: { ...common(), "appId": "WWW", "X-WF-API-VERSION": "V1", "X-WF-CMP-ID": "Locator" } });
    const response = await fetch("/xapi/product-service-research/products-rates/v1/deposit/rates", {
      method: "POST",
      headers: { ...common(), "Content-Type": "application/json", "X-WF-CMP-ID": "CONSUMER_DEPOSITS_RATES" },
      body: JSON.stringify({ sub_product_code: ["40", "128"], product_type: ["c_cd"], rate_type: "standard", zip_code: zip }),
    });
    return response.ok ? response.json() : null;
  }, zipCode);
  const rates = new Map<string, Quote>();
  const depositRates = (payload as { data?: { deposit_rates?: { rates?: Record<string, unknown>[] }[] } } | null)?.data?.deposit_rates ?? [];
  for (const product of depositRates) for (const item of product.rates ?? []) {
    const apy = rateFromUnknown(item.min_apr);
    const start = rateFromUnknown(item.term_start); const end = rateFromUnknown(item.term_end);
    const months = start !== null && start <= 60 ? Math.round(start) : end !== null ? Math.round(end / 30) : 0;
    if (apy === null || months < 1 || months > 120) continue;
    const label = start !== null && end !== null && start !== end ? `${months}-${Math.max(months, Math.round(end <= 60 ? end : end / 30))} Months` : `${months} ${months === 1 ? "Month" : "Months"}`;
    rates.set(`${months}-${apy}`, { months, term: label, apy });
  }
  return rates.size ? [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12) : structuredRates(payload);
}

async function wellsFargoDirectRates(zipCode: string): Promise<Quote[]> {
  const id = () => crypto.randomUUID();
  const headers = () => ({ "Content-Type": "application/json", "X-WF-CLIENT-ID": "WU", "X-WF-CMP-ID": "CONSUMER_DEPOSITS_RATES", "X-REQUEST-ID": id(), "X-CORRELATION-ID": id(), "X-WF-REQUEST-DATE": new Date().toISOString() });
  const payloads = await Promise.all(["40", "128"].map(async (code) => {
    const response = await fetch("https://www.wellsfargo.com/xapi/product-service-research/products-rates/v1/deposit/rates", { method: "POST", headers: headers(), body: JSON.stringify({ sub_product_code: [code], product_type: ["c_cd"], rate_type: "standard", zip_code: zipCode }) }).catch(() => null);
    return response?.ok ? response.json().catch(() => null) : null;
  }));
  type WellsRate = { min_amount?: string | number; min_apr?: string | number; term_start?: string | number; term_end?: string | number };
  type WellsProduct = { special_rate_flag?: boolean; rates?: WellsRate[] };
  const rates = new Map<string, Quote>();
  for (const payload of payloads) for (const product of (payload as { data?: { deposit_rates?: WellsProduct[] } } | null)?.data?.deposit_rates ?? []) for (const item of product.rates ?? []) {
    const minimum = Number(String(item.min_amount ?? "").replace(/[$,]/g, ""));
    if ((!product.special_rate_flag && minimum !== 0) || (product.special_rate_flag && minimum !== 5_000)) continue;
    const apy = rateFromUnknown(item.min_apr); const start = rateFromUnknown(item.term_start); const end = rateFromUnknown(item.term_end);
    const months = start !== null ? Math.round(start) : end !== null ? Math.round(end / 30) : 0;
    if (apy === null || months < 1 || months > 120) continue;
    rates.set(`${months}-${apy}`, { months, term: `${months} ${months === 1 ? "Month" : "Months"}`, apy });
  }
  return [...rates.values()].sort((a, b) => a.months - b.months || a.apy - b.apy).slice(0, 12);
}

type BrowserRead = { rates: Quote[]; reason?: "rate-limited" | "blocked" | "failed" };

async function readRenderedRatePage(source: BankSource, zipCode: string): Promise<BrowserRead> {
  if (!browserBinding) return { rates: [], reason: "failed" };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const limits = await puppeteer.limits(browserBinding);
    if (limits.allowedBrowserAcquisitions < 1) return { rates: [], reason: "rate-limited" };
    browser = await puppeteer.launch(browserBinding);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    // Some bank pages keep analytics connections open; a navigation timeout
    // does not mean their public rate table failed to render.
    // Chase and Fifth Third require their own public form submission; adding a
    // synthetic ZIP query parameter can bypass or disrupt that client flow.
    const navigationUrl = source.adapter === "chase" || source.adapter === "fifth-third" || source.adapter === "pnc" ? source.url : addZipParameter(source.url, zipCode);
    await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    if (source.adapter === "wells-fargo") {
      const rates = await wellsFargoRates(page, zipCode).catch(() => []);
      if (rates.length) return { rates };
    }
    await applyZipCode(page, source, zipCode).catch(() => undefined);
    const [html, visibleText] = await Promise.all([
      page.content(),
      page.evaluate(() => document.body?.innerText ?? ""),
    ]);
    const rendered = `${html.slice(0, 500_000)}\n${visibleText.slice(0, 500_000)}`;
    // Do not attempt to defeat a challenge page or any other access control.
    if (/captcha|verify you are human|unusual traffic/i.test(rendered)) return { rates: [], reason: "blocked" };
    if (source.adapter === "fifth-third") {
      const rates = fifthThirdRates(rendered);
      if (rates.length) return { rates };
    }
    return { rates: publicRatesFromText(rendered) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rates: [], reason: /(?:code:\s*429|time limit exceeded|too many requests|usage limit|daily limit|quota)/i.test(message) ? "rate-limited" : "failed" };
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
  if (!(bank in banks)) return Response.json({ error: "Choose a supported bank." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (!/^\d{5}$/.test(zipCode)) return Response.json({ error: "Enter a five-digit U.S. ZIP code." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const source = banks[bank as keyof typeof banks];
  try {
    // Prefer the scheduled, ZIP-specific D1 observation for sources that are
    // less reliable when queried directly during the email run.
    const earlySaved = bank === "Citizens Bank" || bank === "First American Bank" ? await savedCollectedRates(bank, zipCode).catch(() => ({ rates: [] })) : { rates: [] };
    const quote = earlySaved.rates.length ? { rates: [], retrieval: "unavailable" } : bank === "Synchrony Bank" ? { rates: await synchronyRates(), retrieval: "official-feed" } : await readPublicRatePage(source, zipCode);
    const saved = earlySaved.rates.length ? earlySaved : !quote.rates.length ? await savedCollectedRates(bank, zipCode).catch(() => ({ rates: [] })) : { rates: [] };
    const rates = quote.rates.length ? quote.rates : saved.rates;
    if (!rates.length) {
      const retryAfter = "retryAfter" in quote ? quote.retryAfter : undefined;
      const error = retryAfter ? "ZIP-specific browser capacity is temporarily exhausted. Please try again shortly." : "The bank did not return a usable public CD quote for this ZIP. Use the official link to confirm availability.";
      return Response.json({ error, source: source.url, locationSensitive: source.local, retrieval: quote.retrieval, retryAfter }, { status: retryAfter ? 503 : 424, headers: retryAfter ? { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } : { "Cache-Control": "no-store" } });
    }
    return Response.json({ bank, zipCode, rates, source: source.url, locationSensitive: source.local, retrieval: quote.rates.length ? quote.retrieval : "scheduled-public-page", retrievedAt: saved.retrievedAt ?? new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The live bank quote is temporarily unavailable.", source: source.url, locationSensitive: source.local }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
