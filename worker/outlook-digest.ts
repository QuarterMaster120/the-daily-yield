const MICROSOFT_CLIENT_ID = "2bef4f41-7653-45b9-bcfe-4dc3557ffded";
const OUTLOOK_SENDER = "startcodex@outlook.com";
const SITE_ORIGIN = "https://yield-atlas.startcodex.workers.dev";
const GRAPH_SCOPE = "offline_access User.Read https://graph.microsoft.com/Mail.Send";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const DEVICE_CODE_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TREASURY_SOURCE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";

const BANKS = ["Bank of America", "Chase", "Citizens Bank", "Fifth Third", "First American Bank", "Morgan Stanley", "PNC", "Synchrony Bank", "TD Bank", "Truist", "U.S. Bank", "Wells Fargo"] as const;
const TREASURY_TERMS = ["3 Mo", "6 Mo", "1 Yr", "2 Yr", "5 Yr", "10 Yr", "30 Yr"] as const;
const TREASURY_FIELDS = { "3 Mo": "BC_3MONTH", "6 Mo": "BC_6MONTH", "1 Yr": "BC_1YEAR", "2 Yr": "BC_2YEAR", "5 Yr": "BC_5YEAR", "10 Yr": "BC_10YEAR", "30 Yr": "BC_30YEAR" } as const;

type BankName = (typeof BANKS)[number];
type TreasuryTerm = (typeof TREASURY_TERMS)[number];

export interface OutlookDigestEnv {
  DB: D1Database;
  QUOTE_SERVICE?: Fetcher;
  OUTLOOK_TOKEN_KEY?: string;
  OUTLOOK_SETUP_TOKEN?: string;
  OUTLOOK_REFRESH_TOKEN?: string;
  RATE_INGEST_TOKEN?: string;
}

type SubscriberRow = { email: string; zip_code: string; bank_selections: string; treasury_selections: string };
type Subscriber = { email: string; zipCode: string; banks: BankName[]; treasuries: TreasuryTerm[] };
type TreasurySnapshot = { date: string; yields: Partial<Record<TreasuryTerm, number>> };
type Quote = { term: string; months: number; apy: number; balance?: string };
type BankQuote = { source: string; rates: Quote[]; error?: string };
type StoredConnection = { refresh_token_ciphertext: string; sender_email: string };
type StoredDeviceAuthorization = { device_code_ciphertext: string; expires_at: number };
type TokenResponse = { access_token?: string; refresh_token?: string; error?: string; error_description?: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function equalHash(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomId() {
  const value = new Uint8Array(24);
  crypto.getRandomValues(value);
  return base64Url(value);
}

async function readBoundedText(response: Response, maximumBytes = 1_000_000) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error("Response is too large.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) throw new Error("Response is too large.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(received); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return textDecoder.decode(combined);
}

async function readJson<T>(response: Response, maximumBytes = 250_000): Promise<T> {
  return JSON.parse(await readBoundedText(response, maximumBytes)) as T;
}

async function tokenKey(env: OutlookDigestEnv) {
  if (!env.OUTLOOK_TOKEN_KEY) throw new Error("The Outlook token key is not configured.");
  const key = fromBase64Url(env.OUTLOOK_TOKEN_KEY);
  if (key.byteLength !== 32) throw new Error("The Outlook token key is invalid.");
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function unsubscribeKey(env: OutlookDigestEnv) {
  if (!env.OUTLOOK_TOKEN_KEY) throw new Error("The Outlook token key is not configured.");
  const key = fromBase64Url(env.OUTLOOK_TOKEN_KEY);
  if (key.byteLength !== 32) throw new Error("The Outlook token key is invalid.");
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function unsubscribeToken(env: OutlookDigestEnv, email: string) {
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await unsubscribeKey(env), textEncoder.encode(`yield-atlas-unsubscribe:${email}`)));
  return base64Url(signature);
}

async function validUnsubscribeToken(env: OutlookDigestEnv, email: string, supplied: string) {
  try {
    const expected = await unsubscribeToken(env, email);
    const [expectedHash, suppliedHash] = await Promise.all([
      crypto.subtle.digest("SHA-256", textEncoder.encode(expected)),
      crypto.subtle.digest("SHA-256", textEncoder.encode(supplied)),
    ]);
    return equalHash(new Uint8Array(expectedHash), new Uint8Array(suppliedHash));
  } catch { return false; }
}

async function encryptToken(env: OutlookDigestEnv, value: string) {
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), textEncoder.encode(value)));
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv); combined.set(ciphertext, iv.byteLength);
  return base64Url(combined);
}

