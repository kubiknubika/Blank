import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, type ApplicationInput } from '../api';
import {
  PRIORITIES,
  PRIORITY_LABELS,
  SOURCES,
  SOURCE_LABELS,
  STATUSES,
  STATUS_META,
  WORK_MODES,
  WORK_MODE_LABELS,
  type Application,
} from '../types';

interface ApplicationFormProps {
  initial: Application | null;
  onSubmit: (input: Partial<ApplicationInput>) => Promise<void>;
  onClose: () => void;
}

export function ApplicationForm({ initial, onSubmit, onClose }: ApplicationFormProps) {
  const [company, setCompany] = useState(initial?.company ?? '');
  const [position, setPosition] = useState(initial?.position ?? '');
  const [status, setStatus] = useState(initial?.status ?? 'wishlist');
  const [source, setSource] = useState(initial?.source ?? 'linkedin');
  const [priority, setPriority] = useState(initial?.priority ?? 'medium');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [workMode, setWorkMode] = useState(initial?.workMode ?? 'remote');
  const [salaryMin, setSalaryMin] = useState(initial?.salaryMin?.toString() ?? '');
  const [salaryMax, setSalaryMax] = useState(initial?.salaryMax?.toString() ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? 'EUR');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [appliedAt, setAppliedAt] = useState(initial?.appliedAt ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await onSubmit({
        company: company.trim(),
        position: position.trim(),
        status,
        source,
        priority,
        location: location.trim() || null,
        workMode,
        salaryMin: salaryMin === '' ? null : Number(salaryMin),
        salaryMax: salaryMax === '' ? null : Number(salaryMax),
        currency,
        url: url.trim() || null,
        notes: notes.trim() || null,
        appliedAt: appliedAt || null,
      });
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        const map: Record<string, string> = {};
        for (const d of err.details) map[d.path] = d.message;
        setFieldErrors(map);
        setError('Please fix the highlighted fields.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? 'Edit application' : 'New application'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{initial ? 'Edit application' : 'New application'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <form onSubmit={handleSubmit} className="form">
          <div className="form-grid">
            <Field label="Company *" error={fieldErrors.company}>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                required
                maxLength={120}
                placeholder="Acme Corp"
              />
            </Field>
            <Field label="Position *" error={fieldErrors.position}>
              <input
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                required
                maxLength={160}
                placeholder="Frontend Engineer"
              />
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Source">
              <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Location" error={fieldErrors.location}>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={120}
                placeholder="Berlin, DE"
              />
            </Field>
            <Field label="Work mode">
              <select
                value={workMode}
                onChange={(e) => setWorkMode(e.target.value as typeof workMode)}
              >
                {WORK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {WORK_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Salary min" error={fieldErrors.salaryMin}>
              <input
                type="number"
                min={0}
                step={1000}
                value={salaryMin}
                onChange={(e) => setSalaryMin(e.target.value)}
                placeholder="70000"
              />
            </Field>
            <Field label="Salary max" error={fieldErrors.salaryMax}>
              <input
                type="number"
                min={0}
                step={1000}
                value={salaryMax}
                onChange={(e) => setSalaryMax(e.target.value)}
                placeholder="90000"
              />
            </Field>
            <Field label="Currency" error={fieldErrors.currency}>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="EUR">EUR €</option>
                <option value="USD">USD $</option>
                <option value="RUB">RUB ₽</option>
                <option value="GBP">GBP £</option>
                <option value="CHF">CHF</option>
              </select>
            </Field>
            <Field label="Priority">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Applied on" error={fieldErrors.appliedAt}>
              <input type="date" value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} />
            </Field>
            <Field label="Job posting URL" error={fieldErrors.url}>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                maxLength={500}
                placeholder="https://…"
              />
            </Field>
          </div>
          <Field label="Notes" error={fieldErrors.notes}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder="Anything worth remembering…"
            />
          </Field>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-footer">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Save changes' : 'Create application'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className={error ? 'field invalid' : 'field'}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
