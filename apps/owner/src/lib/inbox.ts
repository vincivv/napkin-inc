// Inbox questions as the owner reads them: an agent's free-text escalation split into a headline and numbered
// points, light de-jargoning (account codes -> names, stockUnits=N -> "uses N per sale"), and [doc N] tokens
// so the page can render them as links. Pure functions; the page does the React side.

export interface ParsedQuestion {
  /** one line: the text before the first numbered point, or a short fallback */
  headline: string;
  /** one issue per entry, in order; empty when the question is not a list */
  points: string[];
  /** remaining prose when the question is not a list (or extra text the headline could not hold) */
  body: string;
}

export const FALLBACK_HEADLINE = "A few things in your books need a look";

// Sign-offs the page replaces with its own "What we need from you" line.
const SIGN_OFF = /\s*(?:please\s+(?:confirm|advise|let me know|review)(?:\s+(?:or|and)\s+(?:confirm|advise))?[^.?!]*[.?!]?\s*)+$/i;

function stripSignOff(s: string): string {
  return s.replace(SIGN_OFF, "").trim();
}

function tidyHeadline(s: string): string {
  return s.replace(/[\s:;,-]+$/, "").trim();
}

/** Splits "Intro. (1) a (2) b" or "Intro\n1. a\n2. b" into headline + points; other text into headline + body. */
export function parseQuestion(raw: string): ParsedQuestion {
  const text = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { headline: FALLBACK_HEADLINE, points: [], body: "" };

  // Newline list: lines starting with "1." / "1)" / "-" / "•".
  const lines = text.split("\n");
  const isItem = (l: string) => /^\s*(?:\d{1,2}[.)]|[-•*])\s+/.test(l);
  const firstItem = lines.findIndex(isItem);
  if (firstItem >= 0 && lines.filter(isItem).length >= 2) {
    const head = lines.slice(0, firstItem).join(" ").trim();
    const points: string[] = [];
    for (const l of lines.slice(firstItem)) {
      if (isItem(l)) points.push(l.replace(/^\s*(?:\d{1,2}[.)]|[-•*])\s+/, "").trim());
      else if (l.trim() && points.length) points[points.length - 1] += " " + l.trim();
    }
    return finish(head, points);
  }

  // Inline list: "(1) … (2) …", accepted only when the numbers run 1, 2, 3… in order.
  const markers: { at: number; end: number }[] = [];
  for (const m of text.matchAll(/\((\d{1,2})\)\s*/g)) {
    if (Number(m[1]) === markers.length + 1) markers.push({ at: m.index, end: m.index + m[0].length });
  }
  if (markers.length >= 2) {
    const head = text.slice(0, markers[0]!.at).trim();
    const points = markers.map((mk, i) => text.slice(mk.end, markers[i + 1]?.at ?? text.length).trim());
    return finish(head, points);
  }

  // Plain prose: short text is the headline; long text gets its first sentence as headline.
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= 140) return { headline: flat, points: [], body: "" };
  const m = /^(.{20,160}?[.?!])\s+(.+)$/.exec(flat);
  if (m) return { headline: m[1]!, points: [], body: m[2]! };
  return { headline: FALLBACK_HEADLINE, points: [], body: flat };
}

function finish(head: string, rawPoints: string[]): ParsedQuestion {
  const points = rawPoints.map((p, i) => (i === rawPoints.length - 1 ? stripSignOff(p) : p).replace(/\s+/g, " ").trim()).filter(Boolean);
  let headline = tidyHeadline(head.replace(/\s+/g, " "));
  let body = "";
  if (headline.length > 160) {
    body = headline;
    headline = FALLBACK_HEADLINE;
  }
  if (!headline) headline = FALLBACK_HEADLINE;
  return { headline, points, body };
}

/** Swaps a little bookkeeping jargon for plain words. `accountName` returns undefined for unknown codes. */
export function humanize(text: string, accountName: (code: string) => string | undefined): string {
  let out = text.replace(/\b([A-Za-z]+\s+)?account\s+#?(\d{3,6})\b/gi, (whole, before: string | undefined, code: string) => {
    const name = accountName(code);
    if (!name) return whole;
    // "Cash account 1000" -> "Cash" rather than "Cash Cash".
    if (before && name.toLowerCase().split(/\s+/)[0] === before.trim().toLowerCase()) return name;
    return `${before ?? ""}${name}`;
  });
  out = out.replace(/\(?\bstockUnits\s*=\s*(\d+(?:\.\d+)?)\)?/g, (_w, n: string) => `(uses ${n} per sale)`);
  return out.replace(/\(\((uses [^)]+)\)\)/g, "($1)");
}

export type Part = { text: string } | { doc: string };

/** Splits text on "[doc N]" (and "[doc N, M]") references so each can become a link. */
export function splitDocRefs(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[docs?\s+([0-9]+(?:\s*(?:,|and)\s*[0-9]+)*)\]/gi)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    const ids = m[1]!.split(/\s*(?:,|and)\s*/).filter(Boolean);
    ids.forEach((id, i) => {
      if (i > 0) parts.push({ text: i === ids.length - 1 ? " and " : ", " });
      parts.push({ doc: id });
    });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Key for spotting the same question asked again: same agent, same headline once numbers and doc refs are ignored. */
export function similarityKey(fromRole: string, question: string): string {
  const { headline, points } = parseQuestion(question);
  const basis = headline === FALLBACK_HEADLINE ? points.join(" ") : headline;
  return `${fromRole}|${basis.toLowerCase().replace(/\[docs?[^\]]*\]/g, "").replace(/[^a-z]+/g, " ").trim()}`;
}

const ROLE_NAMES: Record<string, string> = {
  bookkeeper: "Your bookkeeper",
  shopkeeper: "Your shop assistant",
  support: "Your support assistant",
  cashier: "Your cashier",
};

/** "bookkeeper" -> "Your bookkeeper (AI)". */
export function roleLabel(role: string): string {
  const base = ROLE_NAMES[role] ?? `Your ${role.replace(/[_-]+/g, " ")}`;
  return `${base} (AI)`;
}

/** "bookkeeper" -> "the bookkeeper", for sentences. */
export function roleShort(role: string): string {
  return `the ${(ROLE_NAMES[role] ?? role.replace(/[_-]+/g, " ")).replace(/^Your /, "")}`;
}
