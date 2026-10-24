"use client";

import { useState } from "react";
import { useData } from "@/data/context";
import { Card, Loading, PageHeader, cx } from "@/components/ui";
import { DecisionFeed } from "@/components/widgets";

export default function DecisionsPage() {
  const { snapshot, session } = useData();
  const [outcome, setOutcome] = useState("all");
  const [actor, setActor] = useState("all");
  const actors = [...new Set(snapshot.decisions.map((d) => d.actorId))];
  const rows = snapshot.decisions.filter((d) => (outcome === "all" || d.outcome === outcome) && (actor === "all" || d.actorId === actor));
  const sel = "h-7 rounded-md border border-line bg-surface px-2 text-[12px]";
  return (
    <>
      <PageHeader title="Decisions" subtitle="Every agent action: who acted, which rules applied, what happened, why, and what would change the answer." />
      {session.mode === "live" && !session.ready ? (
        <Loading />
      ) : (
        <Card
          pad={false}
          title={`${rows.length} decisions`}
          actions={
            <>
              <select className={sel} value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Actor">
                <option value="all">All actors</option>
                {actors.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
              <select className={cx(sel)} value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
                {["all", "allowed", "executed", "refused", "escalated", "failed"].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </>
          }
        >
          <DecisionFeed rows={rows} />
        </Card>
      )}
    </>
  );
}
