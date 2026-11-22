import type { Metadata } from "next";
import { Darker_Grotesque, Karla } from "next/font/google";
import { HubShell } from "@/shared/hub/HubShell";
import "./globals.css";
import "./hub.css";

const display = Darker_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Karla({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Codevember 2026",
  description: "One word, one real-time 3D experience, every day of November 2026."
};

// The calendar, drawn on the GPU in the same renderer as the days, which open inside it (shared/hub).
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <div className="cv-root">
          <HubShell>{children}</HubShell>
          <a className="cv-site-credit" href="https://github.com/AntDX316" target="_blank" rel="noreferrer">Site by @AntDX316</a>
        </div>
      </body>
    </html>
  );
}
