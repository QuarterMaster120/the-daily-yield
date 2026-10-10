import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let savedConfig;
export function unsubscribeConfig() {
  if (savedConfig) return savedConfig;
  const file = fileURLToPath(new URL("./data/unsubscribe-config.json", import.meta.url));
  const encrypted = JSON.parse(readFileSync(file, "utf8")).protected;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"], { input: encrypted, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Cannot unlock unsubscribe configuration. Delivery stopped.");
  savedConfig = JSON.parse(result.stdout);
  return savedConfig;
}

export function subscriberId(email, config) {
  return createHmac("sha256", config.tokenKey).update(`subscriber:${email.trim().toLowerCase()}`).digest("hex");
}

export function unsubscribeLink(email, config = unsubscribeConfig()) {
  const id = subscriberId(email, config);
  const signature = createHmac("sha256", config.tokenKey).update(id).digest("hex");
  return `${config.url}/unsubscribe?token=${id}.${signature}`;
}

export async function unsubscribeStatus(emails, options = {}) {
  const config = options.config ?? unsubscribeConfig();
  const ids = emails.map(email => subscriberId(email, config));
  const response = await (options.fetch ?? fetch)(`${config.url}/status`, {
    method: "POST", headers: { Authorization: `Bearer ${config.statusKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Unsubscribe check failed (${response.status}). Delivery stopped.`);
  const result = await response.json();
  if (!Array.isArray(result.unsubscribed) || result.unsubscribed.some(id => !ids.includes(id))) throw new Error("Invalid unsubscribe status response. Delivery stopped.");
  return emails.filter((_, index) => result.unsubscribed.includes(ids[index]));
}

export async function syncUnsubscribes(db, options = {}) {
  const emails = db.prepare("SELECT email FROM subscribers").all().map(row => row.email);
  if (!emails.length) return 0;
  const removed = await unsubscribeStatus(emails, options);
  for (const email of removed) db.prepare("DELETE FROM subscribers WHERE email = ?").run(email);
  return removed.length;
}
