import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { ActivityTimeline, Button, DataTable, Dialog, EmptyState, Form, Loading, PageHeader } from "@stack-ui/react";
import { Select, TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { can, newKey, prettyDate, Status, useApp, useRun } from "../ui";

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function Reservations() {
  const { locationId } = useApp();
  const [date, setDate] = useState(isoToday);
  if (!locationId) return <EmptyState title="No location" body="Add a location under Profile, hours & tables." />;
  return (
    <>
      <PageHeader
        title="Reservations"
        description={prettyDate(date)}
        actions={<label className="date-field">Date <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>}
      />
      <div className="split">
        <Book locationId={locationId} date={date} />
        <NewBooking locationId={locationId} date={date} />
      </div>
      <Waitlist locationId={locationId} date={date} />
    </>
  );
}

function Book({ locationId, date }: { locationId: string; date: string }) {
  const { permissions } = useApp();
  const [showCancelled, setShowCancelled] = useState(false);
  const rows = useQuery(api.reservations.list, { locationId, date, includeInactive: showCancelled });
  const setStatus = useMutation(api.reservations.setStatus);
  const cancel = useMutation(api.reservations.cancel);
  const modify = useMutation(api.reservations.modify);
  const { run } = useRun();
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ id: string; time: string; partySize: string } | null>(null);

  const floor = can(permissions, "reservations.floor");
  return (
    <section className="panel">
      <div className="row between">
        <h2>The book</h2>
        <label className="small"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> show cancelled</label>
      </div>
      <DataTable
        label={`Reservations on ${date}`}
        loading={!rows}
        columns={[{ id: "time", header: "Time" }, { id: "guest", header: "Guest" }, { id: "party", header: "Party", align: "end" }, { id: "table", header: "Table" }, { id: "status", header: "Status" }, { id: "actions", header: "" }]}
        emptyTitle="No reservations"
        emptyBody="Bookings from staff, agents and the public site appear here as they happen."
        rows={(rows ?? []).map((r) => ({
          key: r.id,
          cells: {
            time: r.time,
            guest: (
              <span>
                <a href={`#/guests/${r.guestId}`}>{r.guestName}</a>
                {r.specialRequests && <span className="muted small"> · “{r.specialRequests}”</span>}
                <span className="muted small"> · {r.source}</span>
              </span>
            ),
            party: r.partySize,
            table: r.tableLabel,
            status: <Status value={r.status} />,
            actions: (
              <span className="row wrap">
                {floor && r.next.filter((n) => n !== "cancelled").map((n) => <Button key={n} size="sm" variant="secondary" label={n === "no_show" ? "No-show" : n === "seated" ? "Seat" : "Complete"} onClick={() => void run(() => setStatus({ id: r.id, status: n as "seated" }))} />)}
                {r.status === "booked" && can(permissions, "reservations.write") && <Button size="sm" variant="ghost" label="Change" onClick={() => setEditing({ id: r.id, time: r.time, partySize: String(r.partySize) })} />}
                {r.status === "booked" && can(permissions, "reservations.cancel") && <Button size="sm" variant="ghost" label="Cancel" onClick={() => { setReason(""); setCancelling(r.id); }} />}
                {can(permissions, "audit.read") && <Button size="sm" variant="ghost" label="History" onClick={() => setHistoryOf(r.id)} />}
              </span>
            ),
          },
        }))}
      />
      <Dialog open={!!cancelling} title="Cancel reservation" onClose={() => setCancelling(null)}
        actions={<><Button variant="danger" label="Cancel reservation" disabled={reason.trim().length < 3} onClick={() => void run(() => cancel({ id: cancelling!, reason }), () => setCancelling(null))} /><Button variant="ghost" label="Keep it" onClick={() => setCancelling(null)} /></>}>
        <p>The table is released. The reservation and its history are kept.</p>
        <TextField label="Reason" value={reason} onChange={setReason} required />
      </Dialog>
      <Dialog open={!!editing} title="Change reservation" onClose={() => setEditing(null)}
        actions={<><Button label="Save change" onClick={() => void run(() => modify({ id: editing!.id, time: editing!.time, partySize: Number(editing!.partySize) }), () => setEditing(null))} /><Button variant="ghost" label="Close" onClick={() => setEditing(null)} /></>}>
        <p className="muted">Availability is checked again; the change is refused if nothing fits.</p>
        {editing && <>
          <TextField label="Time (HH:MM)" value={editing.time} onChange={(v) => setEditing({ ...editing, time: v })} />
          <TextField label="Party size" type="number" min={1} value={editing.partySize} onChange={(v) => setEditing({ ...editing, partySize: v })} />
        </>}
      </Dialog>
      {historyOf && <History id={historyOf} onClose={() => setHistoryOf(null)} />}
    </section>
  );
}

function History({ id, onClose }: { id: string; onClose: () => void }) {
  const events = useQuery(api.reservations.history, { id });
  return (
    <Dialog open title="Reservation history" onClose={onClose} actions={<Button variant="ghost" label="Close" onClick={onClose} />}>
      <ActivityTimeline
        loading={!events}
        items={(events ?? []).map((e) => ({ id: e.id, at: e.at, actor: `${e.actor} (${e.actorType})`, summary: e.type.replace("reservation.", ""), detail: e.data ? <pre className="json">{JSON.stringify(e.data, null, 1)}</pre> : undefined }))}
      />
    </Dialog>
  );
}

