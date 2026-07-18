"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type RatePoint = { date: string; rate: number };
type Series = "Treasury 1 Year" | "Treasury 10 Year" | "Ally Bank CD" | "Synchrony Bank CD" | "Chase CD" | "Fifth Third CD" | "Regions CD" | "Bank of America CD";

const options: Series[] = ["Treasury 1 Year", "Treasury 10 Year", "Ally Bank CD", "Synchrony Bank CD", "Chase CD", "Fifth Third CD", "Regions CD", "Bank of America CD"];

function RateCanvas({ points, period }: { points: RatePoint[]; period: "month" | "year" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || points.length < 2) return;
    const context = element.getContext("2d");
    if (!context) return;
    const rect = element.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
    element.width = rect.width * ratio; element.height = rect.height * ratio; context.scale(ratio, ratio);
    const width = rect.width; const height = rect.height; const inset = { x: 16, y: 24 };
    const values = points.map((point) => point.rate); const min = Math.min(...values) - .05; const max = Math.max(...values) + .05;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#e6eae5"; context.lineWidth = 1;
    for (let i = 0; i < 4; i++) { const y = inset.y + (i * (height - inset.y * 2)) / 3; context.beginPath(); context.moveTo(inset.x, y); context.lineTo(width - inset.x, y); context.stroke(); }
    const position = (index: number, value: number) => ({ x: inset.x + (index * (width - inset.x * 2)) / (points.length - 1), y: height - inset.y - ((value - min) / (max - min || 1)) * (height - inset.y * 2) });
    context.beginPath(); points.forEach((point, index) => { const p = position(index, point.rate); index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y); }); context.strokeStyle = "#126b4a"; context.lineWidth = 2.5; context.stroke();
    const final = position(points.length - 1, points[points.length - 1].rate); context.fillStyle = "#dff36a"; context.beginPath(); context.arc(final.x, final.y, 5, 0, Math.PI * 2); context.fill(); context.strokeStyle = "#126b4a"; context.lineWidth = 2; context.stroke();
    context.fillStyle = "#64716d"; context.font = "11px system-ui"; context.fillText(`${max.toFixed(2)}%`, inset.x, 13); context.fillText(`${min.toFixed(2)}%`, inset.x, height - 5); context.fillText(period === "month" ? "Daily close" : "Weekly close", width - 86, height - 5);
  }, [points, period]);
  return <canvas ref={canvas} className="chart" aria-label={`${period} closing-rate chart`} role="img" />;
}

export function RateExplorer() {
  const [series, setSeries] = useState<Series>("Treasury 1 Year");
  const [period, setPeriod] = useState<"month" | "year">("month");
  const [points, setPoints] = useState<RatePoint[]>([]);
  const [status, setStatus] = useState("Loading latest closes…");
  const [email, setEmail] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => { let active = true; setStatus("Loading latest closes…"); fetch(`/api/rates?series=${encodeURIComponent(series)}&period=${period}`).then((r) => r.json()).then((data) => { if (!active) return; setPoints(data.points || []); setStatus(data.points?.length ? "" : "Your first chart point will appear after the next 5 AM collection."); }).catch(() => active && setStatus("Rate history is temporarily unavailable.")); return () => { active = false; }; }, [series, period]);
  async function subscribe(event: FormEvent) { event.preventDefault(); setMessage("Saving your place…"); const response = await fetch("/api/subscribe", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email }) }); const data = await response.json(); setMessage(response.ok ? "You’re on the daily list." : data.error || "Please try again shortly."); if (response.ok) setEmail(""); }
  const last = points.at(-1)?.rate;
  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="mark" /> RATE LEDGER</div><div className="nav-note">Daily close rates, delivered at 5:00 AM ET</div></header>
    <section className="hero"><div><p className="eyebrow">Fixed income, made legible</p><h1>See the rate.<br />Know the close.</h1><p className="hero-copy">Track daily CD offers and the Treasury curve in one calm, clear view. No noise—just the closing rate and its history.</p></div><div className="stamp"><div className="stamp-number">5:00</div><p>Each morning, a concise rate update arrives before your day begins.</p></div></section>
    <section className="dashboard" aria-labelledby="explorer-title"><div className="dash-head"><h2 id="explorer-title">Rate explorer</h2><div className="live"><i /> Updates daily</div></div><div className="controls"><select className="select" value={series} onChange={(event) => setSeries(event.target.value as Series)} aria-label="Select a rate series">{options.map((option) => <option key={option}>{option}</option>)}</select><div className="period" aria-label="Chart aggregation"><button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>Monthly / daily</button><button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>Yearly / weekly</button></div></div><div className="chart-wrap">{points.length > 1 ? <RateCanvas points={points} period={period} /> : <div className="chart-empty"><div><strong>{status}</strong>The chart uses the final observed rate for each selected day or week.</div></div>}<div className="chart-meta"><span>Current close<strong>{last ? `${last.toFixed(2)}%` : "—"}</strong></span><span>View<strong>{period === "month" ? "Daily close" : "Week close"}</strong></span><span>Series<strong>{series}</strong></span></div></div></section>
    <section className="signup" aria-labelledby="signup-title"><div><h2 id="signup-title">Get the 5 AM rate note.</h2><p>One quick email with the day’s CD and Treasury closes.</p></div><form className="signup-form" onSubmit={subscribe}><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" aria-label="Email address" /><button type="submit">Sign me up</button>{message && <p className="form-message" role="status">{message}</p>}</form></section>
    <footer className="footer"><span>Rates are informational. Confirm offers with the issuing bank.</span><span>© 2026 Rate Ledger</span></footer>
  </main>;
}
