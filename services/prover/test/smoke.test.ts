import { afterAll, expect, it } from "vitest";
import { proveBalance, shutdown } from "../src";
import mayaJson from "../../../fixtures/maya/configuration.json";
import { parseConfiguration } from "@napkin/schema";
const maya = parseConfiguration(mayaJson);
afterAll(shutdown);
it("smoke", async () => {
  for (const d of maya.documents) {
    const r = await proveBalance(maya, d.id);
    console.log(d.id, r.status, r.durationMs, JSON.stringify(r.details, null, 1));
  }
  const broken = structuredClone(maya);
  const sale = broken.documents.find((d) => d.id === "sale")!;
  sale.postingRules = sale.postingRules.filter((r) => r.id !== "sale.discount");
  const r = await proveBalance(broken, "sale");
  console.log(JSON.stringify(r, null, 1));
  expect(r.status).toBe("failed");
}, 60000);