async function decryptToken(env: OutlookDigestEnv, value: string) {
  const combined = fromBase64Url(value);
  if (combined.byteLength <= 12) throw new Error("The stored Outlook token is invalid.");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, await tokenKey(env), combined.slice(12));
  return textDecoder.decode(plaintext);
}

async function matchesSetupToken(request: Request, env: OutlookDigestEnv) {
  const supplied = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const expected = env.OUTLOOK_SETUP_TOKEN || env.OUTLOOK_REFRESH_TOKEN || env.RATE_INGEST_TOKEN;
  if (!supplied || !expected) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(expected)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(supplied)),
  ]);
  return equalHash(new Uint8Array(expectedHash), new Uint8Array(suppliedHash));
}

async function ensureEmailTables(env: OutlookDigestEnv) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS outlook_sender_connection (id INTEGER PRIMARY KEY CHECK (id = 1), refresh_token_ciphertext TEXT NOT NULL, sender_email TEXT NOT NULL, connected_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS outlook_device_authorizations (id TEXT PRIMARY KEY, device_code_ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS email_delivery_log (delivery_key TEXT PRIMARY KEY, delivered_at TEXT NOT NULL)"),
  ]);
}

function parsedSelections<T extends string>(value: string, allowed: readonly T[], fallback: readonly T[]) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...fallback];
    const selected = [...new Set(parsed.filter((item): item is T => typeof item === "string" && allowed.includes(item as T)))];
    return selected.length ? selected : [...fallback];
  } catch {
    return [...fallback];
  }
}

function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

function subscriberFromRow(row: SubscriberRow): Subscriber | null {
  const email = row.email.trim().toLowerCase(); const zipCode = row.zip_code.trim();
  if (!validEmail(email) || !/^\d{5}$/.test(zipCode)) return null;
  return { email, zipCode, banks: parsedSelections(row.bank_selections, BANKS, BANKS), treasuries: parsedSelections(row.treasury_selections, TREASURY_TERMS, TREASURY_TERMS) };
}

async function subscribers(env: OutlookDigestEnv, recipient?: string) {
  const statement = recipient
    ? env.DB.prepare("SELECT email, zip_code, bank_selections, treasury_selections FROM subscribers WHERE email = ? LIMIT 1").bind(recipient)
    : env.DB.prepare("SELECT email, zip_code, bank_selections, treasury_selections FROM subscribers ORDER BY id ASC");
  const result = await statement.all<SubscriberRow>();
  return result.results.flatMap((row) => {
    const subscriber = subscriberFromRow(row);
    return subscriber ? [subscriber] : [];
  });
}

function easternDate(time: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(time);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, weekday: part("weekday"), hour: part("hour") };
}

function displayEasternDate(time: Date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" }).format(time);
}

function xmlValue(entry: string, field: string) {
  return entry.match(new RegExp(`<d:${field}[^>]*>([^<]+)`, "i"))?.[1] ?? "";
}

