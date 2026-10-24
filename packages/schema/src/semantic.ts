// Semantic checks a Configuration must pass beyond its shape: every expression parses, every name
// it reads is declared, every account/register/role referenced exists. Used by the compiler before
// proving, and by the platform's load_configuration.

import { names, parse } from "@napkin/ledger-core";
import type { Configuration } from "./index";

export interface SemanticIssue {
  path: string;
  message: string;
}

export function checkConfigurationSemantics(cfg: Configuration): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const accounts = new Set(cfg.chartOfAccounts.map((a) => a.code));
  const registers = new Set(cfg.registers.map((r) => r.id));
  const roles = new Set(cfg.roles.map((r) => r.id));
  const policyNames = new Set(Object.keys(cfg.policies));
  const catalogFields = new Map(cfg.catalogs.map((c) => [c.id, new Set(c.fields.map((f) => f.name))]));

  if (new Set(cfg.chartOfAccounts.map((a) => a.code)).size !== cfg.chartOfAccounts.length) issues.push({ path: "chartOfAccounts", message: "duplicate account code" });
  if (new Set(cfg.documents.map((d) => d.id)).size !== cfg.documents.length) issues.push({ path: "documents", message: "duplicate document id" });

  cfg.documents.forEach((d, di) => {
    const base = `documents[${d.id}]`;
    const docNames = new Set(d.fields.map((f) => f.name));
    const lineNames = new Set(d.lineFields.map((f) => f.name));
    for (const r of [...d.approval.creatorRoles, ...d.approval.approverRoles]) if (!roles.has(r)) issues.push({ path: `${base}.approval`, message: `unknown role "${r}"` });

    const checkExpr = (path: string, src: string, scope: "doc" | "line") => {
      let used: Set<string>;
      try {
        used = names(parse(src));
      } catch (e) {
        issues.push({ path, message: `does not parse: ${(e as Error).message}` });
        return;
      }
      for (const n of used) {
        if (n.startsWith("doc.")) {
          if (!docNames.has(n.slice(4))) issues.push({ path, message: `reads undeclared ${n}` });
        } else if (n.startsWith("line.")) {
          if (scope !== "line" && !src.includes("sum(")) issues.push({ path, message: `${n} used outside line scope` });
          if (!lineNames.has(n.slice(5))) issues.push({ path, message: `reads undeclared ${n}` });
        } else if (n.startsWith("policy.")) {
          if (!policyNames.has(n.slice(7))) issues.push({ path, message: `reads unknown ${n}` });
        } else if (n.startsWith("lookup:")) {
          const [cat, field] = n.slice(7).split(".");
          if (!catalogFields.get(cat!)?.has(field!)) issues.push({ path, message: `lookup of unknown ${n.slice(7)}` });
        } else issues.push({ path, message: `unknown name ${n}` });
      }
    };

    // derived fields become readable names in declaration order
    d.derived.forEach((f, i) => {
      checkExpr(`${base}.derived[${i}]`, f.expr, f.scope);
      (f.scope === "line" ? lineNames : docNames).add(f.name);
    });
    d.checks.forEach((c, i) => checkExpr(`${base}.checks[${i}]`, c.assert, c.scope));
    if (d.postingRules.length === 0) issues.push({ path: base, message: "document has no posting rules" });
    d.postingRules.forEach((r, i) => {
      const p = `${base}.postingRules[${r.id}]`;
      checkExpr(p + ".amountExpr", r.amountExpr, r.scope);
      if (r.qtyExpr) checkExpr(p + ".qtyExpr", r.qtyExpr, r.scope);
      if (r.when) checkExpr(p + ".when", r.when, r.scope);
      if (r.target.kind === "account") {
        if (!accounts.has(r.target.code)) issues.push({ path: p, message: `unknown account ${r.target.code}` });
        if (r.side !== "debit" && r.side !== "credit") issues.push({ path: p, message: "account rules must be debit/credit" });
      } else {
        if (!registers.has(r.target.id)) issues.push({ path: p, message: `unknown register ${r.target.id}` });
        if (r.side !== "in" && r.side !== "out") issues.push({ path: p, message: "register rules must be in/out" });
      }
    });
    void di;
  });

  cfg.agents.forEach((a) => {
    if (!roles.has(a.role)) issues.push({ path: `agents[${a.id}]`, message: `unknown role ${a.role}` });
  });
  return issues;
}
