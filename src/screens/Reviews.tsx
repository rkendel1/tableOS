import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Alert, Button, Form, Loading, PageHeader } from "@stack-ui/react";
import { Select, TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { REVIEW_SOURCES } from "../../feltkit/_constants";
import { can, Status, useApp, useRun, when } from "../ui";

export function Reviews() {
  const { permissions } = useApp();
  const [needs, setNeeds] = useState(false);
  const rows = useQuery(api.reviews.list, needs ? { needsResponse: true } : {});
  const themes = useQuery(api.reviews.themes, can(permissions, "insights.read") ? {} : "skip");
  return (
    <>
      <PageHeader title="Reviews" description="Reviews recorded with their source and provenance. No review site is connected: reviews are entered or imported, and responses are posted by a person." />
      {themes && <Themes data={themes} />}
      <div className="row between">
        <h2>All reviews</h2>
        <label className="small"><input type="checkbox" checked={needs} onChange={(e) => setNeeds(e.target.checked)} /> needs a response</label>
      </div>
      {!rows ? <Loading what="reviews" /> : rows.map((r) => <ReviewCard key={r.id} r={r} />)}
      {rows && !rows.length && <p className="muted">No reviews.</p>}
      {can(permissions, "reviews.write") && <AddReview />}
    </>
  );
}

function Themes({ data }: { data: NonNullable<ReturnType<typeof useQuery<typeof api.reviews.themes>>> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="panel">
      <h2>Recurring themes <span className="muted small">· {data.reviewsConsidered} reviews · average {data.averageRating}★ · {data.method}</span></h2>
      <p className="muted small">{data.note}</p>
      <ul className="themes">
        {data.themes.map((t) => (
          <li key={t.id}>
            <button type="button" className="link" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
              <strong>{t.label}</strong> — {t.mentions} mention{t.mentions === 1 ? "" : "s"}, {t.negativeMentions} in 1–2★ reviews, average {t.averageRating}★
            </button>
            {open === t.id && (
              <ul className="evidence">{t.evidence.map((e) => <li key={e.reviewId}><span className="muted small">{e.rating}★ · {e.source} · {e.reviewedAt}</span> “{e.excerpt}”</li>)}</ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Review = NonNullable<ReturnType<typeof useQuery<typeof api.reviews.list>>>[number];

function ReviewCard({ r }: { r: Review }) {
  const { permissions } = useApp();
  const draft = useMutation(api.reviews.draftResponse);
  const approve = useMutation(api.reviews.approveResponse);
  const published = useMutation(api.reviews.recordPublished);
  const { busy, run } = useRun();
  const [text, setText] = useState(r.response?.text ?? "");
  const [url, setUrl] = useState("");
  const resp = r.response;
  return (
    <article className="panel review">
      <header className="row between">
        <span><strong>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</strong> {r.author} · {r.source}{r.url ? <> · <a href={r.url} target="_blank" rel="noreferrer">source</a></> : null}</span>
        <span className="muted small">written {r.reviewedAt} · {r.provenance.method.replace("_", " ")} by {r.provenance.recordedBy} {when(r.provenance.recordedAt)}{r.provenance.batch ? ` · ${r.provenance.batch}` : ""}</span>
      </header>
      <p>{r.text || <span className="muted">(rating only)</span>}</p>
      {resp && <p className="small"><Status value={resp.status} /> drafted by {resp.draftedBy} ({resp.draftedByType}){resp.approvedBy ? `, approved by ${resp.approvedBy}` : ""}{resp.publishedUrl ? <>, <a href={resp.publishedUrl} target="_blank" rel="noreferrer">published</a> (recorded by {resp.publishedRecordedBy})</> : ""}</p>}
      {(!resp || resp.status === "draft") && can(permissions, "reviews.draft") && (
        <Form label="Response" submitLabel={resp ? "Update draft" : "Save draft"} busy={busy} onSubmit={() => void run(() => draft({ id: r.id, text }))}
          actions={resp?.status === "draft" && can(permissions, "reviews.respond") ? <Button variant="primary" label="Approve response" onClick={() => void run(() => approve({ id: r.id, ...(text !== resp.text ? { text } : {}) }))} /> : undefined}>
          <TextField label="Response" multiline rows={3} value={text} onChange={setText} required />
        </Form>
      )}
      {resp?.status === "approved" && can(permissions, "reviews.respond") && (
        <>
          <Alert tone="info">Approved, not published. Post it on {r.source}, then record where it appears.</Alert>
          <p className="body">{resp.text}</p>
          <Form label="Record publication" layout="inline" submitLabel="Record as published" onSubmit={() => void run(() => published({ id: r.id, url }))}>
            <TextField label="URL where it appears" type="url" value={url} onChange={setUrl} required />
          </Form>
        </>
      )}
      {resp?.status === "published" && <p className="body">{resp.text}</p>}
    </article>
  );
}

function AddReview() {
  const add = useMutation(api.reviews.add);
  const { busy, run } = useRun();
  const today = new Date().toISOString().slice(0, 10);
  const blank = { source: "google", externalId: "", url: "", author: "", rating: "5", text: "", reviewedAt: today };
  const [f, setF] = useState(blank);
  return (
    <section className="panel">
      <h2>Record a review</h2>
      <Form label="Record a review" submitLabel="Record review" busy={busy}
        onSubmit={() => void run(() => add({ review: { source: f.source as never, ...(f.externalId ? { externalId: f.externalId } : {}), ...(f.url ? { url: f.url } : {}), author: f.author, rating: Number(f.rating), text: f.text, reviewedAt: f.reviewedAt } }), () => setF(blank))}>
        <Select label="Source" value={f.source} onChange={(v) => setF({ ...f, source: v })} options={REVIEW_SOURCES.map((s) => ({ value: s, label: s === "direct" ? "Direct guest feedback" : s }))} />
        <TextField label="Source's review id" value={f.externalId} onChange={(v) => setF({ ...f, externalId: v })} hint="Required for review sites, so the same review is never recorded twice." />
        <TextField label="Link to the review" type="url" value={f.url} onChange={(v) => setF({ ...f, url: v })} />
        <TextField label="Author" value={f.author} onChange={(v) => setF({ ...f, author: v })} required />
        <Select label="Rating" value={f.rating} onChange={(v) => setF({ ...f, rating: v })} options={["5", "4", "3", "2", "1"]} />
        <label className="date-field">Written on <input type="date" value={f.reviewedAt} onChange={(e) => setF({ ...f, reviewedAt: e.target.value })} /></label>
        <TextField label="Text" multiline rows={3} value={f.text} onChange={(v) => setF({ ...f, text: v })} />
      </Form>
    </section>
  );
}
