import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Public, read-only release checks. Never print configuration keys or user data.
export async function verifyDataControlsRelease(fetchImpl = fetch) {
  const origin = 'https://inboxpay.vercel.app';
  const get = path => fetchImpl(origin + path, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  const response = await get('/api/config');
  if (response.status !== 200) throw new Error('Production configuration unavailable');
  const config = await response.json();
  if (config.dataControlsEnabled !== false || config.previewReadOnly !== false) throw new Error('Unexpected production feature flags');
  const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
  for (const file of ['data-controls.html', 'data-controls.js', 'data-controls.css']) {
    const actual = await get('/' + file);
    const expected = await readFile(new URL('../../public/' + file, import.meta.url), 'utf8');
    if (actual.status !== 200 || hash(await actual.text()) !== hash(expected)) throw new Error('Production asset mismatch: ' + file);
  }
  const gate = await get('/api/session?view=data_requests');
  if (gate.status !== 503) throw new Error('Expected disabled production request gate');
  return { productionAssetsMatch: true, requestIntakeEnabled: false, previewReadOnly: false, disabledRequestGateStatus: 503 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyDataControlsRelease())); }
  catch { console.error('Production data-controls verification failed; no successful live acceptance is claimed.'); process.exitCode = 1; }
}
