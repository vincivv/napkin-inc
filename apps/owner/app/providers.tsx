"use client";

// Who sees what:
//   signed out                -> landing page (or /signin, /signup)
//   signed in, no business    -> name your business
//   business not live yet     -> setup steps (paper -> questions -> go live)
//   business live             -> the back office, scoped to this account's one business

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AccountProvider, useAccount } from "@/data/account";
import { BootScreen, DataProvider, useData } from "@/data/context";
import { Shell } from "@/components/shell";
import { Landing } from "@/components/landing/Landing";
import { NameBusinessScreen, OwnerAutoGrant, SetupShell, SignInScreen, SignUpScreen } from "@/components/onboarding";
import { Button } from "@/components/ui";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AccountProvider>
      <Gate>{children}</Gate>
    </AccountProvider>
  );
}

const AUTH_PATHS = ["/signin", "/signup"];

function Gate({ children }: { children: ReactNode }) {
  const { status, account, retry } = useAccount();
  const pathname = usePathname();
  const router = useRouter();
  const onAuthPage = AUTH_PATHS.includes(pathname);

  useEffect(() => {
    if (status === "signedIn" && onAuthPage) router.replace("/");
    if (status === "signedOut" && !onAuthPage && pathname !== "/") router.replace("/");
  }, [status, onAuthPage, pathname, router]);

  if (status === "loading") return <BootScreen label="Opening Paper to Biz…" />;
  if (status === "unreachable")
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">
        <p className="text-[14px] text-muted">Can&apos;t reach Paper to Biz right now.</p>
        <Button onClick={retry}>Try again</Button>
      </div>
    );
  if (status === "signedOut") {
    if (pathname === "/signup") return <SignUpScreen />;
    if (pathname === "/signin") return <SignInScreen />;
    return <Landing onStart={() => router.push("/signup")} onSignIn={() => router.push("/signin")} />;
  }
  if (!account?.businessId) return <NameBusinessScreen />;
  return (
    <DataProvider businessId={account.businessId} accountId={account.id}>
      <BusinessLayout>{children}</BusinessLayout>
    </DataProvider>
  );
}

/** Setup steps until the platform has the business with an active configuration; then the back office. */
function BusinessLayout({ children }: { children: ReactNode }) {
  const { snapshot, session } = useData();
  const { account } = useAccount();
  const pathname = usePathname();
  const router = useRouter();
  const live = Boolean(snapshot.business && snapshot.business.activeConfigId !== 0n);
  if (session.mode === "live" && !session.ready) return <BootScreen />;
  if (!live && session.mode === "live") {
    // home while setting up is the landing page (the logo links here), with a way back into the steps
    if (pathname === "/") {
      const resume = () => router.push("/intake");
      return <Landing onStart={resume} onSignIn={resume} startLabel={`Continue setting up ${account?.businessName ?? "your business"}`} signInLabel="Back to setup" />;
    }
    return <SetupShell>{children}</SetupShell>;
  }
  return (
    <Shell>
      <OwnerAutoGrant />
      {children}
    </Shell>
  );
}
