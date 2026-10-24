"use client";

import { useData } from "@/data/context";
import { Badge, Card, Empty, Loading, PageHeader, type Tone } from "@/components/ui";
import { describePath, valueAtPath } from "@/lib/config";

const tone: Record<string, Tone> = { proved: "pos", failed: "neg", skipped: "neutral" };

export default function ProofPage() {
  const { config, session } = useData();
  if (session.mode === "live" && !session.ready) return <Loading />;
  if (!config) return (
    <>
      <PageHeader title="Proof report" />
      <Card><Empty title="No active configuration yet" hint="The proof report appears once a configuration is activated." /></Card>
    </>
  );
  const un = config.config?._unconfirmed;
  const proof = config.proof;
  const sections = proof
    ? ([["Balance proof", proof.balanceProof, "Every posting rule produces equal debits and credits for every input."], ["Discount proof", proof.discountProof, "No allowed discount can push a price below the margin floor."], ["Flow check", proof.flowCheck, "Documents move through their approval flow as configured."]] as const)
    : [];
  return (
    <>
      <PageHeader title="Proof report" subtitle={`Configuration v${config.row.version} · ${config.row.status}`} />
      <div className="space-y-4">
        {un && un.paths.length > 0 && (
          <div className="rounded-lg border border-warn/40 bg-warn-soft p-4">
            <h2 className="text-[14px] font-semibold text-warn">Facts not confirmed by the owner</h2>
            <p className="mt-1 text-[12.5px] text-warn/90">{un.note}</p>
            <ul className="mt-3 divide-y divide-warn/20 rounded-md border border-warn/25 bg-surface text-[13px]">
              {un.paths.map((p) => (
                <li key={p} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
                  <span className="flex-1 font-medium">{describePath(config.config, p)}</span>
                  <span className="num text-muted">{valueAtPath(config.config, p) ?? "—"}</span>
                  <span className="font-mono text-[11px] text-faint">{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {config.error && <div className="rounded-md border border-neg/30 bg-neg-soft px-3 py-2 text-[12.5px] text-neg">Stored configuration does not validate: {config.error}</div>}
        {!proof ? (
          <Card title="Machine proof">
            <div className="text-[14px] font-medium">Not proven yet (hand-written M1 configuration)</div>
            <p className="mt-1 text-[12.5px] text-muted">{config.proofError ? `Stored proof report is invalid: ${config.proofError}` : "No solver has checked this configuration. The ledger engine still refuses any unbalanced posting at runtime."}</p>
          </Card>
        ) : (
          <>
            <Card title="Machine proof" actions={<span className="normal-case text-faint">{proof.solver ?? "solver"} · {proof.generatedAt}</span>}>
              <div className="grid gap-3 md:grid-cols-3">
                {sections.map(([title, r, blurb]) => (
                  <div key={title} className="rounded-md border border-line p-3">
                    <div className="flex items-center justify-between"><span className="font-medium">{title}</span><Badge tone={tone[r.status]}>{r.status}</Badge></div>
                    <p className="mt-1 text-[12px] text-muted">{blurb}</p>
                    <ul className="mt-2 space-y-1 text-[12px]">
                      {r.details.map((d, i) => (
                        <li key={i}>
                          <Badge tone={tone[d.status]}>{d.status}</Badge> <span className="font-mono">{d.subject}</span>
                          {d.message && <div className="text-muted">{d.message}</div>}
                          {d.counterexample && <div className="font-mono text-[11px] text-neg">{JSON.stringify(d.counterexample)}</div>}
                          {d.suggestedFix && <div className="text-muted">Fix: {d.suggestedFix}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
            {proof.synthesisLog.length > 0 && (
              <Card title="Synthesis log">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-muted">{proof.synthesisLog.join("\n")}</pre>
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
