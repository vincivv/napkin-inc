// The ONE place the red team imports the brain's real code (relative paths: services/brain has no package
// exports, and adding a workspace dependency would touch the shared lockfile). Everything the real runner
// drives goes through these modules: the same bootstrap, platform port, webhook dispatcher, event handlers,
// outbox worker and DEV SIMULATOR gateway the running brain uses.

export { bootstrap, configFor, MAYA, MAYA_BASELINE, ACTOR_ROLES, FIXTURE_PATH } from "../../../services/brain/src/bootstrap";
export { StdbHub, actorKey, waitFor, ReducerRefused, PlatformUnavailable, SYSTEM_SUBSCRIPTIONS } from "../../../services/brain/src/stdb";
export { IdentityStore } from "../../../services/brain/src/store";
export { StdbPlatform } from "../../../services/brain/src/platform";
export type { PlatformPort, OutboxView, ProcessorEventArgs, CreateOrderArgs } from "../../../services/brain/src/platform";
export { createApp } from "../../../services/brain/src/app";
export { createCheckout, CheckoutError } from "../../../services/brain/src/payments/checkout";
export type { SessionRecord } from "../../../services/brain/src/payments/checkout";
export { dispatchStripeEvent, verifyStripeEvent } from "../../../services/brain/src/payments/webhook";
export { handlePaymentSucceeded } from "../../../services/brain/src/payments/events";
export { OutboxWorker, RefundExecutor } from "../../../services/brain/src/payments/outbox";
export {
  SimulatorGateway,
  TransientProcessorError,
  PermanentProcessorError,
} from "../../../services/brain/src/payments/gateway";
export type { ProcessorGateway, CreateRefundParams, RefundInfo, CheckoutSessionInfo, CreateSessionParams } from "../../../services/brain/src/payments/gateway";
export type { FeeInfo } from "../../../services/brain/src/payments/events";
export { SIM, simulatedFeeCents } from "../../../services/brain/src/payments/ids";
export { newGrantCode } from "../../../services/brain/src/auth";
// the AI staff, for the compromised-model pass (the Staff runs with a scripted AgentLlm instead of Claude)
export { Staff, createAgentHarness, StdbStaffBackend } from "../../../services/brain/src/agents";
export type { AgentLlm, AgentRequest, AgentResponse } from "../../../services/brain/src/agents";
export { StdbGuardPlatform } from "../../../services/brain/src/guards/platform";
