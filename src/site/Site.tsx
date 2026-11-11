/**
 * The restaurant's public site: a projection of the canonical records through `access: "public"`
 * functions. It holds no copy of anything; a manager's change appears here on the next read
 * (live queries re-run when the records change).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Alert, Button, Form, Loading, ThemeSwitch, readThemePreference, setThemePreference, type ThemePreference } from "@stack-ui/react";
import { Select, TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { describe, money, newKey, prettyDate, useRoute, WEEKDAYS } from "../ui";

export function Site() {
  const info = useQuery(api.public.info, {});
  const route = useRoute();
  const page = route[1] ?? "home";
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  useEffect(() => { document.title = info?.restaurant?.name ?? "Restaurant"; }, [info?.restaurant?.name]);
  if (!info) return <Loading what="restaurant" />;
  const r = info.restaurant;
  if (!r) return <main className="site"><h1>Coming soon</h1></main>;
  return (
    <div className="site">
      <header className="site-header">
        <a className="site-name" href="#/site">{r.name}</a>
        <nav aria-label="Site">
          <a href="#/site/menu" aria-current={page === "menu" ? "page" : undefined}>Menu</a>
          <a href="#/site/book" aria-current={page === "book" ? "page" : undefined}>Reserve</a>
          <a href="#/site/contact" aria-current={page === "contact" ? "page" : undefined}>Contact</a>
        </nav>
        <ThemeSwitch preference={theme} onChange={(p) => setTheme(setThemePreference(p))} />
      </header>
      <main id="site-main">
        {page === "menu" ? <PublicMenu /> : page === "book" ? <BookFlow locations={info.locations} /> : page === "booking" ? <MyBooking code={route[2] ?? ""} /> : page === "contact" ? <Contact locations={info.locations} /> : (
          <>
            <section className="hero">
              <h1>{r.name}</h1>
              {r.tagline && <p className="tagline">{r.tagline}</p>}
              {r.description && <p>{r.description}</p>}
              <p><a className="button-link" href="#/site/book">Reserve a table</a> <a href="#/site/menu">See the menu</a></p>
            </section>
            {info.locations.map((l) => (
              <section key={l.id} className="location">
                <h2>{l.name}</h2>
                <p>{l.address}, {l.city}{l.phone ? ` · ${l.phone}` : ""}</p>
                <table className="hours">
                  <caption>This week</caption>
                  <tbody>
                    {l.week.map((d) => (
                      <tr key={d.date} className={d.date === l.today ? "today" : ""}>
                        <th scope="row">{WEEKDAYS[d.weekday]} <span className="muted small">{d.date.slice(5)}</span></th>
                        <td>{d.closed ? "Closed" : d.periods.map((p) => `${p.open}–${p.close}`).join(", ")}{d.special && <span className="special"> · {d.note ?? "special hours"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {l.upcomingExceptions.filter((e) => !l.week.some((w) => w.date === e.date)).length > 0 && (
                  <p className="small">Coming up: {l.upcomingExceptions.filter((e) => !l.week.some((w) => w.date === e.date)).map((e) => `${prettyDate(e.date)} ${e.closed ? "closed" : e.periods.map((p) => `${p.open}–${p.close}`).join(", ")}${e.note ? ` (${e.note})` : ""}`).join("; ")}</p>
                )}
              </section>
            ))}
          </>
        )}
      </main>
      <footer className="site-footer small">
        {r.phone && <span>{r.phone}</span>} {r.email && <a href={`mailto:${r.email}`}>{r.email}</a>} <a className="muted" href="#/today">Staff</a>
      </footer>
    </div>
  );
}

function PublicMenu() {
  const menus = useQuery(api.public.menu, {});
  if (!menus) return <Loading what="menu" />;
  if (!menus.length) return <p>Our menu is being updated.</p>;
  return (
    <>
      {menus.map((m) => (
        <section key={m.id} className="public-menu">
          <h1>{m.name}</h1>
          {m.description && <p className="muted">{m.description}</p>}
          {m.sections.map((s) => (
            <div key={s.id}>
              <h2>{s.name}</h2>
              <ul className="dishes">
                {s.items.map((i) => (
                  <li key={i.id} className={i.available ? "" : "sold-out"}>
                    <div className="dish-head"><strong>{i.name}</strong><span>{money(i.priceCents)}</span></div>
                    {i.description && <div className="muted">{i.description}</div>}
                    <div className="small">
                      {!i.available && <strong>Sold out today. </strong>}
                      {i.dietary.map((d) => <span key={d} className="tag">{d.replace("_", "-")}</span>)}
                      {i.allergens === null ? <span className="muted"> Allergens: please ask your server.</span> : i.allergens.length ? <span className="muted"> Contains: {i.allergens.join(", ").replace(/_/g, " ")}.</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

type Loc = { id: string; name: string; today: string; maxPartySize: number; acceptingReservations: boolean };

function BookFlow({ locations }: { locations: Loc[] }) {
  const bookable = locations.filter((l) => l.acceptingReservations);
  const [locationId, setLocationId] = useState(bookable[0]?.id ?? "");
  const loc = bookable.find((l) => l.id === locationId);
  const [date, setDate] = useState(loc?.today ?? "");
  const [party, setParty] = useState("2");
  const [time, setTime] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", email: "", phone: "", requests: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(newKey, [locationId, date, time, party]);
  const slots = useQuery(api.public.availability, loc && date ? { locationId, date, partySize: Number(party) } : "skip");
  const book = useMutation(api.public.bookTable);
  if (!bookable.length) return <p>Online reservations are not available right now. Please call us.</p>;
  return (
    <section className="book">
      <h1>Reserve a table</h1>
      {bookable.length > 1 && <Select label="Location" value={locationId} onChange={(v) => { setLocationId(v); setTime(null); }} options={bookable.map((l) => ({ value: l.id, label: l.name }))} />}
      <div className="row wrap">
        <label className="date-field">Date <input type="date" min={loc?.today} value={date} onChange={(e) => { setDate(e.target.value); setTime(null); }} /></label>
        <Select label="Guests" value={party} onChange={(v) => { setParty(v); setTime(null); }} options={Array.from({ length: loc?.maxPartySize ?? 8 }, (_, i) => String(i + 1))} />
      </div>
      <p className="muted small">Larger party? <a href="#/site/contact">Contact us</a>.</p>
      {!slots ? <Loading what="times" /> : !slots.open ? <p>We're closed on {prettyDate(date)}{slots.note ? ` (${slots.note})` : ""}.</p> : (
        <>
          <div className="slots" role="group" aria-label="Times">
            {slots.slots.map((s) => <button key={s.time} type="button" className={`slot ${time === s.time ? "chosen" : ""}`} disabled={!s.available} aria-pressed={time === s.time} onClick={() => setTime(s.time)}>{s.time}</button>)}
          </div>
          {!slots.slots.some((s) => s.available) && <p>No tables for {party} on {prettyDate(date)}. Try another day, or <a href="#/site/contact">contact us</a>.</p>}
        </>
      )}
      {time && (
        <Form label="Your details" submitLabel={`Reserve ${prettyDate(date)} at ${time} for ${party}`} busy={busy}
          onSubmit={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await book({ locationId, date, time, partySize: Number(party), name: f.name, email: f.email, ...(f.phone ? { phone: f.phone } : {}), ...(f.requests ? { specialRequests: f.requests } : {}), idempotencyKey: key });
              window.location.hash = `#/site/booking/${encodeURIComponent(r.code)}`;
            } catch (e) {
              setError(describe(e));
            } finally {
              setBusy(false);
            }
          }}>
          {error && <Alert tone="critical">{error}</Alert>}
          <TextField label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} required autocomplete="name" />
          <TextField label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} required autocomplete="email" />
          <TextField label="Phone" type="tel" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} autocomplete="tel" />
          <TextField label="Special requests" value={f.requests} onChange={(v) => setF({ ...f, requests: v })} hint="Allergies, occasions, accessibility." />
        </Form>
      )}
    </section>
  );
}

function MyBooking({ code }: { code: string }) {
  const booking = useQuery(api.public.myBooking, code ? { code } : "skip");
  const cancel = useMutation(api.public.cancelMyBooking);
  const [error, setError] = useState<string | null>(null);
  if (!booking) return <Loading what="your reservation" />;
  return (
    <section className="book">
      <h1>{booking.status === "cancelled" ? "Reservation cancelled" : "You're booked"}</h1>
      <p className="lead">{prettyDate(booking.date)} at {booking.time} · party of {booking.partySize} · {booking.locationName}</p>
      {booking.specialRequests && <p>Requests: {booking.specialRequests}</p>}
      <Alert tone="info">Keep this page's address: it is how you view or cancel this reservation. We don't send e-mail confirmations yet.</Alert>
      {error && <Alert tone="critical">{error}</Alert>}
      {booking.status === "booked" && <Button variant="danger" label="Cancel my reservation" onClick={() => cancel({ code }).catch((e) => setError(describe(e)))} />}
    </section>
  );
}

function Contact({ locations }: { locations: Array<{ id: string; name: string }> }) {
  const send = useMutation(api.public.contact);
  const [f, setF] = useState({ name: "", email: "", phone: "", subject: "", message: "", locationId: locations[0]?.id ?? "" });
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  if (state === "sent") return <section className="book"><h1>Thank you</h1><p>We received your message and will reply to {f.email}.</p></section>;
  return (
    <section className="book">
      <h1>Contact us</h1>
      {error && <Alert tone="critical">{error}</Alert>}
      <Form label="Contact" submitLabel="Send" busy={state === "busy"}
        onSubmit={async () => {
          setState("busy");
          try {
            await send({ name: f.name, email: f.email, ...(f.phone ? { phone: f.phone } : {}), subject: f.subject, message: f.message, ...(f.locationId ? { locationId: f.locationId } : {}) });
            setState("sent");
          } catch (e) {
            setError(describe(e));
            setState("idle");
          }
        }}>
        <TextField label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} required />
        <TextField label="E-mail" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} required />
        <TextField label="Phone" type="tel" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
        <TextField label="Subject" value={f.subject} onChange={(v) => setF({ ...f, subject: v })} required />
        <TextField label="Message" multiline rows={5} value={f.message} onChange={(v) => setF({ ...f, message: v })} required />
      </Form>
    </section>
  );
}
