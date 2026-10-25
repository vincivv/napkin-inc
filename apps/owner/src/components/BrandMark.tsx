import { useId } from "react";
import { cx } from "./ui";

/** The Paper to Biz mark: a sheet of paper under a shop awning. Same drawing as docs/brand/logo-mark.svg and app/icon.svg. */
export function BrandMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg aria-hidden viewBox="0 0 512 512" className={cx("shrink-0", className)}>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1a7dff" />
          <stop offset="1" stopColor="#0050c8" />
        </linearGradient>
        <clipPath id={`${id}sheet`}>
          <path d="M140 150h232v192l-70 70H140z" />
        </clipPath>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}bg)`} />
      <path d="M140 150h232v192l-70 70H140z" fill="#fff" />
      <path d="M372 342h-70v70z" fill="#bcd6fb" />
      <path d="M176 278h160M176 324h96" stroke="#b9d3fa" strokeWidth={16} strokeLinecap="round" />
      <path clipPath={`url(#${id}sheet)`} d="M112 150h288v50a36 36 0 0 1 -72 0a36 36 0 0 1 -72 0a36 36 0 0 1 -72 0a36 36 0 0 1 -72 0z" fill="#0b3a82" opacity={0.16} />
      <path d="M122 110h62v78a36 36 0 0 1 -72 0v-68a10 10 0 0 1 10-10z" fill="#ff5a4e" />
      <path d="M184 110h72v78a36 36 0 0 1 -72 0z" fill="#fff" />
      <path d="M256 110h72v78a36 36 0 0 1 -72 0z" fill="#ff5a4e" />
      <path d="M328 110h62a10 10 0 0 1 10 10v68a36 36 0 0 1 -72 0z" fill="#fff" />
    </svg>
  );
}
