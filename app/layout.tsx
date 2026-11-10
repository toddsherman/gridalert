import type { Metadata } from 'next';
import Link from 'next/link';
import { LiveStamp } from '@/components/LiveStamp';
import { TooltipLayer } from '@/components/TooltipLayer';
import { getSnapshot } from '@/lib/data';
import { BASE_PATH } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  title: 'GridAlert',
  description: 'Get an alert when a large blackout in the 50 states has no explanation.',
  // On iPhone, alerts need the site saved to the Home Screen as an app.
  appleWebApp: { capable: true, title: 'GridAlert', statusBarStyle: 'default' },
  // With the base path written in, since metadata URLs don't get it.
  icons: {
    icon: [
      { url: `${BASE_PATH}/app-icon/32`, sizes: '32x32', type: 'image/png' },
      { url: `${BASE_PATH}/app-icon/192`, sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: `${BASE_PATH}/app-icon/180`, sizes: '180x180', type: 'image/png' }],
  },
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const snapshot = await getSnapshot();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <nav className="todd-return" aria-label="Return to todd.sh">
          <a href="https://www.todd.sh/"><span aria-hidden="true">←</span> todd.sh</a>
        </nav>
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex min-h-11 items-center gap-2 font-serif text-xl font-semibold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink" aria-hidden>
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-surface">
                  <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
                </svg>
              </span>
              GridAlert
            </Link>
            <div className="ml-auto">
              <LiveStamp generatedAt={snapshot?.generatedAt ?? null} />
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-10">{children}</main>
        <TooltipLayer />
      </body>
    </html>
  );
}
