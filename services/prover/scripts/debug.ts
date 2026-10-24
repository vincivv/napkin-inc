import { readFileSync } from "node:fs";
import { parseConfiguration } from "@napkin/schema";
import { proveBalance, shutdown } from "../src";

const maya = parseConfiguration(JSON.parse(readFileSync(new URL("../../../fixtures/maya/configuration.json", import.meta.url), "utf8")));
const ids = process.argv.slice(2);
for (const id of ids.length ? ids : maya.documents.map((d) => d.id)) {
  const t0 = performance.now();
  const r = await proveBalance(maya, id, { timeoutMs: 5000 });
  console.log(id, r.status, Math.round(performance.now() - t0), JSON.stringify(r.details, null, 1));
}
await shutdown();