async function treasurySnapshot(now: Date): Promise<TreasurySnapshot> {
  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1];
  const documents = await Promise.all(years.map(async (year) => {
    const response = await fetch(`${TREASURY_SOURCE}?data=daily_treasury_yield_curve&field_tdr_date_value=${year}&page=0`, { headers: { Accept: "application/xml", "User-Agent": "YieldAtlas/1.0" } });
    if (!response.ok) return "";
    return readBoundedText(response, 2_000_000).catch(() => "");
  }));
  const rows = documents.flatMap((document) => (document.match(/<entry>[\s\S]*?<\/entry>/gi) ?? []).map((entry) => {
    const date = xmlValue(entry, "NEW_DATE").slice(0, 10);
    const yields = Object.fromEntries(TREASURY_TERMS.flatMap((term) => {
      const rate = Number(xmlValue(entry, TREASURY_FIELDS[term]));
      return Number.isFinite(rate) ? [[term, rate]] : [];
    })) as Partial<Record<TreasuryTerm, number>>;
    return { date, yields };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Object.keys(row.yields).length));
  rows.sort((left, right) => left.date.localeCompare(right.date));
  const latest = rows.at(-1);
  if (!latest) throw new Error("Treasury data is unavailable.");
  return latest;
}

async function bankQuote(env: OutlookDigestEnv, bank: BankName, zipCode: string): Promise<BankQuote> {
  const url = new URL("/api/quote", SITE_ORIGIN);
  url.searchParams.set("bank", bank); url.searchParams.set("zipCode", zipCode);
  try {
    const request = new Request(url, { headers: { Accept: "application/json", "User-Agent": "YieldAtlas-DailyDigest/1.0" } });
    const response = env.QUOTE_SERVICE ? await env.QUOTE_SERVICE.fetch(request) : await fetch(request);
    const payload = await readJson<{ source?: unknown; rates?: unknown; error?: unknown }>(response);
    const source = typeof payload.source === "string" ? payload.source : "";
    const rates = Array.isArray(payload.rates) ? payload.rates.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const quote = item as { term?: unknown; months?: unknown; apy?: unknown; balance?: unknown };
      return typeof quote.term === "string" && typeof quote.months === "number" && typeof quote.apy === "number" && Number.isFinite(quote.apy) ? [{ term: quote.term, months: quote.months, apy: quote.apy, balance: typeof quote.balance === "string" ? quote.balance : undefined }] : [];
    }) : [];
    return rates.length ? { source, rates } : { source, rates: [], error: typeof payload.error === "string" ? payload.error : "No current quote was returned." };
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_digest_quote_request_failed", bank, error: error instanceof Error ? error.message : String(error) }));
    return { source: "", rates: [], error: "The current public quote is unavailable." };
  }
}

