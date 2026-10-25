"use client";

// Prices & rules: the facts the shop runs on (prices, costs, tax, discounts, refunds, hours...) laid out the way
// an owner thinks about them, each one editable in place. Edits land in the BusinessSpec (the brain coerces and
// checks them exactly like an interview answer) and change nothing for customers until the owner applies them:
// "Review & apply" compiles a new configuration (facts check, dry run, proofs), shows what customers will see
// change, and activates it only when the owner says so (invariant 6).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Badge, Button, Card, Empty, ErrorNote, Loading, OwnerButton, PageHeader, cx, errText } from "@/components/ui";
import { EditValue } from "@/components/facts";
import { brain, BrainError, type FactRow, type SpecResponse } from "@/lib/brain";
import { readConfig } from "@/lib/config";
import { STEP_LABEL, diffConfigs, streamCompile, type CompileEvent, type CompileQuestion, type DiffRow } from "@/lib/compile";
import { compiledSpecVersion, groupFacts, rowLabel } from "@/lib/rules";

type Phase =
  | { kind: "idle" }
  | { kind: "checking"; step: string }
  | { kind: "review"; configId: bigint }
  | { kind: "activating"; configId: bigint }
  | { kind: "done"; version: number }
  | { kind: "failed"; message: string; questions: CompileQuestion[] };