function NewBooking({ locationId, date }: { locationId: string; date: string }) {
  const { permissions, notify } = useApp();
  const [party, setParty] = useState("2");
  const [time, setTime] = useState<string | null>(null);
  const [guest, setGuest] = useState({ name: "", email: "", phone: "", requests: "" });
  const key = useMemo(newKey, [date, time, party, guest.name]);
  const slots = useQuery(api.reservations.availability, { locationId, date, partySize: Math.max(1, Number(party) || 1) });
  const create = useMutation(api.reservations.create);
  const { busy, run } = useRun();
  if (!can(permissions, "reservations.write")) return null;
  return (
    <section className="panel">
      <h2>New booking</h2>
      <Select label="Party size" value={party} onChange={(v) => { setParty(v); setTime(null); }} options={Array.from({ length: 12 }, (_, i) => String(i + 1))} />
      {!slots ? <Loading what="availability" /> : !slots.open ? (
        <p className="muted">Closed{slots.note ? `: ${slots.note}` : ""}.</p>
      ) : (
        <div className="slots" role="group" aria-label="Available times">
          {slots.slots.map((s) => (
            <button key={s.time} type="button" className={`slot ${time === s.time ? "chosen" : ""}`} disabled={!s.available} aria-pressed={time === s.time} onClick={() => setTime(s.time)}>{s.time}</button>
          ))}
          {slots.hoursSource === "exception" && <p className="muted small">Special hours today{slots.note ? `: ${slots.note}` : ""}.</p>}
        </div>
      )}
      <Form label="Guest" submitLabel={time ? `Book ${time} for ${party}` : "Choose a time"} busy={busy}
        onSubmit={() => {
          if (!time) return;
          void run(() => create({ locationId, date, time, partySize: Number(party), guest: { name: guest.name, ...(guest.email ? { email: guest.email } : {}), ...(guest.phone ? { phone: guest.phone } : {}) }, ...(guest.requests ? { specialRequests: guest.requests } : {}), idempotencyKey: key }),
            (r) => { notify(`Booked ${r.time} for ${r.partySize} at table ${r.tableLabel}.`); setTime(null); setGuest({ name: "", email: "", phone: "", requests: "" }); });
        }}>
        <TextField label="Name" value={guest.name} onChange={(v) => setGuest({ ...guest, name: v })} required />
        <TextField label="Phone" type="tel" value={guest.phone} onChange={(v) => setGuest({ ...guest, phone: v })} hint="Phone or e-mail is required." />
        <TextField label="E-mail" type="email" value={guest.email} onChange={(v) => setGuest({ ...guest, email: v })} />
        <TextField label="Special requests" value={guest.requests} onChange={(v) => setGuest({ ...guest, requests: v })} />
      </Form>
    </section>
  );
}

function Waitlist({ locationId, date }: { locationId: string; date: string }) {
  const { permissions, notify } = useApp();
  const rows = useQuery(api.reservations.waitlistList, { locationId, date });
  const add = useMutation(api.reservations.waitlistAdd);
  const book = useMutation(api.reservations.waitlistBook);
  const remove = useMutation(api.reservations.waitlistRemove);
  const { busy, run } = useRun();
  const [form, setForm] = useState({ name: "", phone: "", party: "2", time: "" });
  const write = can(permissions, "waitlist.write");
  return (
    <section className="panel">
      <h2>Waitlist</h2>
      <DataTable label="Waitlist" loading={!rows} emptyTitle="Nobody waiting"
        columns={[{ id: "guest", header: "Guest" }, { id: "party", header: "Party", align: "end" }, { id: "pref", header: "Preferred" }, { id: "open", header: "Bookable now" }, { id: "actions", header: "" }]}
        rows={(rows ?? []).map((w) => ({
          key: w.id,
          cells: {
            guest: <span>{w.guestName}{w.guestPhone ? <span className="muted small"> · {w.guestPhone}</span> : null}</span>,
            party: w.partySize,
            pref: w.preferredTime ?? "any",
            open: w.availableTimes.length ? (
              <span className="row wrap">{w.availableTimes.slice(0, 6).map((t) => write ? <Button key={t} size="sm" variant="secondary" label={t} onClick={() => void run(() => book({ id: w.id, time: t, idempotencyKey: `${w.id}:${t}` }), (r) => notify(`${w.guestName} booked at ${r.time}.`))} /> : <span key={t}>{t} </span>)}</span>
            ) : <span className="muted">none yet</span>,
            actions: write ? <Button size="sm" variant="ghost" label="Remove" onClick={() => void run(() => remove({ id: w.id }))} /> : null,
          },
        }))}
      />
      {write && (
        <Form label="Add to waitlist" layout="inline" submitLabel="Add" busy={busy}
          onSubmit={() => void run(() => add({ locationId, date, partySize: Number(form.party), ...(form.time ? { preferredTime: form.time } : {}), guest: { name: form.name, phone: form.phone } }), () => setForm({ name: "", phone: "", party: "2", time: "" }))}>
          <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <TextField label="Phone" type="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} required />
          <TextField label="Party" type="number" min={1} value={form.party} onChange={(v) => setForm({ ...form, party: v })} />
          <TextField label="Preferred (HH:MM)" value={form.time} onChange={(v) => setForm({ ...form, time: v })} />
        </Form>
      )}
    </section>
  );
}
