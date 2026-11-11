import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Button, DataTable, Form, Loading, MetadataList, PageHeader } from "@stack-ui/react";
import { TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { can, prettyDate, Status, useApp, useRun, when } from "../ui";

export function Guests({ id }: { id?: string }) {
  return id ? <Profile id={id} /> : <GuestList />;
}

function GuestList() {
  const [text, setText] = useState("");
  const rows = useQuery(api.guests.list, text.trim().length >= 2 ? { text } : {});
  return (
    <>
      <PageHeader title="Guests" description="Created from bookings and inquiries; recognised again by e-mail or phone." />
      <TextField label="Search" type="search" value={text} onChange={setText} placeholder="name, e-mail or phone" />
      <DataTable label="Guests" loading={!rows} emptyTitle="No guests yet"
        columns={[{ id: "name", header: "Name" }, { id: "contact", header: "Contact" }, { id: "visits", header: "Visits", align: "end" }, { id: "upcoming", header: "Upcoming", align: "end" }, { id: "noshows", header: "No-shows", align: "end" }, { id: "tags", header: "Tags" }]}
        rows={(rows ?? []).map((g) => ({
          key: g.id,
          onSelect: () => { window.location.hash = `#/guests/${g.id}`; },
          cells: { name: <a href={`#/guests/${g.id}`}>{g.name}</a>, contact: [g.email, g.phone].filter(Boolean).join(" · "), visits: g.visits, upcoming: g.upcoming, noshows: g.noShows, tags: g.tags.join(", ") },
        }))}
      />
    </>
  );
}

function Profile({ id }: { id: string }) {
  const { permissions } = useApp();
  const data = useQuery(api.guests.get, { id });
  const addPreference = useMutation(api.guests.addPreference);
  const removePreference = useMutation(api.guests.removePreference);
  const setTags = useMutation(api.guests.setTags);
  const { busy, run } = useRun();
  const [note, setNote] = useState("");
  const [tags, setTagsText] = useState<string | null>(null);
  if (!data) return <Loading what="guest" />;
  const { guest: g } = data;
  const write = can(permissions, "guests.write");
  return (
    <>
      <PageHeader eyebrow={<a href="#/guests">Guests</a>} title={g.name} description={`Guest since ${when(g.createdAt)}`} />
      <MetadataList items={[{ label: "E-mail", value: g.email }, { label: "Phone", value: g.phone }, { label: "Tags", value: g.tags.join(", ") || "—" }]} />
      {write && (
        <Form label="Tags" layout="inline" submitLabel="Save tags" onSubmit={() => void run(() => setTags({ id, tags: (tags ?? g.tags.join(", ")).split(",") }), () => setTagsText(null))}>
          <TextField label="Tags (comma-separated)" value={tags ?? g.tags.join(", ")} onChange={setTagsText} />
        </Form>
      )}
      <section className="panel">
        <h2>Preferences</h2>
        <p className="muted small">Only what the guest told us or staff observed, with who recorded it.</p>
        <ul className="plain">
          {g.preferences.map((p, i) => (
            <li key={i}>{p.note} <span className="muted small">— {p.recordedBy}, {when(p.recordedAt)}</span> {write && <Button size="sm" variant="ghost" label="Remove" onClick={() => void run(() => removePreference({ id, index: i }))} />}</li>
          ))}
          {!g.preferences.length && <li className="muted">None recorded.</li>}
        </ul>
        {write && (
          <Form label="Add preference" layout="inline" submitLabel="Add" busy={busy} onSubmit={() => void run(() => addPreference({ id, note }), () => setNote(""))}>
            <TextField label="Preference" value={note} onChange={setNote} required placeholder="Shellfish allergy; prefers a booth" />
          </Form>
        )}
      </section>
      <section className="panel">
        <h2>Reservations</h2>
        <DataTable label="Reservations" emptyTitle="No reservations"
          columns={[{ id: "when", header: "When" }, { id: "party", header: "Party", align: "end" }, { id: "where", header: "Location" }, { id: "status", header: "Status" }, { id: "req", header: "Requests" }]}
          rows={data.reservations.map((r) => ({ key: r.id, cells: { when: `${prettyDate(r.date)} ${r.time}`, party: r.partySize, where: r.locationName, status: <Status value={r.status} />, req: r.specialRequests ?? "" } }))}
        />
      </section>
      <section className="panel">
        <h2>Inquiries</h2>
        <DataTable label="Inquiries" emptyTitle="No inquiries"
          columns={[{ id: "subject", header: "Subject" }, { id: "status", header: "Status" }, { id: "at", header: "Received" }]}
          rows={data.inquiries.map((q) => ({ key: q.id, cells: { subject: <a href={`#/inquiries/${q.id}`}>{q.subject}</a>, status: <Status value={q.status} />, at: when(q.createdAt) } }))}
        />
      </section>
    </>
  );
}
