/**
 * Real-backend helpers for dsh-session-kit tests.
 *
 * The plugin itself has no dependency on @deepseek-ai packages; these helpers
 * are test-only and load the repository's TypeScript sources. Run them with:
 *
 *   cd <repo> && node --import tsx/esm --test dsh-session-kit/test/*.test.mjs
 *
 * Under plain `node --test` the .ts import fails and every helper reports
 * `ok: false`, so tests can skip instead of failing the plugin's default run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a throwaway JSONL persistence context under the OS temp directory. */
export async function createRealBackend() {
  let root;
  try {
    const { Context } = await import('@deepseek-ai/cordis');
    const { apply } = await import('../../../packages/session/session-persistence-jsonl/src/index.ts');
    root = mkdtempSync(join(tmpdir(), 'dsh-session-kit-'));
    const ctx = new Context();
    await apply(ctx, { root, compression: 'zstd', listConcurrency: 3 });
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined) throw new Error('sessionPersistence service missing after apply');
    return {
      ok: true,
      ctx,
      root,
      persistence,
      cleanup() {
        try { ctx.dispose?.(); } catch { /* context disposal is best-effort in tests */ }
        try { rmSync(root, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
      },
    };
  } catch (error) {
    try { if (root !== undefined) rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, error: String(error) };
  }
}

/** Validate one header + event list with the product's own replay validator. */
export async function replayValidate(header, events) {
  try {
    const { Session } = await import('@deepseek-ai/dsh-session');
    Session.create(header.id, events, header, 0);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Write one session through the real persistence seam and read it back. */
export async function writeAndReadBack(persistence, header, events) {
  const handle = await persistence.create(header);
  try {
    if (events.length > 0) await handle.append(events);
    await handle.flush();
  } finally {
    await handle.close();
  }
  const opened = await persistence.open(header.id, 'read');
  try {
    const slice = await opened.read(0, Number.MAX_SAFE_INTEGER);
    return { header: opened.header, events: slice.events };
  } finally {
    await opened.close();
  }
}
