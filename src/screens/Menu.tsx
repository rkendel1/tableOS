import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { Alert, Button, Checkbox, Dialog, EmptyState, FieldGroup, Form, Loading, PageHeader, StatusIndicator } from "@stack-ui/react";
import { TextField } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { ALLERGENS, DIETARY } from "../../feltkit/_constants";
import { can, centsFrom, money, useApp, useRun } from "../ui";

type Item = NonNullable<ReturnType<typeof useMenu>>["items"][number];
const useMenu = () => useQuery(api.menu.full, {});

interface Draft { id?: string; sectionId: string; name: string; description: string; price: string; dietary: string[]; allergens: string[] | null; available: boolean; position: number }

export function MenuScreen() {
  const { permissions } = useApp();
  const data = useMenu();
  const issues = useQuery(api.menu.issues, can(permissions, "insights.read") ? {} : "skip");
  const saveMenu = useMutation(api.menu.saveMenu);
  const saveSection = useMutation(api.menu.saveSection);
  const saveItem = useMutation(api.menu.saveItem);
  const setAvailability = useMutation(api.menu.setAvailability);
  const removeItem = useMutation(api.menu.removeItem);
  const { busy, run } = useRun();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newMenu, setNewMenu] = useState("");
  const [newSection, setNewSection] = useState<Record<string, string>>({});
  const write = can(permissions, "menu.write");

  if (!data) return <Loading what="menus" />;
  const edit = (i: Item) => setDraft({ id: i.id, sectionId: i.sectionId, name: i.name, description: i.description ?? "", price: (i.priceCents / 100).toFixed(2), dietary: [...i.dietary], allergens: i.allergens ? [...i.allergens] : null, available: i.available, position: i.position });
  const issuesFor = (itemId: string) => issues?.issues.filter((x) => x.itemId === itemId) ?? [];

  return (
    <>
      <PageHeader title="Menu" description="The canonical menu. The public site shows published menus and available items as soon as you save." actions={<a href="#/site/menu">See the public menu →</a>} />
      {issues && issues.issues.length > 0 && (
        <Alert tone={issues.issues.some((i) => i.severity === "error") ? "critical" : "attention"} title={`${issues.issues.length} menu checks to review`}>
          <ul className="plain">{issues.issues.slice(0, 8).map((i, n) => <li key={n}>{i.message}</li>)}</ul>
          {issues.issues.length > 8 && <p className="muted small">…and {issues.issues.length - 8} more (marked below).</p>}
          <p className="muted small">Rule-based checks ({issues.method}); no model involved.</p>
        </Alert>
      )}
      {data.menus.length === 0 && <EmptyState title="No menus yet" body="Create a menu, add sections, then items." />}
      {data.menus.map((m) => (
        <section key={m.id} className="panel">
          <div className="row between">
            <h2>{m.name} {m.active ? <StatusIndicator tone="positive" label="published" /> : <StatusIndicator tone="neutral" label="not published" />}</h2>
            {write && <Button size="sm" variant="secondary" label={m.active ? "Unpublish" : "Publish"} onClick={() => void run(() => saveMenu({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}), active: !m.active, locationIds: m.locationIds, position: m.position }))} />}
          </div>
          {data.sections.filter((s) => s.menuId === m.id).map((s) => (
            <div key={s.id} className="menu-section">
              <h3>{s.name}</h3>
              <table className="items">
                <tbody>
                  {data.items.filter((i) => i.sectionId === s.id).map((i) => (
                    <tr key={i.id} className={i.available ? "" : "unavailable"}>
                      <td>
                        <strong>{i.name}</strong> {!i.available && <StatusIndicator tone="neutral" label="86'd" />}
                        {i.description && <div className="muted small">{i.description}</div>}
                        <div className="small">
                          {i.dietary.map((d) => <span key={d} className="tag">{d.replace("_", "-")}</span>)}
                          {i.allergens === undefined ? <span className="tag warn">allergens not declared</span> : i.allergens.length ? <span className="muted"> contains: {i.allergens.join(", ").replace(/_/g, " ")}</span> : <span className="muted"> no listed allergens</span>}
                        </div>
                        {issuesFor(i.id).map((x, n) => <div key={n} className={`small ${x.severity === "error" ? "critical" : "attention"}`}>⚠ {x.message}</div>)}
                      </td>
                      <td className="num">{money(i.priceCents)}</td>
                      <td className="actions">
                        {write && <>
                          <Button size="sm" variant="secondary" label={i.available ? "Mark sold out" : "Mark available"} onClick={() => void run(() => setAvailability({ itemId: i.id, available: !i.available }))} />
                          <Button size="sm" variant="ghost" label="Edit" onClick={() => edit(i)} />
                        </>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {write && <Button size="sm" variant="ghost" label="+ Add item" onClick={() => setDraft({ sectionId: s.id, name: "", description: "", price: "", dietary: [], allergens: null, available: true, position: data.items.filter((x) => x.sectionId === s.id).length })} />}
            </div>
          ))}
          {write && (
            <Form label="New section" layout="inline" submitLabel="Add section" onSubmit={() => void run(() => saveSection({ menuId: m.id, name: newSection[m.id] ?? "", position: data.sections.filter((s) => s.menuId === m.id).length }), () => setNewSection({ ...newSection, [m.id]: "" }))}>
              <TextField label="Section name" value={newSection[m.id] ?? ""} onChange={(v) => setNewSection({ ...newSection, [m.id]: v })} required />
            </Form>
          )}
        </section>
      ))}
      {write && (
        <Form label="New menu" layout="inline" submitLabel="Create menu" busy={busy} onSubmit={() => void run(() => saveMenu({ name: newMenu, active: false, locationIds: [], position: data.menus.length }), () => setNewMenu(""))}>
          <TextField label="Menu name" value={newMenu} onChange={setNewMenu} required hint="Created unpublished." />
        </Form>
      )}
      <Dialog open={!!draft} title={draft?.id ? "Edit item" : "New item"} onClose={() => setDraft(null)}
        actions={<>
          <Button label="Save item" busy={busy} onClick={() => draft && void run(() => saveItem({
            ...(draft.id ? { id: draft.id } : {}), sectionId: draft.sectionId, name: draft.name, ...(draft.description ? { description: draft.description } : {}),
            priceCents: centsFrom(draft.price || "0"), dietary: draft.dietary as never, ...(draft.allergens ? { allergens: draft.allergens as never } : {}), available: draft.available, position: draft.position,
          }), () => setDraft(null))} />
          {draft?.id && <Button variant="danger" label="Remove item" onClick={() => void run(() => removeItem({ itemId: draft.id! }), () => setDraft(null))} />}
          <Button variant="ghost" label="Close" onClick={() => setDraft(null)} />
        </>}>
        {draft && <>
          <TextField label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} required />
          <TextField label="Description" multiline rows={2} value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} />
          <TextField label="Price (USD)" inputmode="decimal" value={draft.price} onChange={(v) => setDraft({ ...draft, price: v })} required />
          <Checkbox label="Available" checked={draft.available} onChange={(c) => setDraft({ ...draft, available: c })} />
          <FieldGroup legend="Dietary">
            <div className="checks">{DIETARY.map((d) => <Checkbox key={d} label={d.replace("_", "-")} checked={draft.dietary.includes(d)} onChange={(c) => setDraft({ ...draft, dietary: c ? [...draft.dietary, d] : draft.dietary.filter((x) => x !== d) })} />)}</div>
          </FieldGroup>
          <FieldGroup legend="Allergens" hint="Leave undeclared until checked with the kitchen; the public menu then says to ask staff.">
            <Checkbox label="Allergens checked with the kitchen" checked={draft.allergens !== null} onChange={(c) => setDraft({ ...draft, allergens: c ? [] : null })} />
            {draft.allergens && <div className="checks">{ALLERGENS.map((a) => <Checkbox key={a} label={a.replace("_", " ")} checked={draft.allergens!.includes(a)} onChange={(c) => setDraft({ ...draft, allergens: c ? [...draft.allergens!, a] : draft.allergens!.filter((x) => x !== a) })} />)}</div>}
          </FieldGroup>
        </>}
      </Dialog>
    </>
  );
}
