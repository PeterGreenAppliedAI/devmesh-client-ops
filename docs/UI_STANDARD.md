# devmesh-client-ops UI standard

Adopted for the MVP by the owner (DevMesh Factory decision 9, 25 Nov 2026: "Approve draft for MVP"), used as it stands and refined from real use. Every human-facing contract's Style section cites these rules by id, and every style finding cites one.

**Who it's for:** one consultant running their client work day to day. It's a work tool used often, for minutes at a time, on a laptop and sometimes a phone. Calm, dense enough to be useful, and quick to act from.

## Look and feel
- **UI-1 A real visual system, never browype and spacing come from a small set ofCSS custom properties defined once (tokens). No component uses a literal colour.
- **UI-2 Palette:**
  - a neutral warm-grey ground (page slige);CSS custom properties defined once (tokens). No component uses a literal colour.
- **UI-2 Palette:**                                                                                              - a neutral warm-grey ground (page slige);
  - one accent colour for primary actions and the current navigation item;
  - semantic colours only for status: danger, warning, success, info.                                            - No gradients.
- **UI-3 Type:**
  - a 16px base with a fixed scale (for example 13 / 14 / 16 / 20 / 24 / 30);
  - one sans-serif family with system fallbacks;
  - headings set off by size and weight, never by colour alone;                                                  - line length near 70 characters for pr
- **UI-4 Spacing:** one 4px-based spacing scale, and generous whitespace between sections. Nothing touches the edge of its container.edge of its container.                                                                                          - **UI-5 Light and dark:** both themes fr the system setting. Contrast meets WCAG2.2 AA in both.                                                                                                 
## Layout and navigation
- **UI-6 App frame:**
  - a top header bar with the product name and a global "New…" action;                                            - a left sidebar on desktop, styled as page clearly marked;
  - a compact menu on phones.                                                                                     - Breadcrumbs stay.
- **UI-7 Primary navigation** includes Home, Clients, **Tasks**, **Work items**, Meetings and Archived. Work is reachable directly, not only by drilling
- **UI-8 Record pages are broken up, never one long scroll:**
  - a summary card first: name, status, the key facts and the primary actions;
  - then the detail in clearly separated t: Overview, Engagements, Work, Meetings.
- **UI-9 Lists of many things are tables or compact rows,** with columns for what you scan for: title, status, owner, due date, client. They are sortable where it helps. Cards are for grouping, not for every row.

## Actions                                                                                                    - **UI-10 Actions are buttons; navigation
  - Anything that creates, edits, archives or saves is a button.                                                - A link only takes you somewhere.
  - Each page has at most one primary (filled accent) button. Others are secondary (outlined). Destructive oneare danger-styled and confirm first.
- **UI-11 Add where you look.** Every list shows its own add button at the top of that list: "Add task" on every task list, "Add meeting" on the meetings section. Each creation flow is reachable in one click from where its items are shown.
- **UI-12 Empty states lead to the action.** An empty section says what would be there, in a sentence, and offers its add button. Never just "None".

## Content and wording
- **UI-13 Human wording for every stored
  - "In progress", not `in_progress`; "On hold", not `on_hold`.
  - Dates are readable ("Tue 25 Nov"), wid.
  - Counts read as sentences or labelled figures, never `open: 3 in_progress: 1`.
- **UI-14 Status is a badge:** a small roolour, the same everywhere for the samestatus.
- **UI-15 Errors are plain and placed.** A field error sits under its field, in plain language ("Name is
required"), and is linked to the field fo errors also lists them at the top. Nevera developer message such as "client.name must be nonblank".
- **UI-16 No repeated labels.** A section heading and the button inside it never say the same word ("Archive" above "Archive").

## Forms
- **UI-17 Forms are grouped and short:**
  - related fields grouped under a heading;
  - labels above fields;
  - optional fields marked "optional";
  - a select or date picker where the value has a fixed set or is a date;
  - the primary button at the bottom, labtask", not "Submit").

## Accessibility and behaviour
- **UI-18 WCAG 2.2 AA:**
  - visible focus;
  - targets at least 24×24 CSS px (44 for
  - keyboard reachable;
  - landmarks;
  - a skip link.
  - These are already in place; keep them
- **UI-19 Works at phone and desktop widths** (390 px and 1366 px) with no horizontal page scroll. Wide tables scroll inside their own container.
- **UI-20 No scripts unless a contract nerendered HTML with a strictcontent-security policy; keep it so. Interactivity (tabs, disclosure) uses HTML and CSS first.

## Avoid, by name
- **UI-21 Not to be used:**
  - purple-blue gradients and the generic "AI SaaS" look;
  - glassmorphism, neumorphism, glow effe
  - hero banners;
  - emoji in headings or labels;
  - every block wrapped in a shadowed card;
  - low-contrast grey-on-grey text;
  - animation that isn't feedback;
  - decorative illustrations;
  - charts without a decision behind them

## Sample data and screenshots
- **UI-22 Synthetic sample data only.** T/preview.ts --port {port}`, or as theregistration names it) starts the app with a fixture under `test/` that exercises every page: overdue and due-soon tasks, each work-item kind, a meeting, an archived record and a long name. Never real client data.
- **UI-23 Screens to capture,** at least:ient page, an engagement page, the taskslist, a task form with an error.
