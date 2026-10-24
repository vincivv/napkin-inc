// Writes JSON Schemas for the shared contracts to packages/schema/json/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BusinessSpec, Configuration, DecisionRecord, ProofReport } from "./index";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "json");
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries({ BusinessSpec, Configuration, DecisionRecord, ProofReport })) {
  writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }), null, 2) + "\n");
  console.log(`wrote json/${name}.schema.json`);
}
