// Row types derived from the generated client bindings (never hand-copied, so they track the contract).

import type { DbConnection } from "@napkin/stdb-bindings";

type Db = DbConnection["db"];
type RowOf<K extends keyof Db> = Db[K] extends { iter(): IteratorObject<infer R, undefined> } ? R : never;

export type BusinessRow = RowOf<"business">;
export type ConfigVersionRow = RowOf<"configVersion">;
export type ActorRow = RowOf<"actor">;
export type CatalogItemRow = RowOf<"catalogItem">;
export type DocumentRow = RowOf<"document">;
export type JournalLineRow = RowOf<"journalLine">;
export type RegisterMovementRow = RowOf<"registerMovement">;
export type RegisterBalanceRow = RowOf<"registerBalance">;
export type PeriodRow = RowOf<"period">;
export type CustomerOrderRow = RowOf<"customerOrder">;
export type ProcessorEventRow = RowOf<"processorEvent">;
export type OutboxRow = RowOf<"outbox">;
export type DecisionRecordRow = RowOf<"decisionRecord">;
export type InboxItemRow = RowOf<"inboxItem">;
export type PrecedentRow = RowOf<"precedent">;
export type OwnerStatementRow = RowOf<"ownerStatement">;
export type AuditLogRow = RowOf<"auditLog">;
export type FieldValue = DocumentRow["fields"][number];
export type DocLine = DocumentRow["lines"][number];

/** Everything the owner app shows for one business. Live mode fills it from subscriptions; preview mode from a fixture. */
export interface Snapshot {
  businessId: string;
  businesses: readonly BusinessRow[];
  business: BusinessRow | undefined;
  configVersions: readonly ConfigVersionRow[];
  actors: readonly ActorRow[];
  catalogItems: readonly CatalogItemRow[];
  documents: readonly DocumentRow[];
  journalLines: readonly JournalLineRow[];
  registerMovements: readonly RegisterMovementRow[];
  registerBalances: readonly RegisterBalanceRow[];
  periods: readonly PeriodRow[];
  orders: readonly CustomerOrderRow[];
  processorEvents: readonly ProcessorEventRow[];
  outbox: readonly OutboxRow[];
  decisions: readonly DecisionRecordRow[];
  inbox: readonly InboxItemRow[];
  precedents: readonly PrecedentRow[];
  ownerStatements: readonly OwnerStatementRow[];
  audit: readonly AuditLogRow[];
}

export interface Actions {
  updateOrderStatus(orderId: string, status: "ready" | "picked_up"): Promise<void>;
  postDocument(documentId: bigint): Promise<void>;
  reverseDocument(documentId: bigint, reason: string): Promise<void>;
  answerInbox(id: bigint, answer: string, makePrecedent: boolean, precedentRule: string, conditionJson: string): Promise<void>;
  decideOwnerStatement(id: bigint, confirm: boolean): Promise<void>;
  redeemRoleGrant(code: string): Promise<void>;
  /** owner only (invariant 6): make a pending configuration active */
  activateConfiguration(configId: bigint): Promise<void>;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface Session {
  mode: "live" | "preview";
  status: ConnectionStatus;
  /** true once every subscription has delivered its initial rows */
  ready: boolean;
  error: string | undefined;
  identityHex: string | undefined;
  /** this app identity's role in the selected business ("" if none) */
  role: string;
  uri: string;
  dbName: string;
}
