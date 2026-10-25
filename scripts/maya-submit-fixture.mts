// Submit the current Maya fixture to hosted maya-cookies as a PENDING version (activation stays with the owner).
// Usage (repo root): node_modules/.bin/tsx scripts/maya-submit-fixture.mts             -> dry run (proofs + checks only)
//                    node_modules/.bin/tsx scripts/maya-submit-fixture.mts --submit    -> also submits
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdbHub } from "../services/brain/src/stdb";
import { IdentityStore } from "../services/brain/src/store";
import { proveConfiguration, shutdown } from "../services/prover/src/index";

const URI = "https://maincloud.spacetimedb.com", DB = "napkin-inc-mayas", BIZ = "maya-cookies";
const DATA = fileURLToPath(new URL("../services/brain/.data-cloud", import.meta.url));
const submit = process.argv.includes("--submit");

const cfg = JSON.parse(readFileSync(new URL("../fixtures/maya/configuration.json", import.meta.url), "utf8"));
const report: any = await proveConfiguration(cfg);
const statuses = ["balanceProof", "discountProof", "flowCheck"].map((k) => `${k}=${report[k]?.status}`);
console.log("proofs:", statuses.join(" "));
if (!["balanceProof", "discountProof", "flowCheck"].every((k) => report[k]?.status === "proved")) throw new Error("not every proof passed; stopping");
await shutdown();

const hub = new StdbHub({ uri: URI, db: DB, identities: new IdentityStore(DATA, `${URI}#${DB}`) });
if (!hub.storedIdentity("system")) throw new Error("no saved system identity; stopping (would mint a new one)");
const sys = await hub.connect("system", [`SELECT * FROM config_version WHERE business_id = '${BIZ}'`]);
const versions = () => [...(sys.conn as any).db.configVersion.iter()].filter((c: any) => c.businessId === BIZ).map((c: any) => ({ id: c.id, version: c.version, status: c.status, cfgId: JSON.parse(c.json).id }));
console.log("before:", JSON.stringify(versions(), (_, v) => (typeof v === "bigint" ? String(v) : v)));
const vs = versions();
if (vs.length !== 1 || vs[0].status !== "active") throw new Error("expected exactly one (active) version; stopping");

const out = { ...cfg, id: `${BIZ}@2`, version: 2, source: `${cfg.source}; + expenses, owner stock changes, refund sales tax (2026-10-25)` };
if (!submit) {
  console.log("dry run: would submit", out.id, `(${JSON.stringify(out).length} bytes) as a pending version`);
} else {
  await hub.call("system", "submitConfiguration", (c: any) => c.reducers.submitConfiguration({ businessId: BIZ, json: JSON.stringify(out), proofReportJson: JSON.stringify(report) }));
  await new Promise((r) => setTimeout(r, 3000));
  console.log("after:", JSON.stringify(versions(), (_, v) => (typeof v === "bigint" ? String(v) : v)));
}
process.exit(0);
