import { readFileSync } from "node:fs";
import { parseConfiguration } from "@napkin/schema";
import { proveBalance, shutdown } from "../src";

const maya = parseConfiguration(JSON.parse(readFileSync(new URL("../../../fixtures/maya/configuration.json", import.meta.url), "utf8")));
const which = process.argv[2] ?? "nodiscount";
const cfg = structuredClone(maya);
const sale = cfg.documents.find((d) => d.id === "sale")!;
if (which === "nodiscount") sale.postingRules = sale.postingRules.filter((r) => r.id !== "sale.discount");
if (which === "noround") {
  sale.derived.find((d) => d.name === "discount")!.expr = "line.gross * doc.discountRate";
}
const t0 = performance.now();
const r = await proveBalance(cfg, "sale");
console.log(which, r.status, Math.round(performance.now() - t0), JSON.stringify(r.details, null, 1));
await shutdown();
