import type { Application } from '@offerflow/shared';
import { createApplicationSchema } from '@offerflow/shared/schemas';
import type { CreateApplicationInput } from '@offerflow/shared/schemas';
import { ValidationError } from './errors.js';

/**
 * CSV export/import — RFC 4180 with two security-minded deviations:
 *
 * 1. FORMULA INJECTION: a cell starting with = + - @ (or tab/CR) is
 *    prefixed with a single quote so spreadsheet apps treat it as text,
 *    not a formula ("=HYPERLINK(...)" in a notes field is a classic
 *    phishing vector). To keep the transform REVERSIBLE, a leading
 *    quote is itself escaped the same way; import strips exactly one.
 *
 * 2. IMPORT IS ATOMIC: every row is validated BEFORE anything is
 *    written; one bad row rejects the whole file with per-row error
 *    details. A half-imported board is worse than a rejected file.
 *
 * The header row uses the API's camelCase field names — the CSV is
 * machine-round-trippable first, human-readable second.
 */

export const CSV_COLUMNS = [
  'company',
  'position',
  'status',
  'source',
  'priority',
  'location',
  'workMode',
  'salaryMin',
  'salaryMax',
  'currency',
  'url',
  'notes',
  'appliedAt',
  'followUpAt',
  'archivedAt',
] as const;

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r', "'"];

function escapeCell(value: string): string {
  let v = value;
  if (v.length > 0 && FORMULA_PREFIXES.includes(v[0])) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

function unescapeCell(value: string): string {
  // Symmetric to escapeCell: strip exactly ONE protective quote.
  return value.startsWith("'") ? value.slice(1) : value;
}

export function toCsv(apps: Application[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const app of apps) {
    lines.push(
      CSV_COLUMNS.map((col) => {
        const v = app[col];
        return v == null ? '' : escapeCell(String(v));
      }).join(','),
    );
  }
  // RFC 4180: CRLF line endings; trailing newline keeps `wc -l` honest.
  return lines.join('\r\n') + '\r\n';
}

/**
 * Minimal RFC 4180 parser: quoted cells, doubled quotes, embedded
 * newlines, CRLF or LF. Throws on unterminated quotes — a truncated
 * file must not silently import half a row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  // Strip a UTF-8 BOM (Excel adds one).
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (inQuotes) {
    throw new ValidationError([{ path: 'csv', message: 'Unterminated quoted cell' }]);
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop fully-empty trailing lines.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export interface ImportedRow {
  input: CreateApplicationInput;
  archived: boolean;
}

const MAX_IMPORT_ROWS = 1000;

/**
 * Validates the WHOLE file and returns parsed rows, or throws a
 * ValidationError listing every bad row (path = "row N: field").
 * Nothing is written here — the service wraps the writes in one
 * transaction.
 */
export function parseImport(text: string): ImportedRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new ValidationError([{ path: 'csv', message: 'CSV file is empty' }]);
  }
  const header = rows[0].map((h) => h.trim());
  if (!header.includes('company') || !header.includes('position')) {
    throw new ValidationError([
      { path: 'csv', message: 'Header must include at least company and position columns' },
    ]);
  }
  const unknown = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) {
    throw new ValidationError([
      { path: 'csv', message: `Unknown column(s): ${unknown.join(', ')}` },
    ]);
  }
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    throw new ValidationError([{ path: 'csv', message: 'CSV has a header but no data rows' }]);
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new ValidationError([
      { path: 'csv', message: `Too many rows (${dataRows.length}); maximum is ${MAX_IMPORT_ROWS}` },
    ]);
  }

  const errors: { path: string; message: string }[] = [];
  const out: ImportedRow[] = [];

  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 2; // 1-based, header is row 1
    const raw: Record<string, unknown> = {};
    header.forEach((col, ci) => {
      const value = unescapeCell(cells[ci] ?? '');
      if (value === '') return; // let schema defaults/nulls apply
      if (col === 'salaryMin' || col === 'salaryMax') {
        const n = Number(value);
        raw[col] = Number.isFinite(n) ? n : value; // non-numeric → schema error
        return;
      }
      raw[col] = value;
    });
    const archivedAt = raw.archivedAt;
    delete raw.archivedAt; // not a create field; applied after insert
    if (archivedAt !== undefined && typeof archivedAt === 'string') {
      if (Number.isNaN(new Date(archivedAt).getTime())) {
        errors.push({ path: `row ${rowNo}: archivedAt`, message: 'Invalid timestamp' });
        return;
      }
    }
    const parsed = createApplicationSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          path: `row ${rowNo}: ${issue.path.join('.') || 'csv'}`,
          message: issue.message,
        });
      }
      return;
    }
    out.push({ input: parsed.data, archived: archivedAt !== undefined });
  });

  if (errors.length > 0) throw new ValidationError(errors);
  return out;
}
