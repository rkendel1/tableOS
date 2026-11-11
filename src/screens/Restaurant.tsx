import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Button, Checkbox, DataTable, Form, Loading, PageHeader } from "@stack-ui/react";
import { TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { can, prettyDate, useApp, useRun, WEEKDAYS } from "../ui";

/** "17:00-22:00, 11:00-14:30" ⇄ periods. */
const toText = (periods: Array<{ open: string; close: string }>) => periods.map((p) => `${p.open}-${p.close}`).join(", ");
const fromText = (text: string) => text.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
  const [open, close] = x.split(/\s*[-–]\s*/);
  return { open: open!.padStart(5, "0"), close: (close ?? "").padStart(5, "0") };
});

export function RestaurantScreen() {
  const { locationId, permissions } = useApp();
  return (
    <>
      <PageHeader title="Profile, hours & tables" description="Canonical restaurant information. The public site and booking rules read these records directly." />
      <Profile />
      <Locations />
      {locationId && <>
        <Hours locationId={locationId} write={can(permissions, "hours.write")} />
        <Rules locationId={locationId} write={can(permissions, "restaurant.write")} />
        <Tables locationId={locationId} write={can(permissions, "tables.write")} />
      </>}
    </>
  );
}

function Profile() {
  const { permissions, notify } = useApp();
  const r = useQuery(api.restaurant.get, {});
  const update = useMutation(api.restaurant.update);
  const { busy, run } = useRun();
  const [f, setF] = useState({ name: "", tagline: "", description: "", cuisine: "", phone: "", email: "", website: "" });
  useEffect(() => {
    if (r) setF({ name: r.name, tagline: r.tagline ?? "", description: r.description ?? "", cuisine: r.cuisine ?? "", phone: r.phone ?? "", email: r.email ?? "", website: r.website ?? "" });
  }, [r?.id, r?.updatedAt]);
  if (r === undefined) return <Loading what="profile" />;
  const write = can(permissions, "restaurant.write");
  const field = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => <TextField label={label} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} readOnly={!write} {...extra} />;
  return (
    <section className="panel">
      <h2>Restaurant</h2>
      <Form label="Restaurant profile" submitLabel="Save profile" busy={busy} actions={r ? <span className="muted small">Last changed by {r.updatedBy}</span> : undefined}
        onSubmit={() => write && void run(() => update(f), () => notify("Profile saved; the public site shows it now."))}>
        {field("name", "Name", { required: true })}
        {field("tagline", "Tagline")}
        {field("description", "Description", { multiline: true, rows: 3 })}
        {field("cuisine", "Cuisine")}
        {field("phone", "Phone", { type: "tel" })}
        {field("email", "E-mail", { type: "email" })}
        {field("website", "Website", { type: "url" })}
      </Form>
    </section>
  );
}

