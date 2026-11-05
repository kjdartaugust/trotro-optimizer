import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  // Coming back online mustn't reload the page and lose the trip on screen.
  reloadOnOnline: false,
  // The network snapshot is only read on a first visit, and then lives in IndexedDB: not worth
  // 1.7 MB in every install. The route lines are cached when first used (below).
  publicExcludes: ["!noprecache/**/*", "!network/**/*"],
  workboxOptions: {
    // Cache the offline dataset + tiles so routing survives with zero network.
    runtimeCaching: [
      {
        urlPattern: /\/sync\/(dataset|changes).*/,
        handler: "NetworkFirst",
        options: { cacheName: "trotro-dataset", expiration: { maxEntries: 8 } },
      },
      {
        // The street map: its style, fonts and the tiles you've looked at, for next time offline.
        urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "trotro-map",
          expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 3600 },
        },
      },
      {
        urlPattern: /\.(?:png|jpg|jpeg|svg|webp|pbf|json)$/,
        handler: "StaleWhileRevalidate",
        options: { cacheName: "trotro-assets", expiration: { maxEntries: 200 } },
      },
    ],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default withPWA(nextConfig);
