"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo, OfflineIcon } from "./icons";

/** Floats over the map on every page. Says so when there's no connection: trips still plan. */
export default function SiteHeader() {
  const path = usePathname();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  return (
    <header className="site-header">
      <Link href="/" className="brand" aria-label="TroTro, plan a trip">
        <Logo />
        <span>TroTro</span>
        <span className="brand-place">Accra</span>
      </Link>
      {!online && (
        <span className="offline" title="Trips still plan offline">
          <OfflineIcon /> Offline
        </span>
      )}
      <nav className="nav" aria-label="Pages">
        <Link href="/" className={path === "/" ? "active" : undefined}>
          Plan
        </Link>
        <Link href="/contribute" className={path === "/contribute" ? "active" : undefined}>
          <span className="long">Report a fare</span>
          <span className="short">Report</span>
        </Link>
      </nav>
    </header>
  );
}
