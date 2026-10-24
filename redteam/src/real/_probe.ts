import { readFileSync } from "node:fs";
import { loadPlanted } from "../load";
import { auditBooks, policiesFromConfig } from "./auditor";
import { scorePlanted } from "../score";
const cfg = JSON.parse(readFileSync("../fixtures/maya/configuration.json", "utf8"));
for (const { set } of loadPlanted()) {
  const f = auditBooks(set, policiesFromConfig(cfg));
  console.log(set.id, JSON.stringify(f, null, 0));
  const s = scorePlanted(set.answerKey, f);
  console.log(s.precision, s.recall, s.missed);
}
