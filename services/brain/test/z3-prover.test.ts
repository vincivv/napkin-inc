// The compiler with the real Z3 prover (services/prover) on the TEST Maya-equivalent spec.
import { afterAll, describe, expect, it } from "vitest";
import { shutdown } from "@napkin/prover";
import { compile } from "../src/compiler";
import { Z3Prover } from "../src/compiler/z3-prover";
import { mayaTestSpec, TEST_ROLE_LIMITS } from "./fixtures/maya-spec.TEST";

afterAll(() => shutdown());

describe("compile with the Z3 prover", () => {
  it("the TEST Maya spec compiles and every proof is proved (no skipped, no failed)", async () => {
    const r = await compile(mayaTestSpec(), { businessId: "maya-cookies", version: 2, prover: new Z3Prover(), roleLimits: TEST_ROLE_LIMITS });
    const p = r.proofReport;
    expect([p.balanceProof.status, p.discountProof.status, p.flowCheck.status]).toEqual(["proved", "proved", "proved"]);
    expect(p.solver).toMatch(/z3/i);
  }, 60_000);
});