async function emailBody(env: OutlookDigestEnv, subscriber: Subscriber, treasury: TreasurySnapshot, quotes: Map<BankName, BankQuote>, now: Date) {
  const treasuryText = subscriber.treasuries.flatMap((term) => {
    const rate = treasury.yields[term];
    return rate === undefined ? [] : [`${term}: ${rate.toFixed(2)}%`];
  });
  const treasuryHtml = treasuryText.length ? `<section><h2>Treasury par yields <small>(official close: ${escapeHtml(treasury.date)})</small></h2><p><strong>${escapeHtml(treasuryText.join(" · "))}</strong><br><small><a href="${TREASURY_SOURCE}">U.S. Treasury source</a></small></p></section>` : "";
  const bankRows = subscriber.banks.map((bank) => {
    const quote = quotes.get(bank) ?? { source: "", rates: [], error: "No current quote was returned." };
    const source = quote.source ? `<a class="bank-source" href="${escapeHtml(quote.source)}">Source</a>` : "";
    const rateHtml = quote.rates.length
      ? `<div class="rate-list">${quote.rates.map((rate) => `<span class="rate-chip">${escapeHtml(rate.term)}: <strong>${rate.apy.toFixed(2)}%</strong></span>`).join("")}</div>`
      : `<span class="unavailable">Unavailable — ${escapeHtml(quote.error ?? "No current quote was returned.")}</span>`;
    return `<tr><td class="bank-cell"><strong>${escapeHtml(bank)}</strong>${source}</td><td class="rate-cell">${rateHtml}</td></tr>`;
  }).join("");
  const banksHtml = bankRows ? `<section><h2>Bank CD offers</h2><table class="rates-table" role="presentation"><thead><tr><th>Bank</th><th>Term / APY</th></tr></thead><tbody>${bankRows}</tbody></table></section>` : "";
  const subject = `The Daily Yield rate note — ${displayEasternDate(now)}`;
  const unsubscribe = new URL("/unsubscribe", SITE_ORIGIN);
  unsubscribe.searchParams.set("email", subscriber.email);
  unsubscribe.searchParams.set("token", await unsubscribeToken(env, subscriber.email));
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172033;max-width:760px;margin:auto;padding:0 16px"><h1 style="font-size:22px">The Daily Yield rate note</h1><p>Prepared ${escapeHtml(displayEasternDate(now))} for ZIP <strong>${escapeHtml(subscriber.zipCode)}</strong>.</p>${treasuryHtml}${banksHtml}<p style="color:#5f6b7a;font-size:12px">Automated weekday update. Confirm current terms and disclosures with the issuing bank before acting.</p><p class="unsubscribe"><a class="unsubscribe-button" href="${escapeHtml(unsubscribe.toString())}">Unsubscribe</a></p><style>table{border-collapse:collapse;width:100%}.rates-table{table-layout:fixed}th,td{text-align:left;border-bottom:1px solid #d9e0e8;padding:12px 8px;vertical-align:top}.bank-cell{width:126px}.bank-source{display:block;margin-top:6px;font-size:12px}.rate-list{line-height:1.5}.rate-chip{display:inline-block;margin:0 8px 6px 0;white-space:nowrap}.rate-chip small{margin-left:3px}.unavailable{line-height:1.45}.unsubscribe{margin-top:24px}.unsubscribe-button{display:inline-block;border:1px solid #aeb8c4;border-radius:4px;padding:8px 12px;color:#334155;font-size:12px;text-decoration:none}h2{font-size:18px;margin:26px 0 8px}small{font-weight:normal;color:#5f6b7a}@media only screen and (max-width:600px){.rates-table,.rates-table tbody,.rates-table tr,.rates-table td{display:block;width:100%!important;box-sizing:border-box}.rates-table thead{display:none}.rates-table tr{border-bottom:1px solid #d9e0e8;padding:12px 0}.rates-table td{border:0;padding:0}.rates-table .bank-cell{font-size:17px;margin-bottom:9px}.rates-table .bank-source{display:inline;margin-left:8px}.rates-table .rate-chip{display:block;margin:0 0 6px;white-space:normal}}</style></body></html>`;
  const plain = [subject, `Prepared for ZIP ${subscriber.zipCode}.`, treasuryText.length ? `Treasury par yields (${treasury.date}): ${treasuryText.join(" · ")}` : "", ...subscriber.banks.map((bank) => {
    const quote = quotes.get(bank); const value = quote?.rates.length ? quote.rates.map((rate) => `${rate.term}: ${rate.apy.toFixed(2)}%`).join(" · ") : `Unavailable — ${quote?.error ?? "No current quote was returned."}`;
    return `${bank}: ${value}`;
  })].filter(Boolean).join("\n\n");
  return { subject, html, plain: `${plain}\n\nUnsubscribe: ${unsubscribe.toString()}` };
}

async function senderConnection(env: OutlookDigestEnv) {
  await ensureEmailTables(env);
  const existing = await env.DB.prepare("SELECT refresh_token_ciphertext, sender_email FROM outlook_sender_connection WHERE id = 1").first<StoredConnection>();
  if (existing) return existing;
  if (!env.OUTLOOK_REFRESH_TOKEN) return null;
  await replaceConnection(env, env.OUTLOOK_REFRESH_TOKEN);
  return env.DB.prepare("SELECT refresh_token_ciphertext, sender_email FROM outlook_sender_connection WHERE id = 1").first<StoredConnection>();
}

