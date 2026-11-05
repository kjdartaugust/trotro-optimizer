import type { Metadata, Viewport } from "next";
import SiteHeader from "@/components/SiteHeader";
// MapLibre's styles first, so ours can override them.
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "TroTro: Accra's trotros, every route and fare",
    template: "%s · TroTro",
  },
  description:
    "Plan a trotro trip anywhere in Accra: the fastest, the cheapest and the one with fewest changes, step by step, with fares. Works offline.",
  applicationName: "TroTro",
  manifest: "/manifest.webmanifest",
  // Added to an iPhone's home screen: opens full screen, under its own name.
  appleWebApp: { capable: true, title: "TroTro", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // The on-screen keyboard pushes the search sheet up instead of covering it.
  interactiveWidget: "resizes-content",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f3f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
