"use client";

// The signed-in owner account (brain /accounts/*). One business per account: once the account has a
// business, the whole app is scoped to it. The session token lives in localStorage and is sent as a
// bearer token; it unlocks only this account's own business in the brain's setup routes.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BRAIN_URL, SESSION_KEY, safeGet, safeSet } from "./env";

export interface Account {
  id: string;
  email: string;
  businessId: string | null;
  businessName: string | null;
}

type Status = "loading" | "signedOut" | "signedIn" | "unreachable";

export interface AccountValue {
  status: Status;
  account: Account | undefined;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  createBusiness(name: string): Promise<void>;
  /** Delete the account's business for good; `confirm` is the business name as the owner typed it. */
  deleteBusiness(confirm: string): Promise<void>;
  retry(): void;
}

/** Authorization header for brain calls made on behalf of the signed-in account. */
export function authHeaders(): Record<string, string> {
  const t = safeGet("local", SESSION_KEY);
  return t ? { authorization: `Bearer ${t}` } : {};
}

export class AccountRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BRAIN_URL}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...authHeaders(), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new AccountRequestError(0, "Can't reach Paper to Biz right now. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new AccountRequestError(res.status, body.error ?? `request failed (${res.status})`);
  return body;
}

const Ctx = createContext<AccountValue | undefined>(undefined);

export function useAccount(): AccountValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount must be used inside <AccountProvider>");
  return v;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [account, setAccount] = useState<Account>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!safeGet("local", SESSION_KEY)) {
      setStatus("signedOut");
      return;
    }
    let live = true;
    call<{ account: Account }>("/accounts/me")
      .then((r) => {
        if (!live) return;
        setAccount(r.account);
        setStatus("signedIn");
      })
      .catch((e: AccountRequestError) => {
        if (!live) return;
        if (e.status === 401) {
          safeSet("local", SESSION_KEY, null);
          setStatus("signedOut");
        } else setStatus("unreachable");
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const start = useCallback((r: { token: string; account: Account }) => {
    safeSet("local", SESSION_KEY, r.token);
    setAccount(r.account);
    setStatus("signedIn");
  }, []);

  const value = useMemo<AccountValue>(
    () => ({
      status,
      account,
      signIn: async (email, password) => start(await call<{ token: string; account: Account }>("/accounts/login", { body: { email, password } })),
      signUp: async (email, password) => start(await call<{ token: string; account: Account }>("/accounts/signup", { body: { email, password } })),
      signOut: async () => {
        await call("/accounts/logout", { method: "POST" }).catch(() => undefined);
        safeSet("local", SESSION_KEY, null);
        setAccount(undefined);
        setStatus("signedOut");
      },
      createBusiness: async (name) => setAccount((await call<{ account: Account }>("/accounts/business", { body: { name } })).account),
      deleteBusiness: async (confirm) => setAccount((await call<{ account: Account }>("/accounts/business/delete", { body: { confirm } })).account),
      retry: () => {
        setStatus("loading");
        setAttempt((n) => n + 1);
      },
    }),
    [status, account, start],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One-time owner role grant for the account's own (live) business. */
export const requestOwnerGrant = () => call<{ code: string; businessId: string }>("/accounts/owner-grant", { method: "POST" });
