# ECW Workflow: Merge AWV Template into Progress Note
**Workflow ID:** merge-template  
**Total Steps:** 3  
**Source:** Storylane guide "How to Merge AWV Templates into Progress Notes with Social History"

---

## Design Rules (apply to all steps)

- **Hotspot style:** Pulsing blue ring around the target element (copy-cat Storylane design)
- **Instruction box style:** Large blue box with bold key terms and italicized tips (copy-cat Storylane design)
- **Instruction box placement:** Default to center-bottom of screen unless the target element is in that area — in that case Claude picks the best placement to avoid covering the target
- **Step counter:** Shown in bottom-left of instruction box (e.g. "1/3")
- **Next button:** Shown in bottom-right of instruction box
- **Verbiage:** Use exact text from Storylane — do not paraphrase

---

## Starting State

The provider has a progress note open in ECW. The right chart panel is visible. The **Overview** tab is the active tab in the right chart panel. The right chart panel contains a horizontal tab row with these tabs in order: Overview, Enc, DRTLA, History, CDSS, OS, Templates.

---

## Step 1 — Click the Templates Tab

### ⚠️ CRITICAL: Two Elements Named "Templates" Exist
There are TWO elements labeled "Templates" on the ECW progress note page:
- ✅ **CORRECT:** The "Templates" tab in the **right chart panel tab row** — a horizontal row of tabs at the TOP of the right panel (alongside Overview, Enc, DRTLA, History, CDSS, OS)
- ❌ **WRONG:** The "Templates" button in the **bottom toolbar** — a row of buttons at the very bottom of the screen (alongside Send, Print, Fax, Lock, Details, etc.)

**Always target the right chart panel tab. Never target the bottom toolbar button.**

### What Claude should look for
- A horizontal tab row in the upper-right chart panel
- The rightmost tab in that row labeled **"Templates"**
- Its immediate left neighbor is the tab labeled "OS"
- The tab is at approximately y:114 in the right chart panel area (NOT near the bottom of the screen)
- The tab is inactive (Overview is currently the active tab)

### Target element
- **Element:** Tab labeled "Templates"
- **Location:** Last tab in the horizontal tab row in the right chart panel
- **Neighboring elements:** Immediately to the right of the "OS" tab
- **Y coordinate range:** Should be between y:100 and y:150 (near the top of the right panel)
- **NOT the bottom toolbar:** If the only "Templates" element found is near y:750 or higher, that is the wrong element — do not use it

### Hotspot
- Spotlight cutout around the **Templates tab in the right chart panel tab row only**

### Instruction box text
> Click the **Templates** tab in the right chart panel to show favorite templates.

### Step counter
1/3

### Success state (how Claude validates the click worked)
The right chart panel content changes from showing Overview content (Global Alerts, Well Visits, Problem List, etc.) to showing:
- A heading **"My Favorite Templates"** with a filter icon and search box
- A list of templates including **"\*Cano Annual Wellness Visit MCR"** somewhere in the list
- Possibly a yellow warning banner at the top of the panel

---

## Step 2 — Click the Arrow Button to Merge the AWV Template

### What Claude should look for
- The **"My Favorite Templates"** list is now visible in the right chart panel
- Scan the list for the row containing the text **"\*Cano Annual Wellness Visit MCR"**
- Each template row has a **left-pointing blue arrow button (←)** on the left side of the row
- The arrow button position is always consistent relative to the template name

### Target element
- **Element:** Left-pointing blue arrow button (←) on the row containing "\*Cano Annual Wellness Visit MCR"
- **How to find it:** Locate the row with text "\*Cano Annual Wellness Visit MCR" first, then target the arrow on that specific row — do NOT just click the first arrow in the list
- **Note:** Other templates may appear above or below this one — always identify by text match

### Hotspot
- Pulsing blue ring around the **arrow button (←)** on the "\*Cano Annual Wellness Visit MCR" row specifically

### Instruction box text
> Click **arrow** button to merge the AWV Template into the Progress Note.
>
> *Tip: Before you merge, confirm you've selected the right template (\*Cano Annual Wellness Visit MCR)*

### Step counter
2/3

### Success state (how Claude validates the click worked)
One of two things will happen:
- **Option A:** A confirmation pop-up titled "Copy and Merge Templates - Confirmation" appears center-screen → proceed to Step 3
- **Option B:** No pop-up appears and the template merges directly → workflow is complete, skip Step 3

---

## Step 3 — Click Overwrite Social History (CONDITIONAL)

### Trigger condition
⚠️ **This step only appears if** the "Copy and Merge Templates - Confirmation" pop-up is detected on screen after Step 2. If no pop-up appears, the workflow is complete and no hotspot should be shown.

### What Claude should look for
- A modal pop-up titled **"Copy and Merge Templates - Confirmation"** appearing center-screen
- The pop-up contains two buttons: "Copy/Merge Excluding Social History" (left) and "Overwrite Social History" (right)
- An orange/yellow warning triangle icon on the left side of the pop-up

### Target element
- **Element:** Button labeled **"Overwrite Social History"**
- **Location:** Right button inside the confirmation pop-up
- **Do NOT target:** "Copy/Merge Excluding Social History" (the left button)

### Hotspot
- Pulsing blue ring around the **"Overwrite Social History"** button specifically

### Instruction box placement
- Claude should pick the best placement to avoid covering the confirmation pop-up
- Prefer top-right or bottom-right of screen if the pop-up is center-left

### Instruction box text
> ⚠️ **NOTE**
>
> If the confirmation pop-up appears, click **Overwrite Social History**.
>
> *Tip: You'll see this pop-up when the patient has Social History from a previous visit — overwriting Social History will ensure your progress note has all the Social Determinants of Health (SDOH) questions.*

### Step counter
3/3

### Success state (how Claude validates the click worked)
- The confirmation pop-up closes
- The template content is merged into the progress note
- The progress note sections (Subjective, Objective, etc.) may now contain additional pre-filled content from the AWV template
- **Workflow complete**

---

## Edge Cases & Notes

| Situation | How to handle |
|---|---|
| Right chart panel is collapsed | Out of scope for this POC — assume it is always visible |
| Templates tab is not visible in tab row | Out of scope for this POC — assume it is always visible |
| "\*Cano Annual Wellness Visit MCR" not found in template list | Show an error message: "Template not found. Please contact your ECW administrator." |
| Confirmation pop-up does not appear after Step 2 | Skip Step 3 — workflow is complete |
| Provider's template list has many items and requires scrolling | Claude should scroll the template list to find "\*Cano Annual Wellness Visit MCR" if not immediately visible |
