import { setTimeout as delay } from 'node:timers/promises';

export function isTemporaryWikiError(error) {
  return error?.name === 'TimeoutError' || error instanceof TypeError ||
    [408, 429, 500, 502, 503, 504].includes(error?.status);
}

export async function retryWikiRequest(operation, signal, onRetry) {
  try {
    return await operation();
  } catch (error) {
    signal?.throwIfAborted();
    if (!isTemporaryWikiError(error)) throw error;
    await onRetry?.(error);
    await delay(750, undefined, { signal });
    return operation();
  }
}
