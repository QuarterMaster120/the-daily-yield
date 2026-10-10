import { existsSync, readFileSync } from "node:fs";

export const RESEND_SENDER = "The Daily Yield <daily.yield@dayshatter.com>";

function apiKey() {
  const privateFile = "C:/Users/Dallan/.codex/s6e5c3r8e2c9t9s";
  if (existsSync(privateFile)) {
    const match = readFileSync(privateFile, "utf8").match(/^\s*RESEND_API_KEY\s*=\s*(.*?)\s*$/m);
    const value = match?.[1]?.replace(/^['"]|['"]$/g, "");
    if (value) return value;
  }
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  throw new Error("Missing RESEND_API_KEY");
}

export async function sendResend(email, mail, options = {}) {
  const response = await (options.fetch ?? fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey ?? apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_SENDER,
      to: [email],
      reply_to: options.replyTo ?? process.env.ADMIN_EMAIL ?? "startcodex@outlook.com",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.unsubscribe ? { headers: { "List-Unsubscribe": `<${mail.unsubscribe}>` } } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Resend send failed with status ${response.status}.`);
  const result = await response.json();
  if (!result.id) throw new Error("Resend did not return an email ID.");
  return result.id;
}
