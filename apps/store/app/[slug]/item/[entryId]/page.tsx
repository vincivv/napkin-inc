import { ItemPage } from "@/components/ItemPage";

export default async function Item({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  return <ItemPage entryId={decodeURIComponent(entryId)} />;
}
