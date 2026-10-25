"use client";

// Getting-legal checklist: the registrations, permits and licenses a business like this usually needs,
// with official links. A starting list, not legal advice; Napkin never applies or files anything.
// Self-contained (loads and saves through the brain), so it can sit on its own page or inside another.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { brain, type LegalItem, type LegalStatus, type LegalView } from "@/lib/brain";
import { Badge, Button, Card, ErrorNote, Loading, cx, errText } from "./ui";

const inputCls = "h-9 w-full rounded-md border border-line bg-canvas px-3 text-[13.5px] outline-none focus:border-accent";

const STATUS_BUTTONS: { status: LegalStatus; label: string }[] = [
  { status: "done", label: "Done" },
  { status: "not_needed", label: "Not needed" },
  { status: "todo", label: "To do" },
];

export function LegalChecklist({ businessId, className }: { businessId: string; className?: string }) {
  const [view, setView] = useState<LegalView>();
  const [error, setError] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [editingPlace, setEditingPlace] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await brain.legal(businessId));
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  }, [businessId]);
  useEffect(() => void load(), [load]);

  /** With a location: save it, and tailor the list when Napkin can; without: regenerate for the saved one. */
  const generate = async (location?: { city: string; state: string }) => {
    setGenerating(true);
    setError(undefined);
    try {
      const canTailor = Boolean(view?.knowsBusiness && view.aiAvailable);
      setView(await (location && !canTailor ? brain.legalLocation(businessId, location) : brain.legalGenerate(businessId, location)));
      setEditingPlace(false);
    } catch (e) {
      setError(errText(e));
      await load(); // a typed location is kept even when the AI step fails
    } finally {
      setGenerating(false);
    }
  };

  const update = async (item: LegalItem, patch: { status?: LegalStatus; note?: string | null }) => {
    // optimistic: show the change now, then take the brain's answer
    setView((v) => v && { ...v, items: v.items.map((i) => (i.id === item.id ? { ...i, ...(patch.status ? { status: patch.status } : {}), ...(patch.note !== undefined ? { note: patch.note ?? undefined } : {}) } : i)) });
    try {
      setView(await brain.legalItem(businessId, item.id, patch));
    } catch (e) {
      setError(errText(e));
      await load();
    }
  };

  if (!view) return error ? <ErrorNote error={error} /> : <Loading label="Loading your checklist…" />;

  const base = view.items.filter((i) => i.base);
  const tailored = view.items.filter((i) => !i.base);
  const done = view.items.filter((i) => i.status === "done").length;
  const notNeeded = view.items.filter((i) => i.status === "not_needed").length;
  const relevant = view.items.length - notNeeded;
  const pct = relevant > 0 ? Math.round((done / relevant) * 100) : 100;

  return (
    <div className={cx("space-y-4", className)}>
      <div className="rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-[13px] leading-relaxed text-ink">
        <div className="font-semibold text-info">A starting list, not legal advice</div>
        <p className="mt-0.5 text-muted">
          Rules differ by state, county and city, and they change. Napkin doesn&apos;t apply for or file anything for you. Check each item with the agency listed, and ask them if
          you&apos;re not sure it applies.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">
              <span className="num">{done}</span> of <span className="num">{relevant}</span> done
              {notNeeded > 0 && <span className="ml-2 text-[12.5px] font-normal text-faint">· {notNeeded} not needed</span>}
            </div>
            <div className="mt-2 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist progress">
              <div className="h-full rounded-full bg-pos transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
          {!view.needsLocation && !editingPlace && (
            <div className="text-[12.5px] text-muted">
              {view.generated ? "Tailored for" : "Your location:"} <span className="font-medium text-ink">{view.generatedFor ?? view.locationText}</span>{" "}
              <button className="text-accent hover:underline" onClick={() => setEditingPlace(true)}>
                Change
              </button>
            </div>
          )}
        </div>

        {(view.needsLocation || editingPlace) && (
          <LocationForm
            initial={view.location ?? undefined}
            busy={generating}
            canGenerate={view.knowsBusiness && view.aiAvailable}
            onSubmit={(loc) => void generate(loc)}
            onCancel={view.needsLocation ? undefined : () => setEditingPlace(false)}
          />
        )}

        {!view.needsLocation && !editingPlace && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {view.knowsBusiness && view.aiAvailable ? (
              <>
                <Button variant={view.generated ? "secondary" : "primary"} size="sm" disabled={generating} onClick={() => void generate()}>
                  {generating ? "Checking what applies to you…" : view.generated ? "Refresh suggestions" : "Add items for my kind of business"}
                </Button>
                <span className="text-[12px] text-faint">
                  {generating ? "This can take up to a minute." : view.generated ? "Your ticks and notes are kept." : "Napkin suggests permits for what you sell and where."}
                </span>
              </>
            ) : (
              <span className="text-[12.5px] text-faint">
                {!view.knowsBusiness ? "Once Napkin knows what you sell (your napkin step), it can add permits specific to your business." : "Suggestions for your kind of business are unavailable right now; the general items below still apply."}
              </span>
            )}
          </div>
        )}
        <ErrorNote error={error} />
      </Card>

      {tailored.length > 0 && (
        <Section title="For your kind of business" hint="Suggested from what you told Napkin. Double-check each with the agency.">
          {tailored.map((it) => (
            <Item key={it.id} item={it} onChange={(p) => void update(it, p)} />
          ))}
        </Section>
      )}
      <Section title="Every US small business" hint="The usual basics, with official links.">
        {base.map((it) => (
          <Item key={it.id} item={it} onChange={(p) => void update(it, p)} />
        ))}
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <Card title={title} actions={<span className="hidden text-faint normal-case sm:inline">{hint}</span>} pad={false}>
      <ul className="divide-y divide-line">{children}</ul>
    </Card>
  );
}

