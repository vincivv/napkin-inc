"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useData } from "@/data/context";
import { BRAIN_URL } from "@/data/env";
import { Button, Card, ErrorNote, PageHeader, errText } from "@/components/ui";

export default function SignInPage() {
  const { isOwner, session, actions, preview } = useData();
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (isOwner) router.replace("/");
  }, [isOwner, router]);

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const res = await fetch(`${BRAIN_URL}/auth/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (!res.ok || !body.code) throw new Error(body.error || (res.status === 401 || res.status === 403 ? "Wrong PIN" : `Brain responded ${res.status}`));
      await actions.redeemRoleGrant(body.code);
    } catch (e) {
      setErr(e instanceof TypeError ? `Cannot reach the brain at ${BRAIN_URL}. Is it running?` : errText(e));
    } finally {
      setPin(""); // never keep the PIN around
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm pt-10">
      <PageHeader title="Owner sign-in" subtitle="Unlocks approving, reversing, answering and confirming." />
      <Card>
        {preview ? (
          <div className="space-y-3 text-[13px]">
            <p className="text-muted">Preview mode has no real identity. Sign in with one click to try the owner actions on fake data.</p>
            <Button variant="primary" onClick={() => { preview.signIn(); router.replace("/"); }}>Sign in (preview)</Button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
            <label className="block text-[12px] font-medium text-muted" htmlFor="pin">Owner PIN</label>
            <input id="pin" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-3 text-[15px] tracking-widest" />
            <Button variant="primary" type="submit" disabled={busy || !pin || session.status !== "connected"} className="w-full">
              {busy ? "Checking…" : "Sign in"}
            </Button>
            <p className="text-[11.5px] text-faint">The PIN goes to the brain once and is never stored. It returns a one-time code that this browser’s own SpacetimeDB identity redeems for the owner role.</p>
            <ErrorNote error={err} />
          </form>
        )}
      </Card>
    </div>
  );
}
