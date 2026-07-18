import { getDb } from "../../../db";
import { subscribers } from "../../../db/schema";

export async function POST(request: Request) {
  const { email } = await request.json() as { email?: string };
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  try { await getDb().insert(subscribers).values({ email: normalized }).onConflictDoNothing(); return Response.json({ ok: true }); }
  catch { return Response.json({ error: "Signup is unavailable while the database is being prepared." }, { status: 503 }); }
}
