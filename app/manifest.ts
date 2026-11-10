import type { MetadataRoute } from 'next';
import { BASE_PATH } from '@/lib/site';

/** What lets a phone save GridAlert as an app, which iPhone requires before it will deliver alerts. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GridAlert',
    short_name: 'GridAlert',
    description: 'Get notified of large unexplained blackouts in the 50 states.',
    // No trailing slash: the page itself is /gridalert, and a scope of /gridalert/ would leave it out.
    id: BASE_PATH,
    start_url: BASE_PATH,
    scope: BASE_PATH,
    display: 'standalone',
    background_color: '#f4f1ea',
    theme_color: '#f4f1ea',
    icons: [
      { src: `${BASE_PATH}/app-icon/192`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${BASE_PATH}/app-icon/512`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${BASE_PATH}/app-icon/512`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
