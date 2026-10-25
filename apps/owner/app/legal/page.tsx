"use client";

import { useData } from "@/data/context";
import { LegalChecklist } from "@/components/LegalChecklist";
import { PageHeader } from "@/components/ui";

export default function LegalPage() {
  const { snapshot } = useData();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Getting legal" subtitle="The registrations, permits and licenses a business like yours usually needs. Tick them off as you go." />
      <LegalChecklist businessId={snapshot.businessId} />
    </div>
  );
}
