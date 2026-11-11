import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Alert, Button, EmptyState, Loading, MetadataList, PageHeader } from "@stack-ui/react";
import { api } from "../../feltkit/_generated/api";
import { can, useApp, useRun } from "../ui";

export function Today() {
  const { permissions, notify } = useApp();
  const status = useQuery(api.setup.status, {});
  const today = useQuery(api.insights.today, status?.configured ? {} : "skip");
  const loadSample = useMutation(api.setup.loadSample);
  const { busy, run } = useRun();

  if (!status) return <Loading what="the restaurant" />;
  if (!status.configured) {
    return (
      <>
        <PageHeader title="Welcome to TableOS" description="Start with your restaurant's profile, a location, its hours and tables." />
        <EmptyState
          title="No restaurant yet"
          body="Set up your profile, first location, weekly hours and tables. Reservations open as soon as a location has hours and tables."
          action={<a className="button-link" href="#/restaurant">Set up the restaurant</a>}
        />
        {!status.production && can(permissions, "restaurant.write") && (
          <Alert tone="info" title="Development" actions={<Button variant="secondary" busy={busy} label="Load sample restaurant" onClick={() => void run(() => loadSample({}), () => notify("Sample restaurant loaded (development data, not real)."))} />}>
            Try TableOS with a sample restaurant. It is refused in production and once a restaurant exists.
          </Alert>
        )}
      </>
    );
  }
  if (!today) return <Loading what="today" />;
  const a = today.attention;
  return (
    <>
      <PageHeader title="Today" description="From the records, in each location's own time zone." />
      {today.locations.length === 0 && <EmptyState title="No active location" body="Add a location under Profile, hours & tables." />}
      <div className="cards">
        {today.locations.map((l) => (
          <section key={l.id} className="card">
            <h2>{l.name} <span className="muted small">· {l.date} · now {l.now}</span></h2>
            <div className="stats">
              <Stat n={l.reservations} label="reservations" />
              <Stat n={l.covers} label="covers" />
              <Stat n={l.seated} label="seated" />
              <Stat n={l.waiting} label="waiting" />
              <Stat n={l.noShows} label="no-shows" />
            </div>
            <h3>Next two hours</h3>
            {l.nextArrivals.length ? (
              <ul className="plain">{l.nextArrivals.map((r) => <li key={r.id}><strong>{r.time}</strong> · party of {r.partySize}</li>)}</ul>
            ) : <p className="muted">No arrivals due.</p>}
            <a href="#/reservations">Open the book →</a>
          </section>
        ))}
        <section className="card">
          <h2>Needs attention</h2>
          <MetadataList items={[
            { label: <a href="#/inquiries">Open inquiries</a>, value: String(a.openInquiries) },
            { label: "Drafts awaiting a person's approval", value: String(a.draftsAwaitingApproval) },
            { label: "Approved replies not yet recorded as sent", value: String(a.repliesReadyToSend) },
            { label: <a href="#/reviews">Reviews without a response</a>, value: String(a.reviewsWithoutResponse) },
            { label: "1–2★ reviews, last 30 days", value: String(a.lowRatingsLast30Days) },
          ]} />
          <p className="muted small">Agent proposals (hours, menu, cancellations) wait for approval in Studio → Agent.</p>
        </section>
      </div>
    </>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return <div className="stat"><strong>{n}</strong><span>{label}</span></div>;
}
