import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'tsdown';
import { transform } from 'lightningcss';

const PACKAGE_NAME = 'dsh-session-kit';
const CSS_VIRTUAL_PREFIX = '\0session-kit-css:';
const CSS_VIRTUAL_SUFFIX = '.mjs';

/**
 * Build one plugin-local CSS Module into a closure-factory export: the compiled
 * stylesheet is injected once when the client factory materializes, and the
 * default export is the hashed local class map consumed by React.
 */
function cssModules() {
  return {
    name: 'session-kit-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null;
      const base = importer === undefined ? process.cwd() : dirname(importer);
      return CSS_VIRTUAL_PREFIX + resolve(base, source) + CSS_VIRTUAL_SUFFIX;
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
      this.addWatchFile(fileId);
      const source = await readFile(fileId);
      const result = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      });
      const classMap = {};
      for (const [local, entry] of Object.entries(result.exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
        classMap[local] = entry.name;
      }
      const css = JSON.stringify(result.code.toString());
      return [
        `const css = ${css};`,
        `const tagId = ${JSON.stringify(PACKAGE_NAME + '/' + fileId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n');
    },
  };
}

export default defineConfig({
  name: PACKAGE_NAME + '/client',
  entry: { client: 'src/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  plugins: [cssModules()],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
});
