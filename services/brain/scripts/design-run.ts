// Manual real run of the storefront design generator (Claude Opus proposal + Openverse photos + Sonnet pick).
// Saves NOTHING into a brain data dir: the Openverse cache goes to a fresh temp dir; the designs are printed.
//   cd services/brain && npx tsx --env-file-if-exists=../../.env scripts/design-run.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { llmFromEnv } from "../src/llm";
import { generateDesign } from "../src/storefront";
import type { DesignInput } from "../src/storefront/design";
import { OpenverseImages } from "../src/storefront/images";
import { LlmDesignProposer } from "../src/storefront/proposer";

const BUSINESSES: DesignInput[] = [
  {
    businessId: "maya-cookies",
    businessName: "Maya's Cookies",
    oneLiner: "Fresh chocolate chip cookies, pickup only.",
    community: "student side-hustlers selling through Instagram messages and Venmo",
    tagline: "Fresh chocolate chip cookies. Order ahead, pick up.",
    fulfillment: "pickup",
    theme: { primary: "#6b3410", accent: "#e9b872", background: "#fff8ef", text: "#2b1a0e" },
    products: [
      { id: "cookie_single", name: "Chocolate chip cookie", kind: "variant" },
      { id: "cookie_box6", name: "Box of 6", kind: "variant" },
      { id: "sea_salt", name: "Sea-salt topping", kind: "addon" },
    ],
  },
  {
    businessId: "rook-supply",
    businessName: "Rook Supply",
    oneLiner: "Streetwear basics in small drops.",
    community: "skaters and students downtown",
    tagline: "Streetwear basics in small drops.",
    fulfillment: "delivery",
    theme: { primary: "#1f2937", accent: "#2563eb", background: "#ffffff", text: "#111827" },
    products: [
      { id: "hoodie", name: "Heavyweight hoodie", kind: "variant" },
      { id: "cap", name: "Six-panel cap", kind: "variant" },
      { id: "tee", name: "Boxy tee", kind: "variant" },
    ],
  },
];

const llm = llmFromEnv();
if (!llm) {
  console.error("ANTHROPIC_API_KEY is not set; nothing to run");
  process.exit(1);
}
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-design-run-"));
const images = new OpenverseImages({ cacheDir, vision: llm });
const proposer = new LlmDesignProposer(llm);

for (const b of BUSINESSES) {
  const t0 = Date.now();
  const timed = {
    proposer: { name: proposer.name, propose: async (i: DesignInput) => { const t = Date.now(); const r = await proposer.propose(i); console.error(`[${b.businessId}] proposal ${Date.now() - t} ms`); return r; } },
    images: { resolve: async (s: Parameters<OpenverseImages["resolve"]>[0]) => { const t = Date.now(); console.error(`[${b.businessId}] queries: ${s.map((x) => `${x.key}="${x.query}"`).join(", ")}`); const r = await images.resolve(s); console.error(`[${b.businessId}] photos ${Date.now() - t} ms`); return r; } },
  };
  const design = await generateDesign(b, timed);
  console.error(`[${b.businessId}] total ${Date.now() - t0} ms`);
  console.log(JSON.stringify(design, null, 2));
}
fs.rmSync(cacheDir, { recursive: true, force: true });
