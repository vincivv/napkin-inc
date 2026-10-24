// Red-team BASELINE "guard": same agent, prompt and tools, but no policy checks. It only parses the
// arguments with the tool's schema (the tools need typed input) and allows every registered tool, so
// the call goes straight to the platform, where the baseline business has enforce=false.
// It still writes one DecisionRecord per call (outcome "allowed", rule "baseline.no_guard") so both
// modes leave the same audit trail. Never used outside the red-team harness.

import { hashInputs, TOOLS, type GuardCall, type GuardDecision, type GuardPlatformPort } from "../guards";
import { GuardUnavailable } from "../guards";

export class BaselineGuard {
  constructor(private readonly platform: Pick<GuardPlatformPort, "recordDecision">) {}

  async check(call: GuardCall): Promise<GuardDecision> {
    const inputsHash = hashInputs(call);
    const spec = Object.hasOwn(TOOLS, call.tool) ? TOOLS[call.tool] : undefined;
    const parsed = spec?.args.safeParse(call.args);
    const decision: GuardDecision = !spec
      ? { allow: false, outcome: "refused", ruleIds: ["unknown_tool"], reason: `unknown tool "${String(call.tool).slice(0, 64)}"`, wouldChangeIf: null, evidenceRefs: [], inputsHash }
      : !parsed!.success
        ? { allow: false, outcome: "refused", ruleIds: ["invalid_args"], reason: `arguments do not match ${call.tool}`, wouldChangeIf: null, evidenceRefs: [], inputsHash }
        : { allow: true, outcome: "allowed", ruleIds: ["baseline.no_guard"], reason: "baseline mode: no guard checks", wouldChangeIf: null, checkedArgs: parsed!.data, evidenceRefs: [`actor:${call.actor.role}`, "mode:baseline"], inputsHash };
    const args = (call.args ?? {}) as Record<string, unknown>;
    const ref = [args["orderId"], args["documentId"], args["documentRef"]].find((v) => typeof v === "string") as string | undefined;
    try {
      await this.platform.recordDecision(call.actor.role, {
        businessId: call.businessId,
        action: call.tool.slice(0, 64),
        documentRef: (ref ?? "").slice(0, 64),
        ruleIds: decision.ruleIds,
        evidenceRefs: decision.evidenceRefs,
        inputsHash,
        outcome: decision.outcome,
        reason: decision.reason,
        wouldChangeIf: "",
      });
    } catch (e) {
      throw new GuardUnavailable(`could not record the decision (call not allowed): ${(e as Error).message}`);
    }
    return decision;
  }
}
