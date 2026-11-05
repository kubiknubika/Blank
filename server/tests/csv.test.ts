import { describe, it, expect } from 'vitest';
import { toCsv, parseCsv, parseImport, CSV_COLUMNS } from '../src/csv.js';
import { ValidationError } from '../src/errors.js';
import type { Application } from '@offerflow/shared';

function app(overrides: Partial<Application> = {}): Application {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    company: 'Acme',
    position: 'FE',
    status: 'applied',
    source: 'linkedin',
    priority: 'medium',
    location: null,
    workMode: 'remote',
    salaryMin: null,
    salaryMax: null,
    currency: 'EUR',
    url: null,
    notes: null,
    appliedAt: null,
    followUpAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('CSV export', () => {
  it('writes a camelCase header and CRLF rows', () => {
    const csv = toCsv([app()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines[1].startsWith('Acme,FE,applied,linkedin,medium')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('quotes cells containing commas, quotes, and newlines (RFC 4180)', () => {
    const csv = toCsv([app({ company: 'A,B "C"', notes: 'line1\nline2' })]);
    expect(csv).toContain('"A,B ""C"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('quote-prefixes formula cells against spreadsheet injection', () => {
    const csv = toCsv([app({ notes: '=HYPERLINK("http://evil","click")' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    for (const prefix of ['+1', '-2', '@cmd', "'quoted"]) {
      const row = toCsv([app({ notes: prefix })]);
      expect(row).toContain(`'${prefix}`);
    }
  });

  it('round-trips through parseCsv + parseImport without data loss', () => {
    const tricky = app({
      company: 'A,B "C"',
      notes: "=SUM(1,2)\nsecond 'line'",
      location: 'Berlin, DE',
      salaryMin: 70000,
      salaryMax: 90000,
      appliedAt: '2026-10-01',
      followUpAt: '2026-11-10',
    });
    const rows = parseImport(toCsv([tricky]));
    expect(rows).toHaveLength(1);
    expect(rows[0].input.company).toBe('A,B "C"');
    expect(rows[0].input.notes).toBe("=SUM(1,2)\nsecond 'line'");
    expect(rows[0].input.salaryMin).toBe(70000);
    expect(rows[0].input.appliedAt).toBe('2026-10-01');
    expect(rows[0].archived).toBe(false);
  });
});

describe('CSV parser', () => {
  it('handles BOM, CRLF, quoted newlines and doubled quotes', () => {
    const rows = parseCsv('\uFEFFa,b\r\n"x""y","line1\nline2"\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x"y', 'line1\nline2'],
    ]);
  });

  it('rejects unterminated quotes instead of importing half a row', () => {
    expect(() => parseCsv('a,b\n"unterminated,')).toThrow(ValidationError);
  });

  it('drops empty trailing lines', () => {
    expect(parseCsv('a\nb\n\n')).toEqual([['a'], ['b']]);
  });
});

describe('CSV import validation', () => {
  const header = 'company,position';

  /** ValidationError carries the human text in details[], not message. */
  const detailsOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).details!.map((d) => d.message).join('; ');
    }
    expect.unreachable();
  };

  it('requires company and position columns', () => {
    expect(detailsOf(() => parseImport('foo,bar\n1,2'))).toMatch(/company and position/);
  });

  it('rejects unknown columns (typos never silently drop data)', () => {
    expect(detailsOf(() => parseImport('company,position,slary\nA,B,1'))).toMatch(/Unknown column/);
  });

  it('rejects empty files and header-only files', () => {
    expect(detailsOf(() => parseImport(''))).toMatch(/empty/);
    expect(detailsOf(() => parseImport(header + '\n'))).toMatch(/no data rows/);
  });

  it('applies schema defaults for omitted optional columns', () => {
    const rows = parseImport(`${header}\nAcme,FE\n`);
    expect(rows[0].input.status).toBe('wishlist');
    expect(rows[0].input.currency).toBe('EUR');
    expect(rows[0].input.salaryMin).toBeNull();
  });

  it('collects per-row errors with row numbers and rejects the whole file', () => {
    try {
      parseImport('company,position,salaryMin\nA,FE,10\n,FE,20\nB,FE,not-a-number\n');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const details = (err as ValidationError).details!;
      expect(details.some((d) => d.path === 'row 3: company')).toBe(true);
      expect(details.some((d) => d.path === 'row 4: salaryMin')).toBe(true);
    }
  });

  it('enforces the 1000-row cap', () => {
    const csv = header + '\n' + 'A,FE\n'.repeat(1001);
    expect(detailsOf(() => parseImport(csv))).toMatch(/Too many rows/);
  });

  it('marks rows with archivedAt for post-insert archiving', () => {
    const rows = parseImport('company,position,archivedAt\nA,FE,2026-01-01T00:00:00.000Z\nB,BE,\n');
    expect(rows[0].archived).toBe(true);
    expect(rows[1].archived).toBe(false);
  });

  it('rejects invalid archivedAt timestamps', () => {
    expect(detailsOf(() => parseImport('company,position,archivedAt\nA,FE,not-a-date\n'))).toMatch(
      /Invalid timestamp/,
    );
  });
});
