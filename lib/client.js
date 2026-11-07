window.__ModuleLoader__.load({
	id: "dsh-session-kit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region \0session-kit-css:src/client/styles.module.css.mjs
		const css = ".M4q01a_page{background:var(--dsw-alias-bg-base,Canvas);height:100%;color:var(--dsw-alias-label-primary);font:14px/22px var(--dsw-font-family,inherit);overflow-y:auto}.M4q01a_content{flex-direction:column;gap:18px;max-width:1120px;margin:0 auto;padding:28px 24px 56px;display:flex}.M4q01a_header-row{align-items:flex-start;gap:12px;display:flex}.M4q01a_heading{font:600 20px/28px var(--dsw-font-family,inherit);margin:0}.M4q01a_subtitle{font:13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);margin:4px 0 0}.M4q01a_search{box-sizing:border-box;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,Canvas);min-width:180px;height:32px;color:var(--dsw-alias-label-primary);font:13px/20px var(--dsw-font-family,inherit);outline:none;flex:240px;padding:0 10px}.M4q01a_group{flex-direction:column;gap:6px;display:flex}.M4q01a_group-header{align-items:center;gap:8px;padding:2px 0;display:flex}.M4q01a_group-title{font:600 13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary)}.M4q01a_group-path{font:12px/18px var(--dsw-font-family-mono,ui-monospace, SFMono-Regular, Consolas, monospace);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.M4q01a_group-count{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);flex:none}.M4q01a_row-wrapper{flex-direction:column;gap:4px;display:flex}.M4q01a_row{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,Canvas);align-items:flex-start;gap:10px;padding:8px 10px;display:flex}.M4q01a_row-main{flex:auto;align-items:flex-start;gap:10px;min-width:0;display:flex}.M4q01a_row-detail-toggle{min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;flex:auto;align-items:flex-start;gap:10px;padding:0;display:flex}.M4q01a_row-actions{flex:none;align-items:center;gap:6px;display:flex}.M4q01a_row-detail{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,Canvas);padding:8px 12px}.M4q01a_row-text{flex-direction:column;flex:auto;gap:2px;min-width:0;display:flex}.M4q01a_row-title{font:13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);word-break:break-word}.M4q01a_row-meta{font:12px/18px var(--dsw-font-family-mono,ui-monospace, SFMono-Regular, Consolas, monospace);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.M4q01a_badge{font:11px/16px var(--dsw-font-family,inherit);vertical-align:middle;border-radius:999px;flex:none;margin-left:8px;padding:0 6px;display:inline-block}.M4q01a_badge-archived{background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));border:1px solid var(--dsw-alias-border-l2)}.M4q01a_badge-active{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border:1px solid var(--dsw-alias-border-l2);background:0 0}.M4q01a_badge-legacy{color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));border:1px solid var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));background:0 0}.M4q01a_running-dot{background:var(--dsw-alias-state-success-primary);border-radius:50%;width:7px;height:7px;margin-right:6px;display:inline-block}.M4q01a_input{flex:none;margin:2px 0 0}.M4q01a_select{box-sizing:border-box;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,Canvas);height:32px;color:var(--dsw-alias-label-primary);font:13px/20px var(--dsw-font-family,inherit);padding:0 8px}.M4q01a_mode-label{cursor:pointer;font:13px/20px var(--dsw-font-family,inherit);align-items:flex-start;gap:6px;display:inline-flex}.M4q01a_mode-hint{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);display:block}.M4q01a_notice{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,Canvas);flex-direction:column;gap:6px;padding:12px 14px;display:flex}.M4q01a_notice-title{font:600 13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary)}.M4q01a_notice-line{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);word-break:break-word}.M4q01a_empty-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,Canvas);font:13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);padding:18px 16px}.M4q01a_footnote{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);margin:0}.M4q01a_overlay{z-index:2147483200;background:#00000061;justify-content:center;align-items:center;padding:20px;display:flex;position:fixed;inset:0}.M4q01a_dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);width:100%;max-width:480px;max-height:72vh;box-shadow:var(--dsw-shadow-md,0 8px 24px #0000002e);color:var(--dsw-alias-label-primary);font:13px/20px var(--dsw-font-family,inherit);flex-direction:column;gap:10px;padding:18px 18px 16px;display:flex;overflow-y:auto}.M4q01a_dialog-danger{border:1px solid var(--dsw-alias-state-error-primary)}.M4q01a_dialog-title{font:600 16px/24px var(--dsw-font-family,inherit);margin:0}.M4q01a_dialog-title-danger{font:600 16px/24px var(--dsw-font-family,inherit);color:var(--dsw-alias-state-error-primary);margin:0}.M4q01a_dialog-body{font:13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);margin:0}.M4q01a_dialog-list{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,Canvas);flex-direction:column;gap:2px;max-height:160px;padding:6px 8px;display:flex;overflow-y:auto}.M4q01a_dialog-item{font:12px/18px var(--dsw-font-family-mono,ui-monospace, SFMono-Regular, Consolas, monospace);color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.M4q01a_dialog-note{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);margin:0}.M4q01a_dialog-actions{justify-content:flex-end;gap:8px;margin-top:4px;display:flex}.M4q01a_lines{flex-direction:column;gap:2px;display:flex}.M4q01a_header-main{flex:auto;min-width:0}.M4q01a_file-selection{flex-direction:column;gap:8px;display:flex}.M4q01a_file-group{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,Canvas);flex-direction:column;gap:4px;padding:6px 8px;display:flex}.M4q01a_file-group-header{align-items:center;gap:6px;display:flex}.M4q01a_file-group-title{min-width:0;font:600 12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.M4q01a_file-option{cursor:pointer;font:12px/18px var(--dsw-font-family,inherit);align-items:flex-start;gap:8px;display:flex}.M4q01a_file-details{flex-direction:column;gap:1px;min-width:0;display:flex}.M4q01a_file-path{font:12px/18px var(--dsw-font-family-mono,ui-monospace, SFMono-Regular, Consolas, monospace);color:var(--dsw-alias-label-primary);word-break:break-all}.M4q01a_file-weak{font:11px/16px var(--dsw-font-family,inherit);color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}.M4q01a_file-evidence{font:11px/16px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));word-break:break-word}.M4q01a_dialog-parts{flex-direction:column;gap:8px;display:flex}.M4q01a_permanent-risk{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-state-error-primary);margin:0}.M4q01a_hidden-input{display:none}.M4q01a_svg-block{display:block}.M4q01a_notice-header{align-items:center;gap:8px;display:flex}.M4q01a_stats-row{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.M4q01a_stat-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,Canvas);border-radius:999px;align-items:baseline;gap:6px;padding:4px 10px;display:inline-flex}.M4q01a_stat-label{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary)}.M4q01a_stat-value{font:500 13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}.M4q01a_stats-spacer{flex:auto}.M4q01a_main-grid{grid-template-columns:minmax(0,1fr) 340px;align-items:start;gap:20px;display:grid}.M4q01a_sessions-panel{flex-direction:column;gap:12px;min-width:0;display:flex}.M4q01a_tools-panel{flex-direction:column;gap:16px;min-width:0;display:flex}.M4q01a_section-header{justify-content:space-between;align-items:baseline;gap:12px;display:flex}.M4q01a_section-title{font:500 15px/24px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);margin:0}.M4q01a_section-meta{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);white-space:nowrap}.M4q01a_sessions-toolbar{flex-direction:column;gap:10px;display:flex}.M4q01a_search-row{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.M4q01a_search-row .M4q01a_search{flex:240px}.M4q01a_select-actions{flex:none;align-items:center;gap:8px;display:flex}.M4q01a_segmented{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,Canvas);flex-wrap:wrap;align-items:center;gap:2px;width:fit-content;max-width:100%;padding:3px;display:inline-flex}.M4q01a_segment{border-radius:calc(var(--dsw-radius-sm,6px) - 2px);height:26px;color:var(--dsw-alias-label-secondary);font:500 12px/18px var(--dsw-font-family,inherit);cursor:pointer;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:0 10px;display:inline-flex}.M4q01a_segment[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-sm,none)}.M4q01a_segment-count{font:500 11px/16px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}.M4q01a_selection-bar{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,Canvas);flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;display:flex}.M4q01a_selection-info{font:500 12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary)}.M4q01a_selection-actions{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.M4q01a_tool-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,Canvas);flex-direction:column;gap:12px;padding:14px 16px;display:flex}.M4q01a_tool-card-header{flex-direction:column;gap:4px;display:flex}.M4q01a_tool-card-title{font:500 14px/22px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);margin:0}.M4q01a_tool-card-hint{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);margin:0}.M4q01a_export-options{flex-direction:column;gap:12px;display:flex}.M4q01a_mode-grid{grid-template-columns:minmax(0,1fr);gap:8px;display:grid}.M4q01a_mode-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;background:0 0;align-items:flex-start;gap:8px;padding:10px;display:flex}.M4q01a_mode-card input{flex:none;margin:3px 0 0}.M4q01a_mode-card-text{flex-direction:column;gap:2px;min-width:0;display:flex}.M4q01a_mode-card-title{font:500 13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary)}.M4q01a_mode-card-active{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));background:var(--dsw-alias-bg-layer-2,Canvas)}.M4q01a_option-list{flex-direction:column;gap:10px;display:flex}.M4q01a_check-row{cursor:pointer;align-items:flex-start;gap:8px;display:flex}.M4q01a_check-row input{flex:none;margin:3px 0 0}.M4q01a_check-text{min-width:0;font:13px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);flex-direction:column;gap:2px;display:flex}.M4q01a_tool-actions{flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px;display:flex}.M4q01a_tabs{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,Canvas);gap:2px;padding:3px;display:flex}.M4q01a_tab{border-radius:calc(var(--dsw-radius-sm,6px) - 2px);height:28px;color:var(--dsw-alias-label-secondary);font:500 12px/18px var(--dsw-font-family,inherit);cursor:pointer;white-space:nowrap;background:0 0;border:none;flex:1 1 0;padding:0 10px}.M4q01a_tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-sm,none)}.M4q01a_tab-panel{flex-direction:column;gap:12px;display:flex}.M4q01a_share-form{flex-direction:column;gap:8px;display:flex}.M4q01a_share-form .M4q01a_search,.M4q01a_share-form .M4q01a_select{box-sizing:border-box;flex:auto;width:100%;min-width:0}.M4q01a_segment:focus-visible,.M4q01a_tab:focus-visible,.M4q01a_mode-card:focus-within,.M4q01a_check-row:focus-within{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}@media (hover:hover){.M4q01a_segment:hover{background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary)}.M4q01a_mode-card:hover{background:var(--dsw-alias-bg-layer-2,Canvas)}}@media (width<=980px){.M4q01a_main-grid{grid-template-columns:minmax(0,1fr)}.M4q01a_tools-panel{order:2}.M4q01a_content{padding:20px 16px 40px}}.M4q01a_tool-card-status{font:12px/18px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-secondary);margin:0}";
		const tagId = "dsh-session-kit/src/client/styles.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-kit";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var styles_module_css_default = {
			"badge": "M4q01a_badge",
			"badge-active": "M4q01a_badge-active",
			"badge-archived": "M4q01a_badge-archived",
			"badge-legacy": "M4q01a_badge-legacy",
			"check-row": "M4q01a_check-row",
			"check-text": "M4q01a_check-text",
			"content": "M4q01a_content",
			"dialog": "M4q01a_dialog",
			"dialog-actions": "M4q01a_dialog-actions",
			"dialog-body": "M4q01a_dialog-body",
			"dialog-danger": "M4q01a_dialog-danger",
			"dialog-item": "M4q01a_dialog-item",
			"dialog-list": "M4q01a_dialog-list",
			"dialog-note": "M4q01a_dialog-note",
			"dialog-parts": "M4q01a_dialog-parts",
			"dialog-title": "M4q01a_dialog-title",
			"dialog-title-danger": "M4q01a_dialog-title-danger",
			"empty-card": "M4q01a_empty-card",
			"export-options": "M4q01a_export-options",
			"file-details": "M4q01a_file-details",
			"file-evidence": "M4q01a_file-evidence",
			"file-group": "M4q01a_file-group",
			"file-group-header": "M4q01a_file-group-header",
			"file-group-title": "M4q01a_file-group-title",
			"file-option": "M4q01a_file-option",
			"file-path": "M4q01a_file-path",
			"file-selection": "M4q01a_file-selection",
			"file-weak": "M4q01a_file-weak",
			"footnote": "M4q01a_footnote",
			"group": "M4q01a_group",
			"group-count": "M4q01a_group-count",
			"group-header": "M4q01a_group-header",
			"group-path": "M4q01a_group-path",
			"group-title": "M4q01a_group-title",
			"header-main": "M4q01a_header-main",
			"header-row": "M4q01a_header-row",
			"heading": "M4q01a_heading",
			"hidden-input": "M4q01a_hidden-input",
			"input": "M4q01a_input",
			"lines": "M4q01a_lines",
			"main-grid": "M4q01a_main-grid",
			"mode-card": "M4q01a_mode-card",
			"mode-card-active": "M4q01a_mode-card-active",
			"mode-card-text": "M4q01a_mode-card-text",
			"mode-card-title": "M4q01a_mode-card-title",
			"mode-grid": "M4q01a_mode-grid",
			"mode-hint": "M4q01a_mode-hint",
			"mode-label": "M4q01a_mode-label",
			"notice": "M4q01a_notice",
			"notice-header": "M4q01a_notice-header",
			"notice-line": "M4q01a_notice-line",
			"notice-title": "M4q01a_notice-title",
			"option-list": "M4q01a_option-list",
			"overlay": "M4q01a_overlay",
			"page": "M4q01a_page",
			"permanent-risk": "M4q01a_permanent-risk",
			"row": "M4q01a_row",
			"row-actions": "M4q01a_row-actions",
			"row-detail": "M4q01a_row-detail",
			"row-detail-toggle": "M4q01a_row-detail-toggle",
			"row-main": "M4q01a_row-main",
			"row-meta": "M4q01a_row-meta",
			"row-text": "M4q01a_row-text",
			"row-title": "M4q01a_row-title",
			"row-wrapper": "M4q01a_row-wrapper",
			"running-dot": "M4q01a_running-dot",
			"search": "M4q01a_search",
			"search-row": "M4q01a_search-row",
			"section-header": "M4q01a_section-header",
			"section-meta": "M4q01a_section-meta",
			"section-title": "M4q01a_section-title",
			"segment": "M4q01a_segment",
			"segment-count": "M4q01a_segment-count",
			"segmented": "M4q01a_segmented",
			"select": "M4q01a_select",
			"select-actions": "M4q01a_select-actions",
			"selection-actions": "M4q01a_selection-actions",
			"selection-bar": "M4q01a_selection-bar",
			"selection-info": "M4q01a_selection-info",
			"sessions-panel": "M4q01a_sessions-panel",
			"sessions-toolbar": "M4q01a_sessions-toolbar",
			"share-form": "M4q01a_share-form",
			"stat-chip": "M4q01a_stat-chip",
			"stat-label": "M4q01a_stat-label",
			"stat-value": "M4q01a_stat-value",
			"stats-row": "M4q01a_stats-row",
			"stats-spacer": "M4q01a_stats-spacer",
			"subtitle": "M4q01a_subtitle",
			"svg-block": "M4q01a_svg-block",
			"tab": "M4q01a_tab",
			"tab-panel": "M4q01a_tab-panel",
			"tabs": "M4q01a_tabs",
			"tool-actions": "M4q01a_tool-actions",
			"tool-card": "M4q01a_tool-card",
			"tool-card-header": "M4q01a_tool-card-header",
			"tool-card-hint": "M4q01a_tool-card-hint",
			"tool-card-status": "M4q01a_tool-card-status",
			"tool-card-title": "M4q01a_tool-card-title",
			"tools-panel": "M4q01a_tools-panel"
		};
		//#endregion
		//#region src/client/index.js
		/**
		* dsh-session-kit — Client half.
		*
		* One sidebar row ("会话管理") opens a session-management panel in the main
		* column. The panel lists sessions grouped by workspace with an active/archived
		* badge per row, filters them by status and a search box, selects any subset
		* with checkboxes (plus per-group and global select all/none), and exposes both
		* per-row and batch archive / restore / trash-delete actions. Legacy-format
		* sessions additionally carry a version badge and a per-row or batch upgrade
		* action that runs DSH's official migration chain. Clicking/selecting a row
		* loads its storage detail (size across retained generations, format status,
		* archived state). Deleting a session optionally moves its best-effort related
		* files, shown per session as an experimental, individually selectable list
		* (strong evidence preselected) and guarded by a separate second confirmation;
		* permanent delete adds a distinct red second confirmation because data cannot
		* be recovered. It also exports the selection as one ZIP through
		* `POST /session-kit/export`, imports an archive through
		* `POST /session-kit/import`, and imports a DeepSeek public share link through
		* `POST /session-kit/import-share` into a chosen workspace.
		*
		* Bundled by tsdown into the closure-factory artifact `lib/client.js`; static
		* styles live in `styles.module.css` (CSS Modules) and the only runtime import
		* is `react`. Every Host string (titles, warnings, error messages) reaches the
		* DOM as a React text child, never as markup.
		*
		* @module dsh-session-kit/client
		*/
		/** Kebab-case CSS Module locals mapped to the camelCase names used below. */
		const styles = {};
		for (const [local, className] of Object.entries(styles_module_css_default)) styles[local.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = className;
		const h = react.default.createElement;
		/** Dictionary namespace owned by this plugin. */
		const NS = "session-kit";
		/** Host route prefix owned by the Host half. */
		const ROUTE_PREFIX = "/session-kit";
		/** Sidebar row id and main-panel key; the row opens this panel. */
		const PANEL_ID = "session-kit";
		const zh = {
			"panel.title": "会话管理",
			"panel.subtitle": "在左侧浏览与管理会话，在右侧导出或导入。",
			"panel.statSessions": "会话",
			"panel.statWorkspaces": "工作区",
			"panel.statArchived": "已归档",
			"panel.statLegacy": "旧格式",
			"panel.tools": "工具",
			"panel.exportReady": "已选 {count} 个会话",
			"panel.exportNeedSelection": "先在左侧选择会话",
			"panel.exportSection": "导出",
			"panel.importSection": "导入",
			"panel.tabArchive": "会话包",
			"panel.tabShare": "DeepSeek 分享",
			"panel.exportCardHint": "打包所选会话；精简模式体积更小，全量模式保留完整历史。",
			"panel.importCardHint": "导入会话包，或从 DeepSeek 公开分享链接新建会话。",
			"panel.loading": "正在加载会话列表…",
			"panel.loadFailed": "会话列表加载失败",
			"panel.retry": "重试",
			"panel.refresh": "刷新",
			"panel.search": "搜索标题、会话 id 或目录",
			"panel.selectAll": "全选",
			"panel.selectNone": "取消全选",
			"panel.selectedCount": "已选 {selected} / 共 {total}",
			"panel.groupUngrouped": "未分组",
			"panel.untitledWorkspace": "未命名工作区",
			"panel.groupCount": "{count} 个会话",
			"panel.selectGroup": "选择分组 {title}",
			"panel.untitled": "未命名会话",
			"panel.running": "运行中",
			"panel.events": "{count} 条事件",
			"panel.empty": "还没有可管理的会话。",
			"panel.emptyFilter": "没有匹配搜索条件的会话。",
			"panel.modeCompact": "精简",
			"panel.modeCompactHint": "仅保留主对话（用户消息与最终回答），体积更小。",
			"panel.modeFull": "全量",
			"panel.modeFullHint": "完整事件日志，可完整恢复工具调用与过程。",
			"panel.attachments": "包含附件",
			"panel.attachmentsHint": "导出图片与文件附件。",
			"panel.exportOptions": "导出选项",
			"panel.importOptions": "导入选项",
			"panel.workspaceFiles": "包含工作区文件（整个工作区）",
			"panel.workspaceFilesHint": "打包所选会话对应工作区的文件树；自动跳过敏感文件与依赖/构建目录。",
			"panel.subagents": "包含子代理会话",
			"panel.subagentsHint": "一并打包所选会话的子代理日志（仅备份；导入时默认跳过）。",
			"panel.restoreWorkspaceFiles": "恢复工作区文件到当前工作区",
			"panel.restoreWorkspaceFilesHint": "解压到当前工作区；同名文件不覆盖，冲突会列在结果提示里。",
			"panel.workspaceRestored": "已恢复工作区文件 {count} 个（{size}）",
			"panel.workspaceSkipped": "跳过 {count} 个工作区文件",
			"panel.workspaceSkipLine": "跳过 {path}：{reason}",
			"panel.unknownPath": "未知路径",
			"panel.unknownReason": "已存在或不允许",
			"panel.moreLines": "…另有 {count} 条提示",
			"panel.legacyBadge": "旧格式 v{version}",
			"panel.legacyBadgePlain": "旧格式",
			"panel.legacyCount": "旧格式 {count}",
			"panel.upgradeLegacy": "升级旧格式",
			"panel.upgradeFormat": "升级格式",
			"panel.upgradeHint": "使用 DSH 官方迁移工具升级旧格式会话；旧代际保留。",
			"panel.migrating": "正在升级…",
			"panel.migrateFailed": "升级失败",
			"panel.migrateDone": "已升级 {count} 个旧格式会话",
			"panel.migratePartialFailed": "有 {count} 个会话升级失败",
			"panel.migrateFailureLine": "{id}：{reason}",
			"panel.migrateSuccessLine": "{id} 已升级",
			"panel.migrateCurrentLine": "{id} 已是当前格式",
			"panel.migrateAlreadyCurrent": "所选会话已是当前格式（{count} 个）",
			"panel.legacyRemaining": "仍有 {count} 个旧格式会话",
			"panel.migrateNoTarget": "当前没有旧格式会话。",
			"panel.tooManyMigrate": "一次最多升级 {max} 个会话。",
			"panel.confirmMigrateTitle": "升级旧格式会话",
			"panel.confirmMigrateBody": "将使用 DSH 官方迁移工具升级以下 {count} 个会话到当前格式；旧代际会保留，升级失败的会话保持原样。",
			"panel.migrateNote": "迁移由 DSH 官方迁移链执行，不会删除旧日志。",
			"panel.migrateItem": "{title}（v{version}）",
			"panel.migrateItemPlain": "{title}（旧格式）",
			"panel.confirmMigrate": "确认升级",
			"panel.confirmMore": "…另有 {count} 个会话",
			"panel.removeFiles": "同时移走该会话涉及的文件（移到回收站，实验性）",
			"panel.removeFilesHint": "仅从会话事件 best-effort 推导，可能有遗漏。",
			"panel.filesPreviewLoading": "正在推导涉及的文件…",
			"panel.filesPreviewFailed": "文件预览失败：{reason}",
			"panel.filesPreviewEmpty": "没有发现可移走的文件。",
			"panel.filesPreviewSkipped": "另有 {count} 个文件无法移走。",
			"panel.filesSkipLine": "跳过 {path}：{reason}",
			"panel.filesRiskBestEffort": "风险：文件列表只能从事件近似推导，shell/脚本产物可能遗漏。",
			"panel.filesRiskShared": "风险：被多个会话共享的文件移走后会影响其他会话。",
			"panel.filesRiskTrash": "文件只会移到回收站，不会永久删除。",
			"panel.filesItem": "{path}（{size}）",
			"panel.filesMore": "…另有 {count} 个文件",
			"panel.confirmFilesTitle": "确认移走文件并删除会话",
			"panel.confirmFilesBody": "将删除 {count} 个会话，并把 {files} 个文件（{size}）移到回收站；请再次确认。",
			"panel.confirmFilesNote": "请核对文件列表；取消不会删除任何会话或文件。",
			"panel.confirmDeleteWithFiles": "确认删除并移走文件",
			"panel.continue": "继续",
			"panel.filesMoved": "已移走 {count} 个文件（{size}）",
			"panel.filesSkipped": "跳过 {count} 个文件",
			"panel.filesTrashPath": "文件回收站：{path}",
			"panel.experimental": "实验性",
			"panel.fileSelectionExperimental": "文件推导为实验性功能：列表仅从事件近似推导，可能遗漏或误判，请逐项核对。",
			"panel.filesSelectedSummary": "已选 {count} 个文件（{size}）",
			"panel.filesSelectAll": "全选",
			"panel.filesClear": "清空",
			"panel.fileWeakHint": "弱证据：可能只是工具参数，未必真的写入",
			"panel.fileEvidence": "证据：{evidence}",
			"panel.fileGroupTitle": "{title}（{count} 个文件）",
			"panel.unknownSessionGroup": "未知会话",
			"panel.noFileSelected": "请至少勾选一个文件，或取消勾选“移走文件”。",
			"panel.permanentDelete": "永久删除（不可恢复，不进入回收站）",
			"panel.permanentRisk": "永久删除会直接擦除会话目录与选中文件，无法恢复，也不会进入 session-kit-trash。",
			"panel.confirmPermanentTitle": "永久删除会话",
			"panel.confirmPermanentBody": "将永久删除 {count} 个会话，无法恢复，也不会进入回收站。",
			"panel.confirmPermanentWithFilesBody": "将永久删除 {count} 个会话，并永久删除选中的 {files} 个文件（{size}）；无法恢复，也不会进入回收站。",
			"panel.confirmPermanent": "永久删除",
			"panel.permanentDeleting": "正在永久删除…",
			"panel.permanentDone": "已永久删除 {count} 个会话（不可恢复）",
			"panel.permanentNotice": "永久删除已完成，数据无法恢复。",
			"panel.filesRemoved": "已永久删除 {count} 个文件（{size}）",
			"panel.confirmMoreItems": "…另有 {count} 项",
			"panel.detailLoading": "正在读取会话详情…",
			"panel.detailFailed": "会话详情读取失败：{reason}",
			"panel.detailSize": "存储大小（含所有代际）：{size}",
			"panel.detailFormat": "格式状态：{status}",
			"panel.detailArchived": "归档状态：{status}",
			"panel.detailFormatCurrent": "当前格式",
			"panel.detailFormatLegacy": "旧格式",
			"panel.detailArchivedYes": "已归档",
			"panel.detailArchivedNo": "未归档",
			"panel.detailFiles": "相关文件（实验性）：{count} 个，共 {size}",
			"panel.detailFilesNone": "没有从事件中发现相关文件（尽力推导，可能遗漏）。",
			"panel.detailFilesLoading": "正在推导相关文件…",
			"panel.detailFilesFailed": "相关文件预览失败：{reason}",
			"panel.detailFileItem": "{path}（{size}{weak}）",
			"panel.detailFileWeak": " · 弱证据",
			"panel.filesPreviewMore": "…另有 {count} 个文件",
			"panel.showDetail": "查看会话详情 {title}",
			"panel.hideDetail": "收起会话详情 {title}",
			"panel.statusFilter": "状态筛选",
			"panel.statusAll": "全部",
			"panel.statusActive": "未归档",
			"panel.statusArchived": "已归档",
			"panel.statusBadgeArchived": "已归档",
			"panel.statusBadgeActive": "未归档",
			"panel.searchCount": "匹配 {matched} / 共 {total}",
			"panel.selectSession": "选择会话 {title}",
			"panel.archive": "归档",
			"panel.unarchive": "恢复",
			"panel.delete": "删除",
			"panel.archiveSelected": "归档选中",
			"panel.unarchiveSelected": "恢复选中",
			"panel.deleteSelected": "删除选中",
			"panel.archiveDone": "已归档 {count} 个会话",
			"panel.unarchiveDone": "已恢复 {count} 个会话",
			"panel.deleteDone": "已删除 {count} 个会话（已移到 session-kit-trash）",
			"panel.actionFailed": "操作失败",
			"panel.actionPartialFailed": "有 {count} 个会话操作失败",
			"panel.actionFailureLine": "{id}：{reason}",
			"panel.actionUnknownReason": "未知错误",
			"panel.noArchivable": "选中的会话中没有未归档的会话。",
			"panel.noUnarchivable": "选中的会话中没有已归档的会话。",
			"panel.tooManySelected": "一次最多操作 {max} 个会话。",
			"panel.deleting": "正在删除…",
			"panel.confirmDeleteTitle": "删除会话",
			"panel.confirmDeleteBody": "将把以下 {count} 个会话移到 session-kit-trash 回收站，并从工作区列表中移除；这不是永久删除。",
			"panel.confirmDelete": "确认删除",
			"panel.cancel": "取消",
			"panel.deleteNote": "删除只会移动到 session-kit-trash，可稍后手动找回。",
			"panel.emptyStatusFilter": "当前状态下没有会话。",
			"panel.export": "导出所选",
			"panel.exporting": "正在导出…",
			"panel.exportFailed": "导出失败",
			"panel.exportDone": "已导出 {count} 个会话",
			"panel.import": "导入会话包",
			"panel.importing": "正在导入…",
			"panel.importFailed": "导入失败",
			"panel.importDone": "已导入 {count} 个会话",
			"panel.importSessionIds": "新会话：{ids}",
			"panel.importUnverified": "有会话写入后无法通过 DSH 读回校验，请检查警告。",
			"panel.importHint": "导入只会新建会话，不会覆盖已有会话。",
			"panel.openHint": "可在左侧会话列表中打开新会话。",
			"panel.shareTitle": "DeepSeek 分享链接导入",
			"panel.shareHint": "粘贴 chat.deepseek.com 公开分享链接或分享 id，导入为新的 DSH 会话。",
			"panel.sharePlaceholder": "https://chat.deepseek.com/share/<id> 或分享 id",
			"panel.shareWorkspace": "导入到工作区",
			"panel.shareWorkspaceDefault": "默认目录 / 当前工作区",
			"panel.shareTitleLabel": "标题（可选）",
			"panel.shareImport": "导入分享",
			"panel.shareImporting": "正在导入分享…",
			"panel.shareSuccess": "分享已导入",
			"panel.shareFailed": "分享导入失败",
			"panel.shareSessionId": "新会话：{id}",
			"panel.shareEventCount": "{count} 条事件",
			"panel.shareEmptyInput": "请输入分享链接或分享 id。",
			"panel.shareRiskPublic": "仅支持 chat.deepseek.com 的公开分享链接；内容来自公开链接。",
			"panel.shareRiskNew": "导入会新建会话，不会覆盖已有会话。",
			"panel.noSelection": "请先勾选要导出的会话。",
			"panel.dismiss": "关闭",
			"error.network": "无法连接 DSH 主机，请确认页面连接正常后重试。",
			"error.http": "请求失败（HTTP {status}）。",
			"error.empty": "这个文件是空的。",
			"error.unknown": "发生未知错误，请重试。"
		};
		const en = {
			"panel.title": "Session manager",
			"panel.subtitle": "Browse and manage sessions on the left; export or import on the right.",
			"panel.statSessions": "Sessions",
			"panel.statWorkspaces": "Workspaces",
			"panel.statArchived": "Archived",
			"panel.statLegacy": "Legacy",
			"panel.tools": "Tools",
			"panel.exportReady": "{count} selected",
			"panel.exportNeedSelection": "Select sessions on the left first",
			"panel.exportSection": "Export",
			"panel.importSection": "Import",
			"panel.tabArchive": "Archive",
			"panel.tabShare": "DeepSeek share",
			"panel.exportCardHint": "Package the selected sessions; compact is smaller, full keeps the complete history.",
			"panel.importCardHint": "Import an archive, or create a new session from a public DeepSeek share link.",
			"panel.loading": "Loading sessions…",
			"panel.loadFailed": "Could not load sessions",
			"panel.retry": "Retry",
			"panel.refresh": "Refresh",
			"panel.search": "Search title, session id, or directory",
			"panel.selectAll": "Select all",
			"panel.selectNone": "Select none",
			"panel.selectedCount": "{selected} selected of {total}",
			"panel.groupUngrouped": "Ungrouped",
			"panel.untitledWorkspace": "Untitled workspace",
			"panel.groupCount": "{count} sessions",
			"panel.selectGroup": "Select group {title}",
			"panel.untitled": "Untitled session",
			"panel.running": "Running",
			"panel.events": "{count} events",
			"panel.empty": "No sessions to manage yet.",
			"panel.emptyFilter": "No sessions match this search.",
			"panel.modeCompact": "Compact",
			"panel.modeCompactHint": "Main conversation only (user messages and final answers); smaller archives.",
			"panel.modeFull": "Full",
			"panel.modeFullHint": "Complete event log; keeps tool calls and process history.",
			"panel.attachments": "Include attachments",
			"panel.attachmentsHint": "Pack referenced images and files.",
			"panel.exportOptions": "Export options",
			"panel.importOptions": "Import options",
			"panel.workspaceFiles": "Include workspace files (whole workspace)",
			"panel.workspaceFilesHint": "Pack the file tree of the selected sessions' workspaces; sensitive files and dependency/build directories are skipped.",
			"panel.subagents": "Include subagent sessions",
			"panel.subagentsHint": "Pack subagent logs of the selected sessions (backup only; import skips them).",
			"panel.restoreWorkspaceFiles": "Restore workspace files into the current workspace",
			"panel.restoreWorkspaceFilesHint": "Extract into the current workspace; existing files are never overwritten and conflicts are listed.",
			"panel.workspaceRestored": "Restored {count} workspace files ({size})",
			"panel.workspaceSkipped": "Skipped {count} workspace files",
			"panel.workspaceSkipLine": "Skipped {path}: {reason}",
			"panel.unknownPath": "unknown path",
			"panel.unknownReason": "exists or not allowed",
			"panel.moreLines": "…and {count} more notes",
			"panel.legacyBadge": "Legacy format v{version}",
			"panel.legacyBadgePlain": "Legacy format",
			"panel.legacyCount": "{count} legacy",
			"panel.upgradeLegacy": "Upgrade legacy",
			"panel.upgradeFormat": "Upgrade format",
			"panel.upgradeHint": "Upgrade legacy sessions with DSH's official migration; the old generation is preserved.",
			"panel.migrating": "Upgrading…",
			"panel.migrateFailed": "Upgrade failed",
			"panel.migrateDone": "Upgraded {count} legacy sessions",
			"panel.migratePartialFailed": "{count} sessions failed to upgrade",
			"panel.migrateFailureLine": "{id}: {reason}",
			"panel.migrateSuccessLine": "{id} upgraded",
			"panel.migrateCurrentLine": "{id} is already current",
			"panel.migrateAlreadyCurrent": "Selected sessions are already current ({count})",
			"panel.legacyRemaining": "{count} legacy sessions remain",
			"panel.migrateNoTarget": "No legacy sessions to upgrade.",
			"panel.tooManyMigrate": "At most {max} sessions can be upgraded at once.",
			"panel.confirmMigrateTitle": "Upgrade legacy sessions",
			"panel.confirmMigrateBody": "Upgrade {count} session(s) to the current format with DSH's official migration; the old generation is preserved and failed sessions stay unchanged.",
			"panel.migrateNote": "Migration runs through DSH's official migration chain and never deletes the old logs.",
			"panel.migrateItem": "{title} (v{version})",
			"panel.migrateItemPlain": "{title} (legacy format)",
			"panel.confirmMigrate": "Upgrade",
			"panel.confirmMore": "…and {count} more sessions",
			"panel.removeFiles": "Also move related files (to trash, experimental)",
			"panel.removeFilesHint": "Derived best-effort from session events; some files may be missed.",
			"panel.filesPreviewLoading": "Deriving related files…",
			"panel.filesPreviewFailed": "File preview failed: {reason}",
			"panel.filesPreviewEmpty": "No movable files were found.",
			"panel.filesPreviewSkipped": "{count} more files cannot be moved.",
			"panel.filesSkipLine": "Skipped {path}: {reason}",
			"panel.filesRiskBestEffort": "Risk: the list is approximated from events; shell/script output can be missed.",
			"panel.filesRiskShared": "Risk: moving a file shared by several sessions affects the other sessions.",
			"panel.filesRiskTrash": "Files are only moved to the trash, never erased.",
			"panel.filesItem": "{path} ({size})",
			"panel.filesMore": "…and {count} more files",
			"panel.confirmFilesTitle": "Move files and delete sessions",
			"panel.confirmFilesBody": "Delete {count} session(s) and move {files} file(s) ({size}) to the trash; confirm again.",
			"panel.confirmFilesNote": "Review the file list; cancelling deletes no session and no file.",
			"panel.confirmDeleteWithFiles": "Delete and move files",
			"panel.continue": "Continue",
			"panel.filesMoved": "Moved {count} files ({size})",
			"panel.filesSkipped": "Skipped {count} files",
			"panel.filesTrashPath": "Files trash: {path}",
			"panel.experimental": "Experimental",
			"panel.fileSelectionExperimental": "File derivation is experimental: the list is approximated from events and may miss or misjudge files. Review each entry.",
			"panel.filesSelectedSummary": "{count} files selected ({size})",
			"panel.filesSelectAll": "Select all",
			"panel.filesClear": "Clear",
			"panel.fileWeakHint": "Weak evidence: a tool argument, not proof the file was written",
			"panel.fileEvidence": "Evidence: {evidence}",
			"panel.fileGroupTitle": "{title} ({count} files)",
			"panel.unknownSessionGroup": "Unknown session",
			"panel.noFileSelected": "Select at least one file, or uncheck \"move files\".",
			"panel.permanentDelete": "Permanent delete (unrecoverable, skips trash)",
			"panel.permanentRisk": "Permanent delete erases the session directories and selected files irreversibly and never enters session-kit-trash.",
			"panel.confirmPermanentTitle": "Permanently delete sessions",
			"panel.confirmPermanentBody": "Permanently delete {count} session(s). This cannot be recovered and never enters the trash.",
			"panel.confirmPermanentWithFilesBody": "Permanently delete {count} session(s) and the selected {files} file(s) ({size}). This cannot be recovered and never enters the trash.",
			"panel.confirmPermanent": "Delete permanently",
			"panel.permanentDeleting": "Deleting permanently…",
			"panel.permanentDone": "Permanently deleted {count} session(s) (unrecoverable)",
			"panel.permanentNotice": "Permanent deletion finished; the data cannot be recovered.",
			"panel.filesRemoved": "Permanently deleted {count} files ({size})",
			"panel.confirmMoreItems": "…and {count} more items",
			"panel.detailLoading": "Loading session detail…",
			"panel.detailFailed": "Could not load session detail: {reason}",
			"panel.detailSize": "Storage size (all generations): {size}",
			"panel.detailFormat": "Format status: {status}",
			"panel.detailArchived": "Archived: {status}",
			"panel.detailFormatCurrent": "current",
			"panel.detailFormatLegacy": "legacy",
			"panel.detailArchivedYes": "archived",
			"panel.detailArchivedNo": "not archived",
			"panel.detailFiles": "Related files (experimental): {count}, {size} total",
			"panel.detailFilesNone": "No related files derived from events (best-effort; some may be missed).",
			"panel.detailFilesLoading": "Deriving related files…",
			"panel.detailFilesFailed": "Related-file preview failed: {reason}",
			"panel.detailFileItem": "{path} ({size}{weak})",
			"panel.detailFileWeak": " · weak evidence",
			"panel.filesPreviewMore": "…and {count} more files",
			"panel.showDetail": "Show session detail for {title}",
			"panel.hideDetail": "Hide session detail for {title}",
			"panel.statusFilter": "Status",
			"panel.statusAll": "All",
			"panel.statusActive": "Active",
			"panel.statusArchived": "Archived",
			"panel.statusBadgeArchived": "Archived",
			"panel.statusBadgeActive": "Active",
			"panel.searchCount": "{matched} matched of {total}",
			"panel.selectSession": "Select session {title}",
			"panel.archive": "Archive",
			"panel.unarchive": "Restore",
			"panel.delete": "Delete",
			"panel.archiveSelected": "Archive selected",
			"panel.unarchiveSelected": "Restore selected",
			"panel.deleteSelected": "Delete selected",
			"panel.archiveDone": "Archived {count} sessions",
			"panel.unarchiveDone": "Restored {count} sessions",
			"panel.deleteDone": "Deleted {count} sessions (moved to session-kit-trash)",
			"panel.actionFailed": "Action failed",
			"panel.actionPartialFailed": "{count} sessions failed",
			"panel.actionFailureLine": "{id}: {reason}",
			"panel.actionUnknownReason": "unknown error",
			"panel.noArchivable": "No selected session is active.",
			"panel.noUnarchivable": "No selected session is archived.",
			"panel.tooManySelected": "At most {max} sessions can be handled at once.",
			"panel.deleting": "Deleting…",
			"panel.confirmDeleteTitle": "Delete sessions",
			"panel.confirmDeleteBody": "Move {count} session(s) to the session-kit-trash folder and remove them from the workspace list; this is not a permanent erase.",
			"panel.confirmDelete": "Delete",
			"panel.cancel": "Cancel",
			"panel.deleteNote": "Deletion only moves files to session-kit-trash; recover them there later.",
			"panel.emptyStatusFilter": "No sessions in this status.",
			"panel.export": "Export selected",
			"panel.exporting": "Exporting…",
			"panel.exportFailed": "Export failed",
			"panel.exportDone": "Exported {count} sessions",
			"panel.import": "Import archive",
			"panel.importing": "Importing…",
			"panel.importFailed": "Import failed",
			"panel.importDone": "Imported {count} sessions",
			"panel.importSessionIds": "New sessions: {ids}",
			"panel.importUnverified": "Some sessions were written but failed to read back; check the warnings.",
			"panel.importHint": "Import only creates new sessions; it never overwrites an existing one.",
			"panel.openHint": "Open the new sessions from the session list on the left.",
			"panel.shareTitle": "DeepSeek share link import",
			"panel.shareHint": "Paste a public chat.deepseek.com share link or share id to import it as a new DSH session.",
			"panel.sharePlaceholder": "https://chat.deepseek.com/share/<id> or a share id",
			"panel.shareWorkspace": "Import into workspace",
			"panel.shareWorkspaceDefault": "Default directory / current workspace",
			"panel.shareTitleLabel": "Title (optional)",
			"panel.shareImport": "Import share",
			"panel.shareImporting": "Importing share…",
			"panel.shareSuccess": "Share imported",
			"panel.shareFailed": "Share import failed",
			"panel.shareSessionId": "New session: {id}",
			"panel.shareEventCount": "{count} events",
			"panel.shareEmptyInput": "Enter a share link or share id.",
			"panel.shareRiskPublic": "Only public chat.deepseek.com share links are supported; content comes from the public link.",
			"panel.shareRiskNew": "Import creates a new session and never overwrites an existing one.",
			"panel.noSelection": "Select at least one session to export.",
			"panel.dismiss": "Dismiss",
			"error.network": "Cannot reach the DSH host. Check the page connection and try again.",
			"error.http": "Request failed (HTTP {status}).",
			"error.empty": "This file is empty.",
			"error.unknown": "Something went wrong. Please try again."
		};
		const T = {
			labelPrimary: "var(--dsw-alias-label-primary)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))",
			bgBase: "var(--dsw-alias-bg-base, Canvas)",
			bgLayer1: "var(--dsw-alias-bg-layer-1, Canvas)",
			bgLayer2: "var(--dsw-alias-bg-layer-2, Canvas)",
			border: "var(--dsw-alias-border-l2)",
			brand: "var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))",
			hoverFill: "var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))",
			error: "var(--dsw-alias-state-error-primary)",
			success: "var(--dsw-alias-state-success-primary)",
			warn: "var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary))",
			focusRing: "var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))",
			radius: "var(--dsw-radius-sm, 6px)",
			radiusLg: "var(--dsw-radius-lg, 10px)",
			mono: "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
			font: "var(--dsw-font-family, inherit)"
		};
		/** Replace `{name}` placeholders from a plain values object. */
		function formatTemplate(template, params) {
			if (params === void 0 || params === null || typeof params !== "object") return template;
			return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
		}
		/** Chinese-dictionary translator used when the slot supplies no `t`. */
		function fallbackTranslate(key, params) {
			return formatTemplate(Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key, params);
		}
		/** Bind the slot's translator, falling back to the local dictionary. */
		function translatorOf(t) {
			if (typeof t !== "function") return fallbackTranslate;
			return (key, params) => {
				const value = t(key, params);
				return typeof value === "string" && value !== "" ? value : fallbackTranslate(key, params);
			};
		}
		/** Absolute URL of one Host route on the page's own origin. */
		function hostUrl(path) {
			return new URL(`${ROUTE_PREFIX}${path}`, window.location.href).toString();
		}
		/** A failure carrying either the Host payload or the transport status. */
		function requestFailure(payload, status) {
			const hasPayload = payload !== null && typeof payload === "object";
			const message = hasPayload && typeof payload.message === "string" && payload.message.trim() !== "" ? payload.message.trim() : `HTTP ${String(status)}`;
			const failure = new Error(message);
			failure.code = hasPayload && typeof payload.code === "string" ? payload.code : "";
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
				const raw = response.headers.get("x-session-kit-warnings");
				if (raw === null || raw === "") return [];
				const parsed = JSON.parse(decodeURIComponent(raw));
				return Array.isArray(parsed) ? parsed.filter((line) => typeof line === "string") : [];
			} catch {
				return [];
			}
		}
		/** Read the download filename header, rejecting path separators. */
		function filenameOf(response) {
			const raw = response.headers.get("x-session-kit-filename");
			if (raw === null || raw === "") return "";
			try {
				const decoded = decodeURIComponent(raw).replace(/[\\/]+/gu, "_").trim();
				return decoded === "" ? "" : decoded;
			} catch {
				return "";
			}
		}
		/** One JSON request against this plugin's Host routes. */
		async function requestJson(path, init) {
			const headers = {
				accept: "application/json",
				...init === void 0 ? {} : init.headers ?? {}
			};
			const response = await fetch(hostUrl(path), {
				...init === void 0 ? {} : init,
				headers
			});
			const payload = await jsonBody(response);
			if (!response.ok) throw requestFailure(payload, response.status);
			if (payload !== null && typeof payload === "object" && payload.ok === false) throw requestFailure(payload, response.status);
			return payload;
		}
		/** Non-empty string or the empty string. */
		function pickString(value) {
			return typeof value === "string" ? value.trim() : "";
		}
		/** Non-negative finite number or 0. */
		function pickNumber(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
		}
		/** Normalize one workspace row from `GET /session-kit/list`. */
		function normalizeWorkspace(raw) {
			const record = raw !== null && typeof raw === "object" ? raw : {};
			return {
				workspaceId: pickString(record.workspaceId ?? record.id),
				title: pickString(record.title ?? record.name),
				path: pickString(record.path),
				sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((id) => typeof id === "string" && id !== "") : []
			};
		}
		/** Normalize one session row from `GET /session-kit/list`. */
		function normalizeSession(raw) {
			const record = raw !== null && typeof raw === "object" ? raw : {};
			return {
				id: pickString(record.id ?? record.sessionId),
				title: pickString(record.title),
				cwd: pickString(record.cwd),
				workspaceId: pickString(record.workspaceId),
				workspaceTitle: pickString(record.workspaceTitle),
				running: record.running === true,
				archived: record.archived === true,
				legacy: record.legacy === true,
				formatStatus: pickString(record.formatStatus),
				formatVersion: pickNumber(record.formatVersion),
				storedVersion: pickNumber(record.storedVersion),
				eventCount: pickNumber(record.eventCount),
				createdAt: pickNumber(record.createdAt),
				updatedAt: pickNumber(record.updatedAt)
			};
		}
		/** Normalize the `GET /session-kit/list` payload into workspaces plus sessions. */
		function normalizeCatalog(payload) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : Array.isArray(root.workspaces) ? root.workspaces : [];
			const rawSessions = Array.isArray(data.sessions) ? data.sessions : Array.isArray(root.sessions) ? root.sessions : [];
			return {
				workspaces: rawWorkspaces.map(normalizeWorkspace).filter((workspace) => workspace.workspaceId !== "" || workspace.path !== ""),
				sessions: rawSessions.map(normalizeSession).filter((session) => session.id !== ""),
				sessionFormatVersion: pickNumber(data.sessionFormatVersion ?? root.sessionFormatVersion)
			};
		}
		/** Normalize the optional workspace-file restore summary of one import result. */
		function normalizeWorkspaceRestore(data) {
			const record = data !== null && typeof data === "object" ? data : {};
			let source = {};
			for (const candidate of [
				record.workspaceFiles,
				record.workspaceRestore,
				record.workspace
			]) if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
				source = candidate;
				break;
			}
			const restoredFiles = pickNumber(source.restoredFiles ?? source.restored ?? record.restoredFiles ?? record.restored);
			const restoredBytes = pickNumber(source.restoredBytes ?? source.bytes ?? record.restoredBytes);
			const rawSkipped = source.skipped ?? record.skipped;
			const skippedCountRaw = typeof source.skippedFiles === "number" ? source.skippedFiles : typeof record.skippedFiles === "number" ? record.skippedFiles : void 0;
			const skipped = (Array.isArray(rawSkipped) ? rawSkipped : []).map((entry) => {
				if (typeof entry === "string") return {
					path: entry,
					reason: ""
				};
				const item = entry !== null && typeof entry === "object" ? entry : {};
				return {
					path: pickString(item.path ?? item.relPath ?? item.name),
					reason: pickString(item.reason)
				};
			}).filter((entry) => entry.path !== "" || entry.reason !== "");
			const skippedCount = skippedCountRaw !== void 0 ? pickNumber(skippedCountRaw) : typeof rawSkipped === "number" ? pickNumber(rawSkipped) : skipped.length;
			const warnings = Array.isArray(source.warnings) ? source.warnings.filter((line) => typeof line === "string") : [];
			return {
				restoredFiles,
				restoredBytes,
				skipped,
				skippedCount: Math.max(skippedCount, skipped.length),
				warnings
			};
		}
		/** Normalize the import route payload. */
		function normalizeImportPayload(payload) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			const sessions = (Array.isArray(data.sessions) ? data.sessions : []).map((raw) => {
				const record = raw !== null && typeof raw === "object" ? raw : {};
				return {
					sessionId: pickString(record.sessionId ?? record.id),
					title: pickString(record.title),
					eventCount: pickNumber(record.eventCount),
					mode: pickString(record.mode),
					verified: record.verified !== false,
					warnings: Array.isArray(record.warnings) ? record.warnings.filter((line) => typeof line === "string") : []
				};
			});
			const workspace = normalizeWorkspaceRestore(data);
			return {
				sessions,
				warnings: [...Array.isArray(data.warnings) ? data.warnings.filter((line) => typeof line === "string") : [], ...workspace.warnings],
				workspace
			};
		}
		/** Normalize the `POST /session-kit/import-share` payload. */
		function normalizeShareImport(payload) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			const sessionRecord = data.session !== null && typeof data.session === "object" ? data.session : {};
			return {
				sessionId: pickString(sessionRecord.sessionId ?? sessionRecord.id ?? data.sessionId ?? root.sessionId),
				title: pickString(sessionRecord.title ?? data.title),
				eventCount: pickNumber(sessionRecord.eventCount ?? data.eventCount),
				warnings: Array.isArray(data.warnings) ? data.warnings.filter((line) => typeof line === "string") : []
			};
		}
		/** Normalize the archive/unarchive/delete route payload. */
		function normalizeManagePayload(payload, requestedIds) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			const rawResults = Array.isArray(data.results) ? data.results : [];
			const results = rawResults.map((raw) => {
				const record = raw !== null && typeof raw === "object" ? raw : {};
				return {
					sessionId: pickString(record.sessionId ?? record.id),
					ok: record.ok !== false,
					error: pickString(record.error ?? record.message)
				};
			});
			const files = {
				moved: pickNumber(data.filesMoved ?? root.filesMoved),
				removed: pickNumber(data.filesRemoved ?? root.filesRemoved),
				skipped: pickNumber(data.filesSkipped ?? root.filesSkipped),
				bytes: pickNumber(data.filesBytes ?? root.filesBytes),
				trashPath: pickString(data.filesTrashPath ?? root.filesTrashPath),
				warnings: Array.isArray(data.fileWarnings) ? data.fileWarnings.filter((line) => typeof line === "string") : [],
				permanent: data.permanent === true || root.permanent === true || rawResults.some((raw) => raw !== null && typeof raw === "object" && raw.permanent === true)
			};
			if (files.moved === 0 && files.removed === 0 && files.skipped === 0 && files.bytes === 0) for (const raw of rawResults) {
				const perFile = (raw !== null && typeof raw === "object" ? raw : {}).files;
				if (perFile === null || typeof perFile !== "object") continue;
				files.moved += pickNumber(perFile.moved);
				files.removed += pickNumber(perFile.removed);
				files.skipped += pickNumber(perFile.skipped);
				files.bytes += pickNumber(perFile.bytes);
				if (files.trashPath === "" && typeof perFile.trashPath === "string" && perFile.trashPath !== "") files.trashPath = perFile.trashPath;
				if (Array.isArray(perFile.warnings)) {
					for (const warning of perFile.warnings) if (typeof warning === "string" && !files.warnings.includes(warning)) files.warnings.push(warning);
				}
			}
			if (results.length === 0) return {
				results: requestedIds.map((id) => ({
					sessionId: id,
					ok: true,
					error: ""
				})),
				files
			};
			return {
				results,
				files
			};
		}
		/** Normalize the `POST /session-kit/session-files` preview payload. */
		function normalizeFilePreview(payload) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			const files = (Array.isArray(data.files) ? data.files : []).map((raw) => {
				const record = raw !== null && typeof raw === "object" ? raw : {};
				return {
					path: pickString(record.path),
					relative: pickString(record.relative),
					root: pickString(record.root),
					bytes: pickNumber(record.bytes),
					weak: record.weak === true,
					evidence: Array.isArray(record.evidence) ? record.evidence.filter((line) => typeof line === "string") : [],
					sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((id) => typeof id === "string") : []
				};
			}).filter((file) => file.path !== "" || file.relative !== "");
			const skipped = (Array.isArray(data.skipped) ? data.skipped : []).map((raw) => {
				if (typeof raw === "string") return {
					path: raw,
					reason: ""
				};
				const record = raw !== null && typeof raw === "object" ? raw : {};
				return {
					path: pickString(record.path),
					reason: pickString(record.reason)
				};
			}).filter((entry) => entry.path !== "" || entry.reason !== "");
			const warnings = Array.isArray(data.warnings) ? data.warnings.filter((line) => typeof line === "string") : [];
			const totalFromServer = pickNumber(data.totalBytes);
			return {
				files,
				skipped,
				warnings,
				totalBytes: totalFromServer > 0 ? totalFromServer : files.reduce((sum, file) => sum + file.bytes, 0)
			};
		}
		/** Normalize the `POST /session-kit/session-detail` payload. */
		function normalizeSessionDetails(payload) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			return (Array.isArray(data.sessions) ? data.sessions : Array.isArray(root.sessions) ? root.sessions : []).map((raw) => {
				const record = raw !== null && typeof raw === "object" ? raw : {};
				return {
					sessionId: pickString(record.id ?? record.sessionId),
					ok: record.ok !== false,
					error: pickString(record.error ?? record.message),
					sizeBytes: pickNumber(record.sizeBytes ?? record.size),
					formatStatus: pickString(record.formatStatus),
					legacy: record.legacy === true,
					archived: record.archived === true
				};
			}).filter((session) => session.sessionId !== "");
		}
		/** Normalize the `POST /session-kit/migrate` payload. */
		function normalizeMigratePayload(payload, requestedIds) {
			const root = payload !== null && typeof payload === "object" ? payload : {};
			const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root;
			const results = (Array.isArray(data.results) ? data.results : []).map((raw) => {
				const record = raw !== null && typeof raw === "object" ? raw : {};
				return {
					sessionId: pickString(record.sessionId ?? record.id),
					ok: record.ok !== false,
					status: pickString(record.status),
					error: pickString(record.error ?? record.message)
				};
			});
			const migratedCount = pickNumber(data.migratedCount ?? root.migratedCount);
			const legacyRemainingRaw = data.legacyRemaining ?? root.legacyRemaining;
			const legacyRemaining = typeof legacyRemainingRaw === "number" && Number.isFinite(legacyRemainingRaw) && legacyRemainingRaw >= 0 ? legacyRemainingRaw : -1;
			if (results.length === 0) return {
				results: requestedIds.map((id) => ({
					sessionId: id,
					ok: true,
					status: "",
					error: ""
				})),
				migratedCount,
				legacyRemaining
			};
			return {
				results,
				migratedCount,
				legacyRemaining
			};
		}
		/** Recent-first ordering key for one session. */
		function recentKey(session) {
			return session.updatedAt > 0 ? session.updatedAt : session.createdAt;
		}
		/** Does one session match the current search needle? */
		function matchesQuery(session, needle) {
			if (needle === "") return true;
			return [
				session.title,
				session.id,
				session.cwd,
				session.workspaceTitle
			].join("\n").toLowerCase().includes(needle);
		}
		/** Does one session pass the status filter? */
		function matchesStatus(session, statusFilter) {
			if (statusFilter === "archived") return session.archived === true;
			if (statusFilter === "active") return session.archived !== true;
			return true;
		}
		/** Counts per status filter, computed over the whole catalog. */
		function statusCounts(catalog) {
			let archived = 0;
			for (const session of catalog.sessions) if (session.archived === true) archived += 1;
			return {
				all: catalog.sessions.length,
				active: catalog.sessions.length - archived,
				archived
			};
		}
		/** Group sessions by workspace for rendering; empty groups are dropped. */
		function buildGroups(catalog, query, statusFilter, tr) {
			const needle = query.trim().toLowerCase();
			const groups = [];
			const byKey = /* @__PURE__ */ new Map();
			for (const workspace of catalog.workspaces) {
				const key = workspace.workspaceId !== "" ? workspace.workspaceId : `path:${workspace.path}`;
				if (byKey.has(key)) continue;
				const group = {
					key,
					workspaceId: workspace.workspaceId,
					title: workspace.title !== "" ? workspace.title : workspace.path !== "" ? workspace.path : tr("panel.untitledWorkspace"),
					path: workspace.path,
					sessions: []
				};
				byKey.set(key, group);
				groups.push(group);
			}
			for (const session of catalog.sessions) {
				let group = session.workspaceId !== "" ? byKey.get(session.workspaceId) : void 0;
				if (group === void 0) {
					const fallbackKey = session.workspaceId !== "" ? `id:${session.workspaceId}` : "";
					group = byKey.get(fallbackKey);
					if (group === void 0) {
						group = {
							key: fallbackKey,
							workspaceId: session.workspaceId,
							title: session.workspaceTitle !== "" ? session.workspaceTitle : session.workspaceId !== "" ? session.workspaceId : tr("panel.groupUngrouped"),
							path: "",
							sessions: []
						};
						byKey.set(fallbackKey, group);
						groups.push(group);
					}
				}
				if (!matchesStatus(session, statusFilter)) continue;
				if (!matchesQuery(session, needle)) continue;
				group.sessions.push(session);
			}
			return groups.filter((group) => group.sessions.length > 0).map((group) => ({
				...group,
				sessions: group.sessions.slice().sort((left, right) => recentKey(right) - recentKey(left))
			}));
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
			return {
				total: group.sessions.length,
				count,
				all: group.sessions.length > 0 && count === group.sessions.length,
				some: count > 0 && count < group.sessions.length
			};
		}
		/** Trigger one browser download without navigating away from the app. */
		function downloadBlob(blob, filename) {
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename === "" ? "session-kit.zip" : filename;
			anchor.rel = "noopener";
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			try {
				anchor.click();
			} finally {
				anchor.remove();
				window.setTimeout(() => URL.revokeObjectURL(url), 1e4);
			}
		}
		/** One-line, localizable description of a thrown request failure. */
		function errorMessageOf(error, tr) {
			if (error !== null && typeof error === "object") {
				const message = typeof error.message === "string" ? error.message.trim() : "";
				if (typeof error.code === "string" && error.code !== "" && message !== "") return message;
				if (typeof error.httpStatus === "number") return tr("error.http", { status: error.httpStatus });
				if (message !== "") return message;
			}
			if (error instanceof TypeError) return tr("error.network");
			return tr("error.unknown");
		}
		/** Human-readable byte count with binary units. */
		function formatBytes(value) {
			const bytes = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
			if (bytes < 1024) return `${Math.round(bytes)} B`;
			const units = [
				"KiB",
				"MiB",
				"GiB",
				"TiB"
			];
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
			const seen = /* @__PURE__ */ new Set();
			for (const line of lines) {
				if (typeof line !== "string") continue;
				const text = line.trim();
				if (text === "" || seen.has(text)) continue;
				seen.add(text);
				unique.push(text);
			}
			if (unique.length <= 24) return unique;
			return [...unique.slice(0, 24), tr("panel.moreLines", { count: unique.length - 24 })];
		}
		/** Sidebar glyph: a short session list with check marks. Artwork is our own. */
		function SessionKitIcon({ size }) {
			const pixels = typeof size === "number" && size > 0 ? size : 16;
			return h("svg", {
				viewBox: "0 0 16 16",
				width: pixels,
				height: pixels,
				"aria-hidden": "true",
				focusable: "false",
				className: styles.svgBlock
			}, h("g", {
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, h("rect", {
				x: 2.2,
				y: 3.2,
				width: 11.6,
				height: 9.6,
				rx: 1.6
			}), h("path", { d: "M4.6 6.4h3.2M4.6 9.6h6.8" }), h("path", { d: "M10.4 6.2l1 1 1.6-1.9" })));
		}
		/** Button style for one visual role. */
		function buttonStyle(role, disabled) {
			const base = {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 6,
				height: 32,
				padding: "0 14px",
				border: "none",
				borderRadius: T.radius,
				font: `500 13px/20px ${T.font}`,
				cursor: disabled ? "not-allowed" : "pointer",
				opacity: disabled ? .6 : 1,
				whiteSpace: "nowrap"
			};
			if (role === "primary") return {
				...base,
				background: T.brand,
				color: T.bgBase
			};
			if (role === "ghost") return {
				...base,
				background: "transparent",
				color: T.labelSecondary,
				border: `1px solid ${T.border}`
			};
			if (role === "danger") return {
				...base,
				background: T.error,
				color: T.bgBase
			};
			if (role === "dangerGhost") return {
				...base,
				background: "transparent",
				color: T.error,
				border: `1px solid ${T.border}`
			};
			return {
				...base,
				background: T.bgLayer2,
				color: T.labelPrimary,
				border: `1px solid ${T.border}`
			};
		}
		/** Compact button style for row-level actions. */
		function rowButtonStyle(role, disabled) {
			return {
				...buttonStyle(role, disabled),
				height: 26,
				padding: "0 8px",
				font: `12px/18px ${T.font}`
			};
		}
		/** Render one compact block of muted detail lines inside a dialog. */
		function linesNode(lines) {
			return h("div", { className: styles.lines }, lines.map((line, index) => h("span", {
				key: `${index}-${line.slice(0, 12)}`,
				className: styles.noticeLine
			}, line)));
		}
		/** One modal confirmation surface shared by destructive and migration actions. */
		function confirmDialogNode(options) {
			const { tr, title, body, items, note, control, details, moreKey, danger, confirmRole, confirmLabel, busyLabel, busy, busyAction, confirmDisabled, onCancel, onConfirm } = options;
			return h("div", { className: styles.overlay }, h("div", {
				className: danger === true ? styles.dialog + " " + styles.dialogDanger : styles.dialog,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": title,
				onKeyDown: (event) => {
					if (event.key === "Escape" && !busy) onCancel();
				}
			}, h("h2", { className: danger === true ? styles.dialogTitleDanger : styles.dialogTitle }, title), h("p", { className: styles.dialogBody }, body), control === void 0 || control === null ? null : control, h("div", { className: styles.dialogList }, items.slice(0, 8).map((item, index) => h("div", {
				key: `${index}-${item.slice(0, 12)}`,
				className: styles.dialogItem
			}, item)), items.length > 8 ? h("div", {
				key: "more",
				className: styles.dialogItem
			}, tr(moreKey === void 0 ? "panel.confirmMore" : moreKey, { count: items.length - 8 })) : null), details === void 0 || details === null ? null : details, note === "" ? null : h("p", { className: styles.dialogNote }, note), h("div", { className: styles.dialogActions }, h("button", {
				type: "button",
				style: buttonStyle("secondary", busy),
				disabled: busy,
				autoFocus: true,
				onClick: onCancel
			}, tr("panel.cancel")), h("button", {
				type: "button",
				style: buttonStyle(confirmRole, busy || confirmDisabled === true),
				disabled: busy || confirmDisabled === true,
				onClick: onConfirm
			}, busyAction ? busyLabel : confirmLabel))));
		}
		/**
		* Session-management page: workspace groups, status filter and search,
		* checkboxes, archive / restore / trash-delete actions, legacy-format
		* upgrade, export mode switch, export download, and archive import.
		* @param {{t: Function, loadCatalog: Function, exportSelection: Function,
		*          importSelection: Function, importShare: Function,
		*          manageSessions: Function, previewSessionFiles: Function,
		*          loadSessionDetails: Function, migrateSessions: Function,
		*          refreshSessions: Function, targetOf: Function}} props
		*   slot translator and the Host operations injected by `apply`.
		*/
		function SessionKitPanel(props) {
			const tr = translatorOf(props.t);
			const [catalog, setCatalog] = react.default.useState({
				workspaces: [],
				sessions: []
			});
			const [phase, setPhase] = react.default.useState("loading");
			const [loadError, setLoadError] = react.default.useState("");
			const [query, setQuery] = react.default.useState("");
			const [selected, setSelected] = react.default.useState(() => /* @__PURE__ */ new Set());
			const [mode, setMode] = react.default.useState("compact");
			const [includeAttachments, setIncludeAttachments] = react.default.useState(true);
			const [includeWorkspaceFiles, setIncludeWorkspaceFiles] = react.default.useState(true);
			const [includeSubagents, setIncludeSubagents] = react.default.useState(false);
			const [restoreWorkspaceFiles, setRestoreWorkspaceFiles] = react.default.useState(true);
			const [statusFilter, setStatusFilter] = react.default.useState("all");
			const [confirmDelete, setConfirmDelete] = react.default.useState(null);
			const [confirmFiles, setConfirmFiles] = react.default.useState(null);
			const [confirmMigrate, setConfirmMigrate] = react.default.useState(null);
			const [details, setDetails] = react.default.useState({});
			const [openDetail, setOpenDetail] = react.default.useState(null);
			const [shareInput, setShareInput] = react.default.useState("");
			const [shareWorkspaceId, setShareWorkspaceId] = react.default.useState("");
			const [shareTitle, setShareTitle] = react.default.useState("");
			const [shareBusy, setShareBusy] = react.default.useState(false);
			const [shareResult, setShareResult] = react.default.useState(null);
			const [importTab, setImportTab] = react.default.useState("archive");
			const [busy, setBusy] = react.default.useState("");
			const [notice, setNotice] = react.default.useState(null);
			const fileInputRef = react.default.useRef(null);
			const mountedRef = react.default.useRef(true);
			react.default.useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);
			async function reload(options) {
				if (!(options !== void 0 && options.quiet === true)) {
					setPhase("loading");
					setLoadError("");
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
					setDetails((previous) => {
						const kept = {};
						for (const [id, detail] of Object.entries(previous)) if (alive.has(id)) kept[id] = detail;
						return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
					});
					setOpenDetail((current) => current !== null && !alive.has(current) ? null : current);
					setPhase("ready");
					return next;
				} catch (error) {
					if (!mountedRef.current) return;
					setPhase("error");
					setLoadError(errorMessageOf(error, tr));
				}
			}
			react.default.useEffect(() => {
				reload();
			}, []);
			const groups = react.default.useMemo(() => buildGroups(catalog, query, statusFilter, tr), [
				catalog,
				query,
				statusFilter,
				props.t
			]);
			const allVisible = react.default.useMemo(() => visibleIds(groups), [groups]);
			const counts = react.default.useMemo(() => statusCounts(catalog), [catalog]);
			const legacyCount = react.default.useMemo(() => catalog.sessions.filter((session) => session.legacy === true).length, [catalog]);
			const total = catalog.sessions.length;
			const matchedCount = allVisible.length;
			const selectedCount = selected.size;
			const BATCH_LIMIT = 500;
			const MIGRATE_LIMIT = 100;
			/** Load one session's storage detail and derived files on demand and cache them. */
			async function loadSessionDetail(sessionId) {
				const cached = details[sessionId];
				if (cached !== void 0 && (cached.phase === "loading" || cached.phase === "ready")) return;
				setDetails((previous) => ({
					...previous,
					[sessionId]: { phase: "loading" }
				}));
				try {
					const [sessionsResult, previewResult] = await Promise.allSettled([props.loadSessionDetails([sessionId]), props.previewSessionFiles([sessionId])]);
					if (!mountedRef.current) return;
					if (sessionsResult.status !== "fulfilled") throw sessionsResult.reason;
					const found = sessionsResult.value.find((entry) => entry.sessionId === sessionId);
					const filePreview = previewResult.status === "fulfilled" ? previewResult.value : void 0;
					const filePreviewError = previewResult.status === "fulfilled" ? "" : errorMessageOf(previewResult.reason, tr);
					setDetails((previous) => ({
						...previous,
						[sessionId]: found === void 0 ? {
							phase: "error",
							error: tr("panel.unknownSessionGroup")
						} : found.ok === false ? {
							phase: "error",
							error: found.error === "" ? tr("panel.unknownSessionGroup") : found.error
						} : {
							phase: "ready",
							...found,
							...filePreview === void 0 ? {} : { filePreview },
							filePreviewError
						}
					}));
				} catch (error) {
					if (!mountedRef.current) return;
					setDetails((previous) => ({
						...previous,
						[sessionId]: {
							phase: "error",
							error: errorMessageOf(error, tr)
						}
					}));
				}
			}
			/** Toggle the expanded detail block for one row. */
			function toggleSessionDetail(sessionId) {
				setOpenDetail((current) => current === sessionId ? null : sessionId);
				loadSessionDetail(sessionId);
			}
			/** Refresh cached details for sessions that survived an action. */
			async function refreshDetailsFor(sessionIds) {
				if (sessionIds.length === 0) return;
				try {
					const sessions = await props.loadSessionDetails(sessionIds);
					if (!mountedRef.current) return;
					setDetails((previous) => {
						const next = { ...previous };
						for (const session of sessions) if (session.ok !== false) next[session.sessionId] = {
							phase: "ready",
							...session
						};
						return next;
					});
				} catch {}
			}
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
					for (const id of ids) if (on) next.add(id);
					else next.delete(id);
					return next;
				});
			}
			async function runExport() {
				if (busy !== "") return;
				const ids = [...selected];
				if (ids.length === 0) {
					setNotice({
						tone: "error",
						title: tr("panel.exportFailed"),
						lines: [tr("panel.noSelection")]
					});
					return;
				}
				setBusy("export");
				setNotice(null);
				try {
					const result = await props.exportSelection({
						sessionIds: ids,
						mode,
						includeAttachments,
						includeWorkspaceFiles,
						includeSubagents
					});
					downloadBlob(result.blob, result.filename);
					setNotice({
						tone: "success",
						title: tr("panel.exportDone", { count: ids.length }),
						lines: capNoticeLines(result.warnings, tr)
					});
				} catch (error) {
					setNotice({
						tone: "error",
						title: tr("panel.exportFailed"),
						lines: [errorMessageOf(error, tr)]
					});
				} finally {
					if (mountedRef.current) setBusy("");
				}
			}
			async function runImport(file) {
				if (busy !== "" || file === void 0 || file === null) return;
				if (file.size === 0) {
					setNotice({
						tone: "error",
						title: tr("panel.importFailed"),
						lines: [tr("error.empty")]
					});
					return;
				}
				setBusy("import");
				setNotice(null);
				try {
					const target = props.targetOf();
					const result = await props.importSelection(file, {
						filename: typeof file.name === "string" ? file.name : "session-kit.zip",
						restoreWorkspaceFiles,
						...target
					});
					await props.refreshSessions();
					const next = await props.loadCatalog();
					if (mountedRef.current) {
						setCatalog(next);
						setPhase("ready");
					}
					const ids = result.sessions.map((session) => session.sessionId).filter((id) => id !== "");
					const lines = [];
					if (ids.length > 0) lines.push(tr("panel.importSessionIds", { ids: ids.join(", ") }));
					const workspace = result.workspace !== void 0 && result.workspace !== null ? result.workspace : {
						restoredFiles: 0,
						restoredBytes: 0,
						skipped: [],
						skippedCount: 0,
						warnings: []
					};
					if (workspace.restoredFiles > 0) lines.push(tr("panel.workspaceRestored", {
						count: workspace.restoredFiles,
						size: formatBytes(workspace.restoredBytes)
					}));
					if (workspace.skippedCount > 0) {
						lines.push(tr("panel.workspaceSkipped", { count: workspace.skippedCount }));
						for (const detail of workspace.skipped.slice(0, 8)) lines.push(tr("panel.workspaceSkipLine", {
							path: detail.path === "" ? tr("panel.unknownPath") : detail.path,
							reason: detail.reason === "" ? tr("panel.unknownReason") : detail.reason
						}));
					}
					for (const warning of result.warnings) lines.push(warning);
					for (const session of result.sessions) for (const warning of session.warnings) lines.push(warning);
					if (result.sessions.some((session) => session.verified === false)) lines.push(tr("panel.importUnverified"));
					lines.push(tr("panel.openHint"));
					setNotice({
						tone: "success",
						title: tr("panel.importDone", { count: ids.length }),
						lines: capNoticeLines(lines, tr)
					});
					const alive = new Set(next.sessions.map((session) => session.id));
					setSelected((previous) => new Set([...previous].filter((id) => alive.has(id))));
				} catch (error) {
					setNotice({
						tone: "error",
						title: tr("panel.importFailed"),
						lines: [errorMessageOf(error, tr)]
					});
				} finally {
					if (mountedRef.current) setBusy("");
				}
			}
			function pickFile() {
				if (busy !== "") return;
				const input = fileInputRef.current;
				if (input !== null && input !== void 0 && typeof input.click === "function") input.click();
			}
			function onFileChange(event) {
				const file = event.target.files !== null && event.target.files.length > 0 ? event.target.files[0] : void 0;
				event.target.value = "";
				if (file !== void 0) runImport(file);
			}
			/** Import one DeepSeek share link/id as a new session. */
			async function runShareImport() {
				if (shareBusy) return;
				const input = shareInput.trim();
				if (input === "") {
					setShareResult({
						phase: "error",
						error: tr("panel.shareEmptyInput")
					});
					return;
				}
				setShareBusy(true);
				setShareResult({ phase: "busy" });
				try {
					const options = {};
					if (shareWorkspaceId !== "") options.workspaceId = shareWorkspaceId;
					else {
						const target = props.targetOf();
						if (target !== null && typeof target === "object" && typeof target.cwd === "string" && target.cwd !== "") options.cwd = target.cwd;
					}
					const title = shareTitle.trim();
					if (title !== "") options.title = title;
					const result = await props.importShare(input, options);
					await props.refreshSessions();
					const next = await props.loadCatalog();
					if (!mountedRef.current) return;
					setCatalog(next);
					setShareResult({
						phase: "success",
						...result
					});
				} catch (error) {
					if (!mountedRef.current) return;
					setShareResult({
						phase: "error",
						error: errorMessageOf(error, tr)
					});
				} finally {
					if (mountedRef.current) setShareBusy(false);
				}
			}
			/** Open the delete confirmation for the given session ids. */
			function requestDeleteConfirm(sessionIds) {
				const byId = new Map(catalog.sessions.map((session) => [session.id, session]));
				const titles = sessionIds.map((id) => {
					const session = byId.get(id);
					return session !== void 0 && session.title !== "" ? session.title : id;
				});
				setConfirmDelete({
					sessionIds: [...sessionIds],
					titles,
					removeFiles: false,
					permanent: false,
					preview: null,
					previewLoading: false,
					previewError: "",
					selectedFiles: /* @__PURE__ */ new Set()
				});
			}
			/** Load the derived file preview after the delete dialog's checkbox is checked. */
			async function toggleDeleteRemoveFiles(checked) {
				if (confirmDelete === null) return;
				const sessionIds = confirmDelete.sessionIds;
				if (!checked) {
					setConfirmDelete({
						...confirmDelete,
						removeFiles: false,
						preview: null,
						previewLoading: false,
						previewError: "",
						selectedFiles: /* @__PURE__ */ new Set()
					});
					return;
				}
				setConfirmDelete({
					...confirmDelete,
					removeFiles: true,
					preview: null,
					previewLoading: true,
					previewError: "",
					selectedFiles: /* @__PURE__ */ new Set()
				});
				try {
					const preview = await props.previewSessionFiles(sessionIds);
					if (!mountedRef.current) return;
					setConfirmDelete((current) => {
						if (current === null || current.removeFiles !== true || current.sessionIds.join("\0") !== sessionIds.join("\0")) return current;
						const selectedFiles = new Set(preview.files.filter((file) => file.weak !== true).map((file) => file.path));
						return {
							...current,
							preview,
							previewLoading: false,
							previewError: "",
							selectedFiles
						};
					});
				} catch (error) {
					if (!mountedRef.current) return;
					setConfirmDelete((current) => current === null || current.removeFiles !== true ? current : {
						...current,
						previewLoading: false,
						previewError: errorMessageOf(error, tr)
					});
				}
			}
			/** Toggle the permanent-delete option (off by default). */
			function toggleDeletePermanent(checked) {
				setConfirmDelete((current) => current === null ? current : {
					...current,
					permanent: checked
				});
			}
			/** Files of the open delete dialog grouped by the first session that referenced them. */
			function deleteFileGroups(state) {
				if (state.preview === null) return [];
				const byKey = /* @__PURE__ */ new Map();
				const titles = new Map(catalog.sessions.map((session) => [session.id, session.title !== "" ? session.title : session.id]));
				for (const file of state.preview.files) {
					const sessionId = file.sessionIds.length > 0 ? file.sessionIds[0] : "";
					const key = sessionId === "" ? "__unknown__" : sessionId;
					let group = byKey.get(key);
					if (group === void 0) {
						group = {
							key,
							sessionId,
							title: sessionId === "" ? tr("panel.unknownSessionGroup") : titles.get(sessionId) ?? sessionId,
							files: []
						};
						byKey.set(key, group);
					}
					group.files.push(file);
				}
				return [...byKey.values()];
			}
			function selectedFileObjects(state) {
				if (state.preview === null) return [];
				return state.preview.files.filter((file) => state.selectedFiles.has(file.path));
			}
			function fileSelectionTotals(state) {
				const files = selectedFileObjects(state);
				return {
					count: files.length,
					bytes: files.reduce((sum, file) => sum + file.bytes, 0)
				};
			}
			function toggleFileSelection(path) {
				setConfirmDelete((current) => {
					if (current === null) return current;
					const next = new Set(current.selectedFiles);
					if (next.has(path)) next.delete(path);
					else next.add(path);
					return {
						...current,
						selectedFiles: next
					};
				});
			}
			function setGroupFileSelection(group, on) {
				setConfirmDelete((current) => {
					if (current === null) return current;
					const next = new Set(current.selectedFiles);
					for (const file of group.files) if (on) next.add(file.path);
					else next.delete(file.path);
					return {
						...current,
						selectedFiles: next
					};
				});
			}
			/** Interactive per-session file selection shown under the delete dialog. */
			function deleteFileSelectionNode(state) {
				const lines = [tr("panel.fileSelectionExperimental")];
				if (state.previewLoading === true) lines.push(tr("panel.filesPreviewLoading"));
				if (state.previewError !== "") lines.push(tr("panel.filesPreviewFailed", { reason: state.previewError }));
				if (state.preview !== null) {
					const totals = fileSelectionTotals(state);
					lines.push(tr("panel.filesSelectedSummary", {
						count: totals.count,
						size: formatBytes(totals.bytes)
					}));
					if (state.preview.files.length === 0) lines.push(tr("panel.filesPreviewEmpty"));
					if (state.preview.files.length > 0 && state.selectedFiles.size === 0) lines.push(tr("panel.noFileSelected"));
					for (const warning of state.preview.warnings) lines.push(warning);
					if (state.preview.skipped.length > 0) lines.push(tr("panel.filesPreviewSkipped", { count: state.preview.skipped.length }));
				}
				lines.push(tr("panel.filesRiskBestEffort"), tr("panel.filesRiskShared"), tr("panel.filesRiskTrash"));
				const groups = deleteFileGroups(state);
				return h("div", { className: styles.fileSelection }, linesNode(lines), state.preview === null || groups.length === 0 ? null : groups.map((group) => h("div", {
					key: group.key,
					className: styles.fileGroup
				}, h("div", { className: styles.fileGroupHeader }, h("span", { className: styles.fileGroupTitle }, tr("panel.fileGroupTitle", {
					title: group.title,
					count: group.files.length
				})), h("button", {
					type: "button",
					style: {
						...buttonStyle("ghost", false),
						height: 24,
						padding: "0 8px",
						font: `12px/18px ${T.font}`
					},
					onClick: () => setGroupFileSelection(group, true)
				}, tr("panel.filesSelectAll")), h("button", {
					type: "button",
					style: {
						...buttonStyle("ghost", false),
						height: 24,
						padding: "0 8px",
						font: `12px/18px ${T.font}`
					},
					onClick: () => setGroupFileSelection(group, false)
				}, tr("panel.filesClear"))), group.files.map((file) => h("label", {
					key: file.path,
					className: styles.fileOption
				}, h("input", {
					type: "checkbox",
					checked: state.selectedFiles.has(file.path),
					onChange: () => toggleFileSelection(file.path)
				}), h("span", { className: styles.fileDetails }, h("span", { className: styles.filePath }, tr("panel.filesItem", {
					path: file.relative !== "" ? file.relative : file.path,
					size: formatBytes(file.bytes)
				})), file.weak ? h("span", { className: styles.fileWeak }, tr("panel.fileWeakHint")) : null, file.evidence.length > 0 ? h("span", { className: styles.fileEvidence }, tr("panel.fileEvidence", { evidence: file.evidence.join(", ").slice(0, 140) })) : null))))));
			}
			/** Everything the delete dialog shows below its controls. */
			function deleteDialogDetails(state) {
				const parts = [];
				if (state.permanent === true) parts.push(h("p", { className: styles.permanentRisk }, tr("panel.permanentRisk")));
				if (state.removeFiles === true) parts.push(deleteFileSelectionNode(state));
				if (parts.length === 0) return null;
				return h("div", { className: styles.dialogParts }, ...parts);
			}
			/** First delete confirm: delete directly, or open the files/permanent second dialog. */
			function handleDeleteConfirm() {
				if (confirmDelete === null || busy !== "") return;
				const state = confirmDelete;
				if (state.removeFiles === true) {
					if (state.previewLoading === true || state.preview === null) return;
					if (state.preview.files.length === 0 && state.permanent !== true) {
						setConfirmDelete(null);
						runAction("delete", state.sessionIds);
						return;
					}
					if (state.preview.files.length > 0 && state.selectedFiles.size === 0) return;
				}
				if (state.permanent !== true && state.removeFiles !== true) {
					runAction("delete", state.sessionIds);
					return;
				}
				const selected = state.removeFiles === true && state.preview !== null ? state.preview.files.filter((file) => state.selectedFiles.has(file.path)) : [];
				setConfirmDelete(null);
				setConfirmFiles({
					sessionIds: state.sessionIds,
					titles: state.titles,
					files: selected,
					skipped: state.preview === null ? [] : state.preview.skipped,
					warnings: state.preview === null ? [] : state.preview.warnings,
					totalBytes: selected.reduce((sum, file) => sum + file.bytes, 0),
					removeFiles: state.removeFiles === true && selected.length > 0,
					permanent: state.permanent === true
				});
			}
			/** Selected ids that the given management action can apply to. */
			function selectedForAction(action) {
				const byId = new Map(catalog.sessions.map((session) => [session.id, session]));
				return [...selected].filter((id) => {
					const session = byId.get(id);
					if (session === void 0) return false;
					if (action === "archive") return session.archived !== true;
					if (action === "unarchive") return session.archived === true;
					return true;
				});
			}
			/** Run one archive/unarchive/delete batch, refresh the list, report failures. */
			async function runAction(action, sessionIds, options) {
				if (busy !== "") return;
				if (sessionIds.length === 0) return;
				if (sessionIds.length > BATCH_LIMIT) {
					setNotice({
						tone: "error",
						title: tr("panel.actionFailed"),
						lines: [tr("panel.tooManySelected", { max: BATCH_LIMIT })]
					});
					return;
				}
				const removeFiles = action === "delete" && options !== void 0 && options !== null && options.removeFiles === true;
				const permanent = action === "delete" && options !== void 0 && options !== null && options.permanent === true;
				const selectedFiles = options !== void 0 && options !== null && Array.isArray(options.selectedFiles) ? options.selectedFiles.filter((path) => typeof path === "string") : [];
				setBusy(action);
				setNotice(null);
				try {
					const result = await props.manageSessions(action, sessionIds, {
						removeFiles,
						selectedFiles,
						permanent
					});
					const succeeded = result.results.filter((entry) => entry.ok).length;
					const failed = result.results.filter((entry) => !entry.ok);
					const files = result.files !== void 0 && result.files !== null ? result.files : {
						moved: 0,
						removed: 0,
						skipped: 0,
						bytes: 0,
						trashPath: "",
						warnings: [],
						permanent
					};
					const fileLines = [];
					if (removeFiles) {
						if (permanent) fileLines.push(tr("panel.filesRemoved", {
							count: files.removed,
							size: formatBytes(files.bytes)
						}));
						else fileLines.push(tr("panel.filesMoved", {
							count: files.moved,
							size: formatBytes(files.bytes)
						}));
						if (files.skipped > 0) fileLines.push(tr("panel.filesSkipped", { count: files.skipped }));
						if (!permanent && files.trashPath !== "") fileLines.push(tr("panel.filesTrashPath", { path: files.trashPath }));
						for (const warning of files.warnings) fileLines.push(warning);
					}
					if (permanent) fileLines.push(tr("panel.permanentNotice"));
					const next = await reload({ quiet: true });
					await props.refreshSessions();
					const aliveIds = next === void 0 ? [] : sessionIds.filter((id) => next.sessions.some((session) => session.id === id));
					if (aliveIds.length > 0) refreshDetailsFor(aliveIds);
					if (failed.length === 0) {
						const title = permanent ? tr("panel.permanentDone", { count: succeeded === 0 ? sessionIds.length : succeeded }) : tr(action === "archive" ? "panel.archiveDone" : action === "unarchive" ? "panel.unarchiveDone" : "panel.deleteDone", { count: succeeded === 0 ? sessionIds.length : succeeded });
						setNotice({
							tone: "success",
							title,
							lines: capNoticeLines(fileLines, tr)
						});
					} else {
						const lines = failed.map((failure) => tr("panel.actionFailureLine", {
							id: failure.sessionId === "" ? tr("panel.unknownPath") : failure.sessionId,
							reason: failure.error === "" ? tr("panel.actionUnknownReason") : failure.error
						}));
						setNotice({
							tone: "warn",
							title: tr("panel.actionPartialFailed", { count: failed.length }),
							lines: capNoticeLines([...lines, ...fileLines], tr)
						});
					}
				} catch (error) {
					setNotice({
						tone: "error",
						title: tr("panel.actionFailed"),
						lines: [errorMessageOf(error, tr)]
					});
				} finally {
					if (mountedRef.current) {
						setBusy("");
						setConfirmDelete(null);
						setConfirmFiles(null);
					}
				}
			}
			function batchArchive() {
				const ids = selectedForAction("archive");
				if (ids.length === 0) {
					setNotice({
						tone: "warn",
						title: tr("panel.archiveSelected"),
						lines: [tr("panel.noArchivable")]
					});
					return;
				}
				runAction("archive", ids);
			}
			function batchUnarchive() {
				const ids = selectedForAction("unarchive");
				if (ids.length === 0) {
					setNotice({
						tone: "warn",
						title: tr("panel.unarchiveSelected"),
						lines: [tr("panel.noUnarchivable")]
					});
					return;
				}
				runAction("unarchive", ids);
			}
			function batchDelete() {
				const ids = selectedForAction("delete");
				if (ids.length === 0) {
					setNotice({
						tone: "error",
						title: tr("panel.actionFailed"),
						lines: [tr("panel.noSelection")]
					});
					return;
				}
				requestDeleteConfirm(ids);
			}
			/** Open the format-migration confirmation for the given legacy session ids. */
			function requestMigrateConfirm(sessionIds) {
				if (sessionIds.length === 0) {
					setNotice({
						tone: "warn",
						title: tr("panel.upgradeLegacy"),
						lines: [tr("panel.migrateNoTarget")]
					});
					return;
				}
				if (sessionIds.length > MIGRATE_LIMIT) {
					setNotice({
						tone: "error",
						title: tr("panel.migrateFailed"),
						lines: [tr("panel.tooManyMigrate", { max: MIGRATE_LIMIT })]
					});
					return;
				}
				const byId = new Map(catalog.sessions.map((session) => [session.id, session]));
				const items = sessionIds.map((id) => {
					const session = byId.get(id);
					const title = session !== void 0 && session.title !== "" ? session.title : id;
					const version = session !== void 0 && session.storedVersion > 0 ? String(session.storedVersion) : "";
					return version === "" ? tr("panel.migrateItemPlain", { title }) : tr("panel.migrateItem", {
						title,
						version
					});
				});
				setConfirmMigrate({
					sessionIds: [...sessionIds],
					items
				});
			}
			/** Upgrade legacy sessions, refresh the list, and report per-id results. */
			async function runMigrate(sessionIds) {
				if (busy !== "") return;
				if (sessionIds.length === 0) return;
				setBusy("migrate");
				setNotice(null);
				try {
					const result = await props.migrateSessions(sessionIds);
					const succeeded = result.results.filter((entry) => entry.ok);
					const failed = result.results.filter((entry) => !entry.ok);
					const alreadyCurrent = succeeded.filter((entry) => entry.status === "current");
					const migrated = succeeded.filter((entry) => entry.status !== "current");
					const next = await reload({ quiet: true });
					await props.refreshSessions();
					const aliveIds = next === void 0 ? [] : sessionIds.filter((id) => next.sessions.some((session) => session.id === id));
					if (aliveIds.length > 0) refreshDetailsFor(aliveIds);
					const lines = [];
					for (const failure of failed) lines.push(tr("panel.migrateFailureLine", {
						id: failure.sessionId === "" ? tr("panel.unknownPath") : failure.sessionId,
						reason: failure.error === "" ? tr("panel.actionUnknownReason") : failure.error
					}));
					for (const success of migrated) lines.push(tr("panel.migrateSuccessLine", { id: success.sessionId }));
					for (const current of alreadyCurrent) lines.push(tr("panel.migrateCurrentLine", { id: current.sessionId }));
					if (result.legacyRemaining >= 0) lines.push(tr("panel.legacyRemaining", { count: result.legacyRemaining }));
					const migratedCount = result.migratedCount > 0 ? result.migratedCount : migrated.length;
					setNotice({
						tone: failed.length > 0 ? "warn" : "success",
						title: failed.length > 0 ? tr("panel.migratePartialFailed", { count: failed.length }) : migrated.length === 0 && alreadyCurrent.length > 0 ? tr("panel.migrateAlreadyCurrent", { count: alreadyCurrent.length }) : tr("panel.migrateDone", { count: migratedCount }),
						lines: capNoticeLines(lines, tr)
					});
				} catch (error) {
					setNotice({
						tone: "error",
						title: tr("panel.migrateFailed"),
						lines: [errorMessageOf(error, tr)]
					});
				} finally {
					if (mountedRef.current) {
						setBusy("");
						setConfirmMigrate(null);
					}
				}
			}
			function batchMigrate() {
				const ids = catalog.sessions.filter((session) => session.legacy === true).map((session) => session.id);
				if (ids.length === 0) {
					setNotice({
						tone: "warn",
						title: tr("panel.upgradeLegacy"),
						lines: [tr("panel.migrateNoTarget")]
					});
					return;
				}
				requestMigrateConfirm(ids);
			}
			const busyExport = busy === "export";
			const busyImport = busy === "import";
			const noticeTone = notice === null ? T.success : notice.tone === "error" ? T.error : notice.tone === "warn" ? T.warn : T.success;
			const header = h("div", { className: styles.headerRow }, h("div", { className: styles.headerMain }, h("h1", { className: styles.heading }, tr("panel.title")), h("p", { className: styles.subtitle }, tr("panel.subtitle"))), h("button", {
				type: "button",
				style: buttonStyle("ghost", false),
				onClick: () => {
					reload();
				},
				disabled: phase === "loading"
			}, tr("panel.refresh")));
			let body;
			if (phase === "loading") body = h("div", { className: styles.emptyCard }, tr("panel.loading"));
			else if (phase === "error") body = h("div", {
				className: styles.notice,
				style: { borderLeftColor: T.error },
				role: "alert"
			}, h("span", { className: styles.noticeTitle }, tr("panel.loadFailed")), h("span", { className: styles.noticeLine }, loadError), h("span", null, h("button", {
				type: "button",
				style: buttonStyle("secondary", false),
				onClick: () => {
					reload();
				}
			}, tr("panel.retry"))));
			else if (catalog.sessions.length === 0) body = h("div", { className: styles.emptyCard }, tr("panel.empty"));
			else if (groups.length === 0) body = h("div", { className: styles.emptyCard }, query.trim() !== "" ? tr("panel.emptyFilter") : statusFilter !== "all" ? tr("panel.emptyStatusFilter") : tr("panel.emptyFilter"));
			else body = groups.map((group) => {
				const state = groupSelection(group, selected);
				return h("div", {
					key: group.key === "" ? "ungrouped" : group.key,
					className: styles.group,
					role: "group",
					"aria-label": group.title
				}, h("div", { className: styles.groupHeader }, h("input", {
					type: "checkbox",
					checked: state.all,
					ref: (node) => {
						if (node !== null) node.indeterminate = state.some;
					},
					onChange: () => setMany(group.sessions.map((session) => session.id), !state.all),
					"aria-label": tr("panel.selectGroup", { title: group.title })
				}), h("span", { className: styles.groupTitle }, group.title), group.path === "" ? null : h("span", {
					className: styles.groupPath,
					title: group.path
				}, group.path), h("span", { className: styles.groupCount }, tr("panel.groupCount", { count: group.sessions.length }))), group.sessions.map((session) => {
					const checked = selected.has(session.id);
					const archived = session.archived === true;
					const rowBusy = busy !== "";
					const detail = details[session.id];
					const detailReady = detail !== void 0 && detail.phase === "ready";
					const detailOpen = openDetail === session.id;
					const meta = [];
					if (detailReady) meta.push(formatBytes(detail.sizeBytes));
					if (session.eventCount > 0) meta.push(tr("panel.events", { count: session.eventCount }));
					if (session.cwd !== "") meta.push(session.cwd);
					meta.push(session.id);
					const shortId = session.id.length > 26 ? `${session.id.slice(0, 12)}…${session.id.slice(-8)}` : session.id;
					const metaText = meta.length === 0 ? shortId : meta.join(" · ");
					const displayTitle = session.title !== "" ? session.title : tr("panel.untitled");
					let detailNode = null;
					if (detailOpen) {
						const detailLines = detail === void 0 || detail.phase === "loading" ? [tr("panel.detailLoading")] : detail.phase === "error" ? [tr("panel.detailFailed", { reason: detail.error })] : [
							tr("panel.detailSize", { size: formatBytes(detail.sizeBytes) }),
							tr("panel.detailFormat", { status: detail.legacy === true || detail.formatStatus === "migration-required" ? tr("panel.detailFormatLegacy") : detail.formatStatus === "" || detail.formatStatus === "current" ? tr("panel.detailFormatCurrent") : detail.formatStatus }),
							tr("panel.detailArchived", { status: detail.archived === true ? tr("panel.detailArchivedYes") : tr("panel.detailArchivedNo") }),
							...detail.filePreview === void 0 ? [detail.filePreviewError === "" ? tr("panel.detailFilesLoading") : tr("panel.detailFilesFailed", { reason: detail.filePreviewError })] : detail.filePreview.files.length === 0 ? [tr("panel.detailFilesNone")] : [
								tr("panel.detailFiles", {
									count: detail.filePreview.files.length,
									size: formatBytes(detail.filePreview.totalBytes)
								}),
								...detail.filePreview.files.slice(0, 5).map((file) => tr("panel.detailFileItem", {
									path: file.relative === "" ? file.path : file.relative,
									size: formatBytes(file.bytes),
									weak: file.weak === true ? tr("panel.detailFileWeak") : ""
								})),
								...detail.filePreview.files.length > 5 ? [tr("panel.filesPreviewMore", { count: detail.filePreview.files.length - 5 })] : []
							]
						];
						detailNode = h("div", {
							className: styles.rowDetail,
							"data-session-detail": session.id
						}, linesNode(detailLines));
					}
					return h("div", {
						key: session.id,
						className: styles.rowWrapper
					}, h("div", {
						className: styles.row,
						style: { opacity: archived ? .66 : 1 }
					}, h("div", { className: styles.rowMain }, h("input", {
						type: "checkbox",
						checked,
						className: styles.input,
						onChange: () => {
							toggleSession(session.id);
							loadSessionDetail(session.id);
						},
						"aria-label": tr("panel.selectSession", { title: displayTitle })
					}), h("button", {
						type: "button",
						className: styles.rowDetailToggle,
						onClick: () => toggleSessionDetail(session.id),
						"aria-expanded": detailOpen ? "true" : "false",
						"aria-label": detailOpen ? tr("panel.hideDetail", { title: displayTitle }) : tr("panel.showDetail", { title: displayTitle })
					}, h("span", { className: styles.rowText }, h("span", { className: styles.rowTitle }, session.running ? h("span", {
						className: styles.runningDot,
						"aria-hidden": "true"
					}) : null, displayTitle, session.running ? ` (${tr("panel.running")})` : "", h("span", { className: styles.badge + " " + (archived ? styles.badgeArchived : styles.badgeActive) }, archived ? tr("panel.statusBadgeArchived") : tr("panel.statusBadgeActive")), session.legacy ? h("span", { className: styles.badge + " " + styles.badgeLegacy }, session.storedVersion > 0 ? tr("panel.legacyBadge", { version: session.storedVersion }) : tr("panel.legacyBadgePlain")) : null), h("span", {
						className: styles.rowMeta,
						title: session.id
					}, metaText)))), h("span", { className: styles.rowActions }, session.legacy ? h("button", {
						type: "button",
						style: rowButtonStyle("secondary", rowBusy),
						disabled: rowBusy,
						onClick: () => requestMigrateConfirm([session.id])
					}, tr("panel.upgradeFormat")) : null, archived ? h("button", {
						type: "button",
						style: rowButtonStyle("ghost", rowBusy),
						disabled: rowBusy,
						onClick: () => {
							runAction("unarchive", [session.id]);
						}
					}, tr("panel.unarchive")) : h("button", {
						type: "button",
						style: rowButtonStyle("ghost", rowBusy),
						disabled: rowBusy,
						onClick: () => {
							runAction("archive", [session.id]);
						}
					}, tr("panel.archive")), h("button", {
						type: "button",
						style: rowButtonStyle("dangerGhost", rowBusy),
						disabled: rowBusy,
						onClick: () => requestDeleteConfirm([session.id])
					}, tr("panel.delete")))), detailNode);
				}));
			});
			const workspaceCount = catalog.workspaces.length;
			const statChip = (label, value) => h("span", { className: styles.statChip }, h("span", { className: styles.statLabel }, label), h("span", { className: styles.statValue }, String(value)));
			const statsRow = h("div", { className: styles.statsRow }, statChip(tr("panel.statSessions"), total), statChip(tr("panel.statWorkspaces"), workspaceCount), statChip(tr("panel.statArchived"), counts.archived), statChip(tr("panel.statLegacy"), legacyCount), h("span", { className: styles.statsSpacer }), h("button", {
				type: "button",
				style: buttonStyle("secondary", legacyCount === 0 || busy !== ""),
				disabled: legacyCount === 0 || busy !== "",
				onClick: batchMigrate,
				title: tr("panel.upgradeHint")
			}, tr("panel.upgradeLegacy")));
			const statusFilterRow = h("div", {
				className: styles.segmented,
				role: "group",
				"aria-label": tr("panel.statusFilter")
			}, h("button", {
				type: "button",
				className: styles.segment,
				"aria-pressed": statusFilter === "all" ? "true" : "false",
				onClick: () => setStatusFilter("all")
			}, tr("panel.statusAll"), h("span", { className: styles.segmentCount }, String(counts.all))), h("button", {
				type: "button",
				className: styles.segment,
				"aria-pressed": statusFilter === "active" ? "true" : "false",
				onClick: () => setStatusFilter("active")
			}, tr("panel.statusActive"), h("span", { className: styles.segmentCount }, String(counts.active))), h("button", {
				type: "button",
				className: styles.segment,
				"aria-pressed": statusFilter === "archived" ? "true" : "false",
				onClick: () => setStatusFilter("archived")
			}, tr("panel.statusArchived"), h("span", { className: styles.segmentCount }, String(counts.archived))));
			const searchRow = h("div", { className: styles.searchRow }, h("input", {
				type: "search",
				value: query,
				placeholder: tr("panel.search"),
				"aria-label": tr("panel.search"),
				onChange: (event) => setQuery(event.target.value),
				className: styles.search
			}), h("div", { className: styles.selectActions }, h("button", {
				type: "button",
				style: buttonStyle("secondary", allVisible.length === 0),
				disabled: allVisible.length === 0,
				onClick: () => setMany(allVisible, true)
			}, tr("panel.selectAll")), h("button", {
				type: "button",
				style: buttonStyle("secondary", allVisible.length === 0),
				disabled: allVisible.length === 0,
				onClick: () => setMany(allVisible, false)
			}, tr("panel.selectNone"))));
			const selectionBar = selectedCount === 0 ? null : h("div", {
				className: styles.selectionBar,
				role: "group",
				"aria-label": tr("panel.selectedCount", {
					selected: selectedCount,
					total
				})
			}, h("span", { className: styles.selectionInfo }, tr("panel.selectedCount", {
				selected: selectedCount,
				total
			})), h("div", { className: styles.selectionActions }, h("button", {
				type: "button",
				style: buttonStyle("primary", busy !== ""),
				disabled: busy !== "",
				onClick: () => {
					runExport();
				},
				"aria-busy": busyExport ? "true" : void 0
			}, busyExport ? tr("panel.exporting") : tr("panel.export")), h("button", {
				type: "button",
				style: buttonStyle("secondary", busy !== ""),
				disabled: busy !== "",
				onClick: batchArchive
			}, tr("panel.archive")), h("button", {
				type: "button",
				style: buttonStyle("secondary", busy !== ""),
				disabled: busy !== "",
				onClick: batchUnarchive
			}, tr("panel.unarchive")), h("button", {
				type: "button",
				style: buttonStyle("dangerGhost", busy !== ""),
				disabled: busy !== "",
				onClick: batchDelete
			}, tr("panel.delete"))));
			const sessionsPanel = h("section", {
				className: styles.sessionsPanel,
				"aria-label": tr("panel.title")
			}, h("div", { className: styles.sectionHeader }, h("h2", { className: styles.sectionTitle }, tr("panel.statSessions")), h("span", { className: styles.sectionMeta }, tr("panel.searchCount", {
				matched: matchedCount,
				total
			}))), h("div", { className: styles.sessionsToolbar }, searchRow, statusFilterRow), selectionBar, body);
			const checkRow = (checked, disabled, onChange, label, hint) => h("label", { className: styles.checkRow }, h("input", {
				type: "checkbox",
				checked,
				disabled,
				onChange
			}), h("span", { className: styles.checkText }, h("span", null, label), h("span", { className: styles.modeHint }, hint)));
			const modeGrid = h("div", { className: styles.modeGrid }, h("label", { className: mode === "compact" ? styles.modeCard + " " + styles.modeCardActive : styles.modeCard }, h("input", {
				type: "radio",
				name: "session-kit-export-mode",
				value: "compact",
				checked: mode === "compact",
				disabled: busy !== "",
				onChange: () => setMode("compact")
			}), h("span", { className: styles.modeCardText }, h("span", { className: styles.modeCardTitle }, tr("panel.modeCompact")), h("span", { className: styles.modeHint }, tr("panel.modeCompactHint")))), h("label", { className: mode === "full" ? styles.modeCard + " " + styles.modeCardActive : styles.modeCard }, h("input", {
				type: "radio",
				name: "session-kit-export-mode",
				value: "full",
				checked: mode === "full",
				disabled: busy !== "",
				onChange: () => setMode("full")
			}), h("span", { className: styles.modeCardText }, h("span", { className: styles.modeCardTitle }, tr("panel.modeFull")), h("span", { className: styles.modeHint }, tr("panel.modeFullHint")))));
			const exportOptions = h("div", {
				className: styles.exportOptions,
				role: "group",
				"aria-label": tr("panel.exportOptions")
			}, modeGrid, h("div", { className: styles.optionList }, checkRow(includeAttachments, busy !== "", (event) => setIncludeAttachments(event.target.checked), tr("panel.attachments"), tr("panel.attachmentsHint")), checkRow(includeWorkspaceFiles, busy !== "", (event) => setIncludeWorkspaceFiles(event.target.checked), tr("panel.workspaceFiles"), tr("panel.workspaceFilesHint")), checkRow(includeSubagents, busy !== "", (event) => setIncludeSubagents(event.target.checked), tr("panel.subagents"), tr("panel.subagentsHint"))));
			const exportPanel = h("div", { className: styles.toolCard }, h("div", { className: styles.toolCardHeader }, h("h3", { className: styles.toolCardTitle }, tr("panel.exportSection")), h("p", { className: styles.toolCardHint }, tr("panel.exportCardHint"))), exportOptions, h("p", { className: styles.toolCardStatus }, selectedCount === 0 ? tr("panel.exportNeedSelection") : tr("panel.exportReady", { count: selectedCount })), h("div", { className: styles.toolActions }, h("button", {
				type: "button",
				style: buttonStyle("primary", busy !== "" || selectedCount === 0),
				disabled: busy !== "" || selectedCount === 0,
				onClick: () => {
					runExport();
				},
				"aria-busy": busyExport ? "true" : void 0
			}, busyExport ? tr("panel.exporting") : tr("panel.export"))));
			const importOptions = h("div", {
				className: styles.optionList,
				role: "group",
				"aria-label": tr("panel.importOptions")
			}, checkRow(restoreWorkspaceFiles, busy !== "", (event) => setRestoreWorkspaceFiles(event.target.checked), tr("panel.restoreWorkspaceFiles"), tr("panel.restoreWorkspaceFilesHint")));
			const archivePanel = h("div", {
				className: styles.tabPanel,
				role: "tabpanel",
				id: "session-kit-tabpanel-archive",
				"aria-labelledby": "session-kit-tab-archive"
			}, importOptions, h("div", { className: styles.toolActions }, h("button", {
				type: "button",
				style: buttonStyle("secondary", busy !== ""),
				disabled: busy !== "",
				onClick: pickFile,
				"aria-busy": busyImport ? "true" : void 0
			}, busyImport ? tr("panel.importing") : tr("panel.import")), h("input", {
				ref: fileInputRef,
				type: "file",
				accept: ".zip,.jsonl,application/zip,application/jsonl,application/x-ndjson",
				className: styles.hiddenInput,
				onChange: onFileChange,
				"aria-hidden": "true",
				tabIndex: -1
			})), h("p", { className: styles.toolCardHint }, tr("panel.importHint")));
			const shareWorkspaceOptions = catalog.workspaces.filter((workspace) => workspace.workspaceId !== "").map((workspace) => h("option", {
				key: workspace.workspaceId,
				value: workspace.workspaceId
			}, workspace.title !== "" ? workspace.title + " · " + workspace.path : workspace.path));
			const shareResultNode = shareResult === null ? null : h("div", {
				className: styles.notice,
				style: { borderLeftColor: shareResult.phase === "error" ? T.error : T.success },
				role: shareResult.phase === "error" ? "alert" : "status",
				"aria-live": "polite"
			}, shareResult.phase === "error" ? [h("span", {
				key: "title",
				className: styles.noticeTitle
			}, tr("panel.shareFailed")), h("span", {
				key: "error",
				className: styles.noticeLine
			}, shareResult.error)] : shareResult.phase === "success" ? [
				h("span", {
					key: "title",
					className: styles.noticeTitle
				}, tr("panel.shareSuccess")),
				h("span", {
					key: "id",
					className: styles.noticeLine
				}, tr("panel.shareSessionId", { id: shareResult.sessionId })),
				shareResult.title !== "" ? h("span", {
					key: "session-title",
					className: styles.noticeLine
				}, shareResult.title) : null,
				h("span", {
					key: "count",
					className: styles.noticeLine
				}, tr("panel.shareEventCount", { count: shareResult.eventCount })),
				...shareResult.warnings.map((warning, index) => h("span", {
					key: "warning-" + index,
					className: styles.noticeLine
				}, warning))
			] : [h("span", {
				key: "busy",
				className: styles.noticeTitle
			}, tr("panel.shareImporting"))]);
			const sharePanel = h("div", {
				className: styles.tabPanel,
				role: "tabpanel",
				id: "session-kit-tabpanel-share",
				"aria-labelledby": "session-kit-tab-share"
			}, h("div", {
				className: styles.shareForm,
				role: "group",
				"aria-label": tr("panel.shareTitle")
			}, h("input", {
				type: "text",
				value: shareInput,
				placeholder: tr("panel.sharePlaceholder"),
				"aria-label": tr("panel.sharePlaceholder"),
				disabled: shareBusy,
				onChange: (event) => setShareInput(event.target.value),
				className: styles.search
			}), h("select", {
				value: shareWorkspaceId,
				disabled: shareBusy,
				"aria-label": tr("panel.shareWorkspace"),
				onChange: (event) => setShareWorkspaceId(event.target.value),
				className: styles.select
			}, h("option", { value: "" }, tr("panel.shareWorkspaceDefault")), ...shareWorkspaceOptions), h("input", {
				type: "text",
				value: shareTitle,
				placeholder: tr("panel.shareTitleLabel"),
				"aria-label": tr("panel.shareTitleLabel"),
				disabled: shareBusy,
				onChange: (event) => setShareTitle(event.target.value),
				className: styles.search
			}), h("button", {
				type: "button",
				style: buttonStyle("secondary", shareBusy),
				disabled: shareBusy,
				onClick: () => {
					runShareImport();
				},
				"aria-busy": shareBusy ? "true" : void 0
			}, shareBusy ? tr("panel.shareImporting") : tr("panel.shareImport"))), h("div", { className: styles.lines }, h("span", { className: styles.modeHint }, tr("panel.shareRiskPublic")), h("span", { className: styles.modeHint }, tr("panel.shareRiskNew"))), shareResultNode);
			const importTabButton = (id, label) => h("button", {
				type: "button",
				role: "tab",
				id: "session-kit-tab-" + id,
				"aria-selected": importTab === id ? "true" : "false",
				"aria-controls": "session-kit-tabpanel-" + id,
				tabIndex: importTab === id ? 0 : -1,
				className: styles.tab,
				onClick: () => setImportTab(id)
			}, label);
			const importPanel = h("div", { className: styles.toolCard }, h("div", { className: styles.toolCardHeader }, h("h3", { className: styles.toolCardTitle }, tr("panel.importSection")), h("p", { className: styles.toolCardHint }, tr("panel.importCardHint"))), h("div", {
				className: styles.tabs,
				role: "tablist",
				"aria-label": tr("panel.importSection")
			}, importTabButton("archive", tr("panel.tabArchive")), importTabButton("share", tr("panel.tabShare"))), importTab === "archive" ? archivePanel : sharePanel);
			const toolsPanel = h("aside", {
				className: styles.toolsPanel,
				"aria-label": tr("panel.tools")
			}, exportPanel, importPanel);
			const mainGrid = h("div", { className: styles.mainGrid }, sessionsPanel, toolsPanel);
			const noticeCard = notice === null ? null : h("div", {
				className: styles.notice,
				style: { borderLeftColor: noticeTone },
				role: notice.tone === "error" ? "alert" : "status",
				"aria-live": "polite"
			}, h("div", { className: styles.noticeHeader }, h("span", {
				className: styles.noticeTitle,
				style: { flex: "1 1 auto" }
			}, notice.title), h("button", {
				type: "button",
				style: {
					...buttonStyle("ghost", false),
					height: 24,
					padding: "0 8px"
				},
				onClick: () => setNotice(null),
				"aria-label": tr("panel.dismiss")
			}, "×")), notice.lines.map((line, index) => h("span", {
				key: `${index}-${line.slice(0, 12)}`,
				className: styles.noticeLine
			}, line)));
			const confirmDialog = confirmDelete === null ? null : confirmDialogNode({
				tr,
				title: tr("panel.confirmDeleteTitle"),
				body: tr("panel.confirmDeleteBody", { count: confirmDelete.sessionIds.length }),
				control: h("div", { className: styles.dialogParts }, h("label", { className: styles.modeLabel }, h("input", {
					type: "checkbox",
					checked: confirmDelete.removeFiles === true,
					disabled: busy !== "" || confirmDelete.previewLoading === true,
					onChange: (event) => {
						toggleDeleteRemoveFiles(event.target.checked);
					}
				}), h("span", null, tr("panel.removeFiles"), h("span", {
					className: styles.badge,
					style: {
						marginLeft: 6,
						color: T.warn,
						border: `1px solid ${T.border}`
					}
				}, tr("panel.experimental")), h("span", { className: styles.modeHint }, tr("panel.removeFilesHint")))), h("label", {
					className: styles.modeLabel,
					style: { color: T.error }
				}, h("input", {
					type: "checkbox",
					checked: confirmDelete.permanent === true,
					disabled: busy !== "",
					onChange: (event) => toggleDeletePermanent(event.target.checked)
				}), h("span", null, tr("panel.permanentDelete"), h("span", {
					className: styles.modeHint,
					style: { color: T.error }
				}, tr("panel.permanentRisk"))))),
				items: confirmDelete.titles,
				details: deleteDialogDetails(confirmDelete),
				moreKey: "panel.confirmMore",
				note: tr("panel.deleteNote"),
				confirmRole: "danger",
				confirmLabel: confirmDelete.permanent === true || confirmDelete.removeFiles === true && confirmDelete.preview !== null && confirmDelete.preview.files.length > 0 ? tr("panel.continue") : tr("panel.confirmDelete"),
				busyLabel: tr("panel.deleting"),
				busy: busy !== "",
				busyAction: busy === "delete",
				confirmDisabled: confirmDelete.removeFiles === true && (confirmDelete.previewLoading === true || confirmDelete.preview === null || confirmDelete.preview.files.length > 0 && confirmDelete.selectedFiles.size === 0),
				onCancel: () => setConfirmDelete(null),
				onConfirm: handleDeleteConfirm
			});
			const filesDialog = confirmFiles === null ? null : confirmDialogNode(confirmFiles.permanent === true ? {
				tr,
				title: tr("panel.confirmPermanentTitle"),
				body: confirmFiles.removeFiles === true && confirmFiles.files.length > 0 ? tr("panel.confirmPermanentWithFilesBody", {
					count: confirmFiles.sessionIds.length,
					files: confirmFiles.files.length,
					size: formatBytes(confirmFiles.totalBytes)
				}) : tr("panel.confirmPermanentBody", { count: confirmFiles.sessionIds.length }),
				items: [...confirmFiles.titles, ...confirmFiles.files.map((file) => tr("panel.filesItem", {
					path: file.relative !== "" ? file.relative : file.path,
					size: formatBytes(file.bytes)
				}))],
				details: linesNode([
					tr("panel.permanentRisk"),
					...confirmFiles.warnings,
					...confirmFiles.skipped.slice(0, 8).map((entry) => tr("panel.filesSkipLine", {
						path: entry.path === "" ? tr("panel.unknownPath") : entry.path,
						reason: entry.reason === "" ? tr("panel.unknownReason") : entry.reason
					}))
				]),
				moreKey: "panel.confirmMoreItems",
				note: "",
				danger: true,
				confirmRole: "danger",
				confirmLabel: tr("panel.confirmPermanent"),
				busyLabel: tr("panel.permanentDeleting"),
				busy: busy !== "",
				busyAction: busy === "delete",
				onCancel: () => setConfirmFiles(null),
				onConfirm: () => {
					runAction("delete", confirmFiles.sessionIds, {
						removeFiles: confirmFiles.removeFiles === true,
						selectedFiles: confirmFiles.files.map((file) => file.path),
						permanent: true
					});
				}
			} : {
				tr,
				title: tr("panel.confirmFilesTitle"),
				body: tr("panel.confirmFilesBody", {
					count: confirmFiles.sessionIds.length,
					files: confirmFiles.files.length,
					size: formatBytes(confirmFiles.totalBytes)
				}),
				items: confirmFiles.files.map((file) => tr("panel.filesItem", {
					path: file.relative !== "" ? file.relative : file.path,
					size: formatBytes(file.bytes)
				})),
				details: linesNode([
					...confirmFiles.warnings,
					...confirmFiles.skipped.slice(0, 8).map((entry) => tr("panel.filesSkipLine", {
						path: entry.path === "" ? tr("panel.unknownPath") : entry.path,
						reason: entry.reason === "" ? tr("panel.unknownReason") : entry.reason
					})),
					tr("panel.filesRiskBestEffort"),
					tr("panel.filesRiskShared"),
					tr("panel.filesRiskTrash")
				]),
				moreKey: "panel.filesMore",
				note: tr("panel.confirmFilesNote"),
				confirmRole: "danger",
				confirmLabel: tr("panel.confirmDeleteWithFiles"),
				busyLabel: tr("panel.deleting"),
				busy: busy !== "",
				busyAction: busy === "delete",
				onCancel: () => setConfirmFiles(null),
				onConfirm: () => {
					runAction("delete", confirmFiles.sessionIds, {
						removeFiles: true,
						selectedFiles: confirmFiles.files.map((file) => file.path)
					});
				}
			});
			const migrateDialog = confirmMigrate === null ? null : confirmDialogNode({
				tr,
				title: tr("panel.confirmMigrateTitle"),
				body: tr("panel.confirmMigrateBody", { count: confirmMigrate.sessionIds.length }),
				items: confirmMigrate.items,
				note: tr("panel.migrateNote"),
				confirmRole: "primary",
				confirmLabel: tr("panel.confirmMigrate"),
				busyLabel: tr("panel.migrating"),
				busy: busy !== "",
				busyAction: busy === "migrate",
				onCancel: () => setConfirmMigrate(null),
				onConfirm: () => {
					runMigrate(confirmMigrate.sessionIds);
				}
			});
			return h("div", { className: styles.page }, h("div", { className: styles.content }, header, statsRow, noticeCard, mainGrid, h("p", { className: styles.footnote }, tr("panel.importHint"))), confirmDialog, filesDialog, migrateDialog);
		}
		/** Read and normalize the workspace/session catalog. */
		async function loadCatalog() {
			return normalizeCatalog(await requestJson("/list"));
		}
		/** Upload one archive to the Host and return the normalized result. */
		async function importSelection(file, hints) {
			const params = new URLSearchParams();
			const filename = hints !== null && typeof hints === "object" ? pickString(hints.filename) : "";
			const cwd = hints !== null && typeof hints === "object" ? pickString(hints.cwd) : "";
			const workspaceId = hints !== null && typeof hints === "object" ? pickString(hints.workspaceId) : "";
			const restoreWorkspaceFiles = hints !== null && typeof hints === "object" && hints.restoreWorkspaceFiles === true;
			if (filename !== "") params.set("filename", filename);
			if (cwd !== "") params.set("cwd", cwd);
			if (workspaceId !== "") params.set("workspaceId", workspaceId);
			params.set("restoreWorkspaceFiles", restoreWorkspaceFiles ? "1" : "0");
			const query = params.toString();
			const response = await fetch(hostUrl(query === "" ? "/import" : `/import?${query}`), {
				method: "POST",
				headers: {
					"content-type": "application/octet-stream",
					accept: "application/json"
				},
				body: file
			});
			const payload = await jsonBody(response);
			if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) throw requestFailure(payload, response.status);
			return normalizeImportPayload(payload);
		}
		/** Import one DeepSeek share link/id as a new session. */
		async function importShareFromHost(input, options) {
			const requestBody = { input };
			if (options !== null && typeof options === "object") {
				const workspaceId = typeof options.workspaceId === "string" ? options.workspaceId.trim() : "";
				const cwd = typeof options.cwd === "string" ? options.cwd.trim() : "";
				const title = typeof options.title === "string" ? options.title.trim() : "";
				if (workspaceId !== "") requestBody.workspaceId = workspaceId;
				else if (cwd !== "") requestBody.cwd = cwd;
				if (title !== "") requestBody.title = title;
			}
			const response = await fetch(hostUrl("/import-share"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify(requestBody)
			});
			const payload = await jsonBody(response);
			if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) throw requestFailure(payload, response.status);
			return normalizeShareImport(payload);
		}
		/** Request one export archive and return its bytes plus headers. */
		async function exportSelection(request) {
			const response = await fetch(hostUrl("/export"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/zip"
				},
				body: JSON.stringify({
					sessionIds: request.sessionIds,
					mode: request.mode,
					includeAttachments: request.includeAttachments === true,
					includeWorkspaceFiles: request.includeWorkspaceFiles === true,
					includeSubagents: request.includeSubagents === true
				})
			});
			if (!response.ok) throw requestFailure(await jsonBody(response), response.status);
			const blob = await response.blob();
			const filename = filenameOf(response);
			return {
				blob,
				filename: filename === "" ? "session-kit-export.zip" : filename,
				warnings: warningsOf(response)
			};
		}
		/** Run one archive/unarchive/delete batch against the Host. */
		async function manageSelection(action, sessionIds, options) {
			if (action !== "archive" && action !== "unarchive" && action !== "delete") throw new Error(`session-kit: unsupported action ${String(action)}`);
			const requestBody = { sessionIds };
			if (action === "delete") {
				requestBody.confirm = true;
				if (options !== void 0 && options !== null && options.permanent === true) requestBody.permanent = true;
				if (options !== void 0 && options !== null && options.removeFiles === true) {
					requestBody.removeFiles = true;
					requestBody.selectedFiles = Array.isArray(options.selectedFiles) ? options.selectedFiles.filter((path) => typeof path === "string") : [];
				}
			}
			const response = await fetch(hostUrl(`/${action}`), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify(requestBody)
			});
			const payload = await jsonBody(response);
			const data = payload !== null && typeof payload === "object" && payload.data !== null && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
			if (data !== null && typeof data === "object" && Array.isArray(data.results)) return normalizeManagePayload(payload, sessionIds);
			if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) throw requestFailure(payload, response.status);
			return normalizeManagePayload(payload, sessionIds);
		}
		/** Preview the workspace files the Host would move for the given sessions. */
		async function previewSessionFiles(sessionIds) {
			const response = await fetch(hostUrl("/session-files"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify({ sessionIds })
			});
			const payload = await jsonBody(response);
			if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) throw requestFailure(payload, response.status);
			return normalizeFilePreview(payload);
		}
		/** Load storage details (size/format/archived) for the given sessions. */
		async function loadSessionDetails(sessionIds) {
			const response = await fetch(hostUrl("/session-detail"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify({ sessionIds })
			});
			const payload = await jsonBody(response);
			const data = payload !== null && typeof payload === "object" && payload.data !== null && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
			if (data !== null && typeof data === "object" && Array.isArray(data.sessions)) return normalizeSessionDetails(payload);
			if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) throw requestFailure(payload, response.status);
			return normalizeSessionDetails(payload);
		}
		/** Upgrade legacy sessions through the Host's official migration route. */
		async function migrateSelection(sessionIds) {
			const response = await fetch(hostUrl("/migrate"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify({
					sessionIds,
					confirm: true
				})
			});
			const payload = await jsonBody(response);
			const data = payload !== null && typeof payload === "object" && payload.data !== null && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
			if (data !== null && typeof data === "object" && Array.isArray(data.results)) return normalizeMigratePayload(payload, sessionIds);
			if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) throw requestFailure(payload, response.status);
			return normalizeMigratePayload(payload, sessionIds);
		}
		/** Refresh the client session catalog after an import. */
		async function refreshSessionList(ctx) {
			try {
				const sessions = ctx.get("sessions");
				if (sessions !== void 0 && sessions !== null && typeof sessions.refresh === "function") await sessions.refresh();
			} catch (error) {
				console.warn("session-kit: session list refresh failed:", error);
			}
		}
		/** Working directory and workspace the Host should attach an import to. */
		function importTargetOf(ctx) {
			try {
				const uiWorkspace = ctx.get("uiWorkspace");
				const selection = uiWorkspace !== void 0 ? uiWorkspace.selection?.getSnapshot?.() ?? {} : {};
				const currentId = typeof selection.sessionId === "string" ? selection.sessionId : void 0;
				const sessions = ctx.get("sessions")?.list?.getSnapshot?.();
				const workspaceList = ctx.get("workspaces")?.list?.getSnapshot?.();
				const items = Array.isArray(workspaceList?.items) ? workspaceList.items : [];
				if (currentId !== void 0) {
					const cwd = sessions?.byId?.[currentId]?.cwd;
					const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(currentId));
					return {
						...typeof cwd === "string" && cwd !== "" ? { cwd } : owner?.path !== void 0 ? { cwd: owner.path } : {},
						...owner?.workspaceId !== void 0 ? { workspaceId: owner.workspaceId } : {}
					};
				}
				const first = items.find((item) => typeof item.path === "string" && item.path !== "");
				return first === void 0 ? {} : {
					cwd: first.path,
					workspaceId: first.workspaceId
				};
			} catch {
				return {};
			}
		}
		/** Cordis client services this plugin cannot work without. */
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: dictionaries, the session-management main panel, and
		* the sidebar row that opens it.
		* @param {object} ctx - client root context.
		*/
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, {
					zh,
					en
				}), "session-kit: dictionaries");
			} catch (error) {
				console.warn("session-kit: dictionary registration failed:", error);
			}
			try {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: NS,
					inject: () => ({
						loadCatalog: () => loadCatalog(),
						exportSelection: (request) => exportSelection(request),
						importSelection: (file, hints) => importSelection(file, hints),
						importShare: (input, options) => importShareFromHost(input, options),
						manageSessions: (action, sessionIds, options) => manageSelection(action, sessionIds, options),
						previewSessionFiles: (sessionIds) => previewSessionFiles(sessionIds),
						loadSessionDetails: (sessionIds) => loadSessionDetails(sessionIds),
						migrateSessions: (sessionIds) => migrateSelection(sessionIds),
						refreshSessions: () => refreshSessionList(ctx),
						targetOf: () => importTargetOf(ctx)
					})
				}, SessionKitPanel));
			} catch (error) {
				console.warn("session-kit: main panel registration failed:", error);
			}
			try {
				const t = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : fallbackTranslate;
				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 6,
					locale: NS,
					label: () => t("panel.title")
				}, SessionKitIcon));
			} catch (error) {
				console.warn("session-kit: sidebar row registration failed:", error);
			}
		}
		const name = NS;
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map