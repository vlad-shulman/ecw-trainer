// ==UserScript==
// @name         ECW On-Demand Trainer
// @namespace    https://github.com/vlad-shulman/ecw-trainer
// @version      0.5.0
// @description  On-demand training overlay for eClinicalWorks
// @author       Vlad
// @match        *://flcahatrnapp.ecwcloud.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @connect      api.anthropic.com
// @updateURL    https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// @downloadURL  https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// ==/UserScript==

(function () {
    'use strict';

    const GITHUB_RAW  = 'https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main';
    const WORKFLOW_ID = 'merge-awv-template';

    let isActive     = false;
    let menuEl       = null;
    let debugMode    = GM_getValue('debug_mode', false);
    let lastSnapshot = null;
    let lastResult   = null;

    // ── API key ───────────────────────────────────────────────────────────────
    function getApiKey() {
        let key = GM_getValue('anthropic_api_key', '');
        if (!key) {
            key = prompt(
                'ECW Trainer: Enter your Anthropic API key.\n' +
                'It will be saved securely inside Tampermonkey and never shared.'
            );
            if (key) GM_setValue('anthropic_api_key', key.trim());
        }
        return key || null;
    }

    // ── DOM capture ───────────────────────────────────────────────────────────
    function capturePageContext() {
        const seen = new Map();

        function harvest(doc, dx, dy) {
            doc.querySelectorAll(
                'a, button, input, select, textarea, li, td, th, span, label, ' +
                '[role="tab"], [role="button"], [role="menuitem"], [role="option"]'
            ).forEach(el => {
                const raw = (el.textContent || el.value || el.placeholder || '')
                    .trim().replace(/\s+/g, ' ');
                if (!raw || raw.length < 2 || raw.length > 80) return;

                const r = el.getBoundingClientRect();
                if (r.width < 8 || r.height < 8)               return;
                if (r.top  < 0 || r.bottom > window.innerHeight) return;
                if (r.left < 0 || r.right  > window.innerWidth)  return;

                const area = r.width * r.height;
                const key  = raw.toLowerCase();
                if (!seen.has(key) || seen.get(key).area > area) {
                    seen.set(key, {
                        tag:  el.tagName.toLowerCase(),
                        text: raw,
                        role: el.getAttribute('role') || undefined,
                        rect: {
                            x: Math.round(r.left + dx), y: Math.round(r.top  + dy),
                            w: Math.round(r.width),     h: Math.round(r.height),
                        },
                        area,
                    });
                }
            });

            doc.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iDoc = iframe.contentDocument;
                    const ir   = iframe.getBoundingClientRect();
                    if (iDoc && ir.width > 0)
                        harvest(iDoc, Math.round(ir.left + dx), Math.round(ir.top + dy));
                } catch (_) {}
            });
        }

        harvest(document, 0, 0);

        const elements = [...seen.values()]
            .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
            .slice(0, 300)
            .map(({ area, ...el }) => el);

        const iframes = [...document.querySelectorAll('iframe')].map(f => {
            const r = f.getBoundingClientRect();
            return { src: f.src || '(inline)', w: Math.round(r.width), h: Math.round(r.height) };
        });

        return { viewport: { w: window.innerWidth, h: window.innerHeight }, iframes, elements };
    }

    // ── GitHub asset fetchers ─────────────────────────────────────────────────
    function fetchText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                onload:  r => resolve(r.responseText),
                onerror: () => reject(new Error('Failed to fetch: ' + url)),
            });
        });
    }

    function fetchImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'arraybuffer',
                onload: r => {
                    const bytes = new Uint8Array(r.response);
                    let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
                    resolve(btoa(bin));
                },
                onerror: () => reject(new Error('Failed to fetch image: ' + url)),
            });
        });
    }

    // ── Claude API ────────────────────────────────────────────────────────────
    function callClaude(apiKey, domSnapshot, workflowMd, refImageB64) {
        const systemPrompt =
            `You are a UI analysis assistant embedded in a healthcare training tool. ` +
            `You receive a structured DOM snapshot — a list of visible UI elements with ` +
            `their text and screen coordinates — captured from eClinicalWorks (ECW). ` +
            `Locate the requested element and return its exact coordinates from the snapshot. ` +
            `Always respond with valid JSON only — no markdown fences, no explanation outside the JSON.`;

        const userPrompt =
`## Task
Find the target element for Step 1 in the DOM snapshot below and return its screen coordinates.

## Workflow reference
${workflowMd}

## Live DOM snapshot
Viewport: ${domSnapshot.viewport.w} × ${domSnapshot.viewport.h} px
Iframes on page: ${domSnapshot.iframes.length} (${domSnapshot.iframes.map(f => f.src).join(', ') || 'none'})
Elements captured: ${domSnapshot.elements.length}

Element list — each entry has: tag, text, role (optional), rect {x, y, w, h} in screen pixels:
${JSON.stringify(domSnapshot.elements)}

## Instructions
Find the element whose text is "Templates" and that sits in a horizontal tab row alongside elements like "Overview", "Enc", "DRTLA", "History", "CDSS", "OS" in the right chart panel.

Return ONLY this JSON (no markdown fences):
{
  "found": true,
  "reasoning": "<2-4 sentences: describe what elements you see, how you identified the tab row, and which entry matched 'Templates'>",
  "target_description": "<one sentence describing the matched element and its position>",
  "hotspot": {
    "x": <rect.x from matched element>,
    "y": <rect.y from matched element>,
    "width": <rect.w from matched element>,
    "height": <rect.h from matched element>
  },
  "instruction": "Click the **Templates** tab in the right chart panel to show favorite templates."
}

If no "Templates" tab is found in a tab-row context, return:
{
  "found": false,
  "reasoning": "<what you see instead and why Templates was not found>",
  "reason": "<one sentence summary>"
}`;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url:    'https://api.anthropic.com/v1/messages',
                headers: {
                    'Content-Type':      'application/json',
                    'x-api-key':         apiKey,
                    'anthropic-version': '2023-06-01',
                },
                data: JSON.stringify({
                    model:      'claude-sonnet-4-6',
                    max_tokens: 1024,
                    system:     systemPrompt,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: refImageB64 } },
                            { type: 'text',  text: 'Above: reference screenshot showing what the ECW interface looks like for Step 1.' },
                            { type: 'text',  text: userPrompt },
                        ],
                    }],
                }),
                onload: r => {
                    try {
                        const body = JSON.parse(r.responseText);
                        if (body.error) { reject(new Error('Claude API error: ' + body.error.message)); return; }
                        let text = body.content[0].text.trim();
                        const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                        if (fence) text = fence[1].trim();
                        resolve(JSON.parse(text));
                    } catch (e) {
                        reject(new Error('Could not parse Claude response: ' + r.responseText.slice(0, 300)));
                    }
                },
                onerror: () => reject(new Error('Network error calling Claude API')),
            });
        });
    }

    // ── Styles ────────────────────────────────────────────────────────────────
    GM_addStyle(`
        /* ── Toggle switch ── */
        #ecw-trainer-toggle {
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            display: flex; align-items: center; gap: 10px;
            background: #ffffff; border-radius: 999px; padding: 6px 8px 6px 14px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2); cursor: pointer;
            font-family: Arial, sans-serif; font-size: 12px; color: #374151;
            user-select: none; pointer-events: auto; transition: box-shadow 0.15s;
        }
        #ecw-trainer-toggle:hover { box-shadow: 0 3px 12px rgba(0,0,0,0.28); }
        #ecw-trainer-switch {
            width: 36px; height: 20px; border-radius: 10px;
            background: #d1d5db; position: relative; flex-shrink: 0;
            transition: background 0.2s;
        }
        #ecw-trainer-switch.on { background: #1a56db; }
        #ecw-trainer-thumb {
            position: absolute; top: 2px; left: 2px;
            width: 16px; height: 16px; border-radius: 50%;
            background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            transition: transform 0.2s;
        }
        #ecw-trainer-switch.on #ecw-trainer-thumb { transform: translateX(16px); }

        /* ── Workflow menu ── */
        #ecw-workflow-menu {
            position: fixed; bottom: 52px; right: 20px; z-index: 999999;
            background: #ffffff; border: 1px solid #d1d5db; border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.15); font-family: Arial, sans-serif;
            font-size: 13px; overflow: hidden; min-width: 260px;
        }
        .ecw-menu-header {
            padding: 8px 16px; font-size: 11px; font-weight: bold; color: #6b7280;
            text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb;
        }
        .ecw-menu-item              { padding: 10px 16px; cursor: pointer; color: #111827; }
        .ecw-menu-item:hover        { background: #eff6ff; color: #1a56db; }
        .ecw-menu-divider           { border-top: 1px solid #e5e7eb; }
        .ecw-menu-item.ecw-muted    { color: #6b7280; }
        .ecw-menu-item.ecw-muted:hover    { background: #f9fafb; color: #374151; }
        .ecw-menu-item.ecw-debug-on       { color: #d97706; }
        .ecw-menu-item.ecw-debug-on:hover { background: #fffbeb; color: #b45309; }

        /* ── Status bar ── */
        #ecw-status {
            position: fixed; bottom: 56px; right: 20px; z-index: 999999;
            background: #1e3a8a; color: #bfdbfe; font-family: Arial, sans-serif;
            font-size: 12px; padding: 6px 14px; border-radius: 8px;
            pointer-events: none; white-space: nowrap;
        }

        /* ── Debug panel ── */
        #ecw-debug-panel {
            position: fixed; top: 0; right: 0; width: 380px; height: 100vh; z-index: 1000000;
            background: rgba(10,17,32,0.88); backdrop-filter: blur(6px); color: #e2e8f0;
            font-family: Arial, sans-serif; font-size: 13px; display: flex; flex-direction: column;
            box-shadow: -4px 0 24px rgba(0,0,0,0.4); transform: translateX(100%); transition: transform 0.3s ease;
        }
        #ecw-debug-panel.open { transform: translateX(0); }
        #ecw-debug-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 14px 16px; background: rgba(30,58,138,0.6);
            border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0;
        }
        #ecw-debug-header span { font-weight: bold; font-size: 14px; letter-spacing: 0.02em; color: #93c5fd; }
        #ecw-debug-close {
            background: transparent; border: 1px solid rgba(255,255,255,0.25);
            color: #94a3b8; font-size: 13px; padding: 3px 10px; border-radius: 4px; cursor: pointer;
        }
        #ecw-debug-close:hover { background: rgba(255,255,255,0.08); color: #e2e8f0; }
        #ecw-debug-body { flex: 1; overflow-y: auto; padding: 0 0 24px; }
        .ecw-debug-section        { border-bottom: 1px solid rgba(255,255,255,0.07); }
        .ecw-debug-section-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px 10px; font-size: 11px; font-weight: bold;
            text-transform: uppercase; letter-spacing: 0.08em; color: #60a5fa;
            cursor: pointer; user-select: none;
        }
        .ecw-debug-section-header:hover { color: #93c5fd; }
        .ecw-debug-chevron  { font-size: 10px; opacity: 0.7; }
        .ecw-debug-section-body { padding: 0 16px 16px; }
        .ecw-debug-reasoning { line-height: 1.6; color: #cbd5e1; }
        .ecw-debug-field        { margin-bottom: 10px; }
        .ecw-debug-label        {
            font-size: 10px; font-weight: bold; text-transform: uppercase;
            letter-spacing: 0.06em; color: #64748b; margin-bottom: 3px;
        }
        .ecw-debug-value        {
            color: #e2e8f0; background: rgba(255,255,255,0.05);
            border-radius: 4px; padding: 6px 10px; line-height: 1.5; word-break: break-word;
        }
        .ecw-debug-coords       { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .ecw-debug-coord-item   { background: rgba(255,255,255,0.05); border-radius: 4px; padding: 6px 10px; text-align: center; }
        .ecw-debug-coord-item .coord-label { font-size: 10px; color: #64748b; }
        .ecw-debug-coord-item .coord-val   { font-size: 15px; font-weight: bold; color: #60a5fa; }
        .ecw-debug-stat-row {
            display: flex; justify-content: space-between; padding: 4px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px;
        }
        .ecw-debug-stat-row:last-child { border-bottom: none; }
        .ecw-debug-stat-label { color: #64748b; }
        .ecw-debug-stat-val   { color: #93c5fd; font-weight: bold; }
        .ecw-debug-el-table   { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
        .ecw-debug-el-table th { text-align: left; color: #64748b; font-weight: bold; padding: 3px 4px; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .ecw-debug-el-table td { padding: 3px 4px; color: #cbd5e1; vertical-align: top; }
        .ecw-debug-el-table tr:hover td { background: rgba(255,255,255,0.04); }
        .ecw-debug-el-text { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* ── Custom hotspot tooltip ── */
        #ecw-hotspot-tooltip {
            position: fixed; z-index: 999995;
            background: #1a56db; color: #ffffff; border-radius: 12px;
            padding: 16px 18px; font-family: Arial, sans-serif; font-size: 13px;
            min-width: 280px; max-width: 380px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.35);
            pointer-events: none; overflow: visible;
        }
        .ecw-hs-step {
            color: rgba(255,255,255,0.7); font-size: 11px; font-weight: bold;
            text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
        }
        .ecw-hs-body  { font-size: 15px; line-height: 1.55; margin-bottom: 16px; }
        .ecw-hs-body strong { font-weight: bold; }
        .ecw-hs-footer { display: flex; gap: 8px; justify-content: flex-end; }
        #ecw-hs-dismiss {
            pointer-events: auto; cursor: pointer;
            background: transparent; color: rgba(255,255,255,0.85);
            border: 1px solid rgba(255,255,255,0.4); border-radius: 6px;
            font-family: Arial, sans-serif; font-size: 13px; padding: 6px 16px;
        }
        #ecw-hs-dismiss:hover { background: rgba(255,255,255,0.12); }
        #ecw-hs-next {
            pointer-events: auto; cursor: pointer;
            background: #ffffff; color: #1a56db; border: none; border-radius: 6px;
            font-family: Arial, sans-serif; font-size: 13px; font-weight: bold; padding: 6px 16px;
        }
        #ecw-hs-next:hover { background: #e0e7ff; }
    `);

    // ═══════════════════════════════════════════════════════════════════════════
    // renderHotspot — self-contained UI layer (custom SVG overlay).
    // To swap the overlay library, replace only this block — nothing else changes.
    //
    // Public API:
    //   renderHotspot(element, instructionText, stepNum, totalSteps, onNext, onDismiss)
    //   clearRenderHotspot()
    // ═══════════════════════════════════════════════════════════════════════════

    let _hotspotInstance = null;  // { overlayEl, tooltipEl }

    // Returns an element's position in main-document viewport coordinates.
    // Handles elements that live inside same-origin iframes.
    function getAbsoluteRect(element) {
        const rect = element.getBoundingClientRect();
        if (element.ownerDocument === document) return rect;
        for (const iframe of document.querySelectorAll('iframe')) {
            try {
                if (iframe.contentDocument === element.ownerDocument) {
                    const ir = iframe.getBoundingClientRect();
                    return new DOMRect(ir.left + rect.left, ir.top + rect.top, rect.width, rect.height);
                }
            } catch (_) {}
        }
        return rect;
    }

    // Finds the DOM element at (x, y) in main-document coordinates.
    // If the point falls inside an iframe, recursively queries inside it.
    function findElementAtPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== 'IFRAME') return el;
        const ir = el.getBoundingClientRect();
        try {
            const iDoc = el.contentDocument;
            if (iDoc) return iDoc.elementFromPoint(x - ir.left, y - ir.top) || el;
        } catch (_) {}
        return el;
    }

    function renderHotspot(element, instructionText, stepNum, totalSteps, onNext, onDismiss) {
        clearRenderHotspot();

        const html = instructionText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        const r    = getAbsoluteRect(element);
        const PAD  = 6;   // px padding around the spotlight rect
        const GAP  = 14;  // px gap between spotlight edge and tooltip
        const vw   = window.innerWidth;
        const vh   = window.innerHeight;

        // Pick the viewport side with the most space for the tooltip
        const side = [
            ['left',   r.left],
            ['right',  vw - r.right],
            ['top',    r.top],
            ['bottom', vh - r.bottom],
        ].reduce((a, b) => a[1] > b[1] ? a : b)[0];

        // ── SVG dimmed backdrop with evenodd spotlight cutout ─────────────────
        // pointer-events: none means the entire overlay — including the dim —
        // passes all mouse events through to ECW underneath.
        const sx = Math.round(r.left   - PAD);
        const sy = Math.round(r.top    - PAD);
        const sw = Math.round(r.width  + PAD * 2);
        const sh = Math.round(r.height + PAD * 2);

        const svgNS     = 'http://www.w3.org/2000/svg';
        const overlayEl = document.createElementNS(svgNS, 'svg');
        Object.assign(overlayEl.style, {
            position: 'fixed', top: '0', left: '0',
            width: '100%', height: '100%',
            zIndex: '999990', pointerEvents: 'none', overflow: 'visible',
        });

        const pathEl = document.createElementNS(svgNS, 'path');
        // Outer rect (full viewport) + inner rect (spotlight) with fill-rule evenodd
        // → inner area has even crossing count → transparent hole.
        pathEl.setAttribute('d',
            `M0,0 H${vw} V${vh} H0 Z ` +
            `M${sx},${sy} H${sx + sw} V${sy + sh} H${sx} Z`
        );
        pathEl.setAttribute('fill', 'rgba(0,0,0,0.55)');
        pathEl.setAttribute('fill-rule', 'evenodd');
        overlayEl.appendChild(pathEl);

        // ── Tooltip ───────────────────────────────────────────────────────────
        const tooltipEl = document.createElement('div');
        tooltipEl.id = 'ecw-hotspot-tooltip';
        tooltipEl.innerHTML =
            `<div class="ecw-hs-step">Step ${stepNum} / ${totalSteps}</div>` +
            `<div class="ecw-hs-body">${html}</div>` +
            `<div class="ecw-hs-footer">` +
                `<button id="ecw-hs-dismiss">Dismiss</button>` +
                `<button id="ecw-hs-next">Next →</button>` +
            `</div>`;

        document.body.appendChild(overlayEl);
        document.body.appendChild(tooltipEl);

        // Position tooltip + build arrow after first layout pass
        requestAnimationFrame(() => {
            const tw = tooltipEl.offsetWidth  || 300;
            const th = tooltipEl.offsetHeight || 120;
            let left, top;

            if (side === 'left') {
                left = r.left - PAD - GAP - tw;
                top  = r.top + r.height / 2 - th / 2;
            } else if (side === 'right') {
                left = r.right + PAD + GAP;
                top  = r.top + r.height / 2 - th / 2;
            } else if (side === 'bottom') {
                left = r.left + r.width / 2 - tw / 2;
                top  = r.bottom + PAD + GAP;
            } else {
                left = r.left + r.width / 2 - tw / 2;
                top  = r.top - PAD - GAP - th;
            }

            // Clamp to viewport with margin
            left = Math.max(8, Math.min(left, vw - tw - 8));
            top  = Math.max(8, Math.min(top,  vh - th - 8));

            tooltipEl.style.left = left + 'px';
            tooltipEl.style.top  = top  + 'px';

            // Arrow triangle pointing toward the spotlight element
            const arrowEl   = document.createElement('div');
            const arrowSize = 10;
            Object.assign(arrowEl.style, {
                position: 'absolute', width: '0', height: '0',
                border: arrowSize + 'px solid transparent',
                pointerEvents: 'none',
            });

            if (side === 'left' || side === 'right') {
                const cy       = r.top + r.height / 2;
                const arrowTop = Math.max(arrowSize + 4,
                    Math.min(Math.round(cy - top), th - arrowSize - 4));
                arrowEl.style.top       = arrowTop + 'px';
                arrowEl.style.transform = 'translateY(-50%)';
                if (side === 'left') {
                    // Tooltip is left of element → arrow on right edge, points right ▶
                    arrowEl.style.right            = (-arrowSize * 2) + 'px';
                    arrowEl.style.borderLeftColor  = '#1a56db';
                    arrowEl.style.borderRightWidth = '0';
                } else {
                    // Tooltip is right of element → arrow on left edge, points left ◀
                    arrowEl.style.left              = (-arrowSize * 2) + 'px';
                    arrowEl.style.borderRightColor  = '#1a56db';
                    arrowEl.style.borderLeftWidth   = '0';
                }
            } else {
                const cx        = r.left + r.width / 2;
                const arrowLeft = Math.max(arrowSize + 4,
                    Math.min(Math.round(cx - left), tw - arrowSize - 4));
                arrowEl.style.left      = arrowLeft + 'px';
                arrowEl.style.transform = 'translateX(-50%)';
                if (side === 'bottom') {
                    // Tooltip is below element → arrow on top edge, points up ▲
                    arrowEl.style.top              = (-arrowSize * 2) + 'px';
                    arrowEl.style.borderBottomColor = '#1a56db';
                    arrowEl.style.borderTopWidth   = '0';
                } else {
                    // Tooltip is above element → arrow on bottom edge, points down ▼
                    arrowEl.style.bottom            = (-arrowSize * 2) + 'px';
                    arrowEl.style.borderTopColor    = '#1a56db';
                    arrowEl.style.borderBottomWidth = '0';
                }
            }
            tooltipEl.appendChild(arrowEl);
        });

        // ── Button handlers ───────────────────────────────────────────────────
        function cleanup() {
            overlayEl.remove();
            tooltipEl.remove();
            _hotspotInstance = null;
        }

        tooltipEl.querySelector('#ecw-hs-dismiss').addEventListener('click', () => { cleanup(); onDismiss?.(); });
        tooltipEl.querySelector('#ecw-hs-next').addEventListener('click',    () => { cleanup(); onNext?.();    });

        _hotspotInstance = { overlayEl, tooltipEl };
    }

    function clearRenderHotspot() {
        if (_hotspotInstance) {
            _hotspotInstance.overlayEl?.remove();
            _hotspotInstance.tooltipEl?.remove();
            _hotspotInstance = null;
        }
        document.getElementById('ecw-hotspot-tooltip')?.remove();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // End renderHotspot block
    // ═══════════════════════════════════════════════════════════════════════════

    function clearOverlay() {
        clearRenderHotspot();
    }

    // Bridges Claude's coordinate response → DOM element → renderHotspot.
    // findElementAtPoint handles iframes; getAbsoluteRect corrects the proxy position.
    async function drawOverlay(result) {
        const { x, y, width, height } = result.hotspot;
        const element = findElementAtPoint(
            Math.round(x + width  / 2),
            Math.round(y + height / 2)
        );

        if (!element || element === document.documentElement || element === document.body) {
            showStatus('Could not locate element on screen — check the debug panel', 4000);
            return;
        }

        await renderHotspot(
            element,
            result.instruction,
            1, 3,
            () => showStatus('Step 2 coming soon!', 3000),
            () => {}
        );
    }

    function showStatus(msg, autoClearMs = 0) {
        document.getElementById('ecw-status')?.remove();
        const el = document.createElement('div');
        el.id = 'ecw-status'; el.textContent = msg;
        document.body.appendChild(el);
        if (autoClearMs) setTimeout(() => el.remove(), autoClearMs);
        return el;
    }

    // ── Debug panel ───────────────────────────────────────────────────────────
    function showDebugPanel(domSnapshot, result) {
        document.getElementById('ecw-debug-panel')?.remove();

        const { x, y, width, height } = result.found ? result.hotspot : {};
        const elRows = (domSnapshot.elements || []).slice(0, 30).map(el =>
            `<tr>
                <td class="ecw-debug-el-text" title="${el.text.replace(/"/g,'&quot;')}">${el.text}</td>
                <td>${el.tag}</td>
                <td>${el.rect.x},${el.rect.y}</td>
                <td>${el.rect.w}×${el.rect.h}</td>
            </tr>`
        ).join('');
        const iframeList = domSnapshot.iframes.length
            ? domSnapshot.iframes.map(f => `<div style="color:#94a3b8;font-size:11px;margin-bottom:3px">${f.src} (${f.w}×${f.h})</div>`).join('')
            : '<span style="color:#64748b">None detected</span>';

        const panel = document.createElement('div');
        panel.id = 'ecw-debug-panel';
        panel.innerHTML = `
            <div id="ecw-debug-header">
                <span>🔍 Debug Panel</span>
                <button id="ecw-debug-close">✕ Close</button>
            </div>
            <div id="ecw-debug-body">
                <div class="ecw-debug-section">
                    <div class="ecw-debug-section-header" data-target="ecw-dbg-context">
                        <span>Page Context</span><span class="ecw-debug-chevron">▼</span>
                    </div>
                    <div class="ecw-debug-section-body" id="ecw-dbg-context">
                        <div class="ecw-debug-stat-row"><span class="ecw-debug-stat-label">Viewport</span><span class="ecw-debug-stat-val">${domSnapshot.viewport.w} × ${domSnapshot.viewport.h} px</span></div>
                        <div class="ecw-debug-stat-row"><span class="ecw-debug-stat-label">Elements captured</span><span class="ecw-debug-stat-val">${domSnapshot.elements.length}</span></div>
                        <div class="ecw-debug-stat-row"><span class="ecw-debug-stat-label">Iframes on page</span><span class="ecw-debug-stat-val">${domSnapshot.iframes.length}</span></div>
                        <div style="margin-top:10px;margin-bottom:6px;">${iframeList}</div>
                        <table class="ecw-debug-el-table">
                            <thead><tr><th>Text</th><th>Tag</th><th>X,Y</th><th>Size</th></tr></thead>
                            <tbody>${elRows}</tbody>
                        </table>
                        ${domSnapshot.elements.length > 30 ? `<div style="color:#64748b;font-size:11px;margin-top:6px;">…and ${domSnapshot.elements.length - 30} more</div>` : ''}
                    </div>
                </div>
                <div class="ecw-debug-section">
                    <div class="ecw-debug-section-header" data-target="ecw-dbg-reasoning">
                        <span>Claude's Reasoning</span><span class="ecw-debug-chevron">▼</span>
                    </div>
                    <div class="ecw-debug-section-body" id="ecw-dbg-reasoning">
                        <div class="ecw-debug-reasoning">${result.reasoning || '<em style="color:#64748b">No reasoning returned.</em>'}</div>
                    </div>
                </div>
                <div class="ecw-debug-section">
                    <div class="ecw-debug-section-header" data-target="ecw-dbg-decision">
                        <span>Decision</span><span class="ecw-debug-chevron">▼</span>
                    </div>
                    <div class="ecw-debug-section-body" id="ecw-dbg-decision">
                        <div class="ecw-debug-field">
                            <div class="ecw-debug-label">Found</div>
                            <div class="ecw-debug-value">${result.found ? '✅ Yes' : '❌ No — ' + (result.reason || '')}</div>
                        </div>
                        ${result.found ? `
                        <div class="ecw-debug-field">
                            <div class="ecw-debug-label">Target Element</div>
                            <div class="ecw-debug-value">${result.target_description || '—'}</div>
                        </div>
                        <div class="ecw-debug-field">
                            <div class="ecw-debug-label">Hotspot Coordinates (screen px)</div>
                            <div class="ecw-debug-coords">
                                <div class="ecw-debug-coord-item"><div class="coord-label">X</div><div class="coord-val">${x}</div></div>
                                <div class="ecw-debug-coord-item"><div class="coord-label">Y</div><div class="coord-val">${y}</div></div>
                                <div class="ecw-debug-coord-item"><div class="coord-label">Width</div><div class="coord-val">${width}</div></div>
                                <div class="ecw-debug-coord-item"><div class="coord-label">Height</div><div class="coord-val">${height}</div></div>
                            </div>
                        </div>
                        <div class="ecw-debug-field">
                            <div class="ecw-debug-label">Instruction Text</div>
                            <div class="ecw-debug-value">${result.instruction}</div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        requestAnimationFrame(() => panel.classList.add('open'));

        document.getElementById('ecw-debug-close').addEventListener('click', () => {
            panel.classList.remove('open');
            setTimeout(() => panel.remove(), 300);
        });
        panel.querySelectorAll('.ecw-debug-section-header').forEach(header => {
            header.addEventListener('click', () => {
                const target  = document.getElementById(header.dataset.target);
                const chevron = header.querySelector('.ecw-debug-chevron');
                const isOpen  = target.style.display !== 'none';
                target.style.display = isOpen ? 'none' : '';
                chevron.textContent  = isOpen ? '▶' : '▼';
            });
        });
    }

    // ── Workflow runner ───────────────────────────────────────────────────────
    async function startMergeAWVWorkflow() {
        closeMenu();
        const apiKey = getApiKey();
        if (!apiKey) return;

        const statusEl = showStatus('Reading page...');

        try {
            const domSnapshot = capturePageContext();

            statusEl.textContent = 'Fetching workflow...';
            const [workflowMd, refImageB64] = await Promise.all([
                fetchText(`${GITHUB_RAW}/workflows/${WORKFLOW_ID}/workflow-merge-template.md`),
                fetchImageAsBase64(`${GITHUB_RAW}/workflows/${WORKFLOW_ID}/screenshots/step-1-templates-tab.png`),
            ]);

            statusEl.textContent = 'Asking Claude where to click...';
            const result = await callClaude(apiKey, domSnapshot, workflowMd, refImageB64);

            statusEl.remove();

            lastSnapshot = domSnapshot;
            lastResult   = result;

            if (!result.found) {
                alert('ECW Trainer: Could not find the Templates tab.\n\n' + (result.reason || ''));
                if (document.getElementById('ecw-debug-panel')?.classList.contains('open')) {
                    showDebugPanel(domSnapshot, result);
                }
                return;
            }

            await drawOverlay(result);
            if (document.getElementById('ecw-debug-panel')?.classList.contains('open')) {
                showDebugPanel(domSnapshot, result);
            }

        } catch (err) {
            statusEl.remove();
            console.error('[ECW Trainer]', err);
            alert('ECW Trainer error:\n' + err.message);
        }
    }

    // ── Toggle + menu ─────────────────────────────────────────────────────────
    function closeMenu() { menuEl?.remove(); menuEl = null; }

    function openMenu() {
        const debugLabel = debugMode ? '🔍 Debug Mode: ON' : '🔍 Debug Mode: OFF';
        const debugClass = debugMode ? 'ecw-debug-on' : 'ecw-muted';

        menuEl = document.createElement('div');
        menuEl.id = 'ecw-workflow-menu';
        menuEl.innerHTML = `
            <div class="ecw-menu-header">Select a Workflow</div>
            <div class="ecw-menu-item" id="ecw-menu-awv">Merge AWV Template into Progress Note</div>
            <div class="ecw-menu-divider">
                <div class="ecw-menu-item ${debugClass}" id="ecw-menu-debug">${debugLabel}</div>
                <div class="ecw-menu-item ecw-muted" id="ecw-menu-off">⚫ Turn Off Trainer</div>
            </div>
        `;
        document.body.appendChild(menuEl);

        document.getElementById('ecw-menu-awv').addEventListener('click', startMergeAWVWorkflow);
        document.getElementById('ecw-menu-debug').addEventListener('click', () => {
            debugMode = !debugMode;
            GM_setValue('debug_mode', debugMode);
            if (debugMode) {
                if (lastSnapshot && lastResult) showDebugPanel(lastSnapshot, lastResult);
            } else {
                const panel = document.getElementById('ecw-debug-panel');
                if (panel) { panel.classList.remove('open'); setTimeout(() => panel.remove(), 300); }
            }
            closeMenu(); openMenu();
        });
        document.getElementById('ecw-menu-off').addEventListener('click', () => {
            isActive = false; closeMenu(); clearOverlay(); updateToggle();
        });
    }

    // ── Toggle button ─────────────────────────────────────────────────────────
    const toggleBtn = document.createElement('div');
    toggleBtn.id = 'ecw-trainer-toggle';
    toggleBtn.innerHTML = '<span>ECW Trainer</span><div id="ecw-trainer-switch"><div id="ecw-trainer-thumb"></div></div>';

    function updateToggle() {
        toggleBtn.querySelector('#ecw-trainer-switch')?.classList.toggle('on', isActive);
    }

    toggleBtn.addEventListener('click', () => {
        if (!isActive) { isActive = true; updateToggle(); return; }
        menuEl ? closeMenu() : openMenu();
    });

    updateToggle();
    document.body.appendChild(toggleBtn);

})();
