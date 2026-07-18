import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";

const banks = ["Ally Bank", "American Express", "Bank of America", "BMO", "Capital One", "Chase", "Citizens Bank", "Fifth Third", "Huntington", "Morgan Stanley", "PNC", "Regions", "Synchrony Bank", "TD Bank", "Truist", "U.S. Bank", "Wells Fargo"];
const treasuryTerms = ["3 Mo", "6 Mo", "1 Yr", "2 Yr", "5 Yr", "10 Yr", "30 Yr"];

export async function POST(request: Request) {
  const { email, zipCode, bankSelections, treasurySelections } = await request.json() as { email?: string; zipCode?: string; bankSelections?: unknown; treasurySelections?: unknown };
  const normalized = email?.trim().toLowerCase() ?? "";
  const normalizedZip = zipCode?.trim() ?? "";
  const selectedBanks = Array.isArray(bankSelections) ? [...new Set(bankSelections.filter((bank): bank is string => typeof bank === "string" && banks.includes(bank)))] : [];
  const selectedTreasury = Array.isArray(treasurySelections) ? [...new Set(treasurySelections.filter((term): term is string => typeof term === "string" && treasuryTerms.includes(term)))] : [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if (!/^\d{5}$/.test(normalizedZip)) return Response.json({ error: "Enter a five-digit U.S. ZIP code." }, { status: 400 });
  if (!selectedBanks.length && !selectedTreasury.length) return Response.json({ error: "Choose at least one bank or Treasury maturity." }, { status: 400 });
  try { await getDb().insert(subscribers).values({ email: normalized, zipCode: normalizedZip, bankSelections: JSON.stringify(selectedBanks), treasurySelections: JSON.stringify(selectedTreasury) }).onConflictDoUpdate({ target: subscribers.email, set: { zipCode: normalizedZip, bankSelections: JSON.stringify(selectedBanks), treasurySelections: JSON.stringify(selectedTreasury) } }); return Response.json({ ok: true }); }
  catch { return Response.json({ error: "Signup is unavailable while the database is being prepared." }, { status: 503 }); }
}
