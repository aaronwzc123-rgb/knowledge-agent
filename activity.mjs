import { randomUUID } from 'node:crypto';

// These are execution events emitted by code, never a model's private reasoning.
export function createActivityTracker(send = async () => {}) {
  const steps = new Map();
  async function update(id, fields) {
    const previous = steps.get(id);
    if (!previous) return;
    const at = new Date().toISOString();
    const event = { ...previous, ...fields, id, at, elapsedMs: Math.max(0, Date.parse(at) - Date.parse(previous.startedAt)) };
    steps.set(id, event);
    await send({ activity: event });
    return id;
  }
  return {
    async start(kind, title, fields = {}) {
      const id = randomUUID(), at = new Date().toISOString();
      const event = { id, kind, state: 'running', title, ...fields, at, startedAt: at, elapsedMs: 0 };
      steps.set(id, event);
      await send({ activity: event });
      return id;
    },
    update,
    finish(id, fields = {}) { return update(id, { state: 'complete', ...fields }); },
    async stop(state = 'cancelled', detail) {
      for (const [id, step] of steps) if (step.state === 'running') {
        // Persist terminal state even when the client has already disconnected.
        try { await update(id, { state, ...(detail ? { detail } : {}) }); } catch {}
      }
    },
  };
}
