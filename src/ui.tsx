/** Small shared pieces: formatting, permissions, routing, notices. */
import { createContext, useContext, useEffect, useState } from "react";
import { FeltKitClientError } from "@feltdb/feltkit/react";
import { StatusIndicator, type Tone } from "@stack-ui/react";

export const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const centsFrom = (text: string) => Math.round(Number(text.replace(/[^0-9.]/g, "")) * 100);
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function when(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Same matching rule as AppPort: exact, "ns.*", or "*". A UI hint only: the server decides. */
export function can(granted: readonly string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}

/** A fresh idempotency key for one user intent (kept across retries of that intent). */
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function describe(error: unknown): string {
  if (error instanceof FeltKitClientError) {
    if (error.code === "CONFLICT" && error.retryable) return "Someone else changed this at the same moment. Nothing was saved — please try again.";
    if (error.code === "FORBIDDEN" && (error.details as { approval?: string } | undefined)?.approval === "required") return "This change needs a person's approval.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const TONES: Record<string, Tone> = {
  booked: "progress", seated: "attention", completed: "positive", cancelled: "neutral", no_show: "critical",
  waiting: "attention", open: "attention", awaiting_guest: "progress", closed: "neutral",
  received: "neutral", draft: "attention", ready: "progress", sent: "positive", approved: "progress", published: "positive",
};
export function Status({ value }: { value: string }) {
  return <StatusIndicator tone={TONES[value] ?? "unknown"} label={value.replace(/_/g, " ")} />;
}

export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export interface AppContext {
  permissions: string[];
  principalId: string;
  report: (error: unknown) => void;
  notify: (text: string) => void;
  locationId: string | null;
}
export const Ctx = createContext<AppContext | null>(null);
export const useApp = () => useContext(Ctx)!;

/** Run a mutation from a button: reports errors, returns the result or undefined. */
export function useRun() {
  const { report } = useApp();
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>, done?: (value: T) => void): Promise<T | undefined> {
    setBusy(true);
    try {
      const value = await fn();
      done?.(value);
      return value;
    } catch (e) {
      report(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}
