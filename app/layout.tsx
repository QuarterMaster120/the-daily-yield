import type { Metadata } from "next";
import { headers } from "next/headers";
import { DM_Sans, Playfair_Display } from "next/font/google";
import "./globals.css";

const sans = DM_Sans({ variable: "--font-sans", subsets: ["latin"] });
const serif = Playfair_Display({ variable: "--font-serif", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const host = requestHeaders.get("host") ?? "the-daily-yield.local";
  return {
    metadataBase: new URL(`${protocol}://${host}`),
    title: "The Daily Yield | Daily CD & Treasury rates",
    description: "Track closing CD and Treasury rates. Get the daily 5 AM email.",
  openGraph: { title: "The Daily Yield", description: "Daily CD + Treasury closes", images: ["/og-the-daily-yield.png"] },
  twitter: { card: "summary_large_image", title: "The Daily Yield", images: ["/og-the-daily-yield.png"] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${serif.variable}`}>{children}</body>
    </html>
  );
}