async function replaceConnection(env: OutlookDigestEnv, refreshToken: string) {
  const sealed = await encryptToken(env, refreshToken);
  await env.DB.prepare("INSERT INTO outlook_sender_connection (id, refresh_token_ciphertext, sender_email, connected_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET refresh_token_ciphertext = excluded.refresh_token_ciphertext, sender_email = excluded.sender_email, connected_at = excluded.connected_at").bind(sealed, OUTLOOK_SENDER, new Date().toISOString()).run();
}

async function graphMe(accessToken: string) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("Microsoft Graph could not confirm the sender mailbox.");
  const user = await readJson<{ mail?: unknown; userPrincipalName?: unknown }>(response);
  const address = typeof user.mail === "string" && user.mail ? user.mail : typeof user.userPrincipalName === "string" ? user.userPrincipalName : "";
  if (address.trim().toLowerCase() !== OUTLOOK_SENDER) throw new Error("Authorize the startcodex@outlook.com mailbox to send this digest.");
}

async function accessToken(env: OutlookDigestEnv) {
  const connection = await senderConnection(env);
  if (!connection) throw new Error("Outlook has not been connected yet.");
  const refreshToken = await decryptToken(env, connection.refresh_token_ciphertext);
  const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken, scope: GRAPH_SCOPE }).toString() });
  const payload = await readJson<TokenResponse>(response);
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || "Microsoft rejected the Outlook connection.");
  if (payload.refresh_token) await replaceConnection(env, payload.refresh_token);
  return payload.access_token;
}

async function sendGraphMail(access: string, recipient: string, message: { subject: string; html: string; plain: string }) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: { subject: message.subject, body: { contentType: "HTML", content: message.html }, toRecipients: [{ emailAddress: { address: recipient } }] }, saveToSentItems: true }) });
  if (!response.ok) throw new Error(`Microsoft Graph sendMail failed with status ${response.status}.`);
}

async function deliveryKey(date: string, email: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(email)));
  return `${date}:${base64Url(hash)}`;
}

async function reserveDelivery(env: OutlookDigestEnv, date: string, email: string) {
  const key = await deliveryKey(date, email);
  const result = await env.DB.prepare("INSERT OR IGNORE INTO email_delivery_log (delivery_key, delivered_at) VALUES (?, ?)").bind(key, new Date().toISOString()).run();
  return { key, reserved: result.meta.changes === 1 };
}

async function digestForSubscriber(env: OutlookDigestEnv, subscriber: Subscriber, treasury: TreasurySnapshot, quoteCache: Map<string, Promise<BankQuote>>) {
  const quotes = new Map<BankName, BankQuote>();
  for (const bank of subscriber.banks) {
    const cacheKey = `${bank}:${subscriber.zipCode}`;
    const pending = quoteCache.get(cacheKey) ?? bankQuote(env, bank, subscriber.zipCode);
    quoteCache.set(cacheKey, pending);
    quotes.set(bank, await pending);
  }
  return emailBody(env, subscriber, treasury, quotes, new Date());
}

async function sendToSubscriber(env: OutlookDigestEnv, subscriber: Subscriber, access: string, treasury: TreasurySnapshot, quoteCache: Map<string, Promise<BankQuote>>, useIdempotency: boolean) {
  const date = easternDate(new Date()).date;
  const reservation = useIdempotency ? await reserveDelivery(env, date, subscriber.email) : undefined;
  if (reservation && !reservation.reserved) return "skipped" as const;
  try {
    await sendGraphMail(access, subscriber.email, await digestForSubscriber(env, subscriber, treasury, quoteCache));
    return "sent" as const;
  } catch (error) {
    if (reservation) await env.DB.prepare("DELETE FROM email_delivery_log WHERE delivery_key = ?").bind(reservation.key).run();
    throw error;
  }
}

