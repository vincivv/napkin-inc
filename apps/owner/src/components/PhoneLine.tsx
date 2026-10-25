"use client";

// The shop's line on the shared phone number: customers call it and say this 4-digit code to reach the shop.

import { useEffect, useState } from "react";
import { formatPhone, PHONE_LINE } from "@/data/env";
import { brain } from "@/lib/brain";
import { Card } from "./ui";

export function usePhoneCode(businessId: string | undefined): string | undefined {
  const [code, setCode] = useState<string>();
  useEffect(() => {
    if (!PHONE_LINE || !businessId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // a brain that is restarting answers 503 or not at all: try again a few times; a 404 (not live yet) is final
    const load = (tries: number) =>
      brain
        .phoneCode(businessId)
        .then((r) => live && setCode(r.code))
        .catch((e: { status?: number }) => {
          if (live && e.status !== 404 && tries > 1) timer = setTimeout(() => void load(tries - 1), 5_000);
        });
    void load(6);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [businessId]);
  return code;
}

/** compact: one line of text; otherwise the dashboard card. Nothing until the code has loaded. */
export function PhoneLine({ businessId, compact = false }: { businessId: string | undefined; compact?: boolean }) {
  const code = usePhoneCode(businessId);
  if (!PHONE_LINE || !code) return null;
  const spaced = code.split("").join(" ");
  if (compact) {
    return (
      <span>
        Phone orders: {formatPhone(PHONE_LINE)}, shop code <span className="font-semibold tabular-nums text-ink">{spaced}</span>
      </span>
    );
  }
  return (
    <Card title="Phone orders">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted">Call {formatPhone(PHONE_LINE)}, say</span>
        <span className="text-[20px] font-semibold tabular-nums tracking-[0.12em]">{spaced}</span>
      </div>
      <div className="mt-1 text-[12px] text-faint">One number for every Napkin shop: the code connects callers to yours. It's on your storefront and QR sheet.</div>
    </Card>
  );
}