function Locations() {
  const { permissions } = useApp();
  const locations = useQuery(api.restaurant.listLocations, {});
  const create = useMutation(api.restaurant.createLocation);
  const update = useMutation(api.restaurant.updateLocation);
  const { busy, run } = useRun();
  const [f, setF] = useState({ slug: "", name: "", address: "", city: "", phone: "", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const write = can(permissions, "restaurant.write");
  return (
    <section className="panel">
      <h2>Locations</h2>
      <DataTable label="Locations" loading={!locations} emptyTitle="No locations yet"
        columns={[{ id: "name", header: "Name" }, { id: "address", header: "Address" }, { id: "tz", header: "Time zone" }, { id: "active", header: "Shown & bookable" }]}
        rows={(locations ?? []).map((l) => ({
          key: l.id,
          cells: {
            name: l.name, address: `${l.address}, ${l.city}`, tz: l.timeZone,
            active: write ? <Checkbox label={l.active ? "yes" : "no"} checked={l.active} onChange={(c) => void run(() => update({ id: l.id, slug: l.slug, name: l.name, address: l.address, city: l.city, ...(l.phone ? { phone: l.phone } : {}), timeZone: l.timeZone, active: c }))} /> : l.active ? "yes" : "no",
          },
        }))}
      />
      {write && (
        <Form label="New location" submitLabel="Add location" busy={busy}
          onSubmit={() => void run(() => create({ ...f, slug: f.slug || f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }), () => setF({ ...f, slug: "", name: "", address: "", city: "", phone: "" }))}>
          <TextField label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} required />
          <TextField label="Street address" value={f.address} onChange={(v) => setF({ ...f, address: v })} required />
          <TextField label="City" value={f.city} onChange={(v) => setF({ ...f, city: v })} required />
          <TextField label="Phone" type="tel" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
          <TextField label="Time zone (IANA)" value={f.timeZone} onChange={(v) => setF({ ...f, timeZone: v })} required hint="e.g. America/New_York. Every date and time at this location is local to it." />
        </Form>
      )}
    </section>
  );
}

function Hours({ locationId, write }: { locationId: string; write: boolean }) {
  const { notify } = useApp();
  const hours = useQuery(api.restaurant.hours, { locationId });
  const setWeekly = useMutation(api.restaurant.setWeekly);
  const setException = useMutation(api.restaurant.setException);
  const removeException = useMutation(api.restaurant.removeException);
  const { busy, run } = useRun();
  const [text, setText] = useState<Record<number, string>>({});
  const [ex, setEx] = useState({ date: "", closed: true, periods: "", note: "" });
  useEffect(() => {
    if (hours) setText(Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, toText(hours.weekly.find((w) => w.weekday === d)?.periods ?? [])])));
  }, [hours]);
  if (!hours) return <Loading what="hours" />;
  return (
    <section className="panel">
      <h2>Hours</h2>
      <table className="hours">
        <tbody>
          {WEEKDAYS.map((name, d) => {
            const saved = toText(hours.weekly.find((w) => w.weekday === d)?.periods ?? []);
            return (
              <tr key={d}>
                <th scope="row">{name}</th>
                <td>{write ? <input aria-label={`${name} hours`} value={text[d] ?? ""} placeholder="closed" onChange={(e) => setText({ ...text, [d]: e.target.value })} /> : saved || "closed"}</td>
                <td>{write && (text[d] ?? "") !== saved && <Button size="sm" label="Save" busy={busy} onClick={() => void run(() => setWeekly({ locationId, weekday: d, periods: fromText(text[d] ?? "") }), () => notify(`${name} hours saved.`))} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Periods as 17:00-22:00, separated by commas. Empty means closed. Periods past midnight are not supported yet.</p>
      <h3>Special hours and closures</h3>
      <DataTable label="Special hours" emptyTitle="None scheduled"
        columns={[{ id: "date", header: "Date" }, { id: "hours", header: "Hours" }, { id: "note", header: "Note" }, { id: "x", header: "" }]}
        rows={hours.exceptions.map((e) => ({ key: e.id, cells: { date: prettyDate(e.date) + ` (${e.date})`, hours: e.closed ? "Closed" : toText(e.periods), note: e.note ?? "", x: write ? <Button size="sm" variant="ghost" label="Remove" onClick={() => void run(() => removeException({ locationId, date: e.date }))} /> : null } }))}
      />
      {write && (
        <Form label="Add special hours" layout="inline" submitLabel="Save special hours" busy={busy}
          onSubmit={() => void run(() => setException({ locationId, date: ex.date, closed: ex.closed, periods: ex.closed ? [] : fromText(ex.periods), ...(ex.note ? { note: ex.note } : {}) }), () => setEx({ date: "", closed: true, periods: "", note: "" }))}>
          <label className="date-field">Date <input type="date" required value={ex.date} onChange={(e) => setEx({ ...ex, date: e.target.value })} /></label>
          <Checkbox label="Closed all day" checked={ex.closed} onChange={(c) => setEx({ ...ex, closed: c })} />
          {!ex.closed && <TextField label="Hours" value={ex.periods} onChange={(v) => setEx({ ...ex, periods: v })} placeholder="17:00-23:30" />}
          <TextField label="Note (shown publicly)" value={ex.note} onChange={(v) => setEx({ ...ex, note: v })} />
        </Form>
      )}
    </section>
  );
}

function Rules({ locationId, write }: { locationId: string; write: boolean }) {
  const locations = useQuery(api.restaurant.listLocations, {});
  const setRules = useMutation(api.restaurant.setRules);
  const { busy, run } = useRun();
  const loc = locations?.find((l) => l.id === locationId);
  const [r, setR] = useState(loc?.rules);
  useEffect(() => setR(loc?.rules), [loc?.updatedAt, locationId]);
  if (!loc || !r) return null;
  const num = (k: keyof typeof r, label: string, hint?: string) => (
    <TextField label={label} type="number" min={0} value={String(r[k])} readOnly={!write} hint={hint} onChange={(v) => setR({ ...r, [k]: Number(v) })} />
  );
  return (
    <section className="panel">
      <h2>Booking rules</h2>
      <Form label="Booking rules" submitLabel="Save rules" busy={busy} onSubmit={() => write && void run(() => setRules({ locationId, rules: r }))}>
        <Checkbox label="Accepting reservations" checked={r.accepting} disabled={!write} onChange={(c) => setR({ ...r, accepting: c })} />
        {num("slotMinutes", "Slot interval (minutes)")}
        {num("durationMinutes", "Table time per booking (minutes)")}
        {num("minPartySize", "Smallest party")}
        {num("maxPartySize", "Largest party bookable")}
        {num("minLeadMinutes", "Book at least (minutes ahead)")}
        {num("maxDaysAhead", "Book up to (days ahead)")}
        {num("lastSeatingBeforeCloseMinutes", "Last seating (minutes before close)")}
      </Form>
    </section>
  );
}

function Tables({ locationId, write }: { locationId: string; write: boolean }) {
  const list = useQuery(api.restaurant.listTables, { locationId });
  const save = useMutation(api.restaurant.saveTable);
  const { busy, run } = useRun();
  const [f, setF] = useState({ label: "", min: "1", max: "4" });
  return (
    <section className="panel">
      <h2>Tables</h2>
      <DataTable label="Tables" loading={!list} emptyTitle="No tables" emptyBody="Reservations need at least one table."
        columns={[{ id: "label", header: "Table" }, { id: "seats", header: "Seats" }, { id: "active", header: "In use" }]}
        rows={(list ?? []).map((t) => ({ key: t.id, cells: { label: t.label, seats: `${t.minParty}–${t.maxParty}`, active: write ? <Checkbox label={t.active ? "yes" : "no"} checked={t.active} onChange={(c) => void run(() => save({ id: t.id, locationId, label: t.label, minParty: t.minParty, maxParty: t.maxParty, active: c }))} /> : t.active ? "yes" : "no" } }))}
      />
      {write && (
        <Form label="Add table" layout="inline" submitLabel="Add table" busy={busy} onSubmit={() => void run(() => save({ locationId, label: f.label, minParty: Number(f.min), maxParty: Number(f.max), active: true }), () => setF({ label: "", min: "1", max: "4" }))}>
          <TextField label="Label" value={f.label} onChange={(v) => setF({ ...f, label: v })} required />
          <TextField label="Min party" type="number" min={1} value={f.min} onChange={(v) => setF({ ...f, min: v })} />
          <TextField label="Max party" type="number" min={1} value={f.max} onChange={(v) => setF({ ...f, max: v })} />
        </Form>
      )}
    </section>
  );
}
