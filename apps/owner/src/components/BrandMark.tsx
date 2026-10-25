import { cx } from "./ui";

/**
 * The Paper to Biz mark: a P cut from a sheet of paper, its top-right corner folded over.
 * The letter takes the text color and the fold the accent, so it follows light and dark themes.
 * Same drawing as docs/brand/logo-mark.svg.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 100 100" className={cx("shrink-0 text-ink", className)}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M20 6H60V32H86V37C86 54 72 68 55 68H44V88A6 6 0 0 1 38 94H20A6 6 0 0 1 14 88V12A6 6 0 0 1 20 6Z M44 30H54A9 9 0 0 1 54 48H44Z"
      />
      <path fill="var(--accent)" d="M63 6V29H86Z" />
    </svg>
  );
}
