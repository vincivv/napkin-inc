import type { ReactNode } from "react";
import { StoreShell } from "@/components/StoreShell";

export default async function StoreLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <StoreShell slug={decodeURIComponent(slug)}>{children}</StoreShell>;
}
