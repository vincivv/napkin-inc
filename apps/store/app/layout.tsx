import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { fontVariables } from "@/lib/fonts";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Napkin Inc. store",
  description: "Storefronts for businesses built by Napkin Inc.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
