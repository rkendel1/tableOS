import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConnectionState, useQuery, useSession } from "@feltdb/feltkit/react";
import { Alert, Button, Form, Loading, PageHeader, Shell, readThemePreference, setThemePreference, focusMain, type ThemePreference } from "@stack-ui/react";
import { Select, TextField } from "./fields";
import { api } from "../feltkit/_generated/api";
import { Ctx, describe, can, useRoute, type AppContext } from "./ui";
import { Today } from "./screens/Today";
import { Reservations } from "./screens/Reservations";
import { MenuScreen } from "./screens/Menu";
import { RestaurantScreen } from "./screens/Restaurant";
import { Inquiries } from "./screens/Inquiries";
import { Guests } from "./screens/Guests";
import { Reviews } from "./screens/Reviews";
import { Activity } from "./screens/Activity";

const NAV = [
  { id: "today", label: "Today", group: "Front of house" },
  { id: "reservations", label: "Reservations", group: "Front of house" },
  { id: "inquiries", label: "Inquiries", group: "Front of house" },
  { id: "guests", label: "Guests", group: "Front of house" },
  { id: "reviews", label: "Reviews", group: "Reputation" },
  { id: "menu", label: "Menu", group: "Restaurant" },
  { id: "restaurant", label: "Profile, hours & tables", group: "Restaurant" },
  { id: "activity", label: "Audit trail", group: "Restaurant" },
];

function SignIn() {
  const { session, signInAsDevUser, signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!session) return <Loading what="session" />;
  return (
    <main className="signin">
      <PageHeader eyebrow="TableOS" title="Sign in" description="Restaurant front office: reservations, menus, guests and reviews." />
      {error && <Alert tone="critical">{error}</Alert>}
      {session.devUsers.length > 0 && (
        <section>
          <h2>Development users</h2>
          <div className="row wrap">
            {session.devUsers.map((u) => <Button key={u.id} variant="secondary" label={u.name} onClick={() => signInAsDevUser(u.id).catch((e) => setError(describe(e)))} />)}
          </div>
        </section>
      )}
      {session.accounts && (
        <Form label="Sign in" submitLabel="Sign in" onSubmit={() => signIn({ email, password }).catch((e) => setError(describe(e)))}>
          <TextField label="E-mail" type="email" value={email} onChange={setEmail} required />
          <TextField label="Password" type="password" value={password} onChange={setPassword} required />
        </Form>
      )}
      <p><a href="#/site">View the public site →</a></p>
    </main>
  );
}

export function App() {
  const { session, signOut } = useSession();
  const live = useConnectionState();
  const route = useRoute();
  const [notice, setNotice] = useState<{ tone: "critical" | "info"; text: string } | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const [locationId, setLocationId] = useState<string | null>(null);
  const principal = session?.principal ?? null;
  const signedIn = !!principal;

  const locations = useQuery(api.restaurant.listLocations, signedIn ? {} : "skip");
  useEffect(() => {
    if (locations?.length && (!locationId || !locations.some((l) => l.id === locationId))) setLocationId(locations[0]!.id);
  }, [locations, locationId]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    focusMain();
  }, [route[0]]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!session) return <Loading what="TableOS" />;
  if (!principal) return <SignIn />;

  const ctx: AppContext = {
    permissions: session.permissions,
    principalId: principal.id,
    report: (e) => setNotice({ tone: "critical", text: describe(e) }),
    notify: (text) => setNotice({ tone: "info", text }),
    locationId,
  };
  const current = route[0] ?? "today";
  let page: ReactNode;
  switch (current) {
    case "reservations": page = <Reservations />; break;
    case "inquiries": page = <Inquiries id={route[1]} />; break;
    case "guests": page = <Guests id={route[1]} />; break;
    case "reviews": page = <Reviews />; break;
    case "menu": page = <MenuScreen />; break;
    case "restaurant": page = <RestaurantScreen />; break;
    case "activity": page = <Activity />; break;
    default: page = <Today />;
  }

  return (
    <Ctx.Provider value={ctx}>
      <Shell
        product={{ name: "TableOS", homeHref: "#/today" }}
        family={false}
        otherProducts={[]}
        navigation={NAV.map((n) => ({ id: n.id, label: n.label, group: n.group, href: `#/${n.id}`, current: n.id === current }))}
        theme={{ preference: theme, onChange: (p) => setTheme(setThemePreference(p)) }}
        context={locations && locations.length > 1 ? (
          <Select label="Location" value={locationId ?? ""} onChange={setLocationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
        ) : undefined}
        account={
          <span className="account">
            <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes appear as they happen" : "Reconnecting…"} />
            <span>{principal.displayName ?? principal.id}</span>
            <a href="#/site" className="muted">Public site</a>
            {can(session.permissions, "feltkit.agent.read") && session.dashboard && <a className="muted" href={session.dashboard}>Studio</a>}
            <Button size="sm" variant="ghost" label="Sign out" onClick={() => void signOut()} />
          </span>
        }
      >
        {notice && <Alert tone={notice.tone} title={notice.tone === "critical" ? "Not done" : undefined}>{notice.text}</Alert>}
        {page}
      </Shell>
    </Ctx.Provider>
  );
}
