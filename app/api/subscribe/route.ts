import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";

export async function POST(request: Request) {
  const { email, zipCode } = await request.json() as { email?: string; zipCode?: string };
  const normalized = email?.trim().toLowerCase() ?? "";
  const normalizedZip = zipCode?.trim() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if (!/^\d{5}$/.test(normalizedZip)) return Response.json({ error: "Enter a five-digit U.S. ZIP code." }, { status: 400 });
  try { await getDb().insert(subscribers).values({ email: normalized, zipCode: normalizedZip }).onConflictDoUpdate({ target: subscribers.email, set: { zipCode: normalizedZip } }); return Response.json({ ok: true }); }
  catch { return Response.json({ error: "Signup is unavailable while the database is being prepared." }, { status: 503 }); }
}
