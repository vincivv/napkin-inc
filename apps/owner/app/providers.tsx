"use client";

import type { ReactNode } from "react";
import { DataProvider } from "@/data/context";
import { Shell } from "@/components/shell";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <DataProvider>
      <Shell>{children}</Shell>
    </DataProvider>
  );
}
