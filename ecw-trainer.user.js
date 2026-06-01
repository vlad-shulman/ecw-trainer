// ==UserScript==
// @name         ECW On-Demand Trainer
// @namespace    https://github.com/vlad-shulman/ecw-trainer
// @version      0.1.9
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

    let isActive  = false;
    let menuEl    = null;
    let debugMode = GM_getValue('debug_mode', false);

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
    // Walks the document and all accessible same-origin iframes, collecting
    // every visible element with its text and getBoundingClientRect coordinates.
    // No screenshot, no external library — bypasses CSP entirely.
    function capturePageContext() {
        const seen = new Map(); // normalized text → smallest-area element entry

        function harvest(doc, dx, dy) {
            doc.querySelectorAll(
                'a, button, input, select, textarea, li, td, th, span, label, ' +
                '[role="tab"], [role="button"], [role="menuitem"], [role="option"]'
            ).forEach(el => {
                const raw = (el.textContent || el.value || el.placeholder || '')
                    .trim().replace(/\s+/g, ' ');
                if (!raw || raw.length < 2 || raw.length > 80) return;

                const r = el.getBoundingClientRect();
                if (r.width < 8 || r.height < 8)              return;
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
                            x: Math.round(r.left + dx),
                            y: Math.round(r.top  + dy),
                            w: Math.round(r.width),
                            h: Math.round(r.height),
                        },
                        area,
                    });
                }
            });

            // Recurse into same-origin iframes with adjusted coordinate offsets
            doc.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iDoc = iframe.contentDocument;
                    const ir   = iframe.getBoundingClientRect();
                    if (iDoc && ir.width > 0) {
                        harvest(iDoc, Math.round(ir.left + dx), Math.round(ir.top + dy));
                    }
                } catch (_) { /* cross-origin — skip */ }
            });
        }

        harvest(document, 0, 0);

        const elements = [...seen.values()]
            .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
            .slice(0, 300)
            .map(({ area, ...el }) => el); // strip internal area field

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
                method:  'GET',
                url,
                onload:  r => resolve(r.responseText),
                onerror: () => reject(new Error('Failed to fetch: ' + url)),
            });
        });
    }

    function fetchImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method:       'GET',
                url,
                responseType: 'arraybuffer',
                onload: r => {
                    const bytes = new Uint8Array(r.response);
                    let binary  = '';
                    bytes.forEach(b => binary += String.fromCharCode(b));
                    resolve(btoa(binary));
                },
                onerror: () => reject(new Error('Failed to fetch image: ' + url)),
            });
        });
    }

    // ── Claude API ────────────────────────────────────────────────────────────
    // Sends DOM snapshot (text) + reference PNG (image) to Claude.
    // Coordinates in the snapshot come directly from getBoundingClientRect —
    // no scaling needed; Claude returns them as-is for overlay positioning.
    function callClaude(apiKey, domSnapshot, workflowMd, refImageB64) {
        const systemPrompt =
            `You are a UI analysis assistant embedded in a healthcare training tool. ` +
            `You receive a structured DOM snapshot — a list of visible UI elements with ` +
            `their text and screen coordinates — captured from eClinicalWorks (ECW). ` +
            `Locate the requested element and return its exact coordinates from the snapshot. ` +
            `Always respond with valid JSON only — no markdown fences, no explanation outside the JSON.`;

        const elementsJson = JSON.stringify(domSnapshot.elements);

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
${elementsJson}

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
                            {
                                type:   'image',
                                source: { type: 'base64', media_type: 'image/png', data: refImageB64 },
                            },
                            {
                                type: 'text',
                                text: 'Above: reference screenshot showing what the ECW interface looks like for Step 1.',
                            },
                            { type: 'text', text: userPrompt },
                        ],
                    }],
                }),
                onload: r => {
                    try {
                        const body = JSON.parse(r.responseText);
                        if (body.error) {
                            reject(new Error('Claude API error: ' + body.error.message));
                            return;
                        }
                        const text = body.content[0].text.trim();
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
        @keyframes ecw-pulse {
            0%   { box-shadow: 0 0 0 0    rgba(37,99,235,0.75); }
            70%  { box-shadow: 0 0 0 14px rgba(37,99,235,0);    }
            100% { box-shadow: 0 0 0 0    rgba(37,99,235,0);    }
        }

        #ecw-hotspot-ring {
            position:       fixed;
            border:         3px solid #2563eb;
            border-radius:  6px;
            animation:      ecw-pulse 1.4s ease-out infinite;
            pointer-events: none;
            z-index:        999997;
            box-sizing:     border-box;
        }

        #ecw-instruction-box {
            position:      fixed;
            bottom:        24px;
            left:          50%;
            transform:     translateX(-50%);
            z-index:       999998;
            background:    #1a56db;
            color:         #ffffff;
            font-family:   Arial, sans-serif;
            font-size:     15px;
            line-height:   1.55;
            padding:       18px 24px 14px;
            border-radius: 12px;
            box-shadow:    0 6px 24px rgba(0,0,0,0.3);
            max-width:     540px;
            width:         max-content;
            pointer-events: auto;
        }
        #ecw-instruction-box .ecw-body   { margin-bottom: 14px; }
        #ecw-instruction-box strong       { font-weight: bold; }
        #ecw-instruction-box em           { font-style: italic; }
        #ecw-instruction-box .ecw-footer  {
            display:         flex;
            justify-content: space-between;
            align-items:     center;
            font-size:       12px;
            opacity:         0.9;
        }
        #ecw-instruction-box .ecw-btn-next {
            background:    #ffffff;
            color:         #1a56db;
            border:        none;
            padding:       5px 16px;
            border-radius: 6px;
            font-size:     13px;
            font-weight:   bold;
            cursor:        pointer;
        }
        #ecw-instruction-box .ecw-btn-dismiss {
            background:      transparent;
            color:           rgba(255,255,255,0.75);
            border:          none;
            font-size:       12px;
            cursor:          pointer;
            text-decoration: underline;
            margin-right:    12px;
        }

        /* ── Toggle button ── */
        #ecw-trainer-toggle {
            position:       fixed;
            bottom:         20px;
            right:          20px;
            z-index:        999999;
            font-family:    Arial, sans-serif;
            font-size:      12px;
            padding:        6px 14px;
            border-radius:  999px;
            border:         none;
            cursor:         pointer;
            box-shadow:     0 2px 8px rgba(0,0,0,0.2);
            opacity:        0.75;
            transition:     opacity 0.2s, background 0.2s;
            pointer-events: auto;
            white-space:    nowrap;
        }
        #ecw-trainer-toggle:hover { opacity: 1; }
        #ecw-trainer-toggle.on    { background: #1a56db; color: #ffffff; }
        #ecw-trainer-toggle.off   { background: #6b7280; color: #e5e7eb; }

        /* ── Workflow menu ── */
        #ecw-workflow-menu {
            position:      fixed;
            bottom:        52px;
            right:         20px;
            z-index:       999999;
            background:    #ffffff;
            border:        1px solid #d1d5db;
            border-radius: 8px;
            box-shadow:    0 4px 16px rgba(0,0,0,0.15);
            font-family:   Arial, sans-serif;
            font-size:     13px;
            overflow:      hidden;
            min-width:     260px;
        }
        .ecw-menu-header {
            padding:        8px 16px;
            font-size:      11px;
            font-weight:    bold;
            color:          #6b7280;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom:  1px solid #e5e7eb;
        }
        .ecw-menu-item              { padding: 10px 16px; cursor: pointer; color: #111827; }
        .ecw-menu-item:hover        { background: #eff6ff; color: #1a56db; }
        .ecw-menu-divider           { border-top: 1px solid #e5e7eb; }
        .ecw-menu-item.ecw-muted    { color: #6b7280; }
        .ecw-menu-item.ecw-muted:hover     { background: #f9fafb; color: #374151; }
        .ecw-menu-item.ecw-debug-on        { color: #d97706; }
        .ecw-menu-item.ecw-debug-on:hover  { background: #fffbeb; color: #b45309; }

        /* ── Status bar ── */
        #ecw-status {
            position:       fixed;
            bottom:         56px;
            right:          20px;
            z-index:        999999;
            background:     #1e3a8a;
            color:          #bfdbfe;
            font-family:    Arial, sans-serif;
            font-size:      12px;
            padding:        6px 14px;
            border-radius:  8px;
            pointer-events: none;
            white-space:    nowrap;
        }

        /* ── Debug panel ── */
        #ecw-debug-panel {
            position:        fixed;
            top:             0;
            right:           0;
            width:           380px;
            height:          100vh;
            z-index:         1000000;
            background:      rgba(10, 17, 32, 0.88);
            backdrop-filter: blur(6px);
            color:           #e2e8f0;
            font-family:     Arial, sans-serif;
            font-size:       13px;
            display:         flex;
            flex-direction:  column;
            box-shadow:      -4px 0 24px rgba(0,0,0,0.4);
            transform:       translateX(100%);
            transition:      transform 0.3s ease;
        }
        #ecw-debug-panel.open { transform: translateX(0); }

        #ecw-debug-header {
            display:         flex;
            align-items:     center;
            justify-content: space-between;
            padding:         14px 16px;
            background:      rgba(30, 58, 138, 0.6);
            border-bottom:   1px solid rgba(255,255,255,0.1);
            flex-shrink:     0;
        }
        #ecw-debug-header span {
            font-weight: bold; font-size: 14px; letter-spacing: 0.02em; color: #93c5fd;
        }
        #ecw-debug-close {
            background: transparent; border: 1px solid rgba(255,255,255,0.25);
            color: #94a3b8; font-size: 13px; padding: 3px 10px;
            border-radius: 4px; cursor: pointer;
        }
        #ecw-debug-close:hover { background: rgba(255,255,255,0.08); color: #e2e8f0; }

        #ecw-debug-body { flex: 1; overflow-y: auto; padding: 0 0 24px; }

        .ecw-debug-section        { border-bottom: 1px solid rgba(255,255,255,0.07); }
        .ecw-debug-section-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px 10px; font-size: 11px; font-weight: bold;
            text-transform: uppercase; letter-spacing: 0.08em;
            color: #60a5fa; cursor: pointer; user-select: none;
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
        .ecw-debug-coord-item   {
            background: rgba(255,255,255,0.05); border-radius: 4px;
            padding: 6px 10px; text-align: center;
        }
        .ecw-debug-coord-item .coord-label { font-size: 10px; color: #64748b; }
        .ecw-debug-coord-item .coord-val   { font-size: 15px; font-weight: bold; color: #60a5fa; }

        .ecw-debug-stat-row {
            display: flex; justify-content: space-between;
            padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
            font-size: 12px;
        }
        .ecw-debug-stat-row:last-child { border-bottom: none; }
        .ecw-debug-stat-label { color: #64748b; }
        .ecw-debug-stat-val   { color: #93c5fd; font-weight: bold; }

        .ecw-debug-el-table {
            width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px;
        }
        .ecw-debug-el-table th {
            text-align: left; color: #64748b; font-weight: bold; padding: 3px 4px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .ecw-debug-el-table td { padding: 3px 4px; color: #cbd5e1; vertical-align: top; }
        .ecw-debug-el-table tr:hover td { background: rgba(255,255,255,0.04); }
        .ecw-debug-el-text { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `);

    // ── Overlay helpers ───────────────────────────────────────────────────────
    function renderMarkdown(text) {
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g,     '<em>$1</em>');
    }

    function clearOverlay() {
        document.getElementById('ecw-hotspot-ring')?.remove();
        document.getElementById('ecw-instruction-box')?.remove();
    }

    function drawOverlay(result) {
        clearOverlay();

        // Coordinates come directly from getBoundingClientRect via capturePageContext —
        // they are already in CSS screen pixels, no scaling required.
        const { x, y, width, height } = result.hotspot;

        const ring = document.createElement('div');
        ring.id = 'ecw-hotspot-ring';
        Object.assign(ring.style, {
            left:   x      + 'px',
            top:    y      + 'px',
            width:  width  + 'px',
            height: height + 'px',
        });
        document.body.appendChild(ring);

        const box = document.createElement('div');
        box.id = 'ecw-instruction-box';
        box.innerHTML = `
            <div class="ecw-body">${renderMarkdown(result.instruction)}</div>
            <div class="ecw-footer">
                <span>Step 1 / 3</span>
                <div>
                    <button class="ecw-btn-dismiss" id="ecw-dismiss">Dismiss</button>
                    <button class="ecw-btn-next"    id="ecw-next">Next →</button>
                </div>
            </div>
        `;
        document.body.appendChild(box);

        document.getElementById('ecw-dismiss').addEventListener('click', clearOverlay);
        document.getElementById('ecw-next').addEventListener('click', () => {
            clearOverlay();
            showStatus('Step 2 coming soon!', 3000);
        });
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

        // Show first 30 captured elements in a table for inspection
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
                        <span>Page Context</span>
                        <span class="ecw-debug-chevron">▼</span>
                    </div>
                    <div class="ecw-debug-section-body" id="ecw-dbg-context">
                        <div class="ecw-debug-stat-row">
                            <span class="ecw-debug-stat-label">Viewport</span>
                            <span class="ecw-debug-stat-val">${domSnapshot.viewport.w} × ${domSnapshot.viewport.h} px</span>
                        </div>
                        <div class="ecw-debug-stat-row">
                            <span class="ecw-debug-stat-label">Elements captured</span>
                            <span class="ecw-debug-stat-val">${domSnapshot.elements.length}</span>
                        </div>
                        <div class="ecw-debug-stat-row">
                            <span class="ecw-debug-stat-label">Iframes on page</span>
                            <span class="ecw-debug-stat-val">${domSnapshot.iframes.length}</span>
                        </div>
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
                        <span>Claude's Reasoning</span>
                        <span class="ecw-debug-chevron">▼</span>
                    </div>
                    <div class="ecw-debug-section-body" id="ecw-dbg-reasoning">
                        <div class="ecw-debug-reasoning">${result.reasoning || '<em style="color:#64748b">No reasoning returned.</em>'}</div>
                    </div>
                </div>

                <div class="ecw-debug-section">
                    <div class="ecw-debug-section-header" data-target="ecw-dbg-decision">
                        <span>Decision</span>
                        <span class="ecw-debug-chevron">▼</span>
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
            // DOM capture is synchronous — no library load needed
            const domSnapshot = capturePageContext();

            statusEl.textContent = 'Fetching workflow...';
            const [workflowMd, refImageB64] = await Promise.all([
                fetchText(`${GITHUB_RAW}/workflows/${WORKFLOW_ID}/workflow-merge-template.md`),
                fetchImageAsBase64(`${GITHUB_RAW}/workflows/${WORKFLOW_ID}/screenshots/step-1-templates-tab.png`),
            ]);

            statusEl.textContent = 'Asking Claude where to click...';
            const result = await callClaude(apiKey, domSnapshot, workflowMd, refImageB64);

            statusEl.remove();

            if (!result.found) {
                alert('ECW Trainer: Could not find the Templates tab.\n\n' + (result.reason || ''));
                if (debugMode) showDebugPanel(domSnapshot, result);
                return;
            }

            drawOverlay(result);
            if (debugMode) showDebugPanel(domSnapshot, result);

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
            closeMenu(); openMenu();
        });
        document.getElementById('ecw-menu-off').addEventListener('click', () => {
            isActive = false; closeMenu(); clearOverlay(); updateToggle();
        });
    }

    // ── Toggle button ─────────────────────────────────────────────────────────
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ecw-trainer-toggle';

    function updateToggle() {
        toggleBtn.textContent = isActive ? '🟢 ECW Trainer — ON' : '⚫ ECW Trainer — OFF';
        toggleBtn.className   = isActive ? 'on' : 'off';
    }

    toggleBtn.addEventListener('click', () => {
        if (!isActive) { isActive = true; updateToggle(); return; }
        menuEl ? closeMenu() : openMenu();
    });

    updateToggle();
    document.body.appendChild(toggleBtn);

})();
