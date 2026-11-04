import { useState, type DragEvent } from 'react';
import { STATUSES, STATUS_META, type Application, type Status } from '../types';
import { Card } from './Card';

interface BoardProps {
  apps: Application[];
  onMove: (id: string, status: Status) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function Board({ apps, onMove, onSelect, onCreate }: BoardProps) {
  const [dragOver, setDragOver] = useState<Status | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const handleDrop = (e: DragEvent, status: Status) => {
    e.preventDefault();
    setDragOver(null);
    setDraggingId(null);
    const id = e.dataTransfer.getData('text/plain');
    if (id) onMove(id, status);
  };

  return (
    <div className="board">
      {STATUSES.map((status) => {
        const columnApps = apps.filter((a) => a.status === status);
        const meta = STATUS_META[status];
        return (
          <section
            key={status}
            className={dragOver === status ? 'column drag-over' : 'column'}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(status);
            }}
            onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
            onDrop={(e) => handleDrop(e, status)}
            aria-label={`${meta.label} column`}
          >
            <header className="column-header">
              <span className="dot" style={{ background: meta.color }} />
              <h2>{meta.label}</h2>
              <span className="count">{columnApps.length}</span>
            </header>
            <div className="column-body">
              {columnApps.map((app) => (
                <Card
                  key={app.id}
                  app={app}
                  dragging={draggingId === app.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', app.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingId(app.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOver(null);
                  }}
                  onClick={() => onSelect(app.id)}
                />
              ))}
              {columnApps.length === 0 && (
                <div className="column-empty">
                  {status === 'wishlist' ? (
                    <button className="btn ghost small" onClick={onCreate}>
                      + Add a job you like
                    </button>
                  ) : (
                    <span>Drop cards here</span>
                  )}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