export default function RulesPage() {
  const { snapshot, session, config: active, actions } = useData();
  const businessId = snapshot.businessId;
  const [spec, setSpec] = useState<SpecResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editedHere, setEditedHere] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const load = useCallback(async () => {
    try {
      setSpec(await brain.spec(businessId));
    } catch (e) {
      if (!(e instanceof BrainError && e.status === 404)) setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [businessId]);
  useEffect(() => void load(), [load]);

  const groups = useMemo(() => (spec ? groupFacts(spec.facts) : undefined), [spec]);
  const liveVersion = compiledSpecVersion(active?.config);
  const unapplied = !!spec && !!active && (liveVersion !== undefined ? spec.version > liveVersion : editedHere);

  async function save(path: string, value: string): Promise<string | undefined> {
    try {
      setSpec(await brain.editFact(businessId, path, value));
      setEditedHere(true);
      if (phase.kind === "done" || phase.kind === "failed") setPhase({ kind: "idle" });
      return undefined;
    } catch (e) {
      return errText(e);
    }
  }

  async function apply() {
    setPhase({ kind: "checking", step: "Checking your changes" });
    const events: CompileEvent[] = [];
    try {
      await streamCompile(businessId, (e) => {
        events.push(e);
        if (e.event === "step" && e.data.status === "running") setPhase({ kind: "checking", step: STEP_LABEL[e.data.step] ?? "Checking" });
      });
    } catch (e) {
      return setPhase({ kind: "failed", message: errText(e), questions: [] });
    }
    const err = events.find((e) => e.event === "error");
    if (err && err.event === "error") return setPhase({ kind: "failed", message: err.data.message, questions: err.data.questions });
    const res = events.find((e) => e.event === "result");
    if (!res || res.event !== "result") return setPhase({ kind: "failed", message: "The check ended without a result. Try again.", questions: [] });
    setPhase({ kind: "review", configId: BigInt(res.data.configId) });
  }

  // A version compiled earlier (here or on Build) but never activated is waiting: offer it until dismissed.
  const [dismissed, setDismissed] = useState<bigint>();
  const waiting = useMemo(
    () => [...snapshot.configVersions].filter((c) => c.status === "pending" && c.version > (active?.row.version ?? 0)).sort((a, b) => b.version - a.version)[0],
    [snapshot.configVersions, active],
  );
  const shown: Phase = phase.kind === "idle" && waiting && waiting.id !== dismissed && !unapplied ? { kind: "review", configId: waiting.id } : phase;
  const reviewId = shown.kind === "review" || shown.kind === "activating" ? shown.configId : undefined;
  const reviewRow = reviewId !== undefined ? snapshot.configVersions.find((c) => c.id === reviewId) : undefined;
  const changes = useMemo(() => {
    const next = readConfig(reviewRow)?.config;
    return next ? diffConfigs(active?.config, next).filter((d) => d.kind !== "same" && d.section !== "Accounts" && d.section !== "Role limits") : undefined;
  }, [reviewRow, active]);

  async function makeLive() {
    if (!reviewRow) return;
    setPhase({ kind: "activating", configId: reviewRow.id });
    try {
      await actions.activateConfiguration(reviewRow.id);
      setPhase({ kind: "done", version: reviewRow.version });
      setEditedHere(false);
    } catch (e) {
      setPhase({ kind: "failed", message: errText(e), questions: [] });
    }
  }

  if ((session.mode === "live" && !session.ready) || loading) return <Loading />;

  return (
    <>
      <PageHeader
        title="Prices & rules"
        subtitle="What your shop runs on. Fix anything that’s wrong here; customers see it only after you apply it."
      />
      <ErrorNote error={error} />

      {!active && (
        <div className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
          Your shop isn’t live yet, so edits here go straight into setup.{" "}
          <Link href="/build" className="font-medium text-accent hover:underline">
            Go live on the Build page.
          </Link>
        </div>
      )}

      {active && (unapplied || shown.kind !== "idle") && (
        <ApplyBar
          phase={shown}
          changes={changes}
          onApply={() => void apply()}
          onLive={() => void makeLive()}
          onCancel={() => {
            if (reviewId !== undefined) setDismissed(reviewId);
            setPhase({ kind: "idle" });
          }}
        />
      )}

      {!groups ? (
        <Card>
          <Empty title="Nothing set up yet" hint="Start on the Intake page: snap your menu or tell me about your shop." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            {groups.items.map((it) => (
              <Card key={it.id} title={it.name?.display || "Item"}>
                <Rows rows={it.rows} onSave={save} />
                {it.sizes.map((sz) => (
                  <div key={sz.id} className="mt-3 border-t border-line pt-3">
                    <div className="mb-1 text-[12px] font-semibold text-muted">Size · {sz.name?.display || sz.id}</div>
                    <Rows rows={sz.rows} onSave={save} />
                  </div>
                ))}
                {it.addOns.map((a) => (
                  <div key={a.id} className="mt-3 border-t border-line pt-3">
                    <div className="mb-1 text-[12px] font-semibold text-muted">Add-on · {a.name?.display || a.id}</div>
                    <Rows rows={a.rows} onSave={save} />
                  </div>
                ))}
                {it.hasStock && (
                  <p className="mt-3 text-[11.5px] text-faint">
                    To change how many you have, use the{" "}
                    <Link href="/stock" className="text-accent hover:underline">
                      Stock page
                    </Link>
                    .
                  </p>
                )}
              </Card>
            ))}
            <p className="text-[12px] text-faint">
              Adding a new item? Tell me about it on the{" "}
              <Link href="/intake" className="text-accent hover:underline">
                Intake page
              </Link>
              , then come back here to apply it.
            </p>
          </div>
          <div className="space-y-4">
            <Card title="Shop rules">
              <Rows rows={groups.rules} onSave={save} />
            </Card>
            <Card title="Business details">
              <Rows rows={groups.business} onSave={save} />
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function ApplyBar({ phase, changes, onApply, onLive, onCancel }: { phase: Phase; changes: DiffRow[] | undefined; onApply(): void; onLive(): void; onCancel(): void }) {
  if (phase.kind === "done")
    return <div className="mb-4 rounded-md border border-pos/30 bg-pos-soft px-3 py-2 text-[12.5px] text-pos">Done. Your changes are live (version {phase.version}).</div>;
  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3">
      {phase.kind === "idle" && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="font-semibold text-ink">You have changes that aren’t live yet</div>
            <div className="text-[12.5px] text-muted">I’ll check them (prices, costs, the books) and show you what customers will see before anything changes.</div>
          </div>
          <OwnerButton variant="primary" size="md" onClick={onApply}>
            Review & apply
          </OwnerButton>
        </div>
      )}
      {phase.kind === "checking" && (
        <div className="flex items-center gap-3 text-[13px]">
          <span className="flex items-center gap-2 text-ink">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" /> {phase.step}…
          </span>
          <span className="text-[12px] text-muted">This takes about 20 seconds.</span>
        </div>
      )}
      {(phase.kind === "review" || phase.kind === "activating") && (
        <div>
          <div className="mb-2 text-[13px] font-semibold text-ink">Everything checks out. Here’s what will change:</div>
          {!changes ? (
            <div className="text-[12.5px] text-muted">Loading the new version…</div>
          ) : changes.length === 0 ? (
            <div className="text-[12.5px] text-muted">Nothing customers see changes (only details like hours or names, or nothing at all).</div>
          ) : (
            <ul className="space-y-1 text-[12.5px]">
              {changes.map((d) => (
                <li key={`${d.section}:${d.key}`} className="flex flex-wrap items-baseline gap-x-2">
                  <Badge tone={d.kind === "removed" ? "neg" : d.kind === "added" ? "pos" : "warn"}>{d.section}</Badge>
                  <span className="text-ink">{d.label}</span>
                  <span className="text-muted">
                    {d.before ?? "—"} → <b className="text-ink">{d.after ?? "removed"}</b>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <OwnerButton variant="primary" size="md" disabled={phase.kind === "activating" || !changes} onClick={onLive}>
              {phase.kind === "activating" ? "Going live…" : "Make it live"}
            </OwnerButton>
            <Button variant="ghost" onClick={onCancel} disabled={phase.kind === "activating"}>
              Not yet
            </Button>
          </div>
        </div>
      )}
      {phase.kind === "failed" && (
        <div className="text-[13px]">
          <div className="font-semibold text-neg">Not applied: one thing needs fixing first</div>
          <div className="mt-0.5 text-[12.5px] text-muted">{phase.message}</div>
          {phase.questions.length > 0 && (
            <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-ink">
              {phase.questions.map((q) => (
                <li key={q.id}>{q.question}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            <OwnerButton variant="primary" size="sm" onClick={onApply}>
              Try again
            </OwnerButton>
            {phase.questions.length > 0 && (
              <Link href="/interview">
                <Button size="sm">Answer it →</Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Rows({ rows, onSave }: { rows: FactRow[]; onSave(path: string, value: string): Promise<string | undefined> }) {
  if (!rows.length) return <div className="text-[12.5px] text-faint">Nothing here yet.</div>;
  return (
    <dl className="divide-y divide-line/70">
      {rows.map((f) => (
        <Row key={f.path} f={f} onSave={onSave} />
      ))}
    </dl>
  );
}

function Row({ f, onSave }: { f: FactRow; onSave(path: string, value: string): Promise<string | undefined> }) {
  const { isOwner } = useData();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const unsure = !f.missing && !f.fact.confirmed;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-2">
      <div className="min-w-0">
        <dt className="text-[12px] text-faint">{rowLabel(f)}</dt>
        <dd>
          {editing ? (
            <EditValue
              initial={f.missing ? "" : (f.display ?? "")}
              busy={busy}
              onCancel={() => {
                setEditing(false);
                setErr(undefined);
              }}
              onSave={async (v) => {
                setBusy(true);
                const e = await onSave(f.path, v);
                setBusy(false);
                setErr(e);
                if (!e) setEditing(false);
              }}
            />
          ) : (
            <span className={cx("text-[13.5px] font-medium", f.missing ? "text-faint" : "text-ink")}>{f.missing ? "Not set" : f.display || "(empty)"}</span>
          )}
          {unsure && !editing && (
            <Badge tone="warn" className="ml-2" title="Display only: never used for money until you confirm it">
              not confirmed
            </Badge>
          )}
          {err && <div className="mt-1 text-[12px] text-neg">{err}</div>}
        </dd>
      </div>
      {!editing && isOwner && (
        <button type="button" onClick={() => setEditing(true)} className="pt-3 text-[12px] font-medium text-accent hover:underline">
          {f.missing ? "Set" : "Change"}
        </button>
      )}
    </div>
  );
}
