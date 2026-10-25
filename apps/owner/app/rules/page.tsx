"use client";

// Prices & rules: the facts the shop runs on (prices, costs, tax, discounts, refunds, hours...) laid out the way
// an owner thinks about them, each one editable in place. Edits land in the BusinessSpec (the brain coerces and
// checks them exactly like an interview answer) and change nothing for customers until the owner applies them:
// "Review & apply" compiles a new configuration (facts check, dry run, proofs), shows what customers will see
// change, and activates it only when the owner says so (invariant 6).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Card, Empty, ErrorNote, Loading, PageHeader, errText } from "@/components/ui";
import { ApplyBar, type Phase } from "@/components/rules/ApplyBar";
import { FactRows } from "@/components/rules/FactRows";
import { ItemsTab } from "@/components/rules/ItemsTab";
import { Tabs } from "@/components/rules/Tabs";
import { brain, BrainError, type SpecResponse } from "@/lib/brain";
import { readConfig } from "@/lib/config";
import { STEP_LABEL, diffConfigs, streamCompile, type CompileEvent } from "@/lib/compile";
import { compiledSpecVersion, groupFacts } from "@/lib/rules";

type Tab = "items" | "rules" | "business";
const TABS: readonly Tab[] = ["items", "rules", "business"];

/** The selected tab lives in ?tab= (read after mount, written with replaceState so it never reloads the page). */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>("items");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
  }, []);
  const set = (t: Tab) => {
    setTab(t);
    const sp = new URLSearchParams(window.location.search);
    if (t === "items") sp.delete("tab");
    else sp.set("tab", t);
    window.history.replaceState(null, "", `${window.location.pathname}${sp.size ? `?${sp}` : ""}`);
  };
  return [tab, set];
}

export default function RulesPage() {
  const { snapshot, session, config: active, actions } = useData();
  const businessId = snapshot.businessId;
  const [spec, setSpec] = useState<SpecResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editedHere, setEditedHere] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [tab, setTab] = useTab();

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
        <div className="mb-6 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
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
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "items", label: "Items", count: groups.items.length },
              { key: "rules", label: "Shop rules" },
              { key: "business", label: "Business details" },
            ]}
          />
          {tab === "items" && <ItemsTab items={groups.items} onSave={save} />}
          {tab === "rules" && (
            <Card className="max-w-3xl">
              <p className="mb-1 text-[12.5px] text-muted">Tax, discounts, refunds and the other rules every sale follows.</p>
              <FactRows rows={groups.rules} onSave={save} empty="No shop rules set yet." />
            </Card>
          )}
          {tab === "business" && (
            <Card className="max-w-3xl">
              <p className="mb-1 text-[12.5px] text-muted">Who you are and how you operate: name, address, hours.</p>
              <FactRows rows={groups.business} onSave={save} empty="No business details set yet." />
            </Card>
          )}
        </>
      )}
    </>
  );
}
