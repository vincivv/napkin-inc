"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useData } from "@/data/context";
import { Card, Empty, Field, Loading, Money, PageHeader, StatusBadge, fmtTime } from "@/components/ui";
import { OrderAction } from "@/components/widgets";
import { FieldGrid, LinesTable, LinkedDocs } from "@/components/doc";
import { useTz } from "@/lib/hooks";
import { Badge } from "@/components/ui";

export default function OrderDetail() {
  const { id: raw } = useParams<{ id: string }>();
  const id = decodeURIComponent(raw);
  const { snapshot, session } = useData();
  const tz = useTz();
  const order = snapshot.orders.find((o) => o.id === id);
  if (!order) return session.mode === "live" && !session.ready ? <Loading /> : <Empty title={`No order ${id}`} hint={<Link className="text-accent-ink underline" href="/orders">Back to orders</Link>} />;
  const docs = snapshot.documents.filter((d) => d.externalRef === order.id || d.id === order.saleDocumentId).sort((a, b) => (a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch ? -1 : 1));
  const sale = snapshot.documents.find((d) => d.id === order.saleDocumentId) ?? docs.find((d) => d.docType === "sale");
  const events = snapshot.processorEvents.filter((e) => e.orderId === order.id);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{order.id}</span>
            <StatusBadge status={order.status} />
          </span>
        }
        subtitle={<Link href="/orders" className="hover:underline">← All orders</Link>}
        actions={<OrderAction order={order} size="md" />}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card title="Lines" pad={false}>
            {sale ? <LinesTable lines={sale.lines} /> : <Empty compact title="No sale document linked yet" hint="The sale document is created with the order and posts when payment arrives." />}
          </Card>
          {sale && (
            <Card title="Sale details">
              <FieldGrid fields={sale.fields} />
            </Card>
          )}
          <Card title="Linked documents" pad={false}>
            {docs.length ? <LinkedDocs docs={docs} /> : <Empty compact title="None yet" />}
          </Card>
          {events.length > 0 && (
            <Card title="Processor events" pad={false}>
              <div className="divide-y divide-line text-[12.5px]">
                {events.map((e) => (
                  <div key={e.eventId} className="flex items-center gap-3 px-4 py-2">
                    <Badge>{e.kind.replace(/_/g, " ")}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{e.eventId}</span>
                    <Money cents={e.amountCents} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
        <Card title="Summary">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Customer">{order.customerName || "—"}</Field>
            <Field label="Channel">{order.channel}</Field>
            <Field label="Total"><Money cents={order.totalCents} /></Field>
            <Field label="Paid"><Money cents={order.paidCents} muted0 /></Field>
            <Field label="Refunded"><Money cents={order.refundedCents} muted0 /></Field>
            <Field label="Created">{fmtTime(order.createdAt, tz)}</Field>
            <Field label="Paid at">{fmtTime(order.paidAt, tz)}</Field>
          </div>
        </Card>
      </div>
    </>
  );
}
