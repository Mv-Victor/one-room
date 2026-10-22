import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { EVENT_CHANNEL } from '../shared/contracts';
import type { DomainEvent } from '../shared/schemas';

export class DomainEvents {
  private readonly streamId = randomUUID();
  private sequence = 0;
  private listeners = new Set<WebContents>();

  subscribe(webContents: WebContents): void { this.listeners.add(webContents); }
  unsubscribe(webContents: WebContents): void { this.listeners.delete(webContents); }

  publish(type: DomainEvent['type'], entityId: string, revision: number): void {
    const event: DomainEvent = { streamId: this.streamId, sequence: ++this.sequence, type, entityId, revision };
    for (const target of this.listeners) {
      if (target.isDestroyed()) this.listeners.delete(target);
      else target.send(EVENT_CHANNEL, event);
    }
  }
}