async function deliverDigest(env: OutlookDigestEnv, runAt: Date, force: boolean, bypassIdempotency = false) {
  const eastern = easternDate(runAt);
  if (!force && !(["Mon", "Tue", "Wed", "Thu", "Fri"].includes(eastern.weekday) && eastern.hour === "05")) return { sent: 0, skipped: 0, skippedBySchedule: true };
  await ensureEmailTables(env);
  const recipients = await subscribers(env);
  if (!recipients.length) return { sent: 0, skipped: 0, skippedBySchedule: false };
  const [access, treasury] = await Promise.all([accessToken(env), treasurySnapshot(runAt)]);
  const quoteCache = new Map<string, Promise<BankQuote>>(); let sent = 0; let skipped = 0;
  for (const recipient of recipients) {
    try {
      if (await sendToSubscriber(env, recipient, access, treasury, quoteCache, !bypassIdempotency) === "sent") sent += 1;
      else skipped += 1;
    } catch (error) {
      console.error(JSON.stringify({ event: "daily_digest_delivery_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  console.log(JSON.stringify({ event: "daily_digest_finished", sent, skipped, date: eastern.date }));
  return { sent, skipped, skippedBySchedule: false };
}

export function runScheduledDigest(env: OutlookDigestEnv, scheduledTime: number) {
  return deliverDigest(env, new Date(scheduledTime), false);
}

export function runManualDigest(env: OutlookDigestEnv) {
  return deliverDigest(env, new Date(), true, true);
}

async function quoteHealth(env: OutlookDigestEnv) {
  const recipients = await subscribers(env);
  const cache = new Map<string, Promise<BankQuote>>();
  const checks: { bank: BankName; rateCount: number }[] = [];
  for (const recipient of recipients) for (const bank of recipient.banks) {
    const key = `${bank}:${recipient.zipCode}`;
    const quote = cache.get(key) ?? bankQuote(env, bank, recipient.zipCode);
    cache.set(key, quote);
    checks.push({ bank, rateCount: (await quote).rates.length });
  }
  return { subscribers: recipients.length, checks };
}

async function startDeviceAuthorization(env: OutlookDigestEnv) {
  await ensureEmailTables(env);
  const response = await fetch(DEVICE_CODE_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, scope: GRAPH_SCOPE }).toString() });
  const payload = await readJson<{ device_code?: unknown; user_code?: unknown; verification_uri?: unknown; expires_in?: unknown }>(response);
  if (!response.ok || typeof payload.device_code !== "string" || typeof payload.user_code !== "string" || typeof payload.verification_uri !== "string" || typeof payload.expires_in !== "number") throw new Error("Microsoft could not start the device authorization.");
  const id = randomId();
  await env.DB.prepare("INSERT INTO outlook_device_authorizations (id, device_code_ciphertext, expires_at) VALUES (?, ?, ?)").bind(id, await encryptToken(env, payload.device_code), Date.now() + payload.expires_in * 1000).run();
  return { connectionId: id, userCode: payload.user_code, verificationUri: payload.verification_uri, expiresIn: payload.expires_in };
}

async function completeDeviceAuthorization(env: OutlookDigestEnv, connectionId: string) {
  await ensureEmailTables(env);
  const authorization = await env.DB.prepare("SELECT device_code_ciphertext, expires_at FROM outlook_device_authorizations WHERE id = ?").bind(connectionId).first<StoredDeviceAuthorization>();
  if (!authorization || authorization.expires_at <= Date.now()) {
    if (authorization) await env.DB.prepare("DELETE FROM outlook_device_authorizations WHERE id = ?").bind(connectionId).run();
    return { connected: false, pending: false, error: "The authorization code has expired. Start again." };
  }
  const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: await decryptToken(env, authorization.device_code_ciphertext) }).toString() });
  const payload = await readJson<TokenResponse>(response);
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    const pending = payload.error === "authorization_pending" || payload.error === "slow_down";
    return { connected: false, pending, error: pending ? "Microsoft authorization is still pending." : payload.error_description || "Microsoft did not authorize the connection." };
  }
  await graphMe(payload.access_token);
  await replaceConnection(env, payload.refresh_token);
  await env.DB.prepare("DELETE FROM outlook_device_authorizations WHERE id = ?").bind(connectionId).run();
  return { connected: true, pending: false };
}

