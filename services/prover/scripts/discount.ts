import { readFileSync } from "node:fs";
import { parseConfiguration } from "@napkin/schema";
import { proveDiscountStacking, shutdown } from "../src/index";
const maya = parseConfiguration(JSON.parse(readFileSync(new URL("../../../fixtures/maya/configuration.json", import.meta.url), "utf8")));
for (const md of process.argv.slice(2).length ? process.argv.slice(2) : ["0.20", "0.75"]) {
  const cfg = structuredClone(maya); cfg.policies.maxDiscount = md;
  const log: string[] = [];
  const t0 = performance.now();
  const r = await proveDiscountStacking(cfg, { log });
  console.log(md, r.status, Math.round(performance.now() - t0), JSON.stringify(r.details, null, 1), log);
}
await shutdown();
