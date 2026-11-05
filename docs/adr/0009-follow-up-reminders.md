# 0009 — Follow-up reminders

Date: 2026-11-05
Status: Accepted

## Context

The roadmap's next item after auth: knowing WHEN to chase an application.
A tracker without reminders relies on the user's memory — the exact
problem it exists to solve. The feature must fit the existing shape:
date-only fields (`appliedAt`), event-sourced timeline, per-user
isolation, no new dependencies, and a lean client.

## Decision

### A date on the application, not a separate entity

`applications.follow_up_at TEXT` (nullable, YYYY-MM-DD) — migration 5
with a **partial index** `(user_id, follow_up_at) WHERE follow_up_at IS
NOT NULL`. One pending follow-up per application is the honest model for
a job chase: rescheduling replaces the date, and the timeline keeps the
history. A separate `reminders` table would buy multiple reminders per
application at the cost of a join, a second CRUD surface, and cascade
rules — none of which the use case needs.

### Bucketing lives on the client

`GET /api/reminders` returns a flat list, soonest first (YYYY-MM-DD
sorts lexicographically = chronologically). Whether a date is _overdue_,
_today_, or _upcoming_ depends on the USER's timezone — a server in
UTC must not tell a user in UTC+13 that tomorrow's reminder is due
today. The client buckets against `localDateString()` (local calendar
components, never `toISOString()`, which shifts across midnight).

### Lifecycle rules in the service layer

- Scheduling/rescheduling/clearing a follow-up atomically records a
  `reminder` event (`Follow-up scheduled for 2026-11-10`, `Follow-up
cleared`). Setting the same date is a timeline no-op.
- Moving to `rejected` **auto-clears** a pending follow-up with an
  explanatory event — a rejection ends the chase. An explicit
  `followUpAt` in the same patch wins (the caller knows better).
- `reminder` joins `created`/`status` as a system event type: readable
  in the timeline, NOT in `USER_EVENT_TYPES`, so POSTing one by hand is
  a 400. The timeline stays trustworthy.

### UI surface

- Form: a "Follow-up on" date input next to "Applied on".
- Card: a badge — red (overdue), amber (today), neutral (upcoming).
- Dashboard: a Follow-ups panel grouped Overdue / Today / Upcoming,
  each row linking into the detail drawer. A reminders fetch failure
  degrades to no panel; it never takes the dashboard down.
- Drawer: the date with a human label plus 🔔 events in the timeline.

### Seed

Three demo rows carry reminders (overdue −2d, today, +3d) so the panel
and badges are visible immediately in the demo account.

## Consequences

- - The "what do I do today" question is answered on the dashboard.
- - Reminder history is event-sourced like everything else; no silent
    mutations (auto-clear logs its reason).
- - Partial index keeps the reminders query cheap regardless of board
    size; ownership scoping comes free from the round-5 repository.
- - Timezone correctness is pinned by unit tests (late-evening local
    date, month boundaries).
- − One reminder per application; multi-reminder workflows (interview
  rounds) would need the separate-table design. Deferred until asked.
- − No push/email notifications: reminders are pull-based (badge +
  panel). Delivery channels are an infrastructure decision, not a
  schema one, and can layer on later without touching this model.

## Alternatives considered

- **Separate reminders table**: more general, but joins + CRUD + UI for
  a use case that is "one next action per application". Rejected as
  speculative generality.
- **Server-side bucketing with a `?tz=` parameter**: moves the user's
  clock into the API and caches per-timezone answers; the flat list is
  simpler and CDN-agnostic. Rejected.
- **Full timestamp reminders (`2026-11-10T14:00Z`)**: false precision —
  chasing recruiters is a day-granularity activity, and date-only
  matches `appliedAt`. Rejected.
