import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteMcp } from '@inkbox/sdk/remote-mcp';
import { afterEach, expect, it, vi } from 'vitest';
import { contactArguments } from '../src/remote-tools.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(['create', 'update', 'delete'])('validates %s contact arguments and reuses the continuation', async action => {
  const root = mkdtempSync(join(tmpdir(), 'contact-mcp-')); roots.push(root);
  const name = 'inkbox_contact_' + action;
  const fields = { preferredName: 'Example' };
  const args = action === 'create' ? fields : { contactId: 'contact', ...(action === 'update' ? fields : {}) };
  const properties = action === 'create' ? { contact: { type: 'object' } } : { contact_id: { type: 'string' }, ...(action === 'update' ? { patch: { type: 'object' } } : {}) };
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body);
    let result;
    if (request.method === 'server/discover') result = { supportedVersions: ['2026-07-28'] };
    else if (request.method === 'tools/list') result = { tools: [{ name, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } }] };
    else { calls.push(request.params); result = request.params.requestState ? { content: [], structuredContent: { id: 'contact' } } : { resultType: 'input_required', requestState: 'prepared' }; }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }));
  const remote = new RemoteMcp({ apiKey: 'synthetic', baseUrl: 'https://example.test', identity: 'example', journalPath: join(root, 'calls') });
  await remote.refresh();
  const converted = contactArguments('inkbox_' + action + '_contact', args);
  await remote.call(name, converted, { callIdentity: 'native-call' });
  await remote.call(name, converted, { callIdentity: 'native-call' });
  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[2]);
  expect(calls[0].arguments).not.toHaveProperty('idempotency_key');
});
