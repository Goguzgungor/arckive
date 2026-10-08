import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '../components/Footer.js';
import { THEME_SCRIPT } from '../lib/theme.js';
import './globals.css';

// next/font downloads these at build time and serves them from this app:
// no request to Google at runtime.
const serif = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], axes: ['opsz'], variable: '--font-serif', display: 'swap' });
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Arckive Explorer',
  description: 'Every USDC movement and Uniswap v4 pool event on Arc mainnet, from Arckive’s own archive.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // the head script may set data-theme before React hydrates
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <div className="wrap">
          {children}
          <Footer />
        </div>
      </body>
    </html>
  );
}
