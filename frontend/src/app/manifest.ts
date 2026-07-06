import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TroTro Optimizer",
    short_name: "TroTro",
    description: "Crowdsourced, offline-first trotro route & fare optimizer for Ghana.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b132b",
    theme_color: "#0b132b",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
