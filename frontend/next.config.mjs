import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  workboxOptions: {
    // Cache the offline dataset + tiles so routing survives with zero network.
    runtimeCaching: [
      {
        urlPattern: /\/sync\/(dataset|changes).*/,
        handler: "NetworkFirst",
        options: { cacheName: "trotro-dataset", expiration: { maxEntries: 8 } },
      },
      {
        urlPattern: /\.(?:png|jpg|jpeg|svg|webp|pbf|json)$/,
        handler: "StaleWhileRevalidate",
        options: { cacheName: "trotro-assets" },
      },
    ],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default withPWA(nextConfig);
