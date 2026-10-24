"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { STORE_URL } from "@/lib/env";
import { StoreGate } from "./StoreShell";
import { priceLabel } from "./Products";

function useQrSvg(url: string, dark: string) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark, light: "#ffffff" } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [url, dark]);
  return svg;
}

function Qr({ url, dark, label }: { url: string; dark: string; label: string }) {
  const svg = useQrSvg(url, dark);
  return svg ? (
    <div role="img" aria-label={`QR code for ${label}`} className="aspect-square w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <div className="aspect-square w-full animate-pulse rounded-xl bg-ink/8" />
  );
}

export function QrSheet() {
  return (
    <StoreGate>
      {({ info, products }) => {
        const storeUrl = `${STORE_URL}/${info.businessId}`;
        const dark = info.theme.text;
        return (
          <div className="mx-auto max-w-3xl px-4 pt-6 print:max-w-none print:px-0 print:pt-0">
            <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 text-sm">
              <p className="text-muted">
                QR codes point to <span className="font-mono text-ink">{STORE_URL}</span>
                {STORE_URL.includes("localhost") ? " (localhost: phones can't open this; set NEXT_PUBLIC_STORE_URL)" : ""}.
              </p>
              <button type="button" onClick={() => window.print()} className="h-10 rounded-full bg-brand px-5 font-semibold text-on-brand">
                Print
              </button>
            </div>

            <section className="print-break-avoid rounded-[2rem] border-2 border-brand bg-white p-6 text-center print:break-after-page">
              <p className="text-5xl" aria-hidden>
                {info.theme.emoji}
              </p>
              <h1 className="mt-2 font-display text-4xl font-black text-brand">{info.headline}</h1>
              {info.tagline ? <p className="mt-1 text-ink/75">{info.tagline}</p> : null}
              <div className="mx-auto mt-5 w-full max-w-xs">
                <Qr url={storeUrl} dark={dark} label={info.name} />
              </div>
              <p className="mt-3 font-display text-xl font-semibold">Scan to order</p>
              <p className="mt-1 break-all font-mono text-xs text-muted">{storeUrl}</p>
            </section>

            <h2 className="no-print mb-3 mt-8 px-1 font-display text-xl font-semibold text-brand">One per item</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 print:mt-6 print:grid-cols-3">
              {products.map((p) => {
                const url = `${STORE_URL}/${info.businessId}/item/${encodeURIComponent(p.id)}`;
                return (
                  <section key={p.id} className="print-break-avoid rounded-3xl border border-line bg-white p-4 text-center">
                    <Qr url={url} dark={dark} label={p.name} />
                    <p className="mt-2 font-display text-lg font-semibold leading-tight">{p.name}</p>
                    <p className="text-sm text-muted tabular-nums">
                      {p.isAddon ? "+" : ""}
                      {priceLabel(p, info.currency)}
                    </p>
                    <p className="mt-1 break-all font-mono text-[10px] leading-tight text-muted">{url}</p>
                  </section>
                );
              })}
            </div>
          </div>
        );
      }}
    </StoreGate>
  );
}
