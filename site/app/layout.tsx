import type { Metadata } from "next";
import { Public_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  variable: "--font-sans",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Arckive — Your chain events, in your own Postgres",
  description:
    "Give it an ABI, a contract address, and an RPC. Arckive streams every on-chain event into your own PostgreSQL — one table per event, reliable and gap-free — from a single YAML manifest.",
};

// Applied before paint so a stored theme never flashes the wrong colors.
const themeInit = `try{var t=localStorage.getItem("arckive-theme");if(t==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={`${publicSans.variable} ${jetbrains.variable}`}>
        {children}
      </body>
    </html>
  );
}
