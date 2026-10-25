"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useData } from "@/data/context";
import { Button, Card, Empty, ErrorNote, errText, Loading, PageHeader, Badge, cx } from "@/components/ui";
import { Confidence, Confirmed, ProvenanceBadge, regionColor } from "@/components/facts";
import { brain, BrainError, type FactRow, type SpecResponse } from "@/lib/brain";

export default function IntakePage() {
  const { snapshot } = useData();
  const businessId = snapshot.businessId;
  const [spec, setSpec] = useState<SpecResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const [localPhoto, setLocalPhoto] = useState<string | undefined>();
  const [typed, setTyped] = useState("");
  const [rec, setRec] = useState<{ recorder: MediaRecorder; chunks: Blob[]; startedAt: number } | undefined>();
  const [secs, setSecs] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setSpec(await brain.spec(businessId));
    } catch (e) {
      if (!(e instanceof BrainError && e.status === 404)) setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [businessId]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs(Math.round((Date.now() - rec.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [rec]);

  async function run(label: string, fn: () => Promise<SpecResponse>) {
    setBusy(label);
    setError(undefined);
    try {
      setSpec(await fn());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
    }
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    setLocalPhoto(URL.createObjectURL(f));
    void run("Reading the photo", () => brain.uploadPhoto(businessId, f));
  }

  /** "No napkin handy?": the bundled demo napkin (fixtures/demo), uploaded like any photo. */
  async function loadSample() {
    try {
      const blob = await (await fetch("/sample-napkin.png")).blob();
      onFile(new File([blob], "sample-napkin.png", { type: "image/png" }));
    } catch (e) {
      setError(`Could not load the sample napkin: ${errText(e)}`);
    }
  }

  async function startRec() {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void run("Transcribing", () => brain.sendVoice(businessId, new Blob(chunks, { type: recorder.mimeType || "audio/webm" })));
      };
      recorder.start();
      setSecs(0);
      setRec({ recorder, chunks, startedAt: Date.now() });
    } catch (e) {
      setError(`Microphone unavailable: ${errText(e)}. You can type instead.`);
    }
  }
  function stopRec() {
    rec?.recorder.stop();
    setRec(undefined);
  }

  const [storedPhoto, setStoredPhoto] = useState<string | undefined>();
  const hasPhoto = Boolean(spec?.hasPhoto);
  const specVersion = spec?.version ?? 0;
  useEffect(() => {
    if (!hasPhoto || localPhoto) return;
    let url: string | undefined;
    let live = true;
    brain
      .photoObjectUrl(businessId, specVersion)
      .then((u) => {
        url = u;
        if (live) setStoredPhoto(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [businessId, hasPhoto, specVersion, localPhoto]);
  const photoSrc = localPhoto ?? (hasPhoto ? storedPhoto : undefined);
  const withRegion = (spec?.facts ?? []).filter((f) => f.fact.source.region && f.fact.source.kind === "photo" && !f.missing);

  return (
    <>
      <PageHeader
        title="Intake"
        subtitle="Show me your paper and tell me about your business. I only record what I can see or hear, and everything stays unconfirmed until you say so."
        actions={spec && <Link href="/interview" className="text-[12.5px] font-medium text-accent hover:underline">Go to the interview →</Link>}
      />
      <ErrorNote error={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="space-y-4">
          <Card title="1 · Photo" actions={busy === "Reading the photo" && <Loading label="Reading…" />}>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <div className="mb-3 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>{photoSrc ? "Replace photo" : "Take or upload a photo"}</Button>
              {!photoSrc && <Button onClick={() => void loadSample()} disabled={!!busy}>No napkin handy? Use a sample</Button>}
              {spec?.drafts.photo && spec.drafts.voice && <Button onClick={() => run("Merging", () => brain.merge(businessId))} disabled={!!busy}>Re-merge photo and voice</Button>}
            </div>
            {photoSrc ? (
              <div className="relative overflow-hidden rounded-md border border-line bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoSrc} alt="Your paper" className="block w-full" />
                {withRegion.map((f) => {
                  const r = f.fact.source.region!;
                  const active = hover === f.path;
                  return (
                    <div
                      key={f.path}
                      onMouseEnter={() => setHover(f.path)}
                      onMouseLeave={() => setHover(undefined)}
                      title={`${f.label}: ${f.display}`}
                      className="absolute rounded-[3px] transition-all"
                      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, border: `2px solid ${regionColor[f.fact.provenance]}`, background: active ? `color-mix(in srgb, ${regionColor[f.fact.provenance]} 30%, transparent)` : `color-mix(in srgb, ${regionColor[f.fact.provenance]} 8%, transparent)`, opacity: hover && !active ? 0.35 : 1 }}
                    >
                      {active && <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[11px] text-canvas">{f.display}</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty compact title="No photo yet" hint="A menu, a price list, a whiteboard or a napkin. I will box each thing I read." />
            )}
            {spec?.notes && <p className="mt-2 text-[12px] text-muted">Note from the reader: {spec.notes}</p>}
          </Card>

          <Card title="2 · Voice" actions={busy === "Transcribing" || busy === "Reading what you said" ? <Loading label="Listening…" /> : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              {rec ? (
                <Button variant="danger" onClick={stopRec}>
                  <span className="size-2 animate-pulse rounded-full bg-neg" /> Stop · {secs}s
                </Button>
              ) : (
                <Button variant="primary" onClick={startRec} disabled={!!busy}>Record what you want me to know</Button>
              )}
              <span className="text-[12px] text-faint">e.g. your prices, discounts, refunds. Say what it costs you to make things.</span>
            </div>
            <div className="mt-3 flex gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type it" className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent" />
              <Button disabled={!typed.trim() || !!busy} onClick={() => run("Reading what you said", async () => { const r = await brain.sendTranscript(businessId, typed.trim()); setTyped(""); return r; })}>Send</Button>
            </div>
            {spec?.transcript && <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-[12.5px] italic text-muted">“{spec.transcript}”</blockquote>}
          </Card>
        </div>

        <Card
          title={`What I found${spec ? ` · v${spec.version}` : ""}`}
          pad={false}
          actions={spec && <span className="text-[12px] text-muted">{spec.counts.paper} from paper · {spec.counts.owner_said} you said · {spec.counts.inferred} guesses · {spec.counts.missing} unknown</span>}
        >
          {loading ? <Loading /> : !spec ? <Empty title="Nothing yet" hint="Upload a photo or record your voice and the facts appear here." /> : (
            <FactList facts={spec.facts} hover={hover} setHover={setHover} />
          )}
        </Card>
      </div>
    </>
  );
}

function FactList({ facts, hover, setHover }: { facts: FactRow[]; hover: string | undefined; setHover(p: string | undefined): void }) {
  const known = facts.filter((f) => !f.missing);
  const unknown = facts.filter((f) => f.missing && f.moneyRelevant);
  return (
    <div>
      <ul className="divide-y divide-line">
        {known.map((f) => (
          <li key={f.path} onMouseEnter={() => setHover(f.path)} onMouseLeave={() => setHover(undefined)} className={cx("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 transition-colors", hover === f.path && "bg-surface-2")}>
            <div className="min-w-0">
              <div className="truncate text-[12px] text-faint">{f.label}</div>
              <div className="text-[13.5px] font-medium text-ink">{f.display || <span className="text-faint">(empty)</span>}</div>
              {f.fact.source.quote && <div className="truncate text-[11.5px] italic text-faint">“{f.fact.source.quote}”</div>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex gap-1"><ProvenanceBadge f={f} /><Confirmed f={f} /></div>
              <Confidence f={f} />
            </div>
          </li>
        ))}
      </ul>
      {unknown.length > 0 && (
        <div className="border-t border-line bg-surface-2 px-4 py-3">
          <div className="text-[12px] font-medium text-muted">Nobody has told me yet ({unknown.length}) — I will ask in the interview, I won&apos;t guess</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">{unknown.map((f) => <Badge key={f.path}>{f.label}</Badge>)}</div>
        </div>
      )}
    </div>
  );
}
