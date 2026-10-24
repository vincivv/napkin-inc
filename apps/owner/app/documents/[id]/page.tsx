"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useData } from "@/data/context";
import { Badge, Card, Empty, ErrorNote, Field, Loading, Money, OwnerButton, PageHeader, StatusBadge, errText, fmtTime, tableCls, tdCls, thCls, cx, Button } from "@/components/ui";
import { DocLink, FieldGrid, LinesTable } from "@/components/doc";
import { useDocMap, useTz } from "@/lib/hooks";
import { sum } from "@/lib/money";

export default function DocumentDetail() {
  const { id: raw } = useParams<{ id: string }>();
  const { snapshot, session, names, config, actions } = useData();
  const docs = useDocMap();
  const tz = useTz();
  const [reason, setReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  let id: bigint | undefined;
  try {
    id = BigInt(raw);
  } catch {
    id = undefined;
  }
  const doc = id === undefined ? undefined : docs.get(id);
  if (!doc) return session.mode === "live" && !session.ready ? <Loading /> : <Empty title={`No document ${raw}`} hint={<Link className="text-accent-ink underline" href="/documents">Back to documents</Link>} />;

  const type = config?.config?.documents.find((d) => d.id === doc.docType);
  const jl = snapshot.journalLines.filter((l) => l.documentId === doc.id);
  const mv = snapshot.registerMovements.filter((m) => m.documentId === doc.id);
  const orig = doc.reversalOf !== 0n ? docs.get(doc.reversalOf) : undefined;
  const rev = doc.reversedBy !== 0n ? docs.get(doc.reversedBy) : undefined;
  const mine = !!session.identityHex && doc.createdBy.toHexString() === session.identityHex;
  const canReverse = doc.status === "posted" && doc.reversedBy === 0n && doc.reversalOf === 0n;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await f();
      setReversing(false);
      setReason("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {names.docType(doc.docType)} #{doc.number}
            <StatusBadge status={doc.status} />
            {doc.reversalOf !== 0n && <Badge tone="neutral">reversal</Badge>}
          </span>
        }
        subtitle={<Link href="/documents" className="hover:underline">← All documents</Link>}
        actions={
          <>
            {doc.status === "draft" && (
              <OwnerButton variant="primary" size="md" disabled={busy} reason={mine ? "You created this draft; someone else must approve it" : undefined} onClick={() => run(() => actions.postDocument(doc.id))}>
                {busy ? "Posting…" : "Post document"}
              </OwnerButton>
            )}
            {canReverse && (
              <OwnerButton variant="danger" size="md" onClick={() => setReversing((v) => !v)}>
                Reverse…
              </OwnerButton>
            )}
          </>
        }
      />
      {reversing && (
        <Card className="mb-4" title="Reverse this document">
          <p className="mb-2 text-[12.5px] text-muted">Posts an equal and opposite document. Nothing is deleted. A reason is required and goes in the audit log.</p>
          <div className="flex flex-wrap gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="h-8 min-w-64 flex-1 rounded-md border border-line bg-surface px-2 text-[13px]" />
            <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => run(() => actions.reverseDocument(doc.id, reason.trim()))}>
              {busy ? "Reversing…" : "Confirm reversal"}
            </Button>
            <Button variant="ghost" onClick={() => setReversing(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      <ErrorNote error={err} />
      <div className="mt-2 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          {(orig || rev) && (
            <Card>
              <div className="text-[13px]">
                {orig && <div>Reverses <DocLink doc={orig} />{doc.note && <> — “{doc.note}”</>}</div>}
                {rev && <div>Reversed by <DocLink doc={rev} />{rev.note && <> — “{rev.note}”</>}</div>}
              </div>
            </Card>
          )}
          <Card title="Fields">
            <FieldGrid fields={doc.fields} />
          </Card>
          <Card title={`Lines (${doc.lines.length})`} pad={false}>
            <LinesTable lines={doc.lines} />
          </Card>
          <Card title={`Journal lines produced (${jl.length})`} pad={false}>
            {jl.length === 0 ? (
              <Empty compact title={doc.status === "draft" ? "Nothing posted yet" : "No journal lines"} />
            ) : (
              <div className="overflow-x-auto">
                <table className={tableCls}>
                  <thead>
                    <tr>
                      <th className={thCls}>Account</th>
                      <th className={thCls}>Rule</th>
                      <th className={thCls}>Memo</th>
                      <th className={cx(thCls, "text-right")}>Debit</th>
                      <th className={cx(thCls, "text-right")}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jl.map((l) => (
                      <tr key={String(l.id)}>
                        <td className={tdCls}>
                          <span className="font-mono text-[11.5px] text-muted">{l.accountCode}</span> {names.account(l.accountCode)}
                        </td>
                        <td className={cx(tdCls, "font-mono text-[11.5px] text-muted")}>{l.ruleId}{l.lineIndex >= 0 && ` · line ${l.lineIndex + 1}`}</td>
                        <td className={cx(tdCls, "text-muted")}>{l.memo}</td>
                        <td className={cx(tdCls, "text-right")}>{l.debitCents !== 0n && <Money cents={l.debitCents} />}</td>
                        <td className={cx(tdCls, "text-right")}>{l.creditCents !== 0n && <Money cents={l.creditCents} />}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className={tdCls} colSpan={3}>Total</td>
                      <td className={cx(tdCls, "text-right")}><Money cents={sum(jl, (l) => l.debitCents)} /></td>
                      <td className={cx(tdCls, "text-right")}><Money cents={sum(jl, (l) => l.creditCents)} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title={`Register movements (${mv.length})`} pad={false}>
            {mv.length === 0 ? (
              <Empty compact title="No register movements" />
            ) : (
              <div className="overflow-x-auto">
                <table className={tableCls}>
                  <thead>
                    <tr>
                      <th className={thCls}>Register</th>
                      <th className={thCls}>Dimensions</th>
                      <th className={thCls}>Direction</th>
                      <th className={cx(thCls, "text-right")}>Qty</th>
                      <th className={cx(thCls, "text-right")}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mv.map((m) => (
                      <tr key={String(m.id)}>
                        <td className={tdCls}>{names.register(m.registerId)}</td>
                        <td className={tdCls}>{names.dims(m.dimsKey)}</td>
                        <td className={tdCls}><Badge tone={m.kind === "in" ? "pos" : "warn"}>{m.kind}</Badge></td>
                        <td className={cx(tdCls, "num text-right")}>{m.qty.toString()}</td>
                        <td className={cx(tdCls, "text-right")}><Money cents={m.amountCents} muted0 /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Workflow">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Amount"><Money cents={doc.totalCents} muted0 /></Field>
              <Field label="Period">{doc.period}</Field>
              <Field label="Created by">{doc.createdByRole || "—"}</Field>
              <Field label="Approved by">{doc.approvedByRole || "—"}</Field>
              <Field label="Created">{fmtTime(doc.createdAt, tz)}</Field>
              <Field label="Posted">{fmtTime(doc.postedAt, tz)}</Field>
              <Field label="Reference">{doc.externalRef ? <Link className="font-mono text-[12px] text-accent-ink hover:underline" href={`/orders/${encodeURIComponent(doc.externalRef)}`}>{doc.externalRef}</Link> : "—"}</Field>
              <Field label="Config version">#{doc.configId.toString()}</Field>
            </div>
            {type && (
              <div className="mt-4 border-t border-line pt-3 text-[12px] text-muted">
                Rule: created by {type.approval.creatorRoles.join(", ") || "—"}; approved by {type.approval.approverRoles.join(", ") || "—"}
                {type.approval.cannotApproveOwn && " (never the creator)"}; posts on {type.approval.postOn}.
                {type.approval.note && <div className="mt-1 text-faint">{type.approval.note}</div>}
              </div>
            )}
            {doc.note && <div className="mt-3 text-[12.5px]"><span className="text-faint">Note: </span>{doc.note}</div>}
          </Card>
        </div>
      </div>
    </>
  );
}
