// CI-only bounded post-outcome native ingress-log observation. No native SDK
// imports, config/session/database reads, runtime hooks, sends or state writes.
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const unknown = () => ({ phase: 'native', status: 'unavailable', transcript: 'unknown', tool_evidence: 'unavailable', model_start: 'unknown', completion: 'unknown' });

export function sourceSession(log, sourceId) {
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) return { kind: 'missing' };
  const candidates = new Map();
  for (const line of log.split('\n')) {
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) continue;
    try {
      const row = JSON.parse(line);
      if (row.subsystem !== 'diagnostic' || typeof row.message !== 'string') continue;
      const match = /^message received: channel=inkbox chatId=\S+ messageId=(\S+) sessionId=(\S+) sessionKey=(\S+) source=dispatchInboundMessage$/.exec(row.message);
      if (match?.[1] === sourceId && /^agent:[a-z0-9_-]+:.+$/i.test(match[3])) {
        candidates.set(`${match[3]}\0${match[2]}`, { sessionKey: match[3], sessionId: match[2] });
      }
    } catch { /* malformed / oversized diagnostic records carry no proof */ }
  }
  if (candidates.size !== 1) return { kind: candidates.size ? 'ambiguous' : 'missing' };
  return { kind: 'found', ...[...candidates.values()][0] };
}

async function tail(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error();
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return { log: start ? text.slice(text.indexOf('\n') + 1) : text, truncated: start > 0 };
  } finally { await handle.close(); }
}

export async function observeNative(scope, supplied) {
  let logRead = false, ingress = false, mappingAmbiguous = false, truncated = false;
  try {
    if (typeof scope.text !== 'string' || !scope.text || Buffer.byteLength(scope.text) > 16_384 ||
        typeof scope.marker !== 'string' || !scope.marker || scope.marker.length > 128 || !scope.text.includes(scope.marker) ||
        typeof scope.inbound_id !== 'string' || !scope.inbound_id || scope.inbound_id.length > 128) throw new Error();
    const window = supplied?.log !== undefined ? { log: supplied.log, truncated: supplied.logTruncated === true } : await tail(process.env.GATEWAY_LOG);
    logRead = true;
    truncated = window.truncated;
    const route = sourceSession(window.log, scope.inbound_id);
    ingress = route.kind !== 'missing';
    mappingAmbiguous = route.kind === 'ambiguous';
    if (route.kind !== 'found' || truncated) throw new Error();
    // The public catalog resolves runtime config through a writer-backed
    // config-health path. Never inspect it from this post-outcome observer.
    // An exact native ingress record is not model admission or completion.
    return [{ ...unknown(), status: 'observed', ingress_observed: true,
      ambiguous: false, truncated: false }];
  } catch {
    return [{ ...unknown(), ...(logRead ? { ingress_observed: ingress, ambiguous: mappingAmbiguous, truncated } : {}) }];
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 80_000) throw new Error();
      chunks.push(chunk);
    }
    const scope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(await observeNative(scope)));
  } catch {
    process.stdout.write(JSON.stringify([unknown()]));
  }
}
