import { pathToFileURL } from 'node:url';

export async function runRetention({ env = process.env, apply = false, fetchImpl = fetch } = {}) {
  if (apply && env.INBOXPAY_RETENTION_ENABLED !== 'true') throw new Error('Retention application is disabled');
  const url = new URL(env.SUPABASE_URL || '');
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Expected a hosted HTTPS Supabase origin');
  const key = env.SUPABASE_RETENTION_SERVICE_KEY;
  if (!key) throw new Error('Missing retention service credential');
  const response = await fetchImpl(new URL('/rest/v1/rpc/run_business_data_retention', url), {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: 'Bearer ' + key }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_dry_run: !apply, p_batch_size: 500 })
  });
  if (!response.ok) throw new Error('Retention RPC failed; status ' + response.status);
  const result = await response.json();
  if (result?.dryRun !== !apply || result.batchSize !== 500
    || !['expiredLinks', 'terminalPayloads'].every(k => Number.isInteger(result[k]) && result[k] >= 0 && result[k] <= 500)) {
    throw new Error('Invalid retention result; inspect before retrying');
  }
  return { dryRun: result.dryRun, expiredLinks: result.expiredLinks, terminalPayloads: result.terminalPayloads, batchSize: 500 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Usage: run-retention.mjs [--apply]');
  try { console.log(JSON.stringify(await runRetention({ apply: args[0] === '--apply' }))); }
  catch { console.error('Retention run failed. No successful outcome is claimed; inspect provider state without logging credentials.'); process.exitCode = 1; }
}
