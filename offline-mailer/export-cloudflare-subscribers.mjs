import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
function loadWorkspaceEnv(file) { try { for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, ""); } } catch { /* optional local configuration */ } }
loadWorkspaceEnv(join(root, "..", ".env"));
const token = process.env.RATE_INGEST_TOKEN || process.env.HISTORY_INGEST_TOKEN;
if (!token) throw new Error("RATE_INGEST_TOKEN is required to export existing subscriptions.");
const endpoint = (process.env.SUBSCRIBER_API_URL || "https://yield-atlas.startcodex.workers.dev/api/subscribers").replace(/\/$/, "");
const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Cloudflare subscriber export returned ${response.status}.`);
const payload = await response.json();
mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "cloudflare-subscribers.json"), JSON.stringify(payload, null, 2), { mode: 0o600 });
console.log(`Exported ${Array.isArray(payload.subscribers) ? payload.subscribers.length : 0} subscriber(s).`);
