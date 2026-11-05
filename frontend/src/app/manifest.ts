import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TroTro: Accra's trotros",
    short_name: "TroTro",
    description: "Plan a trotro trip anywhere in Accra, with fares. Works offline.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f3f0",
    theme_color: "#f2f3f0",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
