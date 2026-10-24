"use client";

import { useData } from "@/data/context";
import { Badge, Card, Empty, Loading, PageHeader, cx, fmtTime, tableCls, tdCls, thCls } from "@/components/ui";
import { newestFirst, useTz } from "@/lib/hooks";

export default function AuditPage() {
  const { snapshot, session } = useData();
  const tz = useTz();
  const rows = newestFirst(snapshot.audit, (a) => a.timestamp.microsSinceUnixEpoch, (a) => a.id);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every reducer call, successful or refused, with the caller's role. Append-only." />
      {session.mode === "live" && !session.ready ? (
        <Loading />
      ) : (
        <Card pad={false}>
          {rows.length === 0 ? (
            <Empty title="Nothing logged yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>When</th>
                    <th className={thCls}>Role</th>
                    <th className={thCls}>Action</th>
                    <th className={thCls}>Result</th>
                    <th className={thCls}>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={String(a.id)}>
                      <td className={cx(tdCls, "whitespace-nowrap text-muted")}>{fmtTime(a.timestamp, tz)}</td>
                      <td className={tdCls}>{a.actorRole}</td>
                      <td className={cx(tdCls, "font-mono text-[11.5px]")}>{a.reducer}</td>
                      <td className={tdCls}>
                        <Badge tone={a.ok ? "pos" : "neg"}>{a.ok ? "ok" : "refused"}</Badge>
                      </td>
                      <td className={tdCls}>{a.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
