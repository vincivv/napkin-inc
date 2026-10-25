"use client";

// LIVE MODE: SpacetimeDB subscriptions for one business. Every table is subscribed with a
// business filter, so new rows arrive in the same transaction the platform commits them.

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { SpacetimeDBProvider, useSpacetimeDB, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "@napkin/stdb-bindings";
import { DataValueProvider } from "./context";
import type { Actions, ConnectionStatus, Session, Snapshot } from "./types";
import { STDB_DB, STDB_URI, safeGet, safeSet, tokenKey } from "./env";

export function LiveSource({ businessId, accountId, children }: { businessId: string; accountId: string; children: ReactNode }) {
  const builder = useMemo(() => {
    const key = tokenKey(STDB_URI, STDB_DB, accountId);
    return DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_DB)
      .withToken(safeGet("local", key) ?? undefined)
      .withAutomaticReconnect()
      .onConnect((_conn, _identity, token) => {
        // This account's own SpacetimeDB identity in this browser; the owner role is attached to it after sign-in.
        safeSet("local", key, token);
      });
  }, [accountId]);
  return (
    <SpacetimeDBProvider connectionBuilder={builder}>
      <LiveData businessId={businessId}>
        {children}
      </LiveData>
    </SpacetimeDBProvider>
  );
}

function LiveData({ businessId, children }: { businessId: string; children: ReactNode }) {
  const conn = useSpacetimeDB();
  const b = businessId;
  const [businesses, r0] = useTable(tables.business);
  const [configVersions, r1] = useTable(tables.configVersion.where((r) => r.businessId.eq(b)));
  const [actors, r2] = useTable(tables.actor.where((r) => r.businessId.eq(b)));
  const [catalogItems, r3] = useTable(tables.catalogItem.where((r) => r.businessId.eq(b)));
  const [documents, r4] = useTable(tables.document.where((r) => r.businessId.eq(b)));
  const [journalLines, r5] = useTable(tables.journalLine.where((r) => r.businessId.eq(b)));
  const [registerMovements, r6] = useTable(tables.registerMovement.where((r) => r.businessId.eq(b)));
  const [registerBalances, r7] = useTable(tables.registerBalance.where((r) => r.businessId.eq(b)));
  const [periods, r8] = useTable(tables.period.where((r) => r.businessId.eq(b)));
  const [orders, r9] = useTable(tables.customerOrder.where((r) => r.businessId.eq(b)));
  const [processorEvents, r10] = useTable(tables.processorEvent.where((r) => r.businessId.eq(b)));
  const [outbox, r11] = useTable(tables.outbox.where((r) => r.businessId.eq(b)));
  const [decisions, r12] = useTable(tables.decisionRecord.where((r) => r.businessId.eq(b)));
  const [inbox, r13] = useTable(tables.inboxItem.where((r) => r.businessId.eq(b)));
  const [precedents, r14] = useTable(tables.precedent.where((r) => r.businessId.eq(b)));
  const [ownerStatements, r15] = useTable(tables.ownerStatement.where((r) => r.businessId.eq(b)));
  const [audit, r16] = useTable(tables.auditLog.where((r) => r.businessId.eq(b)));
  const ready = r0 && r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9 && r10 && r11 && r12 && r13 && r14 && r15 && r16;

  const snapshot = useMemo<Snapshot>(
    () => ({
      businessId: b,
      businesses,
      business: businesses.find((x) => x.id === b),
      configVersions, actors, catalogItems, documents, journalLines, registerMovements, registerBalances, periods,
      orders, processorEvents, outbox, decisions, inbox, precedents, ownerStatements, audit,
    }),
    [b, businesses, configVersions, actors, catalogItems, documents, journalLines, registerMovements, registerBalances, periods, orders, processorEvents, outbox, decisions, inbox, precedents, ownerStatements, audit],
  );

  const wasConnected = useRef(false);
  if (conn.isActive) wasConnected.current = true;
  const status: ConnectionStatus = conn.isActive ? "connected" : conn.connectionError ? "error" : wasConnected.current ? "disconnected" : "connecting";
  const identityHex = conn.identity?.toHexString();
  const role = useMemo(() => (conn.identity ? actors.find((a) => a.identity.isEqual(conn.identity!))?.role ?? "" : ""), [actors, conn.identity]);

  const session = useMemo<Session>(
    () => ({ mode: "live", status, ready, error: conn.connectionError?.message, identityHex, role, uri: STDB_URI, dbName: STDB_DB }),
    [status, ready, conn.connectionError, identityHex, role],
  );

  const getConnection = conn.getConnection;
  const actions = useMemo<Actions>(() => {
    const c = () => {
      const x = getConnection() as DbConnection | null;
      if (!x) throw new Error("not connected to SpacetimeDB");
      return x;
    };
    return {
      updateOrderStatus: (orderId, status) => c().reducers.updateOrderStatus({ orderId, status }),
      postDocument: (documentId) => c().reducers.postDocument({ documentId }),
      reverseDocument: (documentId, reason) => c().reducers.reverseDocument({ documentId, reason }),
      answerInbox: (id, answer, makePrecedent, precedentRule, conditionJson) => c().reducers.answerInbox({ id, answer, makePrecedent, precedentRule, conditionJson }),
      decideOwnerStatement: (id, confirm) => c().reducers.decideOwnerStatement({ id, confirm }),
      redeemRoleGrant: (code) => c().reducers.redeemRoleGrant({ code }),
      activateConfiguration: (configId) => c().reducers.activateConfiguration({ configId }),
    };
  }, [getConnection]);

  useEffect(() => {
    document.documentElement.dataset.mode = "live";
  }, []);

  return (
    <DataValueProvider snapshot={snapshot} session={session} actions={actions}>
      {children}
    </DataValueProvider>
  );
}
