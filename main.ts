// Entrypoint: the harness lifecycle around the forge in app.ts.
//
// The trial harness runs this process beside its env server and talks to it over HTTP:
//   1. MAKEFUN_ENV_URL names the env's origin. With no env there is no trial, so exit 1.
//   2. The forge binds an ephemeral port (listen(0)); port 8080 belongs to the env.
//   3. The bound port is POSTed to $MAKEFUN_ENV_URL/register as {"port": N}. The env takes
//      the caller's address plus N as the forge's base URL. The first register wins: a 409
//      means another process registered first and is not an error for this one.
//   4. $MAKEFUN_ENV_URL/done is polled until it answers {"done": true}; while the suite
//      runs it answers {"done": false} at once, so polling with a backoff is the protocol.
//   5. The server closes and the process exits 0; the harness reads the env's export after.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `failures` failed attempts: 250ms doubling, capped at 2s. */
function backoff(failures: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures, 8));
}

/**
 * Register the bound port, retrying while the env is still starting. 200 and 409 both end
 * the loop (409: the first register already won). 400/405 are contract errors and throw.
 */
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      // Any other status: the env is presumably still starting, so retry below.
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // A network error or timeout lands here: also retry below.
    }
    await pause(backoff(failures));
  }
}

/** Poll the env's /done until it reports the trial is over; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or a slow poll: the trial is not over, so keep polling.
    }
    await pause(backoff(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the env to finish\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
