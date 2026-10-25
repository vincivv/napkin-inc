"use client";

// Build: compile the owner-confirmed BusinessSpec into configuration vN (brain POST /compile, streamed
// over SSE), compare it with the active configuration, read its proof report, and activate it. The
// compile only SUBMITS a pending version; activation is an owner action here (invariant 6).

import { PhoneLine } from "@/components/PhoneLine";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useData } from "@/data/context";
import { STORE_URL } from "@/data/env";
import { Badge, Button, Card, Empty, ErrorNote, Loading, OwnerButton, PageHeader, errText, tableCls, tdCls, thCls, type Tone } from "@/components/ui";
import { readConfig } from "@/lib/config";
import { BUILD_STEPS, STEP_LABEL, diffConfigs, latestCompile, streamCompile, type BuildStep, type CompileEvent, type DiffRow, type DiffSection } from "@/lib/compile";

type StepState = { status: "running" | "done" | "skipped" | "failed"; message: string; data?: unknown };
const stepTone: Record<StepState["status"], Tone> = { running: "info", done: "pos", skipped: "neutral", failed: "neg" };
const proofTone: Record<string, Tone> = { proved: "pos", failed: "neg", skipped: "warn" };
const diffTone: Record<DiffRow["kind"], Tone> = { added: "pos", removed: "neg", changed: "warn", same: "neutral" };
const SECTIONS: DiffSection[] = ["Prices", "Policies", "Accounts", "Stock", "Role limits", "Storefront"];

function fold(events: CompileEvent[]) {
  const steps: Partial<Record<BuildStep, StepState>> = {};
  let result: Extract<CompileEvent, { event: "result" }>["data"] | undefined;
  let error: Extract<CompileEvent, { event: "error" }>["data"] | undefined;
  for (const e of events) {
    if (e.event === "step") steps[e.data.step] = { status: e.data.status, message: e.data.message, ...(e.data.data !== undefined ? { data: e.data.data } : {}) };
    else if (e.event === "result") result = e.data;
    else error = e.data;
  }
  return { steps, result, error };
}

