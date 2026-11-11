# Stage 0 — Platform audit for TableOS

Inspected on 2026-11-11 from source checkouts (shallow clones of each repository's default branch) and the
packages npm actually serves. Source and tests took precedence over prose; where prose was used it is cited
and was cross-checked against code.

## What was inspected

| Component | Repository @ commit | Published package (npm, 2026-11-11) |
|---|---|---|
| FeltKit SDK, runtime, CLI, Studio | `rkendel1/feltkit` @ `7165a80` | `@feltdb/feltkit` **0.3.24**, `create-feltkit` 0.3.24 |
| FeltDB | (via package; repo `flow_db` not cloned) | `@feltdb/core` **0.21.0** (resolved by FeltKit, single copy — `npm ls`) |
| AppPort | `rkendel1/appport` @ `e91fd39` | `@appport/sdk` 1.8.1, `@appport/server` 1.3.2, `@appport/authorization` 1.1.1, `@appport/protocol` 1.5.0 |
| AppPort Services | `rkendel1/appport-services` @ `a549377` | `@appport/services` **0.16.2** |
| AppBoundry | `rkendel1/appboundry` @ `6c82f1d` | `@appport/appboundry` 1.11.1 |
| AuthBoundry | `rkendel1/authboundry` @ `b0e4c30` | `@authboundry/core` 1.16.0 |
| Resolver | `rkendel1/resolver` @ `c674d14` | `@appport/resolver` 0.3.3, `@appport/resolver-client` 0.2.4 (FeltKit dep) |
| stack-ui | `rkendel1/stack-ui` @ `a28f999` | **not published** (README: "Not published to npm yet (scope: D9)") |
| Reference apps | `rkendel1/supply-desk` @ `2938399`, `rkendel1/personalos` @ `6a716f3` | — |

All FeltKit paths below are relative to `feltkit/packages/sdk/` unless stated.

## Capability inventory

Legend — **R** Reusable (direct) · **C** Composable (existing capabilities + configuration) · **E** Extension
(platform change needed) · **A** Application-owned (restaurant domain logic).

| Requirement | Class | Platform capability used (package@version) | Evidence (source / tests) | Limitations that affect TableOS |
|---|---|---|---|---|
| Durable restaurant data | **R** | `app.collection` → FeltDB JSON documents, state contract with types, required fields, `unique`, `indexes`, `s.ref` (feltkit 0.3.24 / feltdb core 0.21.0) | `src/app.ts`, `src/runtime/state-contract.ts`; tests `test/contract.test.ts`, `test/schema-lifecycle.test.ts`, `test/shared-instance.test.ts` (restart durability) | One FeltDB instance per environment; local runtime is single-host (README "Guarantees and limitations"). |
| Atomic writes, concurrency | **R** | Mutations commit in one FeltDB transaction; every read (incl. `find` predicates / phantoms) is validated at commit → `CONFLICT` (retryable) | README "Queries and mutations"; `docs/GUARANTEES.md#mutation-isolation`; `test/transactions.test.ts`, `test/isolation.test.ts`, `test/sequence.test.ts` | A conflicting concurrent booking is **refused**, not merged; the loser must retry. Read-only mutations are not checked. |
| Audit history | **C** | Business events written in the same transaction (SupplyDesk pattern `feltkit/_audit.ts`) ordered with `ctx.db.sequence`; FeltKit activity log records every call with principal, authority decision, committed writes, linked by `ctx.requestId` | `src/runtime/activity.ts`, `src/runtime/data.ts` (sequence); `test/audit.test.ts`, `test/sequence.test.ts` | Domain event shape is the app's; activity log is platform-owned. |
| Restaurant & locations | **A** on **R** | Collections + `access` permissions | — | One restaurant per application (multi-restaurant would use `auth.tenant`, `src/runtime/tenancy.ts`; not used — scope). |
| Hours & special hours | **A** | Collections; IANA time zone handled by app code | — | Overnight periods (close after midnight) are not modelled in v1. |
| Menu management | **A** on **R** | Collections; Files service for images (`ctx.services.files`, file links) | README "Services"; `test/file-links.test.ts` | Image upload deferred (Files available; UI not built). |
| Public projections (site, menu, hours, booking) | **R** | `access: "public"` functions served by the same runtime, live queries | `src/app.ts:365-386`, `src/runtime/authority.ts:155-163` | Public mutations have no built-in rate limiting (README: "put the platform's rate limiting in front"). |
| External projections | **C** | Webhooks service (`services.webhooks`, `ctx.afterCommit.webhooks.emit`): signed, durable, retried deliveries with status in Studio | README "Services"; `test/outbox.test.ts`, e2e `tests/e2e/outbox-lifecycle.test.mjs` | No directory/listing integration (Google Business Profile, Yelp…) exists in the ecosystem. |
| Reservations, availability, capacity | **A** on **R** | Domain logic; correctness from mutation isolation | — | — |
| Idempotent booking | **C** | `unique` constraint on the reservation's idempotency key + lookup inside the mutation | `test/contract.test.ts` (unique) | FeltKit also has HTTP/AppPort idempotency (`src/runtime/idempotency.ts`) for capability calls; a domain key is still needed for the public form. |
| Waitlists | **A** | Collections + same booking core | — | — |
| Customer inquiries | **A** on **R** | Collections, `ctx.db.search` (`search` fields) | README "Queries and mutations" (`search`) ; `test/search.test.ts` | — |
| Guest records & privacy | **A** on **R** | Permissions (`guests.read`) keep guest PII off public functions | `src/runtime/authority.ts` | No field-level redaction primitive; privacy is enforced by which functions return what. |
| Reviews ingestion | **A** + **E** | Collections with provenance; **no review-platform integration exists** (only `@appport/github` on npm) | `npm search` results; `app.integration` (`src/runtime/integrations.ts`) could wrap a real API if one is provided | Manual entry / file import only. External publication cannot be automated. |
| Customer notifications (guests) | **E** | Notifications service is in-app for principals; e-mail channel is reserved for account mail | `src/runtime/services.ts:13`, `:433-439`; AppPort Services `src/notifications/channels.ts` | **Gap:** no outbound e-mail/SMS to non-principals. TableOS records messages and emits webhooks for an external sender; it never claims delivery. |
| Staff notifications | **R** | `ctx.afterCommit.notifications.send` (in-app, exactly-once creation) | `src/runtime/outbox.ts`; `test/outbox.test.ts` | — |
| Scheduled operations | **R** (not used in v1) | `services.jobs` + `services.schedules` | README "Services": "Schedules are mounted but not exercised end to end by the tests." | Deferred. |
| External integrations | **R** | `app.integration` (AppPort capabilities, recorded calls, `unknown` outcomes, `verify`) | `src/runtime/integrations.ts`; `test/integrations.test.ts` | Nothing to integrate with yet (see reviews). |
| Resolver | **R** (config only) | `agent.model: "ref://…"` | `docs/RESOLVER.md` | Only **model** references are supported ("What is in this release"). |
| Roles & permissions | **R** | `feltkit({ roles })`, `access`, `ctx.auth`, `feltkit({ authorize })`; AppPort authorizer at every boundary | `src/runtime/authority.ts`, `src/authorize.ts`; `test/authorization.test.ts`, `test/authorize.test.ts` | — |
| Identity (people) | **R** | `auth.accounts` (password, providers), dev users | `docs/AUTH.md`; `test/accounts.test.ts` | — |
| AuthBoundry | **R** (optional) | Delegated-authority check for agents (`src/runtime/authboundry.ts`, configured by env) | `test/platform-authboundry.test.ts`, e2e `authboundry-delegation.test.mjs` | Needs a running AuthBoundry; not required for TableOS v1. |
| Agent-assisted operations | **R** | MCP endpoint (`/mcp`), `feltkit_context`, agent tasks, `approval: "required"` → agents can only propose; a person who may perform it approves; runs as proposer; recorded | `skills/feltkit-agent/SKILL.md`; `test/approval-required.test.ts`, `test/agent-lifecycle.test.ts` | Approval requirement is **refused by the AppBoundry build** (`src/appboundry/build.ts:163`). |
| Deterministic analysis (no LLM) | **A** | Plain queries | — | Must work without a model (requirement). |
| Management UI | **C** | stack-ui 0.7.0 (`Shell`, `DataTable`, `Form`, `Dialog`, `StatusIndicator`…) + `@feltdb/feltkit/react` (`useQuery` live, `useMutation`, `useSession`) | stack-ui `docs/product-shell.md`; feltkit `src/react/` | stack-ui must be **vendored** (unpublished). FeltKit's own Studio vendors it identically (`dashboard/vendor/stack-ui/README.md`). |
| Deployment | **R** | `feltkit build`, `feltkit deploy --target container|hosted|…` | README "Deploying"; `test/deploy.test.ts`, e2e `deploy-targets.test.mjs` | — |
| AppBoundry artifact | **E** for this app | `feltkit build --target appboundry` | `src/appboundry/build.ts`; README "Running from an artifact" | Artifact refuses `approval: "required"`, `ctx.agent`, `app.integration`, `Intl`; omits `/mcp`, API keys, schedules, webhook delivery. An agent-operated app cannot use it today. |

## Smallest viable architecture

One FeltKit application (`feltkit/` backend + `src/` React frontend), one FeltDB instance per environment.
Nothing else is introduced: no sidecars, no second database, no agent runtime, no custom auth.

- **Canonical state:** FeltDB collections declared in `feltkit/app.ts`.
- **Domain rules:** pure functions in `feltkit/_*.ts` (availability, transitions, menu checks, review themes),
  unit-tested without a runtime.
- **Workflows:** mutations; each writes its business event in the same transaction.
- **Public experience:** `access: "public"` functions in `feltkit/public.ts`, rendered by the same frontend
  at `#/site`. It never returns guest data except a booking's own confirmation, by bearer code.
- **Agents:** MCP + FeltKit agent tasks. Externally visible / canonical changes an agent may want to make
  (hours, menu prices and availability, cancellations) carry `approval: "required"`. Draft-only operations
  (reply and review-response drafts) are direct; publishing them is a person's act.
- **External projections:** webhook events emitted after commit; delivery evidence lives in AppPort Services.
- **Deployment:** `feltkit deploy` (Node/container). AppBoundry is evaluated and its refusal recorded, not
  worked around by removing the approval guarantees.
