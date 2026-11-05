// Small line icons, drawn here rather than pulled from a package: a handful of paths isn't worth a
// dependency, and these take the text colour.
import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const SearchIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const PinIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </Icon>
);

export const LocateIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="1.5" />
  </Icon>
);

export const MapTapIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
    <path d="M9 4v14M15 6v14" />
  </Icon>
);

export const BusIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="4" y="3" width="16" height="15" rx="3" />
    <path d="M4 11h16M8 18v2M16 18v2" />
    <circle cx="8" cy="14.5" r=".6" fill="currentColor" />
    <circle cx="16" cy="14.5" r=".6" fill="currentColor" />
  </Icon>
);

export const StopIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="8" r="5" />
    <path d="M12 13v8" />
  </Icon>
);

export const WalkIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <circle cx="13" cy="4" r="1.6" />
    <path d="m9 21 2.5-6.5L14 17v4M8 11l3-3.5 3 1.5 2 3M11.5 14.5 12 8" />
  </Icon>
);

export const ClockIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const SwapIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" />
  </Icon>
);

export const CloseIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const BackIcon = ({ size = 20 }: P) => (
  <Icon size={size}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

export const ChevronIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);

export const ShareIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M12 3v12" />
    <path d="m7 8 5-5 5 5" />
    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </Icon>
);

export const HistoryIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Icon>
);

export const PlusIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const OfflineIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5" />
    <circle cx="12" cy="20" r=".8" fill="currentColor" />
  </Icon>
);

export const CheckIcon = ({ size = 18 }: P) => (
  <Icon size={size}>
    <path d="m5 12 5 5 9-10" />
  </Icon>
);

export function Logo({ size = 30 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path
        d="M8 21.5V11a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10.5"
        fill="none"
        stroke="var(--on-brand)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M8 15h16" stroke="var(--on-brand)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="22" r="2" fill="var(--on-brand)" />
      <circle cx="20" cy="22" r="2" fill="var(--on-brand)" />
    </svg>
  );
}
