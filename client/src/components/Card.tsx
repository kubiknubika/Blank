import type { DragEvent } from 'react';
import { SOURCE_LABELS, type Application } from '../types';
import { companyColor, companyInitials, formatSalary, relativeDays } from '../lib/format';

interface CardProps {
  app: Application;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onClick: () => void;
}

export function Card({ app, dragging, onDragStart, onDragEnd, onClick }: CardProps) {
  const salary = formatSalary(app);
  return (
    <article
      className={dragging ? 'card dragging' : 'card'}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${app.position} at ${app.company}`}
    >
      <div className="card-top">
        <span className="avatar" style={{ background: companyColor(app.company) }}>
          {companyInitials(app.company)}
        </span>
        <div className="card-title">
          <strong>{app.company}</strong>
          <span>{app.position}</span>
        </div>
        <span className={`priority priority-${app.priority}`} title={`${app.priority} priority`} />
      </div>
      <div className="card-meta">
        {app.location && <span>📍 {app.location}</span>}
        {salary && <span>💰 {salary}</span>}
      </div>
      <div className="card-footer">
        <span className="chip">{SOURCE_LABELS[app.source]}</span>
        {app.appliedAt && <span className="muted">{relativeDays(app.appliedAt)}</span>}
      </div>
    </article>
  );
}
