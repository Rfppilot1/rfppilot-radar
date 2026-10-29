import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "RFP Pilot Radar",
  description: "Public-sector opportunities scored for your firm.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="bg-gradient-to-br from-teal via-brand to-brand-dark text-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3">
            <Link href="/opportunities" className="flex items-baseline gap-2">
              <span className="font-serif text-xl font-bold">RFP Pilot</span>
              <span className="text-xs font-semibold tracking-[0.2em] text-cyan-200">RADAR</span>
            </Link>
            <nav aria-label="Main" className="flex gap-1 text-sm font-medium">
              <Link className="rounded-md px-3 py-1.5 hover:bg-white/15" href="/opportunities">
                Opportunities
              </Link>
              <Link className="rounded-md px-3 py-1.5 hover:bg-white/15" href="/market">
                Market
              </Link>
            </nav>
            <span className="ml-auto rounded bg-white/15 px-2 py-0.5 text-xs font-semibold tracking-wide">
              STAGING PROTOTYPE
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
