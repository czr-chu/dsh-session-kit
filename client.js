/**
 * dsh-session-kit — Client half.
 *
 * One sidebar row ("会话管理") opens a session-management panel in the main
 * column. The panel lists sessions grouped by workspace, filters them with a
 * search box, selects any subset with checkboxes (plus per-group and global
 * select all/none), then exports the selection as one ZIP through
 * `POST /session-kit/export` or imports an archive through
 * `POST /session-kit/import`.
 *
 * Hand-written ModuleLoader factory: no bundler, no JSX, no TypeScript, and the
 * only runtime import is `react`. Every Host string (titles, warnings,
 * error messages) reaches the DOM as a React text child, never as markup.
 *
 * @module dsh-session-kit/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-kit',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'session-kit';
    /** Host route prefix owned by the Host half. */
    const ROUTE_PREFIX = '/session-kit';
    /** Sidebar row id and main-panel key; the row opens this panel. */
    const PANEL_ID = 'session-kit';

    // #region dictionaries
    const zh = {
      'panel.title': '会话管理',
      'panel.subtitle': '按工作区浏览会话，勾选后打包导出，或导入会话包。',
      'panel.loading': '正在加载会话列表…',
      'panel.loadFailed': '会话列表加载失败',
      'panel.retry': '重试',
      'panel.refresh': '刷新',
      'panel.search': '搜索标题、会话 id 或目录',
      'panel.selectAll': '全选',
      'panel.selectNone': '取消全选',
      'panel.selectedCount': '已选 {selected} / 共 {total}',
      'panel.groupUngrouped': '未分组',
      'panel.untitledWorkspace': '未命名工作区',
      'panel.groupCount': '{count} 个会话',
      'panel.selectGroup': '选择分组 {title}',
      'panel.untitled': '未命名会话',
      'panel.running': '运行中',
      'panel.events': '{count} 条事件',
      'panel.empty': '还没有可管理的会话。',
      'panel.emptyFilter': '没有匹配搜索条件的会话。',
      'panel.modeCompact': '精简',
      'panel.modeCompactHint': '仅保留主对话（用户消息与最终回答），体积更小。',
      'panel.modeFull': '全量',
      'panel.modeFullHint': '完整事件日志，可完整恢复工具调用与过程。',
      'panel.attachments': '包含附件',
      'panel.attachmentsHint': '导出图片与文件附件。',
      'panel.exportOptions': '导出选项',
      'panel.importOptions': '导入选项',
      'panel.workspaceFiles': '包含工作区文件（整个工作区）',
      'panel.workspaceFilesHint': '打包所选会话对应工作区的文件树；自动跳过敏感文件与依赖/构建目录。',
      'panel.subagents': '包含子代理会话',
      'panel.subagentsHint': '一并打包所选会话的子代理日志（仅备份；导入时默认跳过）。',
      'panel.restoreWorkspaceFiles': '恢复工作区文件到当前工作区',
      'panel.restoreWorkspaceFilesHint': '解压到当前工作区；同名文件不覆盖，冲突会列在结果提示里。',
      'panel.workspaceRestored': '已恢复工作区文件 {count} 个（{size}）',
      'panel.workspaceSkipped': '跳过 {count} 个工作区文件',
      'panel.workspaceSkipLine': '跳过 {path}：{reason}',
      'panel.unknownPath': '未知路径',
      'panel.unknownReason': '已存在或不允许',
      'panel.moreLines': '…另有 {count} 条提示',
      'panel.export': '导出所选',
      'panel.exporting': '正在导出…',
      'panel.exportFailed': '导出失败',
      'panel.exportDone': '已导出 {count} 个会话',
      'panel.import': '导入会话包',
      'panel.importing': '正在导入…',
      'panel.importFailed': '导入失败',
      'panel.importDone': '已导入 {count} 个会话',
      'panel.importSessionIds': '新会话：{ids}',
      'panel.importUnverified': '有会话写入后无法通过 DSH 读回校验，请检查警告。',
      'panel.importHint': '导入只会新建会话，不会覆盖已有会话。',
      'panel.openHint': '可在左侧会话列表中打开新会话。',
      'panel.noSelection': '请先勾选要导出的会话。',
      'panel.dismiss': '关闭',
      'error.network': '无法连接 DSH 主机，请确认页面连接正常后重试。',
      'error.http': '请求失败（HTTP {status}）。',
      'error.empty': '这个文件是空的。',
      'error.unknown': '发生未知错误，请重试。',
    };
    const en = {
      'panel.title': 'Session manager',
      'panel.subtitle': 'Browse sessions by workspace, select any subset, and export or import archives.',
      'panel.loading': 'Loading sessions…',
      'panel.loadFailed': 'Could not load sessions',
      'panel.retry': 'Retry',
      'panel.refresh': 'Refresh',
      'panel.search': 'Search title, session id, or directory',
      'panel.selectAll': 'Select all',
      'panel.selectNone': 'Select none',
      'panel.selectedCount': '{selected} selected of {total}',
      'panel.groupUngrouped': 'Ungrouped',
      'panel.untitledWorkspace': 'Untitled workspace',
      'panel.groupCount': '{count} sessions',
      'panel.selectGroup': 'Select group {title}',
      'panel.untitled': 'Untitled session',
      'panel.running': 'Running',
      'panel.events': '{count} events',
      'panel.empty': 'No sessions to manage yet.',
      'panel.emptyFilter': 'No sessions match this search.',
      'panel.modeCompact': 'Compact',
      'panel.modeCompactHint': 'Main conversation only (user messages and final answers); smaller archives.',
      'panel.modeFull': 'Full',
      'panel.modeFullHint': 'Complete event log; keeps tool calls and process history.',
      'panel.attachments': 'Include attachments',
      'panel.attachmentsHint': 'Pack referenced images and files.',
      'panel.exportOptions': 'Export options',
      'panel.importOptions': 'Import options',
      'panel.workspaceFiles': 'Include workspace files (whole workspace)',
      'panel.workspaceFilesHint': 'Pack the file tree of the selected sessions\' workspaces; sensitive files and dependency/build directories are skipped.',
      'panel.subagents': 'Include subagent sessions',
      'panel.subagentsHint': 'Pack subagent logs of the selected sessions (backup only; import skips them).',
      'panel.restoreWorkspaceFiles': 'Restore workspace files into the current workspace',
      'panel.restoreWorkspaceFilesHint': 'Extract into the current workspace; existing files are never overwritten and conflicts are listed.',
      'panel.workspaceRestored': 'Restored {count} workspace files ({size})',
      'panel.workspaceSkipped': 'Skipped {count} workspace files',
      'panel.workspaceSkipLine': 'Skipped {path}: {reason}',
      'panel.unknownPath': 'unknown path',
      'panel.unknownReason': 'exists or not allowed',
      'panel.moreLines': '…and {count} more notes',
      'panel.export': 'Export selected',
      'panel.exporting': 'Exporting…',
      'panel.exportFailed': 'Export failed',
      'panel.exportDone': 'Exported {count} sessions',
      'panel.import': 'Import archive',
      'panel.importing': 'Importing…',
      'panel.importFailed': 'Import failed',
      'panel.importDone': 'Imported {count} sessions',
      'panel.importSessionIds': 'New sessions: {ids}',
      'panel.importUnverified': 'Some sessions were written but failed to read back; check the warnings.',
      'panel.importHint': 'Import only creates new sessions; it never overwrites an existing one.',
      'panel.openHint': 'Open the new sessions from the session list on the left.',
      'panel.noSelection': 'Select at least one session to export.',
      'panel.dismiss': 'Dismiss',
      'error.network': 'Cannot reach the DSH host. Check the page connection and try again.',
      'error.http': 'Request failed (HTTP {status}).',
      'error.empty': 'This file is empty.',
      'error.unknown': 'Something went wrong. Please try again.',
    };
    // #endregion

    // #region theme tokens
    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      bgBase: 'var(--dsw-alias-bg-base, Canvas)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, Canvas)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, Canvas)',
      border: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))',
      hoverFill: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary))',
      focusRing:
        'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
      radius: 'var(--dsw-radius-sm, 6px)',
      radiusLg: 'var(--dsw-radius-lg, 10px)',
      mono: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
      font: 'var(--dsw-font-family, inherit)',
    };
    // #endregion

    // #region i18n helpers

    /** Replace `{name}` placeholders from a plain values object. */
    function formatTemplate(template, params) {
      if (params === undefined || params === null || typeof params !== 'object') return template;
      return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    }

    /** Chinese-dictionary translator used when the slot supplies no `t`. */
    function fallbackTranslate(key, params) {
      const template = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
      return formatTemplate(template, params);
    }

    /** Bind the slot's translator, falling back to the local dictionary. */
    function translatorOf(t) {
      if (typeof t !== 'function') return fallbackTranslate;
      return (key, params) => {
        const value = t(key, params);
        return typeof value === 'string' && value !== '' ? value : fallbackTranslate(key, params);
      };
    }
    // #endregion

    // #region HTTP helpers

    /** Absolute URL of one Host route on the page's own origin. */
    function hostUrl(path) {
      return new URL(`${ROUTE_PREFIX}${path}`, window.location.href).toString();
    }

    /** A failure carrying either the Host payload or the transport status. */
    function requestFailure(payload, status) {
      const hasPayload = payload !== null && typeof payload === 'object';
      const message = hasPayload && typeof payload.message === 'string' && payload.message.trim() !== ''
        ? payload.message.trim()
        : `HTTP ${String(status)}`;
      const failure = new Error(message);
      failure.code = hasPayload && typeof payload.code === 'string' ? payload.code : '';
      failure.httpStatus = status;
      return failure;
    }

    /** Parse one JSON response body, tolerating an empty or non-JSON body. */
    async function jsonBody(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    /** Decode the percent-encoded warnings header; a bad header never fails the request. */
    function warningsOf(response) {
      try {
        const raw = response.headers.get('x-session-kit-warnings');
        if (raw === null || raw === '') return [];
        const parsed = JSON.parse(decodeURIComponent(raw));
        return Array.isArray(parsed) ? parsed.filter((line) => typeof line === 'string') : [];
      } catch {
        return [];
      }
    }

    /** Read the download filename header, rejecting path separators. */
    function filenameOf(response) {
      const raw = response.headers.get('x-session-kit-filename');
      if (raw === null || raw === '') return '';
      try {
        const decoded = decodeURIComponent(raw).replace(/[\\/]+/gu, '_').trim();
        return decoded === '' ? '' : decoded;
      } catch {
        return '';
      }
    }

    /** One JSON request against this plugin's Host routes. */
    async function requestJson(path, init) {
      const headers = { accept: 'application/json', ...(init === undefined ? {} : init.headers ?? {}) };
      const response = await fetch(hostUrl(path), { ...(init === undefined ? {} : init), headers });
      const payload = await jsonBody(response);
      if (!response.ok) throw requestFailure(payload, response.status);
      if (payload !== null && typeof payload === 'object' && payload.ok === false) {
        throw requestFailure(payload, response.status);
      }
      return payload;
    }
    // #endregion

    // #region catalog normalization

    /** Non-empty string or the empty string. */
    function pickString(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    /** Non-negative finite number or 0. */
    function pickNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    }

    /** Normalize one workspace row from `GET /session-kit/list`. */
    function normalizeWorkspace(raw) {
      const record = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        workspaceId: pickString(record.workspaceId ?? record.id),
        title: pickString(record.title ?? record.name),
        path: pickString(record.path),
        sessionIds: Array.isArray(record.sessionIds)
          ? record.sessionIds.filter((id) => typeof id === 'string' && id !== '')
          : [],
      };
    }

    /** Normalize one session row from `GET /session-kit/list`. */
    function normalizeSession(raw) {
      const record = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        id: pickString(record.id ?? record.sessionId),
        title: pickString(record.title),
        cwd: pickString(record.cwd),
        workspaceId: pickString(record.workspaceId),
        workspaceTitle: pickString(record.workspaceTitle),
        running: record.running === true,
        formatVersion: pickNumber(record.formatVersion),
        eventCount: pickNumber(record.eventCount),
        createdAt: pickNumber(record.createdAt),
        updatedAt: pickNumber(record.updatedAt),
      };
    }

    /** Normalize the `GET /session-kit/list` payload into workspaces plus sessions. */
    function normalizeCatalog(payload) {
      const root = payload !== null && typeof payload === 'object' ? payload : {};
      const data = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;
      const rawWorkspaces = Array.isArray(data.workspaces)
        ? data.workspaces
        : Array.isArray(root.workspaces) ? root.workspaces : [];
      const rawSessions = Array.isArray(data.sessions)
        ? data.sessions
        : Array.isArray(root.sessions) ? root.sessions : [];
      const workspaces = rawWorkspaces.map(normalizeWorkspace).filter((workspace) => workspace.workspaceId !== '' || workspace.path !== '');
      const sessions = rawSessions.map(normalizeSession).filter((session) => session.id !== '');
      return {
        workspaces,
        sessions,
        sessionFormatVersion: pickNumber(data.sessionFormatVersion ?? root.sessionFormatVersion),
      };
    }

    /** Normalize the optional workspace-file restore summary of one import result. */
    function normalizeWorkspaceRestore(data) {
      const record = data !== null && typeof data === 'object' ? data : {};
      let source = {};
      for (const candidate of [record.workspaceFiles, record.workspaceRestore, record.workspace]) {
        if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
          source = candidate;
          break;
        }
      }
      const restoredFiles = pickNumber(source.restoredFiles ?? source.restored ?? record.restoredFiles ?? record.restored);
      const restoredBytes = pickNumber(source.restoredBytes ?? source.bytes ?? record.restoredBytes);
      const rawSkipped = source.skipped ?? record.skipped;
      const skippedCountRaw = typeof source.skippedFiles === 'number'
        ? source.skippedFiles
        : typeof record.skippedFiles === 'number' ? record.skippedFiles : undefined;
      const skipped = (Array.isArray(rawSkipped) ? rawSkipped : []).map((entry) => {
        if (typeof entry === 'string') return { path: entry, reason: '' };
        const item = entry !== null && typeof entry === 'object' ? entry : {};
        return { path: pickString(item.path ?? item.relPath ?? item.name), reason: pickString(item.reason) };
      }).filter((entry) => entry.path !== '' || entry.reason !== '');
      const skippedCount = skippedCountRaw !== undefined
        ? pickNumber(skippedCountRaw)
        : typeof rawSkipped === 'number' ? pickNumber(rawSkipped) : skipped.length;
      const warnings = Array.isArray(source.warnings) ? source.warnings.filter((line) => typeof line === 'string') : [];
      return { restoredFiles, restoredBytes, skipped, skippedCount: Math.max(skippedCount, skipped.length), warnings };
    }

    /** Normalize the import route payload. */
    function normalizeImportPayload(payload) {
      const root = payload !== null && typeof payload === 'object' ? payload : {};
      const data = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;
      const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
      const sessions = rawSessions.map((raw) => {
        const record = raw !== null && typeof raw === 'object' ? raw : {};
        return {
          sessionId: pickString(record.sessionId ?? record.id),
          title: pickString(record.title),
          eventCount: pickNumber(record.eventCount),
          mode: pickString(record.mode),
          verified: record.verified !== false,
          warnings: Array.isArray(record.warnings) ? record.warnings.filter((line) => typeof line === 'string') : [],
        };
      });
      const workspace = normalizeWorkspaceRestore(data);
      const warnings = [
        ...(Array.isArray(data.warnings) ? data.warnings.filter((line) => typeof line === 'string') : []),
        ...workspace.warnings,
      ];
      return { sessions, warnings, workspace };
    }
    // #endregion

    // #region grouping and selection helpers

    /** Recent-first ordering key for one session. */
    function recentKey(session) {
      return session.updatedAt > 0 ? session.updatedAt : session.createdAt;
    }

    /** Does one session match the current search needle? */
    function matchesQuery(session, needle) {
      if (needle === '') return true;
      const haystack = [session.title, session.id, session.cwd, session.workspaceTitle].join('\n').toLowerCase();
      return haystack.includes(needle);
    }

    /** Group sessions by workspace for rendering; empty groups are dropped. */
    function buildGroups(catalog, query, tr) {
      const needle = query.trim().toLowerCase();
      const groups = [];
      const byKey = new Map();
      for (const workspace of catalog.workspaces) {
        const key = workspace.workspaceId !== '' ? workspace.workspaceId : `path:${workspace.path}`;
        if (byKey.has(key)) continue;
        const group = {
          key,
          workspaceId: workspace.workspaceId,
          title: workspace.title !== '' ? workspace.title : workspace.path !== '' ? workspace.path : tr('panel.untitledWorkspace'),
          path: workspace.path,
          sessions: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      for (const session of catalog.sessions) {
        let group = session.workspaceId !== '' ? byKey.get(session.workspaceId) : undefined;
        if (group === undefined) {
          const fallbackKey = session.workspaceId !== '' ? `id:${session.workspaceId}` : '';
          group = byKey.get(fallbackKey);
          if (group === undefined) {
            group = {
              key: fallbackKey,
              workspaceId: session.workspaceId,
              title: session.workspaceTitle !== ''
                ? session.workspaceTitle
                : session.workspaceId !== '' ? session.workspaceId : tr('panel.groupUngrouped'),
              path: '',
              sessions: [],
            };
            byKey.set(fallbackKey, group);
            groups.push(group);
          }
        }
        if (!matchesQuery(session, needle)) continue;
        group.sessions.push(session);
      }
      return groups
        .filter((group) => group.sessions.length > 0)
        .map((group) => ({ ...group, sessions: group.sessions.slice().sort((left, right) => recentKey(right) - recentKey(left)) }));
    }

    /** Every session id currently visible after filtering. */
    function visibleIds(groups) {
      const ids = [];
      for (const group of groups) for (const session of group.sessions) ids.push(session.id);
      return ids;
    }

    /** Selected count within one group and its select-all state. */
    function groupSelection(group, selected) {
      let count = 0;
      for (const session of group.sessions) if (selected.has(session.id)) count += 1;
      return { total: group.sessions.length, count, all: group.sessions.length > 0 && count === group.sessions.length, some: count > 0 && count < group.sessions.length };
    }
    // #endregion

    // #region DOM helpers

    /** Trigger one browser download without navigating away from the app. */
    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename === '' ? 'session-kit.zip' : filename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    }

    /** One-line, localizable description of a thrown request failure. */
    function errorMessageOf(error, tr) {
      if (error !== null && typeof error === 'object') {
        const message = typeof error.message === 'string' ? error.message.trim() : '';
        if (typeof error.code === 'string' && error.code !== '' && message !== '') return message;
        if (typeof error.httpStatus === 'number') return tr('error.http', { status: error.httpStatus });
        if (message !== '') return message;
      }
      if (error instanceof TypeError) return tr('error.network');
      return tr('error.unknown');
    }

    /** Human-readable byte count with binary units. */
    function formatBytes(value) {
      const bytes = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
      if (bytes < 1024) return `${Math.round(bytes)} B`;
      const units = ['KiB', 'MiB', 'GiB', 'TiB'];
      let amount = bytes;
      let unit = -1;
      while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
      }
      return `${amount >= 100 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
    }

    /** Deduplicate one notice line list and cap it so a noisy archive stays readable. */
    function capNoticeLines(lines, tr) {
      const unique = [];
      const seen = new Set();
      for (const line of lines) {
        if (typeof line !== 'string') continue;
        const text = line.trim();
        if (text === '' || seen.has(text)) continue;
        seen.add(text);
        unique.push(text);
      }
      if (unique.length <= 24) return unique;
      return [...unique.slice(0, 24), tr('panel.moreLines', { count: unique.length - 24 })];
    }
    // #endregion

    // #region icons

    /** Sidebar glyph: a short session list with check marks. Artwork is our own. */
    function SessionKitIcon({ size }) {
      const pixels = typeof size === 'number' && size > 0 ? size : 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: pixels,
          height: pixels,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h(
          'g',
          { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 1.6 }),
          h('path', { d: 'M4.6 6.4h3.2M4.6 9.6h6.8' }),
          h('path', { d: 'M10.4 6.2l1 1 1.6-1.9' }),
        ),
      );
    }
    // #endregion

    // #region styles

    const STYLES = {
      page: {
        height: '100%',
        overflowY: 'auto',
        background: T.bgBase,
        color: T.labelPrimary,
        font: `14px/22px ${T.font}`,
      },
      content: {
        maxWidth: 860,
        margin: '0 auto',
        padding: '28px 24px 56px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      },
      headerRow: { display: 'flex', alignItems: 'flex-start', gap: 12 },
      heading: { margin: 0, font: `600 20px/28px ${T.font}` },
      subtitle: { margin: '4px 0 0', font: `13px/20px ${T.font}`, color: T.labelSecondary },
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      search: {
        flex: '1 1 240px',
        minWidth: 180,
        height: 32,
        padding: '0 10px',
        boxSizing: 'border-box',
        borderRadius: T.radius,
        border: `1px solid ${T.border}`,
        background: T.bgLayer1,
        color: T.labelPrimary,
        font: `13px/20px ${T.font}`,
        outline: 'none',
      },
      counter: { font: `12px/18px ${T.font}`, color: T.labelSecondary },
      group: { display: 'flex', flexDirection: 'column', gap: 6 },
      groupHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
      groupTitle: { font: `600 13px/20px ${T.font}`, color: T.labelPrimary },
      groupPath: {
        font: `12px/18px ${T.mono}`,
        color: T.labelTertiary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '1 1 auto',
        minWidth: 0,
      },
      groupCount: { font: `12px/18px ${T.font}`, color: T.labelSecondary, flex: 'none' },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 10px',
        boxSizing: 'border-box',
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        background: T.bgLayer1,
        cursor: 'pointer',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 },
      rowTitle: { font: `13px/20px ${T.font}`, color: T.labelPrimary, wordBreak: 'break-word' },
      rowMeta: {
        font: `12px/18px ${T.mono}`,
        color: T.labelSecondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      runningDot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: T.success, marginRight: 6 },
      input: { margin: '2px 0 0', flex: 'none' },
      modeRow: { display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' },
      modeLabel: { display: 'inline-flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer', font: `13px/20px ${T.font}` },
      modeHint: { display: 'block', font: `12px/18px ${T.font}`, color: T.labelSecondary },
      actionsRow: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      notice: (tone) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 14px',
        border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${tone}`,
        borderRadius: T.radiusLg,
        background: T.bgLayer1,
      }),
      noticeTitle: { font: `600 13px/20px ${T.font}`, color: T.labelPrimary },
      noticeLine: { font: `12px/18px ${T.font}`, color: T.labelSecondary, wordBreak: 'break-word' },
      emptyCard: {
        padding: '18px 16px',
        border: `1px solid ${T.border}`,
        borderRadius: T.radiusLg,
        background: T.bgLayer1,
        font: `13px/20px ${T.font}`,
        color: T.labelSecondary,
      },
      footnote: { margin: 0, font: `12px/18px ${T.font}`, color: T.labelSecondary },
    };

    /** Button style for one visual role. */
    function buttonStyle(role, disabled) {
      const base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 32,
        padding: '0 14px',
        border: 'none',
        borderRadius: T.radius,
        font: `500 13px/20px ${T.font}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        whiteSpace: 'nowrap',
      };
      if (role === 'primary') return { ...base, background: T.brand, color: T.bgBase };
      if (role === 'ghost') return { ...base, background: 'transparent', color: T.labelSecondary, border: `1px solid ${T.border}` };
      return { ...base, background: T.bgLayer2, color: T.labelPrimary, border: `1px solid ${T.border}` };
    }
    // #endregion

    // #region panel component

    /**
     * Session-management page: workspace groups, search, checkboxes, export
     * mode switch, export download, and archive import.
     * @param {{t: Function, loadCatalog: Function, exportSelection: Function,
     *          importSelection: Function, refreshSessions: Function, targetOf: Function}} props
     *   slot translator and the Host operations injected by `apply`.
     */
    function SessionKitPanel(props) {
      const tr = translatorOf(props.t);
      const [catalog, setCatalog] = React.useState({ workspaces: [], sessions: [] });
      const [phase, setPhase] = React.useState('loading');
      const [loadError, setLoadError] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [selected, setSelected] = React.useState(() => new Set());
      const [mode, setMode] = React.useState('compact');
      const [includeAttachments, setIncludeAttachments] = React.useState(true);
      const [includeWorkspaceFiles, setIncludeWorkspaceFiles] = React.useState(true);
      const [includeSubagents, setIncludeSubagents] = React.useState(false);
      const [restoreWorkspaceFiles, setRestoreWorkspaceFiles] = React.useState(true);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const fileInputRef = React.useRef(null);
      const mountedRef = React.useRef(true);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      async function reload(options) {
        const quiet = options !== undefined && options.quiet === true;
        if (!quiet) {
          setPhase('loading');
          setLoadError('');
        }
        try {
          const next = await props.loadCatalog();
          if (!mountedRef.current) return;
          const alive = new Set(next.sessions.map((session) => session.id));
          setCatalog(next);
          setSelected((previous) => {
            const kept = [...previous].filter((id) => alive.has(id));
            return kept.length === previous.size ? previous : new Set(kept);
          });
          setPhase('ready');
        } catch (error) {
          if (!mountedRef.current) return;
          setPhase('error');
          setLoadError(errorMessageOf(error, tr));
        }
      }

      React.useEffect(() => {
        void reload();
      }, []);

      const groups = React.useMemo(() => buildGroups(catalog, query, tr), [catalog, query, props.t]);
      const allVisible = React.useMemo(() => visibleIds(groups), [groups]);
      const total = catalog.sessions.length;
      const selectedCount = selected.size;

      function toggleSession(id) {
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }

      function setMany(ids, on) {
        setSelected((previous) => {
          const next = new Set(previous);
          for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      }

      async function runExport() {
        if (busy !== '') return;
        const ids = [...selected];
        if (ids.length === 0) {
          setNotice({ tone: 'error', title: tr('panel.exportFailed'), lines: [tr('panel.noSelection')] });
          return;
        }
        setBusy('export');
        setNotice(null);
        try {
          const result = await props.exportSelection({
            sessionIds: ids,
            mode,
            includeAttachments,
            includeWorkspaceFiles,
            includeSubagents,
          });
          downloadBlob(result.blob, result.filename);
          setNotice({ tone: 'success', title: tr('panel.exportDone', { count: ids.length }), lines: capNoticeLines(result.warnings, tr) });
        } catch (error) {
          setNotice({ tone: 'error', title: tr('panel.exportFailed'), lines: [errorMessageOf(error, tr)] });
        } finally {
          if (mountedRef.current) setBusy('');
        }
      }

      async function runImport(file) {
        if (busy !== '' || file === undefined || file === null) return;
        if (file.size === 0) {
          setNotice({ tone: 'error', title: tr('panel.importFailed'), lines: [tr('error.empty')] });
          return;
        }
        setBusy('import');
        setNotice(null);
        try {
          const target = props.targetOf();
          const result = await props.importSelection(file, {
            filename: typeof file.name === 'string' ? file.name : 'session-kit.zip',
            restoreWorkspaceFiles,
            ...target,
          });
          await props.refreshSessions();
          const next = await props.loadCatalog();
          if (mountedRef.current) {
            setCatalog(next);
            setPhase('ready');
          }
          const ids = result.sessions.map((session) => session.sessionId).filter((id) => id !== '');
          const lines = [];
          if (ids.length > 0) lines.push(tr('panel.importSessionIds', { ids: ids.join(', ') }));
          const workspace = result.workspace !== undefined && result.workspace !== null
            ? result.workspace
            : { restoredFiles: 0, restoredBytes: 0, skipped: [], skippedCount: 0, warnings: [] };
          if (workspace.restoredFiles > 0) {
            lines.push(tr('panel.workspaceRestored', {
              count: workspace.restoredFiles,
              size: formatBytes(workspace.restoredBytes),
            }));
          }
          if (workspace.skippedCount > 0) {
            lines.push(tr('panel.workspaceSkipped', { count: workspace.skippedCount }));
            for (const detail of workspace.skipped.slice(0, 8)) {
              lines.push(tr('panel.workspaceSkipLine', {
                path: detail.path === '' ? tr('panel.unknownPath') : detail.path,
                reason: detail.reason === '' ? tr('panel.unknownReason') : detail.reason,
              }));
            }
          }
          for (const warning of result.warnings) lines.push(warning);
          for (const session of result.sessions) for (const warning of session.warnings) lines.push(warning);
          if (result.sessions.some((session) => session.verified === false)) lines.push(tr('panel.importUnverified'));
          lines.push(tr('panel.openHint'));
          setNotice({ tone: 'success', title: tr('panel.importDone', { count: ids.length }), lines: capNoticeLines(lines, tr) });
          const alive = new Set(next.sessions.map((session) => session.id));
          setSelected((previous) => new Set([...previous].filter((id) => alive.has(id))));
        } catch (error) {
          setNotice({ tone: 'error', title: tr('panel.importFailed'), lines: [errorMessageOf(error, tr)] });
        } finally {
          if (mountedRef.current) setBusy('');
        }
      }

      function pickFile() {
        if (busy !== '') return;
        const input = fileInputRef.current;
        if (input !== null && input !== undefined && typeof input.click === 'function') input.click();
      }

      function onFileChange(event) {
        const file = event.target.files !== null && event.target.files.length > 0 ? event.target.files[0] : undefined;
        event.target.value = '';
        if (file !== undefined) void runImport(file);
      }

      const busyExport = busy === 'export';
      const busyImport = busy === 'import';

      const noticeTone = notice === null ? T.success
        : notice.tone === 'error' ? T.error
          : notice.tone === 'warn' ? T.warn : T.success;

      const header = h(
        'div',
        { style: STYLES.headerRow },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('h1', { style: STYLES.heading }, tr('panel.title')),
          h('p', { style: STYLES.subtitle }, tr('panel.subtitle')),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('ghost', false), onClick: () => { void reload(); }, disabled: phase === 'loading' },
          tr('panel.refresh'),
        ),
      );

      const searchRow = h(
        'div',
        { style: STYLES.toolbar },
        h('input', {
          type: 'search',
          value: query,
          placeholder: tr('panel.search'),
          'aria-label': tr('panel.search'),
          onChange: (event) => setQuery(event.target.value),
          style: STYLES.search,
        }),
        h('button', { type: 'button', style: buttonStyle('secondary', allVisible.length === 0), disabled: allVisible.length === 0, onClick: () => setMany(allVisible, true) }, tr('panel.selectAll')),
        h('button', { type: 'button', style: buttonStyle('secondary', allVisible.length === 0), disabled: allVisible.length === 0, onClick: () => setMany(allVisible, false) }, tr('panel.selectNone')),
        h('span', { style: STYLES.counter }, tr('panel.selectedCount', { selected: selectedCount, total })),
      );

      const modeRow = h(
        'div',
        { style: STYLES.modeRow, role: 'group', 'aria-label': tr('panel.exportOptions') },
        h(
          'label',
          { style: STYLES.modeLabel },
          h('input', {
            type: 'radio',
            name: 'session-kit-export-mode',
            value: 'compact',
            checked: mode === 'compact',
            disabled: busy !== '',
            onChange: () => setMode('compact'),
          }),
          h(
            'span',
            null,
            tr('panel.modeCompact'),
            h('span', { style: STYLES.modeHint }, tr('panel.modeCompactHint')),
          ),
        ),
        h(
          'label',
          { style: STYLES.modeLabel },
          h('input', {
            type: 'radio',
            name: 'session-kit-export-mode',
            value: 'full',
            checked: mode === 'full',
            disabled: busy !== '',
            onChange: () => setMode('full'),
          }),
          h(
            'span',
            null,
            tr('panel.modeFull'),
            h('span', { style: STYLES.modeHint }, tr('panel.modeFullHint')),
          ),
        ),
        h(
          'label',
          { style: STYLES.modeLabel },
          h('input', {
            type: 'checkbox',
            checked: includeAttachments,
            disabled: busy !== '',
            onChange: (event) => setIncludeAttachments(event.target.checked),
          }),
          h(
            'span',
            null,
            tr('panel.attachments'),
            h('span', { style: STYLES.modeHint }, tr('panel.attachmentsHint')),
          ),
        ),
        h(
          'label',
          { style: STYLES.modeLabel },
          h('input', {
            type: 'checkbox',
            checked: includeWorkspaceFiles,
            disabled: busy !== '',
            onChange: (event) => setIncludeWorkspaceFiles(event.target.checked),
          }),
          h(
            'span',
            null,
            tr('panel.workspaceFiles'),
            h('span', { style: STYLES.modeHint }, tr('panel.workspaceFilesHint')),
          ),
        ),
        h(
          'label',
          { style: STYLES.modeLabel },
          h('input', {
            type: 'checkbox',
            checked: includeSubagents,
            disabled: busy !== '',
            onChange: (event) => setIncludeSubagents(event.target.checked),
          }),
          h(
            'span',
            null,
            tr('panel.subagents'),
            h('span', { style: STYLES.modeHint }, tr('panel.subagentsHint')),
          ),
        ),
      );

      const actions = h(
        'div',
        { style: STYLES.actionsRow },
        h(
          'button',
          { type: 'button', style: buttonStyle('primary', busy !== '' || selectedCount === 0), disabled: busy !== '' || selectedCount === 0, onClick: () => { void runExport(); }, 'aria-busy': busyExport ? 'true' : undefined },
          busyExport ? tr('panel.exporting') : tr('panel.export'),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('secondary', busy !== ''), disabled: busy !== '', onClick: pickFile, 'aria-busy': busyImport ? 'true' : undefined },
          busyImport ? tr('panel.importing') : tr('panel.import'),
        ),
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: '.zip,.jsonl,application/zip,application/jsonl,application/x-ndjson',
          style: { display: 'none' },
          onChange: onFileChange,
          'aria-hidden': 'true',
          tabIndex: -1,
        }),
      );

      const importOptions = h(
        'div',
        { style: STYLES.modeRow, role: 'group', 'aria-label': tr('panel.importOptions') },
        h(
          'label',
          { style: STYLES.modeLabel },
          h('input', {
            type: 'checkbox',
            checked: restoreWorkspaceFiles,
            disabled: busy !== '',
            onChange: (event) => setRestoreWorkspaceFiles(event.target.checked),
          }),
          h(
            'span',
            null,
            tr('panel.restoreWorkspaceFiles'),
            h('span', { style: STYLES.modeHint }, tr('panel.restoreWorkspaceFilesHint')),
          ),
        ),
      );

      let body;
      if (phase === 'loading') {
        body = h('div', { style: STYLES.emptyCard }, tr('panel.loading'));
      } else if (phase === 'error') {
        body = h(
          'div',
          { style: STYLES.notice(T.error), role: 'alert' },
          h('span', { style: STYLES.noticeTitle }, tr('panel.loadFailed')),
          h('span', { style: STYLES.noticeLine }, loadError),
          h(
            'span',
            null,
            h('button', { type: 'button', style: buttonStyle('secondary', false), onClick: () => { void reload(); } }, tr('panel.retry')),
          ),
        );
      } else if (catalog.sessions.length === 0) {
        body = h('div', { style: STYLES.emptyCard }, tr('panel.empty'));
      } else if (groups.length === 0) {
        body = h('div', { style: STYLES.emptyCard }, tr('panel.emptyFilter'));
      } else {
        body = groups.map((group) => {
          const state = groupSelection(group, selected);
          return h(
            'div',
            { key: group.key === '' ? 'ungrouped' : group.key, style: STYLES.group, role: 'group', 'aria-label': group.title },
            h(
              'div',
              { style: STYLES.groupHeader },
              h('input', {
                type: 'checkbox',
                checked: state.all,
                ref: (node) => {
                  if (node !== null) {
                    node.indeterminate = state.some;
                  }
                },
                onChange: () => setMany(group.sessions.map((session) => session.id), !state.all),
                'aria-label': tr('panel.selectGroup', { title: group.title }),
              }),
              h('span', { style: STYLES.groupTitle }, group.title),
              group.path === '' ? null : h('span', { style: STYLES.groupPath, title: group.path }, group.path),
              h('span', { style: STYLES.groupCount }, tr('panel.groupCount', { count: group.sessions.length })),
            ),
            group.sessions.map((session) => {
              const checked = selected.has(session.id);
              const meta = [];
              if (session.eventCount > 0) meta.push(tr('panel.events', { count: session.eventCount }));
              if (session.cwd !== '') meta.push(session.cwd);
              meta.push(session.id);
              const shortId = session.id.length > 26 ? `${session.id.slice(0, 12)}…${session.id.slice(-8)}` : session.id;
              const metaText = meta.length === 0 ? shortId : meta.join(' · ');
              return h(
                'label',
                { key: session.id, style: STYLES.row },
                h('input', {
                  type: 'checkbox',
                  checked,
                  style: STYLES.input,
                  onChange: () => toggleSession(session.id),
                }),
                h(
                  'span',
                  { style: STYLES.rowText },
                  h(
                    'span',
                    { style: STYLES.rowTitle },
                    session.running ? h('span', { style: STYLES.runningDot, 'aria-hidden': 'true' }) : null,
                    session.title !== '' ? session.title : tr('panel.untitled'),
                    session.running ? ` (${tr('panel.running')})` : '',
                  ),
                  h('span', { style: STYLES.rowMeta, title: session.id }, metaText),
                ),
              );
            }),
          );
        });
      }

      const noticeCard = notice === null ? null : h(
        'div',
        { style: STYLES.notice(noticeTone), role: notice.tone === 'error' ? 'alert' : 'status', 'aria-live': 'polite' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { ...STYLES.noticeTitle, flex: '1 1 auto' } }, notice.title),
          h(
            'button',
            { type: 'button', style: { ...buttonStyle('ghost', false), height: 24, padding: '0 8px' }, onClick: () => setNotice(null), 'aria-label': tr('panel.dismiss') },
            '×',
          ),
        ),
        notice.lines.map((line, index) => h('span', { key: `${index}-${line.slice(0, 12)}`, style: STYLES.noticeLine }, line)),
      );

      return h(
        'div',
        { style: STYLES.page },
        h(
          'div',
          { style: STYLES.content },
          header,
          searchRow,
          modeRow,
          actions,
          importOptions,
          noticeCard,
          body,
          h('p', { style: STYLES.footnote }, tr('panel.importHint')),
        ),
      );
    }
    // #endregion

    // #region host operations (apply-world closures)

    /** Read and normalize the workspace/session catalog. */
    async function loadCatalog() {
      const payload = await requestJson('/list');
      return normalizeCatalog(payload);
    }

    /** Upload one archive to the Host and return the normalized result. */
    async function importSelection(file, hints) {
      const params = new URLSearchParams();
      const filename = hints !== null && typeof hints === 'object' ? pickString(hints.filename) : '';
      const cwd = hints !== null && typeof hints === 'object' ? pickString(hints.cwd) : '';
      const workspaceId = hints !== null && typeof hints === 'object' ? pickString(hints.workspaceId) : '';
      const restoreWorkspaceFiles = hints !== null && typeof hints === 'object' && hints.restoreWorkspaceFiles === true;
      if (filename !== '') params.set('filename', filename);
      if (cwd !== '') params.set('cwd', cwd);
      if (workspaceId !== '') params.set('workspaceId', workspaceId);
      params.set('restoreWorkspaceFiles', restoreWorkspaceFiles ? '1' : '0');
      const query = params.toString();
      const response = await fetch(hostUrl(query === '' ? '/import' : `/import?${query}`), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
        body: file,
      });
      const payload = await jsonBody(response);
      if (!response.ok || payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw requestFailure(payload, response.status);
      }
      return normalizeImportPayload(payload);
    }

    /** Request one export archive and return its bytes plus headers. */
    async function exportSelection(request) {
      const response = await fetch(hostUrl('/export'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/zip' },
        body: JSON.stringify({
          sessionIds: request.sessionIds,
          mode: request.mode,
          includeAttachments: request.includeAttachments === true,
          includeWorkspaceFiles: request.includeWorkspaceFiles === true,
          includeSubagents: request.includeSubagents === true,
        }),
      });
      if (!response.ok) {
        const payload = await jsonBody(response);
        throw requestFailure(payload, response.status);
      }
      const blob = await response.blob();
      const filename = filenameOf(response);
      return {
        blob,
        filename: filename === '' ? 'session-kit-export.zip' : filename,
        warnings: warningsOf(response),
      };
    }

    /** Refresh the client session catalog after an import. */
    async function refreshSessionList(ctx) {
      try {
        const sessions = ctx.get('sessions');
        if (sessions !== undefined && sessions !== null && typeof sessions.refresh === 'function') await sessions.refresh();
      } catch (error) {
        console.warn('session-kit: session list refresh failed:', error);
      }
    }

    /** Working directory and workspace the Host should attach an import to. */
    function importTargetOf(ctx) {
      try {
        const uiWorkspace = ctx.get('uiWorkspace');
        const selection = uiWorkspace !== undefined ? uiWorkspace.selection?.getSnapshot?.() ?? {} : {};
        const currentId = typeof selection.sessionId === 'string' ? selection.sessionId : undefined;
        const sessions = ctx.get('sessions')?.list?.getSnapshot?.();
        const workspaceList = ctx.get('workspaces')?.list?.getSnapshot?.();
        const items = Array.isArray(workspaceList?.items) ? workspaceList.items : [];
        if (currentId !== undefined) {
          const cwd = sessions?.byId?.[currentId]?.cwd;
          const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(currentId));
          return {
            ...typeof cwd === 'string' && cwd !== '' ? { cwd } : owner?.path !== undefined ? { cwd: owner.path } : {},
            ...owner?.workspaceId !== undefined ? { workspaceId: owner.workspaceId } : {},
          };
        }
        const first = items.find((item) => typeof item.path === 'string' && item.path !== '');
        return first === undefined ? {} : { cwd: first.path, workspaceId: first.workspaceId };
      } catch {
        return {};
      }
    }
    // #endregion

    // #region plugin body

    /** Cordis client services this plugin cannot work without. */
    const inject = ['slots', 'locale'];

    /**
     * Client plugin body: dictionaries, the session-management main panel, and
     * the sidebar row that opens it.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-kit: dictionaries');
      } catch (error) {
        console.warn('session-kit: dictionary registration failed:', error);
      }

      try {
        ctx.slots.inject('main', () => ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({
              loadCatalog: () => loadCatalog(),
              exportSelection: (request) => exportSelection(request),
              importSelection: (file, hints) => importSelection(file, hints),
              refreshSessions: () => refreshSessionList(ctx),
              targetOf: () => importTargetOf(ctx),
            }),
          },
          SessionKitPanel,
        ));
      } catch (error) {
        console.warn('session-kit: main panel registration failed:', error);
      }

      try {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : fallbackTranslate;
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 6,
            locale: NS,
            label: () => t('panel.title'),
          },
          SessionKitIcon,
        ));
      } catch (error) {
        console.warn('session-kit: sidebar row registration failed:', error);
      }
    }
    // #endregion

    return { inject, apply, name: NS };
  },
});
