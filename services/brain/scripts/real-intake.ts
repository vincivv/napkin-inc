// One real photo call + one real voice call (real keys from the env), no server or platform needed.
//   pnpm --filter @napkin/brain exec tsx --env-file=/path/to/.env scripts/real-intake.ts <image> <audio> [dataDir]
// Prints only counts by provenance and the extracted values, never keys.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { intakeRoutes } from "../src/intake/routes";
import { llmFromEnv } from "../src/llm";
import { questionRoutes } from "../src/questions/routes";
import { SpecStore } from "../src/spec/store";
import { listFacts } from "../src/spec/paths";

const [imgPath, audioPath, dir] = process.argv.slice(2);
if (!imgPath) throw new Error("usage: real-intake.ts <image> [audio] [dataDir]");
const store = new SpecStore(dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "real-intake-")));
const app = new Hono();
const deps = { store, llm: llmFromEnv(), platform: undefined, cartesiaKey: process.env.CARTESIA_API_KEY };
app.route("/", intakeRoutes(deps));
app.route("/", questionRoutes(deps));

async function show(label: string, res: Response) {
  const b = (await res.json()) as { error?: string; counts?: unknown; version?: number; moneyReady?: boolean; transcript?: string; rejected?: string[]; spec?: Parameters<typeof listFacts>[0]; notes?: string };
  console.log(`\n== ${label}: HTTP ${res.status}`);
  if (b.error) return console.log("error:", b.error);
  console.log("version", b.version, "moneyReady", b.moneyReady, "counts", JSON.stringify(b.counts));
  if (b.transcript) console.log("transcript:", b.transcript);
  if (b.rejected?.length) console.log("rejected:", b.rejected);
  if (b.notes) console.log("notes:", b.notes);
  for (const { path: p, fact } of listFacts(b.spec!)) {
    if (fact.source.ref === "missing") continue;
    console.log(`  ${p} = ${JSON.stringify(fact.value)} [${fact.provenance} ${fact.confidence}] ${fact.source.region ? "region " + JSON.stringify(fact.source.region) : ""} "${fact.source.quote ?? ""}"`);
  }
}

const ext = path.extname(imgPath).slice(1).replace("jpg", "jpeg");
const fd = new FormData();
fd.set("businessId", "maya-cookies");
fd.set("image", new File([fs.readFileSync(imgPath)], path.basename(imgPath), { type: `image/${ext}` }));
await show("photo", await app.request("/intake/photo", { method: "POST", body: fd }));

if (audioPath) {
  const fv = new FormData();
  fv.set("businessId", "maya-cookies");
  fv.set("audio", new File([fs.readFileSync(audioPath)], path.basename(audioPath), { type: audioPath.endsWith(".wav") ? "audio/wav" : "audio/webm" }));
  await show("voice", await app.request("/intake/voice", { method: "POST", body: fv }));
}
const next = (await (await app.request("/questions/next?businessId=maya-cookies")).json()) as { question?: { id: string; question: string; phrased: string; phrasedBy: string; impactScore: number }; remaining: number };
console.log("\n== next question:", JSON.stringify(next.question), "remaining", next.remaining);
