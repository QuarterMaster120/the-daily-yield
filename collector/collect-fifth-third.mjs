import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const sourceUrl = "https://openonline.53.com/apps/oc/rates.html?productType=cd";
const defaultEndpoint = "https://rate-ledger-daily.startcodex.workers.dev";
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
  return [...rates.values()].sort((a, b) => a.months - b.months);
}

async function fifthThirdRates(page, zipCode) {
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
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

async function main() {
  requireConfig();
  const plan = await request("/api/collection-plan", { headers: { Authorization: `Bearer ${readToken}` } });
  const jobs = Array.isArray(plan.requests) ? plan.requests.filter((item) => item?.bank === "Fifth Third" && /^\d{5}$/.test(item?.zipCode ?? "")) : [];
  if (!jobs.length) { console.log("No Fifth Third ZIPs are currently selected by subscribers."); return; }
  const executablePath = edgeCandidates.find((candidate) => existsSync(candidate));
  if (!executablePath) throw new Error("Microsoft Edge was not found. Set RATE_COLLECTOR_EDGE_PATH to the browser executable.");
  const browser = await chromium.launch({ executablePath, headless: !headed });
  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36" });
    const observations = [];
    for (const job of jobs) {
      const page = await context.newPage();
      try {
        const rates = await fifthThirdRates(page, job.zipCode);
        observations.push({ bank: "Fifth Third", zipCode: job.zipCode, rates });
        console.log(`Collected ${rates.length} Fifth Third CD terms for ZIP ${job.zipCode}.`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Fifth Third collection failed.");
      } finally {
        await page.close();
      }
    }
    if (!observations.length) throw new Error("No valid Fifth Third results were collected; no existing data was overwritten.");
    if (dryRun) { console.log(JSON.stringify({ observations }, null, 2)); return; }
    const result = await request("/api/bank-rate-observations", { method: "POST", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ observations }) });
    console.log(`Stored ${result.stored} Fifth Third CD observations for ${result.observedOn}.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Rate collector failed."); process.exitCode = 1; });