function unsubscribePage(title: string, content: string) {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f5f7f8;font-family:Arial,sans-serif;color:#172033"><main style="max-width:520px;margin:64px auto;padding:32px;background:#fff;border:1px solid #d9e0e8;border-radius:12px"><p style="margin:0 0 12px;color:#64716d;font-size:12px;letter-spacing:.08em">THE DAILY YIELD</p><h1 style="margin:0 0 16px;font-size:26px">${escapeHtml(title)}</h1>${content}</main></body></html>`, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function handleUnsubscribe(request: Request, env: OutlookDigestEnv): Promise<Response> {
  const url = new URL(request.url);
  let email = url.searchParams.get("email")?.trim().toLowerCase() ?? "";
  let token = url.searchParams.get("token") ?? "";
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    email = typeof form?.get("email") === "string" ? form.get("email")!.trim().toLowerCase() : "";
    token = typeof form?.get("token") === "string" ? form.get("token")! : "";
  }
  if (!validEmail(email) || !token || !await validUnsubscribeToken(env, email, token)) {
    return unsubscribePage("This link is invalid", "<p>This unsubscribe link is no longer valid. Return to a recent The Daily Yield email and use its unsubscribe button.</p>");
  }
  if (request.method === "GET") {
    const form = `<p>You are about to stop The Daily Yield rate-note emails for <strong>${escapeHtml(email)}</strong>.</p><form method="post"><input type="hidden" name="email" value="${escapeHtml(email)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="border:0;border-radius:5px;background:#172033;color:#fff;padding:11px 16px;font:inherit;cursor:pointer">Confirm unsubscribe</button></form>`;
    return unsubscribePage("Unsubscribe from The Daily Yield", form);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  await env.DB.prepare("DELETE FROM subscribers WHERE email = ?").bind(email).run();
  return unsubscribePage("You’re unsubscribed", "<p>You will no longer receive The Daily Yield rate-note emails at this address.</p>");
}

export async function handleOutlookInternal(request: Request, env: OutlookDigestEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/unsubscribe") return handleUnsubscribe(request, env);
  if (!url.pathname.startsWith("/internal/outlook/")) return null;
  if (request.method !== "POST" || !await matchesSetupToken(request, env)) return Response.json({ error: "Not found" }, { status: 404 });
  if (url.pathname === "/internal/outlook/start") {
    try { return Response.json(await startDeviceAuthorization(env), { headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to start Outlook authorization." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  if (url.pathname === "/internal/outlook/complete") {
    let connectionId: unknown;
    try { ({ connectionId } = await request.json() as { connectionId?: unknown }); } catch { /* response below */ }
    if (typeof connectionId !== "string" || !connectionId || connectionId.length > 128) return Response.json({ error: "A valid authorization id is required." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    try {
      const result = await completeDeviceAuthorization(env, connectionId);
      return Response.json(result, { status: result.connected ? 200 : result.pending ? 409 : 400, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to complete Outlook authorization." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  if (url.pathname === "/internal/outlook/test") {
    const recipient = OUTLOOK_SENDER;
    try {
      await ensureEmailTables(env);
      const subscriber = (await subscribers(env, recipient))[0];
      if (!subscriber) return Response.json({ error: "No saved The Daily Yield signup exists for startcodex@outlook.com." }, { status: 409, headers: { "Cache-Control": "no-store" } });
      const [access, treasury] = await Promise.all([accessToken(env), treasurySnapshot(new Date())]);
      await sendToSubscriber(env, subscriber, access, treasury, new Map(), false);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to send the test." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  if (url.pathname === "/internal/outlook/send-today") {
    try { return Response.json(await runManualDigest(env), { headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to send today's digest." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  if (url.pathname === "/internal/outlook/quote-health") {
    try { return Response.json(await quoteHealth(env), { headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to check current quote health." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
