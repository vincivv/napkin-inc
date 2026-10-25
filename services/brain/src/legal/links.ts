// A model-suggested link is kept only when it is https, on a government host, and actually answers
// (2xx/3xx) within a short timeout. Anything else is dropped and the item keeps its search hint.

/** Hosts that are official but not under .gov (extend with care). */
const OFFICIAL_HOSTS = new Set<string>([]);

/** Locality-based .us names are reserved for governments: ci.<city>.<st>.us, co.<county>.<st>.us, <agency>.state.<st>.us. */
const LOCALITY_US = /(?:^|\.)(?:ci|co|town|vil|twp)\.[a-z0-9-]+\.[a-z]{2}\.us$|(?:^|\.)state\.[a-z]{2}\.us$/;

export function isOfficialHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(h)) return false;
  return h.endsWith(".gov") || OFFICIAL_HOSTS.has(h) || LOCALITY_US.test(h);
}

/** Syntax + host check only (no network). */
export function officialUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  return isOfficialHost(u.hostname) ? u : undefined;
}

/** The slice of fetch the link check uses (tests inject a fake; the real one is globalThis.fetch). */
export type FetchLike = (url: string, init: RequestInit) => Promise<{ status: number; url?: string; body?: { cancel(): Promise<void> } | null }>;

const UA = "Mozilla/5.0 (compatible; NapkinLinkCheck/1.0)";

/** True when the official link answers 2xx/3xx (HEAD, then GET when HEAD is refused) and any redirect stays official. */
export async function linkWorks(raw: string, fetchImpl: FetchLike, timeoutMs = 4000): Promise<boolean> {
  const u = officialUrl(raw);
  if (!u) return false;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetchImpl(u.toString(), { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept: "text/html,*/*" } });
      void res.body?.cancel().catch(() => undefined); // only the status matters
      if (res.url && res.url !== u.toString() && !officialUrl(res.url)) return false; // redirected off government hosts
      if (res.status >= 200 && res.status < 400) return true;
      if (method === "HEAD" && [403, 405, 501].includes(res.status)) continue; // some sites refuse HEAD
      return false;
    } catch {
      return false;
    }
  }
  return false;
}