function Item({ item, onChange }: { item: LegalItem; onChange: (p: { status?: LegalStatus; note?: string | null }) => void }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [draft, setDraft] = useState(item.note ?? "");
  useEffect(() => setDraft(item.note ?? ""), [item.note]);
  const settled = item.status !== "todo";
  const saveNote = () => {
    const next = draft.trim();
    if (next !== (item.note ?? "")) onChange({ note: next || null });
    setNoteOpen(false);
  };

  return (
    <li className={cx("px-4 py-3.5", settled && "bg-surface-2/40")}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cx("text-[14px] font-semibold", settled && "text-muted")}>{item.title}</h3>
            {item.status === "done" && <Badge tone="pos">Done</Badge>}
            {item.status === "not_needed" && <Badge>Not needed</Badge>}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{item.why}</p>
          {item.appliesBecause && (
            <p className="mt-1 text-[12.5px] text-muted">
              <span className="font-medium text-ink">Why you:</span> {item.appliesBecause}
            </p>
          )}
          <p className="mt-1 text-[12.5px] text-muted">
            <span className="font-medium text-ink">Who:</span> {item.who}
          </p>
          <div className="mt-1.5 text-[12.5px]">
            {item.link ? (
              <a href={item.link} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
                Official page ↗
              </a>
            ) : null}
            {item.howToFind && (
              <span className={cx("text-faint", item.link && "ml-3")}>
                {item.link ? "Or: " : "How to find it: "}
                {item.howToFind}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 rounded-md border border-line-strong bg-surface p-0.5" role="group" aria-label={`Status of ${item.title}`}>
          {STATUS_BUTTONS.map((b) => (
            <button
              key={b.status}
              aria-pressed={item.status === b.status}
              onClick={() => item.status !== b.status && onChange({ status: b.status })}
              className={cx(
                "h-7 rounded px-2.5 text-[12px] font-medium transition-colors",
                item.status === b.status ? (b.status === "done" ? "bg-pos text-white" : b.status === "not_needed" ? "bg-ink text-canvas" : "bg-surface-2 text-ink") : "text-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2">
        {noteOpen ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <textarea
              className="min-h-[60px] w-full rounded-md border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent"
              maxLength={500}
              autoFocus
              placeholder="e.g. Applied on May 3, permit #12345, renew every year"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={saveNote}>
                Save note
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(item.note ?? "");
                  setNoteOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : item.note ? (
          <button className="max-w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-left text-[12.5px] text-ink hover:border-line-strong" onClick={() => setNoteOpen(true)} title="Edit note">
            <span className="text-faint">Note: </span>
            {item.note}
          </button>
        ) : (
          <button className="text-[12px] text-faint hover:text-ink" onClick={() => setNoteOpen(true)}>
            + Add a note
          </button>
        )}
      </div>
    </li>
  );
}

function LocationForm({
  initial,
  busy,
  canGenerate,
  onSubmit,
  onCancel,
}: {
  initial?: { city: string; state: string };
  busy: boolean;
  canGenerate: boolean;
  onSubmit: (loc: { city: string; state: string }) => void;
  onCancel?: () => void;
}) {
  const [city, setCity] = useState(initial?.city ?? "");
  const [state, setState] = useState(initial?.state ?? "");
  return (
    <form
      className="mt-3 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ city: city.trim(), state: state.trim() });
      }}
    >
      <div className="text-[13.5px] font-medium">Where is your business?</div>
      <p className="mt-0.5 text-[12.5px] text-muted">Permits depend on your city and state. We only use this for this checklist.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="block min-w-[160px] flex-1 space-y-1">
          <span className="text-[11.5px] font-medium text-faint">City or town</span>
          <input className={inputCls} required maxLength={80} placeholder="Austin" value={city} onChange={(e) => setCity(e.target.value)} />
        </label>
        <label className="block w-[140px] space-y-1">
          <span className="text-[11.5px] font-medium text-faint">State</span>
          <input className={inputCls} required maxLength={40} placeholder="TX" value={state} onChange={(e) => setState(e.target.value)} />
        </label>
        <Button type="submit" variant="primary" disabled={busy || !city.trim() || state.trim().length < 2} className="h-9">
          {busy ? "Checking what applies…" : canGenerate ? "Make my checklist" : "Save"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" className="h-9" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {busy && <p className="mt-2 text-[12px] text-faint">This can take up to a minute.</p>}
    </form>
  );
}
