// ==UserScript==
// @name         ECW On-Demand Trainer
// @namespace    https://github.com/vlad-shulman/ecw-trainer
// @version      0.1.4
// @description  On-demand training overlay for eClinicalWorks
// @author       Vlad
// @match        *://flcahatrnapp.ecwcloud.com/*
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// @downloadURL  https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js
// ==/UserScript==

(function () {
    'use strict';

    let isActive = true;

    // --- Styles ---
    GM_addStyle(`
        #ecw-trainer-toggle {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 999999;
            font-family: Arial, sans-serif;
            font-size: 12px;
            padding: 6px 14px;
            border-radius: 999px;
            border: none;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            opacity: 0.75;
            transition: opacity 0.2s, background 0.2s;
            pointer-events: auto;
            white-space: nowrap;
        }

        #ecw-trainer-toggle:hover {
            opacity: 1;
        }

        #ecw-trainer-toggle.on {
            background: #1a56db;
            color: #ffffff;
        }

        #ecw-trainer-toggle.off {
            background: #6b7280;
            color: #e5e7eb;
        }
    `);

    // --- Toggle button ---
    const btn = document.createElement('button');
    btn.id = 'ecw-trainer-toggle';

    function updateButton() {
        if (isActive) {
            btn.textContent = '🟢 ECW Trainer — ON';
            btn.className = 'on';
        } else {
            btn.textContent = '⚫ ECW Trainer — OFF';
            btn.className = 'off';
        }
    }

    btn.addEventListener('click', () => {
        isActive = !isActive;
        updateButton();
    });

    updateButton();
    document.body.appendChild(btn);

})();
