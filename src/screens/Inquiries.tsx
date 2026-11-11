import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Alert, Button, DataTable, Form, Loading, PageHeader } from "@stack-ui/react";
import { Select, TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { INQUIRY_CATEGORIES } from "../../feltkit/_constants";
import { can, Status, useApp, useRun, when } from "../ui";

export function Inquiries({ id }: { id?: string }) {
  return id ? <Thread id={id} /> : <InquiryList />;
}

function InquiryList() {
  const { permissions } = useApp();
  const [status, setStatus] = useState<"" | "open" | "awaiting_guest" | "closed">("open");
  const rows = useQuery(api.inquiries.list, status ? { status } : {});
  const log = useMutation(api.inquiries.log);
  const { busy, run } = useRun();
  const [f, setF] = useState({ name: "", email: "", phone: "", channel: "phone", subject: "", message: "" });
  return (
    <>
      <PageHeader title="Inquiries" description="Questions and requests from the site, phone, e-mail and in person — one place, with the whole conversation." />
      <Select label="Show" value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: "open", label: "Open" }, { value: "awaiting_guest", label: "Awaiting guest" }, { value: "closed", label: "Closed" }, { value: "", label: "All" }]} />
      <DataTable label="Inquiries" loading={!rows} emptyTitle="Nothing here"
        columns={[{ id: "subject", header: "Subject" }, { id: "guest", header: "Guest" }, { id: "category", header: "Category" }, { id: "status", header: "Status" }, { id: "last", header: "Last activity" }]}
        rows={(rows ?? []).map((q) => ({
          key: q.id,
          onSelect: () => { window.location.hash = `#/inquiries/${q.id}`; },
          cells: {
            subject: <a href={`#/inquiries/${q.id}`}>{q.subject}</a>,
            guest: q.guestName,
            category: <span>{q.category.replace("_", " ")} <span className="muted small">({q.categorizedBy})</span></span>,
            status: <span><Status value={q.status} />{q.pendingDrafts ? <span className="muted small"> · {q.pendingDrafts} draft</span> : null}</span>,
            last: when(q.lastMessageAt),
          },
        }))}
      />
      {can(permissions, "inquiries.write") && (
        <section className="panel">
          <h2>Log an inquiry</h2>
          <Form label="Log an inquiry" submitLabel="Log inquiry" busy={busy}
            onSubmit={() => void run(() => log({ guest: { name: f.name, ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}) }, channel: f.channel as "phone", subject: f.subject, message: f.message }), (r) => { window.location.hash = `#/inquiries/${r.inquiryId}`; })}>
            <Select label="Channel" value={f.channel} onChange={(v) => setF({ ...f, channel: v })} options={[{ value: "phone", label: "Phone" }, { value: "email", label: "E-mail" }, { value: "in_person", label: "In person" }]} />
            <TextField label="Guest name" value={f.name} onChange={(v) => setF({ ...f, name: v })} required />
            <TextField label="Phone" type="tel" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
            <TextField label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
            <TextField label="Subject" value={f.subject} onChange={(v) => setF({ ...f, subject: v })} required />
            <TextField label="What they asked" multiline rows={3} value={f.message} onChange={(v) => setF({ ...f, message: v })} required />
          </Form>
        </section>
      )}
    </>
  );
}

function Thread({ id }: { id: string }) {
  const { permissions } = useApp();
  const data = useQuery(api.inquiries.get, { id });
  const draftReply = useMutation(api.inquiries.draftReply);
  const approve = useMutation(api.inquiries.approveReply);
  const recordSent = useMutation(api.inquiries.recordSent);
  const addInbound = useMutation(api.inquiries.addInbound);
  const categorize = useMutation(api.inquiries.categorize);
  const close = useMutation(api.inquiries.close);
  const { busy, run } = useRun();
  const [reply, setReply] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [via, setVia] = useState<Record<string, string>>({});
  const [inbound, setInbound] = useState("");
  if (!data) return <Loading what="inquiry" />;
  const { inquiry: q, guest, messages } = data;
  const send = can(permissions, "inquiries.send");
  const write = can(permissions, "inquiries.write");
  return (
    <>
      <PageHeader eyebrow={<a href="#/inquiries">Inquiries</a>} title={q.subject} status={<Status value={q.status} />}
        description={<>From <a href={`#/guests/${guest.id}`}>{guest.name}</a>{guest.email ? ` · ${guest.email}` : ""}{guest.phone ? ` · ${guest.phone}` : ""} · via {q.channel.replace("_", " ")}</>}
        actions={write && q.status !== "closed" ? <Button variant="secondary" label="Close inquiry" onClick={() => void run(() => close({ id }))} /> : undefined} />
      {write && <Select label={`Category (${q.categorizedBy === "rules" ? "set by rules" : "set by a person"})`} value={q.category} onChange={(v) => void run(() => categorize({ id, category: v as never }))} options={INQUIRY_CATEGORIES.map((c) => ({ value: c, label: c.replace("_", " ") }))} />}
      <ol className="thread">
        {messages.map((m) => (
          <li key={m.id} className={`msg ${m.direction}`}>
            <div className="meta"><Status value={m.status} /> <span className="muted small">{m.direction === "inbound" ? "from guest" : `by ${m.author} (${m.authorType})`} · {when(m.at)}{m.approvedBy ? ` · approved by ${m.approvedBy}` : ""}{m.sentVia ? ` · sent ${m.sentVia} (recorded by ${m.sentRecordedBy})` : ""}</span></div>
            {m.status === "draft" && send ? (
              <>
                <TextField label="Draft" multiline rows={4} value={edits[m.id] ?? m.body} onChange={(v) => setEdits({ ...edits, [m.id]: v })} />
                <Button label="Approve reply" busy={busy} onClick={() => void run(() => approve({ messageId: m.id, ...(edits[m.id] && edits[m.id] !== m.body ? { body: edits[m.id] } : {}) }))} />
              </>
            ) : <p className="body">{m.body}</p>}
            {m.status === "ready" && send && (
              <div className="row wrap">
                <Alert tone="info">Approved, not yet sent. TableOS has no e-mail or SMS channel of its own: send it, then record how.</Alert>
                <TextField label="Sent how" placeholder="e-mail from host@…" value={via[m.id] ?? ""} onChange={(v) => setVia({ ...via, [m.id]: v })} />
                <Button size="sm" label="Record as sent" disabled={(via[m.id] ?? "").trim().length < 2} onClick={() => void run(() => recordSent({ messageId: m.id, via: via[m.id]! }))} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {write && q.status !== "closed" && (
        <div className="split">
          <Form label="Draft a reply" submitLabel="Save draft" busy={busy} onSubmit={() => void run(() => draftReply({ id, body: reply }), () => setReply(""))}>
            <TextField label="Reply" multiline rows={4} value={reply} onChange={setReply} required hint="A draft sends nothing. A person with permission approves it." />
          </Form>
          <Form label="Guest wrote again" submitLabel="Add guest message" onSubmit={() => void run(() => addInbound({ id, body: inbound }), () => setInbound(""))}>
            <TextField label="Their message" multiline rows={4} value={inbound} onChange={setInbound} required />
          </Form>
        </div>
      )}
    </>
  );
}
