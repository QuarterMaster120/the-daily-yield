import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const sourceUrls = {
  "Citizens Bank": "https://www.citizensbank.com/assets/CB_resources/json/rates/ODS.json",
  "Fifth Third": "https://openonline.53.com/apps/oc/rates.html?productType=cd",
  "First American Bank": "https://www.firstambank.com/Personal/Explore/Rates/Deposit-Rates",
  PNC: "https://www.pnc.com/en/personal-banking/banking/savings/certificate-of-deposits.html",
};
const defaultEndpoint = "https://yield-atlas.startcodex.workers.dev";
const edgeCandidates = [
  process.env.RATE_COLLECTOR_EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const dryRun = process.argv.includes("--dry-run");
const headed = process.argv.includes("--headed");
const endpoint = (process.env.RATE_LEDGER_URL ?? defaultEndpoint).replace(/\/$/, "");
const readToken = process.env.RATE_COLLECTION_READ_TOKEN;
const writeToken = process.env.RATE_COLLECTION_WRITE_TOKEN;

function requireConfig() {
  if (!readToken || !writeToken) throw new Error("RATE_COLLECTION_READ_TOKEN and RATE_COLLECTION_WRITE_TOKEN must be set as user environment variables.");
}

async function request(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, { ...options, headers: { Accept: "application/json", ...(options.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${typeof data.error === "string" ? data.error : "request failed"}`);
  return data;
}

function parseRates(text) {
  const section = text.split(/Standard CD Interest Rates/i)[0];
  const rates = new Map();
  for (const match of section.matchAll(/(\d{1,2})\s*Month\s+CD\s+Promo[\s\S]{0,160}?(\d(?:\.\d+)?)%[\s\S]{0,80}?(\d(?:\.\d+)?)%/gi)) {
    const months = Number(match[1]); const apy = Number(match[3]);
    if (Number.isInteger(months) && months >= 1 && months <= 120 && Number.isFinite(apy) && apy >= 0 && apy <= 20) rates.set(months, { months, term: `${months} ${months === 1 ? "Month" : "Months"}`, apy });
  }
  return [...rates.values()].sort((a, b) => a.months - b.months).slice(0, 12);
}

async function fifthThirdRates(page, zipCode) {
  await page.goto(sourceUrls["Fifth Third"], { waitUntil: "domcontentloaded", timeout: 25_000 });
  const initialText = await page.locator("body").innerText();
  if (/oops, something went wrong|page you're trying to access doesn't appear to exist|ip address:/i.test(initialText)) throw new Error("Fifth Third rejected this computer's network before its public ZIP form loaded; no rates were saved.");
  const input = page.locator("#enter-zip");
  await input.waitFor({ state: "visible", timeout: 15_000 }).catch(() => { throw new Error("Fifth Third did not display its public ZIP form; no rates were saved."); });
  await input.fill(zipCode);
  await page.locator("form.zip-form button").click();
  await page.waitForFunction(() => {
    const text = document.body?.innerText ?? "";
    return /(?:APY|Annual Percentage Yield)/i.test(text) && /\b\d+\s*Month\s+CD\s+Promo/i.test(text);
  }, undefined, { timeout: 20_000 });
  const text = await page.locator("body").innerText();
  if (/captcha|verify you are human|unusual traffic|access denied/i.test(text)) throw new Error(`Fifth Third presented an access-control page for ZIP ${zipCode}; no rates were saved.`);
  const rates = parseRates(text);
  if (!rates.length) throw new Error(`Fifth Third returned no promotional CD APYs for ZIP ${zipCode}; no rates were saved.`);
  return rates;
}

async function citizensRates(zipCode) {
  const fetchText = async (url) => {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Citizens returned ${response.status} for its public rate feed.`);
    return response.text();
  };
  const [regionText, ratesText] = await Promise.all([
    fetchText(`https://services.citizensbank.com/regionalization/api/query?zipcode=${zipCode}`),
    fetchText(sourceUrls["Citizens Bank"]),
  ]);
  const region = JSON.parse(regionText)?.RegionZipCodeMapping?.[0]?.Region;
  const brand = JSON.parse(ratesText)?.find((item) => item?.Brand === "citizensbank");
  const options = brand?.BrandData?.find((item) => item?.RegionCode === region)?.RegionData?.ProductSetData?.find((item) => item?.Product === "CD")?.ProductOptions;
  if (!region || !Array.isArray(options)) throw new Error(`Citizens did not return a CD rate region for ZIP ${zipCode}; no rates were saved.`);
  const rates = new Map();
  for (const option of options) {
    if (option?.customerType !== "CONSUMER" || option?.ProductLevelCode !== "NOR") continue;
    const term = String(option.ProductName ?? "").match(/\b(\d{1,2})\s*(month|mo|year|yr)s?\b/i);
    const number = Number(term?.[1]); const months = /year|yr/i.test(term?.[2] ?? "") ? number * 12 : number;
    const apy = Number(String(option.CurrentAPY ?? "").match(/\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isInteger(months) || months < 1 || months > 120 || !Number.isFinite(apy) || apy < 0 || apy > 20) continue;
    const current = rates.get(months);
    if (!current || apy > current.apy) rates.set(months, { months, term: `${number} ${months === 1 ? "Month" : /year|yr/i.test(term?.[2] ?? "") ? "Years" : "Months"}`, apy });
  }
  if (!rates.size) throw new Error(`Citizens returned no consumer CD APYs for ZIP ${zipCode}; no rates were saved.`);
  return [...rates.values()].sort((a, b) => a.months - b.months).slice(0, 12);
}

async function firstAmericanRates() {
  const source = sourceUrls["First American Bank"].replace(/^https?:\/\//, "");
  const response = await fetch(`https://r.jina.ai/http://${source}`, { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`First American returned ${response.status} through its public reader.`);
  const text = await response.text();
  const section = text.match(/Certificates of Deposit[\s\S]*?(?:Get Started|$)/i)?.[0] ?? "";
  const rates = new Map();
  for (const match of section.matchAll(/\|\s*(\d{1,2}(?:\.5)?\s*(?:month|mo|year|yr)s?)\s*\|\s*\d+(?:\.\d+)?%\s*\|\s*(\d+(?:\.\d+)?)%/gi)) {
    const term = match[1].match(/(\d{1,2}(?:\.5)?)\s*(month|mo|year|yr)/i);
    const number = Number(term?.[1]); const months = /year|yr/i.test(term?.[2] ?? "") ? Math.round(number * 12) : Math.round(number);
    const apy = Number(match[2]);
    if (!Number.isInteger(months) || months < 1 || months > 120 || !Number.isFinite(apy) || apy < 0 || apy > 20) continue;
    rates.set(months, { months, term: `${number} ${months === 1 ? "Month" : /year|yr/i.test(term?.[2] ?? "") ? "Years" : "Months"}`, apy });
  }
  if (!rates.size) throw new Error("First American returned no public CD APYs; no rates were saved.");
  return [...rates.values()].sort((a, b) => a.months - b.months).slice(0, 12);
}

function pncRows(rows) {
  const rates = new Map();
  for (const row of rows) {
    const term = row.match(/\b(\d{1,2})\s*(month|mo|year|yr)s?\b/i);
    const percentages = [...row.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
    if (!term || !percentages.length) continue;
    const number = Number(term[1]); const months = /year|yr/i.test(term[2]) ? number * 12 : number;
    const apy = percentages.at(-1);
    if (!Number.isInteger(months) || months < 1 || months > 120 || !Number.isFinite(apy) || apy < 0 || apy > 20) continue;
    rates.set(months, { months, term: `${number} ${months === 1 ? "Month" : /year|yr/i.test(term[2]) ? "Years" : "Months"}`, apy });
  }
  return [...rates.values()].sort((a, b) => a.months - b.months);
}

async function pncRates(page, zipCode) {
  await page.goto(sourceUrls.PNC, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const input = page.locator("#zip-overlay #zipCodeUpdate, #zip-overlay-01 #zipCode").first();
  await input.waitFor({ state: "visible", timeout: 15_000 }).catch(() => { throw new Error("PNC did not display its public ZIP form; no rates were saved."); });
  await input.fill(zipCode);
  await page.locator("#form-button-1275034976, #form-button-1195175473").first().click();
  await page.waitForFunction((zip) => {
    const text = document.body?.innerText ?? "";
    return text.includes(zip) && /\b\d+\s*(?:month|year)s?\b/i.test(text) && /APY/i.test(text);
  }, zipCode, { timeout: 25_000 });
  const text = await page.locator("body").innerText();
  if (/captcha|verify you are human|unusual traffic|access denied/i.test(text)) throw new Error(`PNC presented an access-control page for ZIP ${zipCode}; no rates were saved.`);
  if (!text.includes(zipCode)) throw new Error(`PNC did not confirm ZIP ${zipCode}; no default-market rates were saved.`);
  const rates = pncRows(await page.locator("tr").allInnerTexts());
  if (!rates.length) throw new Error(`PNC returned no CD APYs for ZIP ${zipCode}; no rates were saved.`);
  return rates;
}

async function main() {
  requireConfig();
  const plan = await request("/api/collection-plan", { headers: { Authorization: `Bearer ${readToken}` } });
  const jobs = Array.isArray(plan.requests) ? plan.requests.filter((item) => item && item.bank in sourceUrls && /^\d{5}$/.test(item.zipCode ?? "")) : [];
  if (!jobs.length) { console.log("No desktop-collected bank ZIPs are currently selected by subscribers."); return; }
  const executablePath = edgeCandidates.find((candidate) => existsSync(candidate));
  if (!executablePath) throw new Error("Microsoft Edge was not found. Set RATE_COLLECTOR_EDGE_PATH to the browser executable.");
  const browser = await chromium.launch({ executablePath, headless: !headed });
  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36" });
    const observations = [];
    for (const job of jobs) {
      const page = await context.newPage();
      try {
        const rates = job.bank === "Citizens Bank" ? await citizensRates(job.zipCode) : job.bank === "Fifth Third" ? await fifthThirdRates(page, job.zipCode) : job.bank === "First American Bank" ? await firstAmericanRates() : await pncRates(page, job.zipCode);
        observations.push({ bank: job.bank, zipCode: job.zipCode, rates });
        console.log(`Collected ${rates.length} ${job.bank} CD terms for ZIP ${job.zipCode}.`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Desktop bank collection failed.");
      } finally {
        await page.close();
      }
    }
    if (!observations.length) throw new Error("No valid desktop bank results were collected; no existing data was overwritten.");
    if (dryRun) { console.log(JSON.stringify({ observations }, null, 2)); return; }
    const result = await request("/api/bank-rate-observations", { method: "POST", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ observations }) });
    console.log(`Stored ${result.stored} desktop-collected CD observations for ${result.observedOn}.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Rate collector failed."); process.exitCode = 1; });
