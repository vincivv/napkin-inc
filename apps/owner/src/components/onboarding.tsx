"use client";

// Account screens and the first-run setup: sign up / sign in, name the business, then the napkin ->
// interview -> go-live steps inside SetupShell. Once the business is live the normal Shell takes over.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { requestOwnerGrant, useAccount } from "@/data/account";
import { useData } from "@/data/context";
import { brain } from "@/lib/brain";
import { Button, ErrorNote, cx, errText } from "./ui";

function Brand() {
  return (
    <Link href="/" className="inline-flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-md bg-ink text-[13px] font-bold text-canvas">N</span>
      <span className="text-[14px] font-semibold">Napkin Inc.</span>
    </Link>
  );
}

function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas px-4">
      <header className="mx-auto flex h-14 w-full max-w-5xl items-center">
        <Brand />
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center pb-16">
        <h1 className="text-[24px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>
        <div className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-sm">{children}</div>
        <div className="mt-4 text-center text-[13px] text-muted">{footer}</div>
      </main>
    </div>
  );
}

const inputCls = "h-10 w-full rounded-md border border-line bg-canvas px-3 text-[14px] outline-none focus:border-accent";

function CredentialsForm({ mode }: { mode: "signin" | "signup" }) {
  const { signIn, signUp } = useAccount();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await (mode === "signup" ? signUp(email, password) : signIn(email, password));
      router.replace("/");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="block space-y-1">
        <span className="text-[12px] font-medium text-muted">Email</span>
        <input className={inputCls} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] font-medium text-muted">Password</span>
        <input
          className={inputCls}
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={mode === "signup" ? 8 : 1}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "signup" && <span className="text-[11.5px] text-faint">At least 8 characters.</span>}
      </label>
      <Button variant="primary" type="submit" disabled={busy} className="h-10 w-full text-[14px]">
        {busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}
      </Button>
      <ErrorNote error={err} />
    </form>
  );
}

export function SignUpScreen() {
  return (
    <AuthFrame
      title="Start your business"
      subtitle="Create your account. Next you'll name your business and show us your napkin."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/signin" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <CredentialsForm mode="signup" />
    </AuthFrame>
  );
}

export function SignInScreen() {
  return (
    <AuthFrame
      title="Welcome back"
      subtitle="Sign in to your business's back office."
      footer={
        <>
          New here?{" "}
          <Link href="/signup" className="font-medium text-accent hover:underline">
            Start your business
          </Link>
        </>
      }
    >
      <CredentialsForm mode="signin" />
    </AuthFrame>
  );
}

/** Step 0 of setup: the account names its one business. */
export function NameBusinessScreen() {
  const { createBusiness, account, signOut } = useAccount();
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await createBusiness(name);
      router.replace("/intake");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame
      title="What's your business called?"
      subtitle="You can run one business per account. The name becomes your shop's web address."
      footer={
        <>
          Signed in as {account?.email}.{" "}
          <button className="font-medium text-accent hover:underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-muted">Business name</span>
          <input className={inputCls} required minLength={2} maxLength={60} autoFocus placeholder="Sam's Tacos" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button variant="primary" type="submit" disabled={busy || name.trim().length < 2} className="h-10 w-full text-[14px]">
          {busy ? "Creating…" : "Continue"}
        </Button>
        <ErrorNote error={err} />
      </form>
    </AuthFrame>
  );
}

const STEPS = [
  { href: "/intake", n: 1, label: "Your napkin", hint: "Photo or voice" },
  { href: "/interview", n: 2, label: "Money questions", hint: "Confirm the facts" },
  { href: "/build", n: 3, label: "Go live", hint: "Proofs, store, staff" },
] as const;
export const SETUP_PATHS: readonly string[] = STEPS.map((s) => s.href);

/** Layout while the business is being set up (not live yet): a three-step header instead of the back office. */
export function SetupShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { account, signOut } = useAccount();
  useEffect(() => {
    if (pathname !== "/" && !SETUP_PATHS.some((p) => pathname.startsWith(p))) router.replace("/intake");
  }, [pathname, router]);
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1100px] items-center gap-4 px-4">
          <Brand />
          <span className="hidden truncate text-[13px] text-muted sm:inline">· setting up {account?.businessName}</span>
          <div className="flex-1" />
          <StartOver businessId={account?.businessId ?? undefined} />
          <button onClick={() => void signOut()} className="text-[12.5px] text-faint hover:text-ink">
            Sign out
          </button>
        </div>
        <nav className="mx-auto flex max-w-[1100px] gap-2 overflow-x-auto px-4 pb-3" aria-label="Setup steps">
          {STEPS.map((s) => {
            const active = pathname.startsWith(s.href);
            return (
              <Link
                key={s.href}
                href={s.href}
                aria-current={active ? "step" : undefined}
                className={cx("flex min-w-[150px] flex-1 items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors", active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-2")}
              >
                <span className={cx("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold", active ? "bg-accent text-canvas" : "bg-surface-2 text-muted")}>{s.n}</span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[13px] font-medium">{s.label}</span>
                  <span className="block truncate text-[11.5px] text-faint">{s.hint}</span>
                </span>
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[1100px] px-4 py-5">{children}</main>
    </div>
  );
}

/** Throw the setup draft away (photo, notes, answers) and begin again at the napkin step. */
function StartOver({ businessId }: { businessId: string | undefined }) {
  const [busy, setBusy] = useState(false);
  if (!businessId) return null;
  const reset = async () => {
    if (!window.confirm("Start over? Your photo, notes and answers are deleted and setup begins again at step 1. Your account and business name stay.")) return;
    setBusy(true);
    try {
      await brain.resetSetup(businessId);
      window.location.assign("/intake");
    } catch (e) {
      window.alert(`Could not start over: ${errText(e)}`);
      setBusy(false);
    }
  };
  return (
    <button onClick={() => void reset()} disabled={busy} className="text-[12.5px] text-faint hover:text-neg disabled:opacity-50">
      {busy ? "Starting over…" : "Start over"}
    </button>
  );
}

/**
 * Once the account's business is live, give this browser's identity the owner role automatically:
 * the brain mints a one-time grant for the account's own business and this identity redeems it.
 */
export function OwnerAutoGrant() {
  const { session, isOwner, actions, snapshot } = useData();
  const tried = useRef(false);
  const live = Boolean(snapshot.business && snapshot.business.activeConfigId !== 0n);
  useEffect(() => {
    if (tried.current || isOwner || session.mode !== "live" || !session.ready || session.status !== "connected" || !live) return;
    if (session.role) return; // this identity already holds another role; never stack roles on it
    tried.current = true;
    requestOwnerGrant()
      .then((g) => actions.redeemRoleGrant(g.code))
      .catch((e) => {
        console.warn("owner access:", errText(e));
        setTimeout(() => (tried.current = false), 5000); // retry later, never in a tight loop
      });
  }, [isOwner, session, live, actions]);
  return null;
}
