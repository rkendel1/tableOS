# TableOS

A restaurant front-office application built on [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit)
(`@feltdb/feltkit` 0.3.24, FeltDB 0.21.0, AppPort Services 0.16.2).

TableOS keeps the restaurant's canonical records: identity, locations, hours and special hours, menus, booking
rules, tables, reservations, waitlist, guests, inquiries with their communication history, and reviews with
provenance. The public site, webhook subscribers and agents are projections of those records, or callers into
them. TableOS is fully usable without a language model.

It is not a POS, accounting, payroll or kitchen system.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000. Sign in as a development user:

| User | Role | Can |
|---|---|---|
| Maria Rossi | manager (+ admin) | everything, including approving agent proposals |
| Sam Okafor | host | bookings, floor status, waitlist, guests, inquiries |
| Lee Chen | staff | read only |
| Front-desk Agent | agent | reads, books for confirmed guests, drafts; hours/menu/cancellations only by proposal |

On an empty development environment, **Today → Load sample restaurant** creates a sample restaurant. Its
reviews are labelled as development data. Loading the sample is refused in production, and once a restaurant
exists. The public site is at http://localhost:3000/#/site.

```bash
npm test                         # 31 acceptance tests, each on a fresh FeltDB instance
node scripts/smoke-http.mjs      # anonymous public path over real HTTP, against a running server
npm run build                    # production build (backend bundle, state contract, frontend)
npx feltkit deploy --target container   # verified Node/Docker artifact in .feltkit/deploy
```

## How it is built

| Path | What |
|---|---|
| `feltkit/app.ts` | roles, services, the 15 collections (the state contract FeltDB enforces) |
| `feltkit/restaurant.ts`, `menu.ts` | canonical restaurant information |
| `feltkit/reservations.ts`, `_booking.ts`, `_availability.ts` | availability, booking, modification, cancellation, floor status, waitlist |
| `feltkit/public.ts` | the public site's functions (`access: "public"`) |
| `feltkit/guests.ts`, `inquiries.ts`, `reviews.ts`, `insights.ts` | customer operations, reputation, today's picture, audit trail |
| `feltkit/publisher.ts` | an application agent (deterministic handler) that announces committed changes as webhooks |
| `feltkit/_rules.ts`, `_time.ts` | pure rules: menu checks, inquiry triage, review themes, local time |
| `src/` | management UI (stack-ui `Shell`, from npm `@stack-ui/*` 0.8.1) and the public site (`src/site`) |

Key guarantees, each covered by tests in `tests/`:

- **Reservations cannot overbook.** A booking reads the location's reservations for the date and inserts in
  one FeltDB transaction. FeltDB validates the reads at commit, so simultaneous bookings for the last table
  commit exactly once; the others get a retryable `CONFLICT` and write nothing.
- **Idempotent booking.** The idempotency key is a unique constraint. The same key returns the original booking.
- **History is kept.** Changes are audit events written in the same transaction, ordered by a FeltDB
  sequence, and linked by request id to FeltKit's activity log. Cancellations keep the record.
- **Agents propose; people approve.** Hours, menu changes and cancellations are `approval: "required"`.
  An agent's direct call is refused; its proposal runs only after a person who holds the permission approves
  it in Studio → Agent, and it runs as the agent, with the approval on record.
- **No claimed effects without evidence.** TableOS has no e-mail/SMS channel and no review-site integration.
  An approved reply is `ready`, not `sent`, until a person records how it was sent. A review response is
  `published` only with the URL where it appears.

Evaluation (what FeltKit provides, what TableOS requires, the agent's experience, what the platform should
improve): [FeltKit Evaluation: TableOS](https://claude.ai/artifact/TSofpWqgTsrmBvYchgTTQn). Stage 0 capability
inventory: [docs/PLATFORM-AUDIT.md](docs/PLATFORM-AUDIT.md).

## Deploying

`npx feltkit deploy --target container` writes `.feltkit/deploy/` (Dockerfile, compose file, `DEPLOY.md`).
Other FeltKit targets (`hosted`, `self-hosted`, `vercel`, `cloudflare`, `fly`) work the same way.

TableOS **cannot** be packaged as an AppBoundry artifact today. `feltkit build --target appboundry` refuses it,
naming each use: `approval: "required"`, the publisher application agent, and time-zone handling (`Intl`).

If the machine's environment sets `FELTDB_URL`/`FELTDB_TOKEN`, `feltkit start` uses that FeltDB server.
