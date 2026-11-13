/**
 * dsh-session-kit — read-only attachment reference report.
 *
 * DSH's attachment store is content-addressed and has no delete/GC surface, so
 * this plugin cannot remove orphaned attachment bytes. What it can do is answer
 * the narrower, safe question: which attachment references recorded in session
 * logs no longer resolve to bytes on this machine?
 *
 * The report is deliberately read-only:
 *   - it lists at most `MAX_REPORT_SESSIONS` sessions (newest first as returned
 *     by the session query) so one call cannot scan an unbounded corpus;
 *   - it never deletes, rewrites or repacks anything;
 *   - it prefers the provider's host path and only checks that the file exists
 *     and is readable; when a backend exposes no host path the reference is
 *     counted as `unverifiable` instead of being read into memory;
 *   - a failure to list or read one session becomes a warning, not an error.
 *
 * @module dsh-session-kit/attachment-report
 */

import { stat } from 'node:fs/promises';

import { collectAttachmentRefs } from './format.js';
import { listSessionEntries, readSessionDoc, servicesOf } from './sessions.js';
import { errorText } from './attachments.js';

/** Default and maximum number of sessions examined per report. */
export const MAX_REPORT_SESSIONS = 300;

/**
 * Build a read-only report of attachment references that do not resolve.
 * @param {object} ctx - plugin context.
 * @param {{limit?: number, includeSubagents?: boolean}} [options] - scan bounds.
 * @returns {Promise<{scannedSessions: number, sessionTotal: number, limit: number,
 *   truncated: boolean, totalReferences: number,
 *   missing: Array<{sessionId: string, kind: 'image'|'file', attachmentId?: string,
 *     name?: string, reason: string}>,
 *   unverifiable: number, warnings: string[]}>} report.
 */
export async function reportAttachmentReferences(ctx, options = {}) {
  const requested = options?.limit ?? MAX_REPORT_SESSIONS;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError('limit 必须是正整数');
  }
  const limit = Math.min(requested, MAX_REPORT_SESSIONS);
  const includeSubagents = options?.includeSubagents === true;
  const attachments = servicesOf(ctx).attachments;

  const listed = await listSessionEntries(ctx, { includeSubagents });
  const selected = listed.slice(0, limit);
  const warnings = [];
  const missing = [];
  let unverifiable = 0;
  let totalReferences = 0;
  let scannedSessions = 0;

  if (attachments === undefined) {
    warnings.push('当前未挂载附件服务；只能报告日志中的引用，无法验证字节是否存在');
  }

  for (const entry of selected) {
    let doc;
    try {
      doc = await readSessionDoc(ctx, entry.id);
    } catch (error) {
      warnings.push(`会话 ${entry.id} 读取失败：${errorText(error)}`);
      continue;
    }
    scannedSessions += 1;
    const refs = collectAttachmentRefs(doc.events);
    totalReferences += refs.images.size + refs.files.size;
    for (const ref of refs.images.values()) {
      const result = await referenceState(attachments, 'image', ref);
      if (result === 'missing') {
        missing.push({ sessionId: entry.id, kind: 'image', attachmentId: String(ref.attachmentId), reason: 'not-found' });
      } else if (result === 'unverifiable') {
        unverifiable += 1;
      }
    }
    for (const ref of refs.files.values()) {
      const result = await referenceState(attachments, 'file', ref);
      if (result === 'missing') {
        missing.push({
          sessionId: entry.id,
          kind: 'file',
          attachmentId: String(ref.attachmentId ?? ''),
          ...(typeof ref.name === 'string' && ref.name !== '' ? { name: ref.name } : {}),
          reason: 'not-found',
        });
      } else if (result === 'unverifiable') {
        unverifiable += 1;
      }
    }
  }

  return {
    scannedSessions,
    sessionTotal: listed.length,
    limit,
    truncated: listed.length > limit,
    totalReferences,
    missing,
    unverifiable,
    warnings,
  };
}

/**
 * Classify one reference without reading its contents.
 * @param {object | undefined} attachments - attachment service.
 * @param {'image'|'file'} kind - reference kind.
 * @param {object} ref - durable reference.
 * @returns {Promise<'ok'|'missing'|'unverifiable'>} state.
 */
async function referenceState(attachments, kind, ref) {
  if (attachments === undefined) return 'unverifiable';
  const hostPath =
    kind === 'image'
      ? typeof attachments.imageHostPath === 'function'
        ? attachments.imageHostPath(ref)
        : undefined
      : typeof attachments.fileHostPath === 'function'
        ? attachments.fileHostPath(ref)
        : undefined;
  if (typeof hostPath !== 'string' || hostPath === '') return 'unverifiable';
  try {
    const info = await stat(hostPath);
    return info.isFile() ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
}
