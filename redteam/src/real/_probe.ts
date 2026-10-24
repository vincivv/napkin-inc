import { ScratchWorld } from "./db";
import { RealChaosDriver } from "./chaos";
import { loadChaos } from "../load";
const w = new ScratchWorld();
const d = new RealChaosDriver(w);
for (const c of loadChaos()) for (const m of ["baseline", "napkin"] as const) {
  const t = Date.now();
  const r = await d.runCase(c, m);
  console.log(`== ${c.id} ${m} ${r.skipped ? r.skipped : r.passed ? "PASS" : "FAIL"} ${Date.now() - t}ms`);
  for (const l of r.trace) console.log("   " + l);
  for (const f of r.failures) console.log("   ! " + f);
}
w.close(); process.exit(0);
