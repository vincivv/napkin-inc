import { Card, Empty, PageHeader } from "@/components/ui";

export default function Page() {
  return (
    <>
      <PageHeader title="Interview" subtitle="Coming in M2" />
      <Card>
        <Empty title="Coming in M2" hint="A short voice or chat interview confirms prices, costs and policies, replacing every placeholder." />
      </Card>
    </>
  );
}
