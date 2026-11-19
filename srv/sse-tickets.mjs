import { randomBytes } from 'node:crypto';

export const SSE_TICKET_TTL_MS = 20_000;

// An opaque grant for exactly one EventSource opening; never valid on other relay endpoints.
export function createSseTickets({ now = () => performance.now(), capacity = 4096 } = {}) {
  const tickets = new Map();
  function sweep(t = now()) {
    for (const [key, value] of tickets) {
      if (value.exp > t) break; // inserted in order with a fixed TTL
      tickets.delete(key);
    }
  }
  return {
    issue(room, peer, ident) {
      const t = now();
      sweep(t);
      if (tickets.size >= capacity) return null;
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { room, peer, ident, exp: t + SSE_TICKET_TTL_MS });
      return ticket;
    },
    consume(ticket, room, peer) {
      sweep();
      const grant = tickets.get(ticket);
      if (!grant || grant.exp <= now() || grant.room !== room || grant.peer !== peer) return null;
      tickets.delete(ticket);
      return grant;
    },
    sweep,
  };
}
