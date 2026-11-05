# 0010 — CSV export/import, archive, themes, markdown notes

Date: 2026-11-05
Status: Accepted

## Context

Four user-facing features in one round, all under the standing
constraint: zero new runtime dependencies, engineering depth over
feature breadth. They share a theme — the tracker becomes a tool you
can live in daily: get data out (CSV), get data in (CSV), clean the
board without destroying history (archive), make it yours (theme), and
write useful notes (markdown).

## Decisions

### CSV: machine-round-trippable first

- **Export** (`GET /api/export/csv`) streams every row the user owns —
  active AND archived; a backup that silently drops the archive is not
  a backup. RFC 4180: CRLF, quoted cells, doubled quotes. Header uses
  the API's camelCase field names so export→import is lossless.
- **Formula injection**: cells starting with `= + - @ tab CR` are
  prefixed with `'` so spreadsheets treat them as text
  (`=HYPERLINK(…)` in notes is a real phishing vector). A leading quote
  is escaped the same way, making the transform reversible; import
  strips exactly one. Pinned by a round-trip test with commas, quotes,
  newlines, and formula payloads.
- **Import** (`POST /api/import/csv`) travels as JSON `{ csv }` — the
  browser reads the file and posts it like any mutation, so the
  JSON-only CSRF defense (ADR-0005) applies unchanged; no multipart
  parser, no new attack surface. Caps: 256 KiB (the express.json limit)
  and 1000 rows.
- **Atomic**: the whole file is parsed and validated BEFORE the first
  write; every bad row is reported with its row number
  (`row 7: salaryMin`). One bad row rejects the file — a half-imported
  board is worse than a rejected file. Unknown header columns are
  errors, not silent drops (a `slary` typo must not lose data).
- Rows with `archivedAt` are created and then archived through the same
  service path, so the timeline records it like any manual archive.

### Archive: soft delete with history

`applications.archived_at TEXT` (migration 6) + an index on
`(user_id, archived_at)`. The board and the archive are disjoint views
(`archived_at IS NULL` / `IS NOT NULL`) over the same table; the list
endpoint takes `?archived=true`. Analytics and reminders exclude
archived rows — an archived chase is not an active pipeline.

`POST /applications/:id/archive` and `/restore` are **idempotent**:
repeating them changes nothing (no event, no version bump). State
changes record an `archive` event and bump the row version, so ETag
clients stay consistent. Delete remains the destructive option,
unchanged.

### Theme: variables, not components

The stylesheet already ran on CSS custom properties, so light mode is
one `[data-theme='light']` variable block — no component changes, no
flash-of-wrong-theme machinery beyond a localStorage read at mount.
Priority: stored choice → OS `prefers-color-scheme` → dark (the
product's default design). Playwright pins `colorScheme: 'dark'` so
the theme E2E doesn't depend on the runner's default.

### Markdown: safe by construction

Notes render a small subset — `**bold**`, `*italic*`, `` `code` ``,
`[links](https://…)`, `- ` lists, paragraphs. The renderer builds
**React elements, never HTML strings**: there is no
`dangerouslySetInnerHTML` anywhere, so `<script>` in a note is inert
text by construction, not by sanitizer correctness. Links are
restricted to http(s); `javascript:` and `data:` URLs render as plain
text. A markdown dependency (with its sanitizer CVE history) is not
justified for a notes field.

## Consequences

- - Full data portability: export → import into a fresh account is
    tested end-to-end, including archived rows and tricky cells.
- - Import errors are actionable (row numbers) and never partial.
- - Archive keeps the timeline trustworthy; restore is one click.
- - Theme and markdown add zero dependencies and zero XSS surface.
- − CSV has no event history (rows only). Events are an audit trail,
  not user data; exporting them would complicate the format for little
  user value. Revisit if asked.
- − The markdown subset is deliberately small (no headings, tables,
  images). Notes are short-form; a full parser can replace the module
  later without touching storage.
- − Import creates new rows; it does not deduplicate against existing
  data. Idempotent re-import would need natural keys the domain does
  not have (company+position is not unique).

## Alternatives considered

- **Multipart file upload**: new parser dependency, CSRF surface
  outside the JSON-only rule, and no benefit for ≤256 KiB files.
- **JSON export instead of CSV**: spreadsheets are the target; JSON
  would serve backups but not the "open in Excel" workflow.
- **Hard delete with trash table**: same soft-delete idea with more
  moving parts; a nullable timestamp on the existing table wins.
- **A markdown library + DOMPurify**: two dependencies and a sanitizer
  bypass risk for a five-token subset. Rejected.
