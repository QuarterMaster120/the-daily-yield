"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Quote = { term: string; months: number; apy: number };
type Treasury = { date: string; oneYear: number; tenYear: number; thirtyYear: number };

const banks = ["Ally Bank", "American Express", "Bank of America", "Capital One", "Chase", "Fifth Third", "Marcus by Goldman Sachs", "Regions", "Synchrony Bank"];

function RateCanvas({ points }: { points: Quote[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current; if (!element || !points.length) return;
    const context = element.getContext("2d"); if (!context) return;
    const rect = element.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
    element.width = rect.width * ratio; element.height = rect.height * ratio; context.scale(ratio, ratio);
    const width = rect.width; const height = rect.height; const inset = { x: 38, y: 28 }; const max = Math.max(...points.map((point) => point.apy), 0.1) + .15;
    context.clearRect(0, 0, width, height); context.strokeStyle = "#e6eae5"; context.lineWidth = 1;
    for (let i = 0; i < 4; i++) { const y = inset.y + (i * (height - inset.y * 2)) / 3; context.beginPath(); context.moveTo(inset.x, y); context.lineTo(width - inset.x, y); context.stroke(); context.fillStyle = "#64716d"; context.font = "11px system-ui"; context.fillText(`${(max * (3 - i) / 3).toFixed(2)}%`, 0, y + 3); }
    const gap = Math.max(6, (width - inset.x * 2) / points.length * .22); const bar = Math.max(10, (width - inset.x * 2 - gap * (points.length - 1)) / points.length);
    points.forEach((point, index) => { const x = inset.x + index * (bar + gap); const barHeight = (point.apy / max) * (height - inset.y * 2); const y = height - inset.y - barHeight; context.fillStyle = "#126b4a"; context.fillRect(x, y, bar, barHeight); context.fillStyle = "#19201e"; context.font = "600 11px system-ui"; context.textAlign = "center"; context.fillText(`${point.apy.toFixed(2)}%`, x + bar / 2, Math.max(15, y - 7)); context.fillStyle = "#64716d"; context.font = "10px system-ui"; context.fillText(point.term.replace(" Months", "m").replace(" Month", "m").replace(" Years", "y").replace(" Year", "y"), x + bar / 2, height - 7); });
  }, [points]);
  return <canvas ref={canvas} className="chart" aria-label="Live CD APY by term" role="img" />;
}

export function RateExplorer() {
  const [bank, setBank] = useState("Chase"); const [zipCode, setZipCode] = useState(""); const [points, setPoints] = useState<Quote[]>([]); const [status, setStatus] = useState("Choose a bank and ZIP to generate a live quote chart."); const [source, setSource] = useState(""); const [locationSensitive, setLocationSensitive] = useState(false);
  const [email, setEmail] = useState(""); const [signupZip, setSignupZip] = useState(""); const [message, setMessage] = useState(""); const [treasury, setTreasury] = useState<Treasury | null>(null);
  useEffect(() => { fetch("/api/yield-curve").then((response) => response.ok ? response.json() : null).then((data) => data?.date && setTreasury(data)).catch(() => undefined); }, []);
  async function quote(event: FormEvent) { event.preventDefault(); if (!/^\d{5}$/.test(zipCode)) { setStatus("Enter a five-digit U.S. ZIP code."); return; } setStatus("Retrieving the bank’s live public quote…"); setPoints([]); try { const response = await fetch(`/api/quote?bank=${encodeURIComponent(bank)}&zipCode=${zipCode}`); const data = await response.json(); setSource(data.source ?? ""); setLocationSensitive(Boolean(data.locationSensitive)); if (!response.ok) { setStatus(data.error ?? "The live quote is unavailable."); return; } setPoints(data.rates); setStatus(""); } catch { setStatus("The live quote is temporarily unavailable."); } }
  async function subscribe(event: FormEvent) { event.preventDefault(); setMessage("Saving your delivery preferences…"); const response = await fetch("/api/subscribe", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email, zipCode: signupZip }) }); const data = await response.json(); setMessage(response.ok ? "You’re on the 5 AM list for this ZIP." : data.error || "Please try again shortly."); if (response.ok) { setEmail(""); setSignupZip(""); } }
  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="mark" /> RATE LEDGER</div><div className="nav-note">ZIP-specific CD quotes, delivered at 5:00 AM ET</div></header>
    <section className="hero"><div><p className="eyebrow">Fixed income, made legible</p><h1>See the rate.<br />Know your market.</h1><p className="hero-copy">Generate a fresh CD-rate chart for a bank and ZIP code—no recycled bank-rate history. Treasury values come directly from the official daily curve.</p></div><div className="stamp"><div className="stamp-number">5:00</div><p>Each morning, a ZIP-aware rate update arrives before your day begins.</p></div></section>
    <section className="treasury-strip" aria-label="Latest Treasury par yields"><div><span>1-year Treasury</span><strong>{treasury ? `${treasury.oneYear.toFixed(2)}%` : "—"}</strong></div><div><span>10-year Treasury</span><strong>{treasury ? `${treasury.tenYear.toFixed(2)}%` : "—"}</strong></div><div><span>30-year Treasury</span><strong>{treasury ? `${treasury.thirtyYear.toFixed(2)}%` : "—"}</strong></div><small>{treasury ? `Official close: ${treasury.date}` : "Official Treasury curve loading…"}</small></section>
    <section className="dashboard" aria-labelledby="explorer-title"><div className="dash-head"><h2 id="explorer-title">Live bank CD quote</h2><div className="live"><i /> Generated on demand</div></div><form className="controls quote-controls" onSubmit={quote}><select className="select" value={bank} onChange={(event) => setBank(event.target.value)} aria-label="Select a bank">{banks.map((option) => <option key={option}>{option}</option>)}</select><input className="select zip-input" value={zipCode} onChange={(event) => setZipCode(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" pattern="\d{5}" placeholder="ZIP code" aria-label="ZIP code" /><button className="quote-button" type="submit">Generate chart</button></form><div className="chart-wrap">{points.length ? <RateCanvas points={points} /> : <div className="chart-empty"><div><strong>{status}</strong>Each bar represents the current APY for a CD term returned by the official bank source.</div></div>}<div className="chart-meta"><span>Market<strong>{zipCode || "Enter ZIP"}</strong></span><span>Quote<strong>{locationSensitive ? "ZIP-sensitive offer" : "National offer"}</strong></span><span>Source<strong>{source ? "Official bank page" : "Awaiting request"}</strong></span></div>{source && <p className="source-note">Some branch-market banks require an interactive ZIP gate. If no usable quote is returned, verify availability at <a href={source} target="_blank" rel="noreferrer">the official bank page</a>.</p>}</div></section>
    <section className="signup" aria-labelledby="signup-title"><div><h2 id="signup-title">Get the 5 AM rate note.</h2><p>One ZIP-aware email with current CD offers and the Treasury curve.</p></div><form className="signup-form" onSubmit={subscribe}><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" aria-label="Email address" /><input required value={signupZip} onChange={(event) => setSignupZip(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" pattern="\d{5}" placeholder="ZIP code" aria-label="ZIP code for daily emails" /><button type="submit">Sign me up</button>{message && <p className="form-message" role="status">{message}</p>}</form></section>
    <footer className="footer"><span>Rates are informational. Confirm offers with the issuing bank.</span><span>© 2026 Rate Ledger</span></footer>
  </main>;
}
