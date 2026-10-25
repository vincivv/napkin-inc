"use client";

import { useState } from "react";
import { useAccount } from "@/data/account";
import { Button, Card, ErrorNote, PageHeader, errText } from "@/components/ui";

export default function SettingsPage() {
  const { account } = useAccount();
  if (!account) return null;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-6">
        <Card title="Account">
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-2 text-[13.5px]">
            <dt className="text-muted">Email</dt>
            <dd className="truncate text-ink">{account.email}</dd>
            <dt className="text-muted">Shop</dt>
            <dd className="truncate text-ink">{account.businessName ?? "—"}</dd>
            <dt className="text-muted">Shop address</dt>
            <dd className="truncate font-mono text-[12.5px] text-ink">{account.businessId ?? "—"}</dd>
          </dl>
        </Card>
        {account.businessId && <DeleteShop name={account.businessName ?? account.businessId} />}
      </div>
    </>
  );
}

/** Danger zone: the owner types the shop's name, then everything about the shop is deleted. The account stays. */
function DeleteShop({ name }: { name: string }) {
  const { deleteBusiness } = useAccount();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const norm = (s: string) => s.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const matches = norm(typed) === norm(name);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await deleteBusiness(typed);
      // start the app fresh: the old shop's live connection and cached data go with it
      window.location.assign("/");
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-neg/40 bg-surface shadow-card">
      <header className="border-b border-neg/30 px-5 py-3">
        <h2 className="text-[14px] font-semibold text-neg">Delete this shop</h2>
      </header>
      <div className="space-y-3 p-5 text-[13.5px]">
        <p className="text-muted">
          Deletes <span className="font-medium text-ink">{name}</span> for good: the storefront, products and prices, orders, the books, receipts, questions and your setup answers. Customers can no longer
          order. This can&apos;t be undone. Your account stays, and you can start a new shop afterwards.
        </p>
        {!open ? (
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete this shop…
          </Button>
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
            <label htmlFor="confirm-delete" className="block text-[13px] text-ink">
              Type <span className="font-semibold">{name}</span> to confirm
            </label>
            <input
              id="confirm-delete"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && matches && !busy && void run()}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-[14px] text-ink outline-none focus:border-neg"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" disabled={!matches || busy} onClick={() => void run()}>
                {busy ? "Deleting…" : "Delete forever"}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setTyped("");
                  setError(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
            <ErrorNote error={error} />
          </div>
        )}
      </div>
    </section>
  );
}
