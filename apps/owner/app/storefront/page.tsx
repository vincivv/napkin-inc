"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BODY_FONTS, DISPLAY_FONTS, type DesignImage, type StorefrontDesign } from "@napkin/schema/storefront-design";
import { useData } from "@/data/context";
import { STORE_URL } from "@/data/env";
import { brain, type DesignPatch } from "@/lib/brain";
import { Badge, Button, Card, ErrorNote, Loading, PageHeader, cx, errText } from "@/components/ui";

const inputCls = "h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent";

export default function StorefrontPage() {
  const { snapshot, config } = useData();
  const biz = snapshot.businessId;
  const [design, setDesign] = useState<StorefrontDesign | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");

  useEffect(() => {
    if (!biz) return;
    brain.design(biz).then(setDesign, (e) => setError(errText(e)));
  }, [biz]);

  const products = useMemo(() => {
    const cat = config?.config?.catalogs.find((c) => c.id === "products");
    return (cat?.entries ?? []).map((e) => ({ id: e.id, name: String((e.data as Record<string, unknown>).name ?? e.id), kind: String((e.data as Record<string, unknown>).kind ?? "") }));
  }, [config]);

  const run = useCallback(
    async (label: string, f: () => Promise<StorefrontDesign>) => {
      setBusy(label);
      setError(undefined);
      try {
        setDesign(await f());
        setFrameKey((k) => k + 1);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  if (!biz) return <Loading />;
  const storeUrl = `${STORE_URL}/${biz}`;

  return (
    <>
      <PageHeader
        title="Storefront"
        subtitle="What your customers see. The look is yours to change any time; prices, stock and checkout always come from your books."
        actions={
          <>
            <a href={`${storeUrl}/qr`} target="_blank" rel="noreferrer">
              <Button size="sm">QR codes ↗</Button>
            </a>
            <a href={storeUrl} target="_blank" rel="noreferrer">
              <Button size="sm" variant="primary">
                Open store ↗
              </Button>
            </a>
          </>
        }
      />
      <ErrorNote error={error} />
      {!design ? (
        error ? null : <Loading label="Loading your storefront design…" />
      ) : (
        <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <Card
            title="Live preview"
            pad={false}
            actions={
              <div className="flex items-center gap-1">
                {(["desktop", "phone"] as const).map((d) => (
                  <button key={d} onClick={() => setDevice(d)} className={cx("rounded px-2 py-0.5 capitalize", device === d ? "bg-surface-2 font-semibold text-ink" : "text-muted")}>
                    {d}
                  </button>
                ))}
                <button onClick={() => setFrameKey((k) => k + 1)} className="ml-1 rounded px-2 py-0.5 text-muted hover:text-ink">
                  Reload
                </button>
              </div>
            }
          >
            <div className="flex justify-center bg-surface-2 p-3">
              <iframe
                key={frameKey}
                src={storeUrl}
                title="Storefront preview"
                className={cx("h-[78vh] rounded-md border border-line bg-white shadow-card transition-[width]", device === "phone" ? "w-[390px]" : "w-full")}
              />
            </div>
          </Card>

          <div className="space-y-4">
            <Card title="Look" actions={<Badge tone="neutral">{design.generator}</Badge>}>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["editorial", "Editorial", "Soft neutrals, photo-led, pill buttons"],
                    ["bold", "Bold", "Black and white, big uppercase type"],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    disabled={!!busy}
                    onClick={() => id !== design.style && run("style", () => brain.patchDesign(biz, { style: id, corners: id === "bold" ? "square" : "round" }))}
                    className={cx("rounded-md border p-2.5 text-left transition", design.style === id ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2")}
                  >
                    <div className="text-[13px] font-semibold">{label}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="primary" disabled={!!busy} onClick={() => run("regenerate", () => brain.regenerateDesign(biz, design.style))}>
                  {busy === "regenerate" ? "Designing… (up to a minute)" : "Regenerate with AI"}
                </Button>
                <Button disabled={!!busy} onClick={() => run("regenerate", () => brain.regenerateDesign(biz, design.style === "bold" ? "editorial" : "bold"))}>
                  Try {design.style === "bold" ? "editorial" : "bold"}
                </Button>
              </div>
              <p className="mt-2 text-[11.5px] text-faint">
                Claude proposes colors, fonts, wording and photo searches. Every proposal is checked by code (contrast, no prices or made-up claims) before it reaches your store. Your uploaded photos are kept.
              </p>
              {design.notes.length > 0 && (
                <details className="mt-2 text-[12px] text-muted">
                  <summary className="cursor-pointer">Proposals the checker replaced ({design.notes.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {design.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </details>
              )}
            </Card>

            <PhotosCard design={design} products={products} busy={!!busy} run={run} biz={biz} />
            <WordingCard key={`w${design.generatedAt}${frameKey}`} design={design} busy={!!busy} onSave={(p) => run("save", () => brain.patchDesign(biz, p))} />
            <PaletteCard key={`p${design.generatedAt}${frameKey}`} design={design} busy={!!busy} onSave={(p) => run("save", () => brain.patchDesign(biz, p))} />
          </div>
        </div>
      )}
    </>
  );
}

// ---------- photos ----------

function PhotosCard({
  design,
  products,
  busy,
  run,
  biz,
}: {
  design: StorefrontDesign;
  products: { id: string; name: string; kind: string }[];
  busy: boolean;
  run: (label: string, f: () => Promise<StorefrontDesign>) => Promise<void>;
  biz: string;
}) {
  const slots: { slot: string; label: string; image: DesignImage | null }[] = [
    { slot: "hero", label: "Hero (top of the page)", image: design.hero.image },
    ...products.map((p) => ({ slot: `product:${p.id}`, label: p.name + (p.kind === "addon" ? " (add-on)" : ""), image: design.productImages[p.id] ?? null })),
    { slot: "banner", label: "Pickup banner", image: design.banner.image },
  ];
  return (
    <Card title="Photos">
      <p className="mb-3 text-[12px] text-muted">Your own photos always beat stock photos. JPEG, PNG or WebP, up to 6 MB.</p>
      <ul className="space-y-2.5">
        {slots.map((s) => (
          <PhotoRow key={s.slot} {...s} busy={busy} onUpload={(f) => run("upload", () => brain.uploadDesignImage(biz, s.slot, f))} onRemove={() => run("remove", () => brain.removeDesignImage(biz, s.slot))} />
        ))}
      </ul>
    </Card>
  );
}

function PhotoRow({ label, image, busy, onUpload, onRemove }: { label: string; image: DesignImage | null; busy: boolean; onUpload: (f: File) => void; onRemove: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <li className="flex items-center gap-3">
      <div className="size-12 shrink-0 overflow-hidden rounded-md border border-line bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image ? <img src={image.url} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{label}</div>
        <div className="truncate text-[11.5px] text-faint" title={image?.credit}>
          {image ? (image.source === "upload" ? "Your photo" : `${image.license} · ${image.credit.replace(/^Photo:\s*/, "")}`) : "No photo yet"}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />
      <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
        Upload
      </Button>
      {image ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove} aria-label={`Remove photo for ${label}`}>
          ×
        </Button>
      ) : null}
    </li>
  );
}

// ---------- wording ----------

function WordingCard({ design, busy, onSave }: { design: StorefrontDesign; busy: boolean; onSave: (p: DesignPatch) => void }) {
  const [v, setV] = useState({
    announcement: design.announcement,
    eyebrow: design.hero.eyebrow,
    title: design.hero.title,
    subtitle: design.hero.subtitle,
    cta: design.hero.cta,
    collectionTitle: design.collection.title,
    collectionAccent: design.collection.accent,
    banner: design.banner.title,
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const dirty =
    v.announcement !== design.announcement ||
    v.eyebrow !== design.hero.eyebrow ||
    v.title !== design.hero.title ||
    v.subtitle !== design.hero.subtitle ||
    v.cta !== design.hero.cta ||
    v.collectionTitle !== design.collection.title ||
    v.collectionAccent !== design.collection.accent ||
    v.banner !== design.banner.title;
  return (
    <Card title="Wording">
      <div className="space-y-2.5">
        <Row label="Announcement bar" hint="Leave empty to hide it">
          <input className={inputCls} maxLength={70} value={v.announcement} onChange={set("announcement")} />
        </Row>
        <Row label="Hero eyebrow">
          <input className={inputCls} maxLength={32} value={v.eyebrow} onChange={set("eyebrow")} />
        </Row>
        <Row label="Hero title">
          <input className={inputCls} maxLength={48} value={v.title} onChange={set("title")} />
        </Row>
        <Row label="Hero subtitle">
          <textarea className={cx(inputCls, "h-16 py-1.5")} maxLength={120} value={v.subtitle} onChange={set("subtitle")} />
        </Row>
        <div className="grid grid-cols-3 gap-2">
          <Row label="Button">
            <input className={inputCls} maxLength={20} value={v.cta} onChange={set("cta")} />
          </Row>
          <Row label="Grid title">
            <input className={inputCls} maxLength={24} value={v.collectionTitle} onChange={set("collectionTitle")} />
          </Row>
          <Row label="Accent word">
            <input className={inputCls} maxLength={24} value={v.collectionAccent} onChange={set("collectionAccent")} />
          </Row>
        </div>
        <Row label="Pickup banner title">
          <input className={inputCls} maxLength={40} value={v.banner} onChange={set("banner")} />
        </Row>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11.5px] text-faint">No prices, discounts or numbers here: those live in your books.</span>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !dirty}
          onClick={() =>
            onSave({
              announcement: v.announcement.trim(),
              hero: { eyebrow: v.eyebrow.trim(), title: v.title.trim(), subtitle: v.subtitle.trim(), cta: v.cta.trim() },
              collection: { title: v.collectionTitle.trim(), accent: v.collectionAccent.trim() },
              banner: { title: v.banner.trim() },
            })
          }
        >
          Save wording
        </Button>
      </div>
    </Card>
  );
}

// ---------- colors and type ----------

const PALETTE_KEYS = [
  ["background", "Background"],
  ["surface", "Tiles"],
  ["text", "Text"],
  ["muted", "Secondary text"],
  ["primary", "Buttons"],
  ["onPrimary", "Button text"],
  ["accent", "Accent"],
] as const;

function PaletteCard({ design, busy, onSave }: { design: StorefrontDesign; busy: boolean; onSave: (p: DesignPatch) => void }) {
  const [palette, setPalette] = useState(design.palette);
  const [fonts, setFonts] = useState(design.fonts);
  const [corners, setCorners] = useState(design.corners);
  const dirty = JSON.stringify([palette, fonts, corners]) !== JSON.stringify([design.palette, design.fonts, design.corners]);
  return (
    <Card title="Colors and type">
      <div className="grid grid-cols-2 gap-2">
        {PALETTE_KEYS.map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5">
            <input type="color" value={palette[k]} onChange={(e) => setPalette((p) => ({ ...p, [k]: e.target.value }))} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />
            <span className="min-w-0">
              <span className="block text-[12px] font-medium">{label}</span>
              <span className="block font-mono text-[11px] text-faint">{palette[k]}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Row label="Headings">
          <select className={inputCls} value={fonts.display} onChange={(e) => setFonts((f) => ({ ...f, display: e.target.value as typeof f.display }))}>
            {DISPLAY_FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Row>
        <Row label="Body">
          <select className={inputCls} value={fonts.body} onChange={(e) => setFonts((f) => ({ ...f, body: e.target.value as typeof f.body }))}>
            {BODY_FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Row>
        <Row label="Corners">
          <select className={inputCls} value={corners} onChange={(e) => setCorners(e.target.value as typeof corners)}>
            <option value="round">Round</option>
            <option value="soft">Soft</option>
            <option value="square">Square</option>
          </select>
        </Row>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11.5px] text-faint">Text must stay readable: low-contrast colors are refused.</span>
        <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => onSave({ palette, fonts, corners })}>
          Save colors
        </Button>
      </div>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-medium text-muted">
        {label}
        {hint ? <span className="font-normal text-faint"> · {hint}</span> : null}
      </span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}
