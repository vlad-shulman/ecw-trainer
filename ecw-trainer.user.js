// ==UserScript==
// @name         ECW On-Demand Trainer
// @namespace    https://github.com/vlad-shulman/ecw-trainer
// @version      0.1.5
// @description  On-demand training overlay for eClinicalWorks
// @author       Vlad
// @match        *://flcahatrnapp.ecwcloud.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @connect      raw.githubusercontent.com
// @connect      api.anthropic.com
// @updateURL    https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// @downloadURL  https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// ==/UserScript==

(function () {
    'use strict';

    const GITHUB_RAW  = 'https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main';
    const WORKFLOW_ID = 'merge-awv-template';
    const SCREENSHOT_SCALE = 0.75; // reduces image size sent to Claude

    let isActive = true;
    let menuEl   = null;

    // ── API key ───────────────────────────────────────────────────────────────
    // Stored in Tampermonkey's secure storage — never in the script itself.
    // User is prompted once on first use.
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

    // ── Screenshot ────────────────────────────────────────────────────────────
    async function captureScreenshot() {
        const canvas = await html2canvas(document.documentElement, {
            useCORS:     true,
            allowTaint:  true,
            scale:       SCREENSHOT_SCALE,
            logging:     false,
            windowWidth:  window.innerWidth,
            windowHeight: window.innerHeight,
        });
        // JPEG at 85% quality keeps file size manageable
        return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
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
    function callClaude(apiKey, screenshotB64, workflowMd, refImageB64) {
        const systemPrompt = `You are a UI analysis assistant embedded in a healthcare training tool.
Your job is to locate specific UI elements in screenshots of eClinicalWorks (ECW) and return their exact pixel coordinates.
Always respond with valid JSON only — no markdown, no explanation.`;

        const userPrompt = `## Task
Locate the target element for Step 1 of the workflow described below and return its pixel coordinates in the live screenshot.

## Workflow reference
${workflowMd}

## Instructions
1. The first image is a reference screenshot showing what Step 1 looks like (what you are trying to find).
2. The second image is the provider's live ECW screen taken just now.

Find the **Templates** tab in the horizontal tab row in the upper-right chart panel of the live screenshot.

Return ONLY this JSON (no markdown fences):
{
  "found": true,
  "hotspot": {
    "x": <integer — left edge of the Templates tab, in pixels from left of screenshot>,
    "y": <integer — top edge of the Templates tab, in pixels from top of screenshot>,
    "width": <integer — width of the tab in pixels>,
    "height": <integer — height of the tab in pixels>
  },
  "instruction": "Click the **Templates** tab in the right chart panel to show favorite templates."
}

If the Templates tab is not visible on screen, return:
{ "found": false, "reason": "<one sentence explanation>" }`;

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
                    max_tokens: 512,
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
                                text: 'Above: reference screenshot of Step 1. Below: live provider screen.',
                            },
                            {
                                type:   'image',
                                source: { type: 'base64', media_type: 'image/jpeg', data: screenshotB64 },
                            },
                            { type: 'text', text: userPrompt },
                        ],
                    }],
                }),
                onload: r => {
                    try {
                        const body   = JSON.parse(r.responseText);
                        if (body.error) {
                            reject(new Error('Claude API error: ' + body.error.message));
                            return;
                        }
                        const text   = body.content[0].text.trim();
                        resolve(JSON.parse(text));
                    } catch (e) {
                        reject(new Error('Could not parse Claude response: ' + r.responseText.slice(0, 200)));
                    }
                },
                onerror: () => reject(new Error('Network error calling Claude API')),
            });
        });
    }

    // ── Styles ────────────────────────────────────────────────────────────────
    GM_addStyle(`
        @keyframes ecw-pulse {
            0%   { box-shadow: 0 0 0 0   rgba(37,99,235,0.75); }
            70%  { box-shadow: 0 0 0 14px rgba(37,99,235,0);   }
            100% { box-shadow: 0 0 0 0   rgba(37,99,235,0);    }
        }

        #ecw-hotspot-ring {
            position:      fixed;
            border:        3px solid #2563eb;
            border-radius: 6px;
            animation:     ecw-pulse 1.4s ease-out infinite;
            pointer-events: none;
            z-index:       999997;
            box-sizing:    border-box;
        }

        #ecw-instruction-box {
            position:   fixed;
            bottom:     24px;
            left:       50%;
            transform:  translateX(-50%);
            z-index:    999998;
            background: #1a56db;
            color:      #ffffff;
            font-family: Arial, sans-serif;
            font-size:  15px;
            line-height: 1.55;
            padding:    18px 24px 14px;
            border-radius: 12px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.3);
            max-width:  540px;
            width:      max-content;
            pointer-events: auto;
        }

        #ecw-instruction-box .ecw-body {
            margin-bottom: 14px;
        }

        #ecw-instruction-box strong { font-weight: bold; }
        #ecw-instruction-box em     { font-style: italic; }

        #ecw-instruction-box .ecw-footer {
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

        #ecw-trainer-toggle {
            position:      fixed;
            bottom:        20px;
            right:         20px;
            z-index:       999999;
            font-family:   Arial, sans-serif;
            font-size:     12px;
            padding:       6px 14px;
            border-radius: 999px;
            border:        none;
            cursor:        pointer;
            box-shadow:    0 2px 8px rgba(0,0,0,0.2);
            opacity:       0.75;
            transition:    opacity 0.2s, background 0.2s;
            pointer-events: auto;
            white-space:   nowrap;
        }
        #ecw-trainer-toggle:hover { opacity: 1; }
        #ecw-trainer-toggle.on    { background: #1a56db; color: #ffffff; }
        #ecw-trainer-toggle.off   { background: #6b7280; color: #e5e7eb; }

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
        .ecw-menu-item {
            padding: 10px 16px;
            cursor:  pointer;
            color:   #111827;
        }
        .ecw-menu-item:hover           { background: #eff6ff; color: #1a56db; }
        .ecw-menu-item.ecw-menu-off    { color: #6b7280; border-top: 1px solid #e5e7eb; }
        .ecw-menu-item.ecw-menu-off:hover { background: #f9fafb; color: #374151; }

        #ecw-status {
            position:      fixed;
            bottom:        56px;
            right:         20px;
            z-index:       999999;
            background:    #1e3a8a;
            color:         #bfdbfe;
            font-family:   Arial, sans-serif;
            font-size:     12px;
            padding:       6px 14px;
            border-radius: 8px;
            pointer-events: none;
            white-space:   nowrap;
        }
    `);

    // ── Overlay helpers ───────────────────────────────────────────────────────
    // Convert **bold** and *italic* markdown to HTML for instruction display
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

        // Claude's coordinates are in screenshot space (SCREENSHOT_SCALE).
        // Multiply back to CSS pixel space for the overlay.
        const upscale = 1 / SCREENSHOT_SCALE;
        const { x, y, width, height } = result.hotspot;

        const ring = document.createElement('div');
        ring.id = 'ecw-hotspot-ring';
        Object.assign(ring.style, {
            left:   Math.round(x * upscale) + 'px',
            top:    Math.round(y * upscale) + 'px',
            width:  Math.round(width  * upscale) + 'px',
            height: Math.round(height * upscale) + 'px',
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
        el.id = 'ecw-status';
        el.textContent = msg;
        document.body.appendChild(el);
        if (autoClearMs) setTimeout(() => el.remove(), autoClearMs);
        return el;
    }

    // ── Workflow runner ───────────────────────────────────────────────────────
    async function startMergeAWVWorkflow() {
        closeMenu();
        const apiKey = getApiKey();
        if (!apiKey) return;

        const statusEl = showStatus('Taking screenshot...');

        try {
            // Capture screen and fetch workflow assets in parallel
            const [screenshotB64, workflowMd, refImageB64] = await Promise.all([
                captureScreenshot(),
                fetchText(`${GITHUB_RAW}/workflows/${WORKFLOW_ID}/workflow-merge-template.md`),
                fetchImageAsBase64(`${GITHUB_RAW}/workflows/${WORKFLOW_ID}/screenshots/step-1-templates-tab.png`),
            ]);

            statusEl.textContent = 'Asking Claude where to click...';

            const result = await callClaude(apiKey, screenshotB64, workflowMd, refImageB64);

            statusEl.remove();

            if (!result.found) {
                alert('ECW Trainer: Could not find the Templates tab.\n\n' + (result.reason || ''));
                return;
            }

            drawOverlay(result);

        } catch (err) {
            statusEl.remove();
            console.error('[ECW Trainer]', err);
            alert('ECW Trainer error:\n' + err.message);
        }
    }

    // ── Toggle + menu ─────────────────────────────────────────────────────────
    function closeMenu() {
        menuEl?.remove();
        menuEl = null;
    }

    function openMenu() {
        menuEl = document.createElement('div');
        menuEl.id = 'ecw-workflow-menu';
        menuEl.innerHTML = `
            <div class="ecw-menu-header">Select a Workflow</div>
            <div class="ecw-menu-item" id="ecw-menu-awv">Merge AWV Template into Progress Note</div>
            <div class="ecw-menu-item ecw-menu-off" id="ecw-menu-off">⚫ Turn Off Trainer</div>
        `;
        document.body.appendChild(menuEl);

        document.getElementById('ecw-menu-awv').addEventListener('click', startMergeAWVWorkflow);
        document.getElementById('ecw-menu-off').addEventListener('click', () => {
            isActive = false;
            closeMenu();
            clearOverlay();
            updateToggle();
        });
    }

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ecw-trainer-toggle';

    function updateToggle() {
        if (isActive) {
            toggleBtn.textContent = '🟢 ECW Trainer — ON';
            toggleBtn.className   = 'on';
        } else {
            toggleBtn.textContent = '⚫ ECW Trainer — OFF';
            toggleBtn.className   = 'off';
        }
    }

    toggleBtn.addEventListener('click', () => {
        if (!isActive) {
            // Turn back on
            isActive = true;
            updateToggle();
            return;
        }
        // When ON: toggle the workflow menu open/closed
        if (menuEl) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    updateToggle();
    document.body.appendChild(toggleBtn);

})();
