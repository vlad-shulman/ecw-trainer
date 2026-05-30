// ==UserScript==
// @name         ECW On-Demand Trainer
// @namespace    https://github.com/vlad-shulman/ecw-trainer
// @version      0.1.0
// @description  On-demand training overlay for eClinicalWorks
// @author       Vlad
// @match        *://*/*
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// @downloadURL  https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// ==/UserScript==

(function () {
    'use strict';

    // --- Styles ---
    GM_addStyle(`
        #ecw-trainer-banner {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 999999;
            background: #1a56db;
            color: #ffffff;
            font-family: Arial, sans-serif;
            font-size: 14px;
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            display: flex;
            align-items: center;
            gap: 12px;
            pointer-events: auto;
        }

        #ecw-trainer-banner button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.6);
            color: #ffffff;
            font-size: 12px;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
        }

        #ecw-trainer-banner button:hover {
            background: rgba(255,255,255,0.15);
        }
    `);

    // --- UI ---
    const banner = document.createElement('div');
    banner.id = 'ecw-trainer-banner';
    banner.innerHTML = `
        <span>✅ ECW Trainer loaded — Hello World!</span>
        <button id="ecw-trainer-dismiss">Dismiss</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('ecw-trainer-dismiss').addEventListener('click', () => {
        banner.remove();
    });

})();
