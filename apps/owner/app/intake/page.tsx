import { Card, Empty, PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <>
      <PageHeader title="Intake" subtitle="Coming in M2" />
      <Card>
        <Empty title="Coming in M2" hint="Photograph a menu, a shelf or a whiteboard and the system reads the business off it." />
      </Card>
    </>
  );
}
