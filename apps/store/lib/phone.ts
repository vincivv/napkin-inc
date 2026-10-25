// The shared phone line: one number for every shop, plus each shop's 4-digit code (from the brain).
import { useEffect, useState } from "react";
import { BRAIN_URL, PHONE_LINE } from "./env";

/** The shop's phone code, or undefined while loading, when the line is off or the brain can't be reached. */
export function usePhoneCode(businessId: string): string | undefined {
  const [code, setCode] = useState<string>();
  useEffect(() => {
    if (!PHONE_LINE) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // a brain that is restarting answers 503 or not at all: try again a few times; a 404 (not live) is final
    const load = (tries: number) =>
      fetch(`${BRAIN_URL}/phone/code/${encodeURIComponent(businessId)}`, { cache: "no-store" })
        .then(async (r) => {
          if (r.status === 404) return;
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as { code?: string };
          if (live && /^\d{4}$/.test(j.code ?? "")) setCode(j.code);
        })
        .catch(() => {
          if (live && tries > 1) timer = setTimeout(() => void load(tries - 1), 5_000);
        });
    void load(6);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [businessId]);
  return code;
}

/** "4217" -> "4 2 1 7", easier to read out. */
export const spacedCode = (code: string) => code.split("").join(" ");
