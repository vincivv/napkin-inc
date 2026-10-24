import { OrderView } from "@/components/OrderView";

export default async function Order({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orderId } = await params;
  const sp = await searchParams;
  // ?simulate=1 is set by the brain's DEV SIMULATOR checkout (no Stripe key yet).
  return <OrderView orderId={decodeURIComponent(orderId)} simulate={sp.simulate === "1"} />;
}