export default function BuildPage() {
  const { snapshot, session, config: active, actions } = useData();
  const biz = snapshot.businessId;
  const [events, setEvents] = useState<CompileEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [activateError, setActivateError] = useState<string>();
  const [activating, setActivating] = useState(false);
  const [showSame, setShowSame] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Restore the last run (or a run still in progress) after a reload.
  useEffect(() => {
    let off = false;
    void latestCompile(biz).then((l) => {
      if (!off && l) {
        setEvents(l.events);
        setRunning(l.running);
      }
    });
    return () => {
      off = true;
      abort.current?.abort();
    };
  }, [biz]);

  const run = useCallback(async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setEvents([]);
    setStartError(undefined);
    setRunning(true);
    try {
      await streamCompile(biz, (e) => setEvents((xs) => [...xs, e]), ac.signal);
    } catch (e) {
      setStartError(errText(e));
    } finally {
      if (abort.current === ac) setRunning(false);
    }
  }, [biz]);

  const { steps, result, error } = useMemo(() => fold(events), [events]);
  const dryRun = (steps.proofs?.data as { dryRun?: { subject: string; ok: boolean; refused: string | null }[] } | undefined)?.dryRun;

  // The newest pending version is the one to review and activate.
  const pendingRow = useMemo(() => [...snapshot.configVersions].filter((c) => c.status === "pending").sort((a, b) => b.version - a.version)[0], [snapshot.configVersions]);
  const pending = useMemo(() => readConfig(pendingRow), [pendingRow]);
  const diff = useMemo(() => (pending?.config ? diffConfigs(active?.config, pending.config) : []), [pending, active]);
  const changed = diff.filter((d) => d.kind !== "same").length;

  const activate = async () => {
    if (!pendingRow) return;
    setActivating(true);
    setActivateError(undefined);
    try {
      await actions.activateConfiguration(pendingRow.id);
    } catch (e) {
      setActivateError(errText(e));
    } finally {
      setActivating(false);
    }
  };

  if (session.mode === "live" && !session.ready) return <Loading />;

  const stub = pending?.proof?.solver?.includes("STUB") ?? false;
  const proofSections = pending?.proof
    ? ([["Balance proof", pending.proof.balanceProof], ["Discount proof", pending.proof.discountProof], ["Flow check", pending.proof.flowCheck]] as const)
    : [];
  const unconfirmed = pending?.config?._unconfirmed?.paths ?? [];

  return (
    <>
      <PageHeader
        title="Build"
        subtitle="Compile the confirmed facts into a configuration, check it, then activate it."
        actions={
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? (active ? "Finishing setup…" : "Compiling…") : "Compile configuration"}
          </Button>
        }
      />
      <div className="space-y-4">
        {active && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-pos/30 bg-pos-soft px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-pos">Your business is live</div>
              <div className="text-[12.5px] text-muted">Configuration v{active.row.version} is active. Customers can order from your storefront now.</div>
              <div className="text-[12.5px] text-muted">
                <PhoneLine businessId={biz} compact />
              </div>
            </div>
            <Link href="/">
              <Button size="sm">Dashboard</Button>
            </Link>
            <Link href="/storefront">
              <Button size="sm">Customize storefront</Button>
            </Link>
            <a href={`${STORE_URL}/${biz}/qr`} target="_blank" rel="noreferrer">
              <Button size="sm">QR codes ↗</Button>
            </a>
            <a href={`${STORE_URL}/${biz}`} target="_blank" rel="noreferrer">
              <Button size="sm" variant="primary">
                Open storefront ↗
              </Button>
            </a>
          </div>
        )}
        <Card title="Build progress" actions={<span className="normal-case text-faint">{biz}</span>}>
          {startError && <ErrorNote error={startError} />}
          {events.length === 0 && !running && !startError ? (
            <Empty compact title="No build yet" hint="Compile uses the facts you confirmed in the interview. Nothing about money is guessed: unconfirmed prices, costs or policies stop the build." />
          ) : (
            <ol className="divide-y divide-line">
              {BUILD_STEPS.map((s) => {
                const st = steps[s];
                return (
                  <li key={s} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span className="w-44 shrink-0 text-[13px] font-medium">{STEP_LABEL[s]}</span>
                    {st ? <Badge tone={stepTone[st.status]}>{st.status}</Badge> : <Badge>{running ? "waiting" : "not run"}</Badge>}
                    <span className="min-w-0 flex-1 break-words text-[12.5px] text-muted">{st?.message}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {error && (
            <div className="mt-3 rounded-md border border-neg/30 bg-neg-soft p-3 text-[12.5px] text-neg">
              <div className="font-medium">
                {error.questions.length > 0 ? `Almost there: ${error.questions.length === 1 ? "one thing needs" : `${error.questions.length} things need`} your answer before going live` : `Build stopped (${error.code})`}
              </div>
              {error.questions.length === 0 && <div className="mt-1 whitespace-pre-wrap">{error.message}</div>}
              {error.questions.length > 0 && (
                <>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
                    {error.questions.map((q) => (
                      <li key={q.id} title={q.fieldPath}>
                        {q.question}
                        {q.candidates && q.candidates.length > 0 && <span className="text-muted"> ({q.candidates.join(" / ")})</span>}
                      </li>
                    ))}
                  </ul>
                  <Link href="/interview" className="mt-3 inline-block">
                    <Button variant="primary" size="sm">Answer now →</Button>
                  </Link>
                  <span className="ml-2 text-[12px] text-muted">One tap each in the interview, then compile again.</span>
                </>
              )}
            </div>
          )}
          {result && result.message !== steps.submit?.message && <div className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12.5px]">{result.message}</div>}
          {dryRun && dryRun.length > 0 && (
            <details className="mt-3 text-[12.5px]">
              <summary className="cursor-pointer text-muted">Dry run: {dryRun.length} sample postings through the ledger engine</summary>
              <ul className="mt-2 space-y-0.5">
                {dryRun.map((c, i) => (
                  <li key={i} className="flex flex-wrap gap-2">
                    <Badge tone={c.ok ? "pos" : "neg"}>{c.ok ? "balanced" : "failed"}</Badge>
                    <span className="font-mono text-[11.5px]">{c.subject}</span>
                    {c.refused && <span className="text-muted">refused as expected: {c.refused}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>

        {!pendingRow ? (
          <Card title="Pending configuration">
            <Empty compact title="Nothing waiting for activation" hint={active ? `Configuration v${active.row.version} is active.` : "Compile to create the first configuration."} />
          </Card>
        ) : (
          <>
            <Card
              title={`Configuration v${pendingRow.version} vs ${active ? `active v${active.row.version}` : "nothing active"}`}
              actions={
                <label className="flex items-center gap-1.5 normal-case text-faint">
                  <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> show unchanged
                </label>
              }
              pad={false}
            >
              {pending?.error ? (
                <div className="p-4 text-[12.5px] text-neg">Stored configuration does not validate: {pending.error}</div>
              ) : changed === 0 && !showSame ? (
                <div className="p-4"><Empty compact title="No differences" hint="This version has the same prices, policies, accounts, stock, limits and storefront." /></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className={tableCls}>
                    <thead>
                      <tr>
                        <th className={thCls}>Section</th>
                        <th className={thCls}>What</th>
                        <th className={thCls}>Active</th>
                        <th className={thCls}>v{pendingRow.version}</th>
                        <th className={thCls} />
                      </tr>
                    </thead>
                    <tbody>
                      {SECTIONS.flatMap((sec) =>
                        diff
                          .filter((d) => d.section === sec && (showSame || d.kind !== "same"))
                          .map((d) => (
                            <tr key={`${sec}.${d.key}`}>
                              <td className={`${tdCls} text-muted`}>{sec}</td>
                              <td className={tdCls}>{d.label}</td>
                              <td className={`${tdCls} num text-muted`}>{d.before ?? "—"}</td>
                              <td className={`${tdCls} num`}>{d.after ?? "—"}</td>
                              <td className={tdCls}>{d.kind !== "same" && <Badge tone={diffTone[d.kind]}>{d.kind}</Badge>}</td>
                            </tr>
                          )),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {unconfirmed.length > 0 && (
              <div className="rounded-lg border border-warn/40 bg-warn-soft p-4 text-[12.5px] text-warn">
                <div className="font-semibold">Not confirmed by you (display only, never used for money)</div>
                <div className="mt-1 font-mono text-[11.5px]">{unconfirmed.join(", ")}</div>
              </div>
            )}

            <Card title={`Proof report for v${pendingRow.version}`} actions={pending?.proof ? <span className="normal-case text-faint">{pending.proof.solver ?? "solver"} · {pending.proof.generatedAt}</span> : undefined}>
              {stub && (
                <div className="mb-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                  <span className="font-semibold">Not proven.</span> The prover is a stub in this build, so every proof is marked skipped. The ledger engine still refuses any unbalanced posting, and the dry run above posted sample documents through it.
                </div>
              )}
              {!pending?.proof ? (
                <div className="text-[12.5px] text-muted">{pending?.proofError ? `Stored proof report is invalid: ${pending.proofError}` : "No proof report was stored with this version."}</div>
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  {proofSections.map(([title, r]) => (
                    <div key={title} className="rounded-md border border-line p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{title}</span>
                        <Badge tone={proofTone[r.status]}>{r.status === "skipped" && stub ? "skipped (stub)" : r.status}</Badge>
                      </div>
                      <ul className="mt-2 space-y-1 text-[12px]">
                        {r.details.map((d, i) => (
                          <li key={i}>
                            <span className="font-mono">{d.subject}</span>
                            {d.message && <div className="text-muted">{d.message}</div>}
                            {d.counterexample && <div className="font-mono text-[11px] text-neg">{JSON.stringify(d.counterexample)}</div>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div className="flex flex-wrap items-center gap-3">
                <OwnerButton
                  variant="primary"
                  onClick={() => void activate()}
                  disabled={activating}
                  {...(pending?.error ? { reason: "This version does not validate" } : {})}
                >
                  {activating ? "Activating…" : `Activate configuration v${pendingRow.version}`}
                </OwnerButton>
                <span className="text-[12.5px] text-muted">
                  {active ? `v${active.row.version} becomes superseded. Posted documents keep the version they were posted under.` : "This becomes the first active configuration."}
                </span>
              </div>
              <ErrorNote error={activateError} />
            </Card>
          </>
        )}
      </div>
    </>
  );
}
