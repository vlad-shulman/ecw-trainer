> [!WARNING]
> This is a proof-of-concept (work in progress). Not production ready.

# ECW On-Demand Trainer

A Tampermonkey userscript that overlays AI-powered training hotspots on eClinicalWorks (ECW) to guide providers through EMR workflows in real time.

## How It Works

When a provider gets stuck in ECW, they click the **ECW Trainer** toggle button in the bottom-right corner of their screen. The trainer analyzes their current screen, compares it against a pre-built workflow guide, and draws a pulsing hotspot directly on the ECW interface showing exactly where to click — along with instructional text. The provider clicks through the real ECW interface, building actual muscle memory.

---

## Repo Structure

```
ecw-trainer/
├── ecw-trainer.user.js         # The Tampermonkey userscript (installed via Tampermonkey)
├── README.md                   # This file
└── workflows/                  # One folder per ECW workflow
    └── merge-awv-template/     # Workflow: Merge AWV Template into Progress Note
        ├── workflow-merge-template.md   # Claude instruction file for this workflow
        ├── storylane-export.pdf         # Storylane PDF export (human-readable reference)
        └── screenshots/                 # Storylane screenshots per step
            ├── step-1-templates-tab.png
            ├── step-2-arrow-button.png
            └── step-3-overwrite-social-history.png
```

---

## Adding a New Workflow

1. Create a new folder under `workflows/` with a descriptive name (e.g. `place-diagnostic-imaging-order`)
2. Add a workflow MD file following the same structure as `workflow-merge-template.md`
3. Export the Storylane guide as PDF and save as `storylane-export.pdf` in the folder
4. Add a `screenshots/` subfolder with one screenshot per step, named `step-1-xxx.png`, `step-2-xxx.png`, etc.
5. Reference the new workflow in the userscript

---

## Workflow MD File Structure

Each workflow MD file contains:
- **Design rules** — hotspot style, instruction box style, placement rules
- **Starting state** — what the ECW screen looks like before the workflow begins
- **Steps** — for each step: target element description, how Claude finds it, hotspot placement, exact instruction text, and success state
- **Edge cases** — known variations and how to handle them

---

## Installation (for new providers)

1. Install the [Tampermonkey Chrome extension](https://www.tampermonkey.net/)
2. Enable "Allow User Scripts" in Tampermonkey settings
3. Open Tampermonkey Dashboard → Utilities → Install from URL
4. Paste: `https://raw.githubusercontent.com/vlad-shulman/ecw-trainer/main/ecw-trainer.user.js`
5. Click Install and confirm
6. Open ECW — the **ECW Trainer** toggle button will appear in the bottom-right corner

---

## Tech Stack

- **Tampermonkey** — userscript host, injects the trainer into ECW
- **Claude API** — analyzes screenshots, identifies workflow position, calculates hotspot coordinates
- **GitHub** — hosts the userscript and workflow reference files

---

## Future UX Vision: The Minimap HUD

Inspired by RPG minimap mechanics (think WoW quest markers), the long-term UX vision has two states:

**State 1 — Navigation Mode** (target element is off-screen)
A sticky arrow hugs the edge of the viewport pointing in the direction the provider needs to scroll. Similar to a quest marker arrow guiding you toward a destination.

**State 2 — Hotspot Mode** (target element is in viewport)
The pulsing ring appears directly on the target element. Similar to a quest marker becoming a full hotspot when you arrive at the destination.

The transition between states is triggered automatically based on whether the target element is currently visible in the provider's viewport. This solves the scroll problem elegantly — providers instinctively understand "follow the arrow, then click the hotspot."

> 🚧 This is a future vision item — not part of the current POC.
