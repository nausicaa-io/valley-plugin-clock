/**
 * Clock plugin stylesheet — injected once from `register()`.
 *
 * The panel used to be 100 % inline styles in a hardcoded Apple idiom
 * (Helvetica Neue, 56px hairline readouts, 999px capsules, iOS steppers). Every
 * box/text/button rule now lives here and speaks only Valley tokens, so the
 * panel follows the theme, the accent colour and the interface font like the
 * rest of the app. Inline styles survive only for SVG geometry.
 *
 * `.clock-switch` deliberately re-implements the settings toggle instead of
 * reusing `.settings-switch`: that CSS ships with the settings modal bundle and
 * is not guaranteed to be loaded while the sidebar panel is open.
 */
const STYLE_ID = 'notes-clock-styles'

export const CSS = `
.clock-panel {
  --clock-control-h: 34px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  font-family: var(--interface-font);
  color: var(--text-color);
}

/* ---- Tab strip ---------------------------------------------------------- */
.clock-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  height: var(--app-bar-height);
  padding: 0 5px;
  background: var(--container-color-alt);
  border-bottom: 1px solid var(--border-light);
  box-sizing: border-box;
  flex-shrink: 0;
}
.clock-tab {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  /* The strip reorders by drag and the icon button is its own handle. */
  cursor: grab;
  outline: none;
  box-shadow: none;
}
.clock-tab:hover {
  background: transparent;
  color: var(--title-color);
}
.clock-tab.active {
  background: transparent;
  color: var(--accent-color);
}
.clock-tab.dragging {
  opacity: 0.5;
  cursor: grabbing;
}
.clock-tab.drop-before::before,
.clock-tab.drop-after::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--drop-knob);
  background:
    radial-gradient(
      circle at 50% var(--drop-knob),
      transparent 0 calc(var(--drop-knob) / 2 - var(--drop-line)),
      var(--drop-indicator-color) calc(var(--drop-knob) / 2 - var(--drop-line) + 0.5px)
        calc(var(--drop-knob) / 2 - 0.5px),
      transparent calc(var(--drop-knob) / 2)
    ) center top / var(--drop-knob) var(--drop-knob) no-repeat,
    linear-gradient(var(--drop-indicator-color), var(--drop-indicator-color)) center bottom /
      var(--drop-line) calc(100% - var(--drop-knob)) no-repeat;
  pointer-events: none;
  z-index: 1;
}
.clock-tab.drop-before::before { left: calc(var(--drop-knob) / -2); }
.clock-tab.drop-after::before {
  right: calc(var(--drop-knob) / -2);
  transform: rotate(180deg);
}

/* ---- Body / layout ------------------------------------------------------ */
/* Content runs the panel's full width on a small, even inset — the sidebar is
   narrow enough already, and a centred column left a gutter wider than the
   controls it framed. */
.clock-body {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: var(--space-3) var(--space-3) var(--space-4);
  box-sizing: border-box;
  overflow-y: auto;
}
.clock-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
}
.clock-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}
/* The one thing that must stay square and bounded: an analog dial. Everything
   else in the panel is full-bleed. */
.clock-face {
  width: 100%;
  max-width: 208px;
  aspect-ratio: 1 / 1;
}
.clock-divider {
  height: 1px;
  width: 100%;
  background: var(--border-light);
  flex-shrink: 0;
}
/* Inside the panel a section rule and the world list run edge to edge, like
   every separator in the app chrome: they bleed out by the body's own inset and
   pad their contents back in. The same markup in Settings keeps the pane's
   inset instead, so this is scoped to the panel. */
.clock-body .clock-divider,
.clock-body .clock-list--flush {
  width: auto;
  margin-inline: calc(var(--space-3) * -1);
}
.clock-body .clock-line-row {
  padding-inline: var(--space-3);
}
/* A section title with its primary action on the same line. */
.clock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}
.clock-section-title {
  font-size: var(--smaller-font-size);
  font-weight: var(--font-semi-bold);
  color: var(--text-secondary);
}
.clock-world-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  flex: 1 1 auto;
  min-width: 0;
}
.clock-world-actions .clock-citysearch.compact {
  max-width: 100%;
}
/* A settings group heading mid-page. The shell only gives .settings-label its
   air as a pane's first child, so a heading that follows rows needs its own —
   the same allowance the assistant pane makes. */
.clock-settings-label {
  font-size: var(--h3-font-size);
  margin: var(--space-3) 0;
}
/* A form fills the panel: labels above controls, every control full-bleed. */
.clock-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
}
.clock-empty {
  padding: var(--space-5) 0;
  text-align: center;
  color: var(--text-secondary);
  font-size: var(--smaller-font-size);
}

/* ---- Readouts ----------------------------------------------------------- */
.clock-readout {
  font-size: 2rem;
  font-weight: var(--font-medium);
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  line-height: 1.1;
  color: var(--title-color);
}
.clock-readout.sm {
  font-size: var(--normal-font-size);
  font-weight: var(--font-semi-bold);
}
.clock-readout.md {
  font-size: 1.35rem;
  font-weight: var(--font-semi-bold);
}
.clock-readout.done {
  color: var(--accent-color);
}
.clock-sub {
  font-size: var(--smaller-font-size);
  color: var(--text-secondary);
}

/* ---- Rows / cards ------------------------------------------------------- */
.clock-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}
.clock-row,
.clock-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: var(--container-color);
  box-sizing: border-box;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.clock-row:hover,
.clock-card:hover {
  border-color: var(--border-medium);
}
.clock-row.is-off {
  opacity: 0.6;
}
/* A running timer: a full-width band — countdown + label left, its actions
   right, and the remaining fraction as a bar across the bottom edge. */
.clock-card {
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-3);
}
.clock-card.is-paused {
  opacity: 0.75;
}
.clock-card.is-done {
  border-color: var(--accent-color);
}
.clock-row.draggable,
.clock-card.draggable {
  cursor: grab;
}
.clock-row.dragging,
.clock-card.dragging {
  opacity: 0.5;
  cursor: grabbing;
}
.clock-row.drop-before::before,
.clock-row.drop-after::before,
.clock-card.drop-before::before,
.clock-card.drop-after::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--drop-knob);
  background: var(--drop-indicator-fill);
  pointer-events: none;
  z-index: 2;
}
.clock-row.drop-before::before,
.clock-card.drop-before::before {
  top: calc(var(--drop-knob) / -2);
}
.clock-row.drop-after::before,
.clock-card.drop-after::before {
  bottom: calc(var(--drop-knob) / -2);
}
.clock-row-drag-icon {
  display: none;
}
.clock-card-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}
.clock-card-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.clock-timer-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
  color: var(--text-secondary);
}
.clock-timer-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clock-timer-duration,
.clock-timer-state {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.clock-progress {
  width: 100%;
  height: 3px;
  border-radius: 999px;
  background: var(--border-light);
  overflow: hidden;
}
/* No transition: the panel's own loop redraws the width, and a tween on top of
   that reads as lag rather than motion. */
.clock-progress-fill {
  height: 100%;
  background: var(--accent-color);
}
.clock-row-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}
.clock-row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.clock-row-name {
  font-size: var(--small-font-size);
  font-weight: var(--font-medium);
  color: var(--title-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* World rows: no card, no tint — a full-bleed line list separated by hairlines,
   with the app's hover highlight. The row bleeds past the body inset and pads
   itself back, so the highlight reaches the panel edges the way every other
   Valley list does. A stroke sun/moon in front of the city is the day/night
   cue; the time sits hard right on the baseline of the city name. */
.clock-list--flush {
  gap: 0;
}
.clock-line-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-2) 0;
  background: transparent;
  border: none;
  box-sizing: border-box;
  transition: background var(--duration-fast) var(--ease-out);
}
.clock-line-row:hover {
  background: var(--hover-bg);
}
.clock-line-row.drop-before:hover,
.clock-line-row.drop-after:hover,
.clock-line-row.dragging:hover {
  background: transparent;
}
.clock-line-row + .clock-line-row {
  box-shadow: inset 0 1px 0 var(--border-light);
}
.clock-line-time {
  flex-shrink: 0;
  font-size: var(--h3-font-size);
  font-weight: var(--font-medium);
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  color: var(--title-color);
  letter-spacing: 0.01em;
}
/* Remove stays out of the way until the row is hovered or keyboard-focused. */
.clock-line-row .clock-icon-btn {
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.clock-line-row:hover .clock-icon-btn,
.clock-line-row .clock-icon-btn:focus-visible {
  opacity: 1;
}
.clock-world-settings .clock-line-row {
  padding-inline-end: var(--space-2);
}
.clock-line-glyph {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-tertiary);
}
/* Daytime takes the accent, night stays quiet — the same weighting the app uses
   to mark one row of a list as live. */
.clock-line-glyph:not(.night) {
  color: var(--accent-color);
}
.clock-line-row.dragging {
  opacity: 0.5;
}
.clock-line-row.draggable {
  cursor: grab;
}
.clock-line-row.drop-before::before,
.clock-line-row.drop-after::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--drop-knob);
  background: var(--drop-indicator-fill);
  pointer-events: none;
  z-index: 1;
}
.clock-line-row.drop-before::before { top: calc(var(--drop-knob) / -2); }
.clock-line-row.drop-after::before { bottom: calc(var(--drop-knob) / -2); }
.clock-drag-ghost {
  position: fixed;
  left: -1000px;
  top: -1000px;
  display: flex;
  width: 24px;
  height: 24px;
  color: var(--text-secondary);
  pointer-events: none;
}
.clock-drag-ghost svg {
  width: 24px;
  height: 24px;
}

/* ---- Buttons ------------------------------------------------------------ */
.clock-btn-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.clock-btn-row--center {
  justify-content: center;
}
/* Transport rows (stopwatch, pomodoro): the row owns the panel's width and the
   buttons split it, so a label swap (Reset⇄Lap, Start⇄Stop) can never reflow
   them. */
.clock-btn-row--fill {
  width: 100%;
  flex-wrap: nowrap;
}
/* Timer presets: one equal-width track each, so five chips fill the row instead
   of huddling in the middle of it. */
.clock-preset-row {
  /* Auto columns, not a fixed five: the row holds whatever quick timers the
     user kept, and a five-track grid left dead tracks behind every one removed. */
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: var(--space-1);
  width: 100%;
}
.clock-preset-row > .clock-chip {
  justify-content: center;
  padding: 0;
  height: 26px;
}
.clock-btn-row--fill > .clock-btn {
  flex: 1 1 0;
  min-width: 0;
}
.clock-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--small-font-size);
  font-weight: var(--font-medium);
  cursor: pointer;
  outline: none;
}
.clock-btn:hover:not(:disabled) {
  background: var(--hover-bg);
  color: var(--title-color);
}
.clock-btn--primary {
  border: none;
  background: var(--accent-color);
  color: #fff;
}
.clock-btn--primary:hover:not(:disabled) {
  background: var(--accent-color);
  color: #fff;
  opacity: 0.9;
}
.clock-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.clock-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  outline: none;
}
.clock-icon-btn:hover {
  background: var(--hover-bg);
  color: var(--title-color);
}
.clock-sound-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--clock-control-h, 34px);
  width: var(--clock-control-h, 34px);
  height: var(--clock-control-h, 34px);
  padding: 0;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: var(--container-color-alt);
  color: var(--text-secondary);
  cursor: pointer;
  outline: none;
}
.clock-sound-preview:hover,
.clock-sound-preview.is-playing {
  border-color: var(--accent-color);
  background: var(--accent-tint-bg);
  color: var(--accent-color);
}
.clock-sound-preview svg {
  width: 17px;
  height: 17px;
}
.pomo-picker-list {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.modal-body.pomo-picker-modal-body {
  padding-top: 0;
}
.pomo-picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  width: 100%;
  padding: var(--space-2) 0;
  border: none;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}
.pomo-picker-row:hover {
  background: transparent;
}
.pomo-picker-icon {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
}
.pomo-picker-row.active .pomo-picker-icon,
.pomo-picker-row.active .pomo-picker-check {
  color: var(--accent-color);
}
.pomo-picker-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.pomo-picker-name,
.pomo-picker-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pomo-picker-name {
  font-weight: var(--font-medium);
}
.pomo-picker-summary {
  color: var(--text-secondary);
  font-size: var(--smaller-font-size);
}
.pomo-picker-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  color: var(--text-tertiary);
  line-height: 1;
}
.pomo-profile-chip {
  cursor: pointer;
}
.pomo-panel-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.pomo-picker-row + .pomo-picker-row {
  border-top: 1px solid var(--border-light);
}
.clock-pomodoro-settings .settings-button--danger:hover:not(:disabled) {
  border-color: var(--negative-color);
  background: var(--negative-color);
  color: #fff;
  filter: brightness(0.92);
}
.clock-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-tertiary);
  cursor: grab;
}
.clock-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent-tint-bg);
  color: var(--accent-tint-text);
  font: inherit;
  font-size: var(--smaller-font-size);
  font-weight: var(--font-medium);
  cursor: pointer;
  outline: none;
}
.clock-chip:hover {
  opacity: 0.85;
}
.clock-chip.static {
  cursor: default;
}
.clock-chip.static:hover {
  opacity: 1;
}

/* ---- Fields ------------------------------------------------------------- */
/* Label above its control, not in a left gutter: the control gets the full
   panel width, which is what lets all seven repeat circles sit on one line. */
.clock-field {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-1);
  width: 100%;
}
.clock-field-label {
  flex: none;
  font-size: var(--smaller-font-size);
  color: var(--text-secondary);
}
/* Groups several controls onto the field's single line (hh : mm, sound + ▶). */
.clock-field-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}
/* Every field in the plugin is the same box: one height, one type size, pinned
   top and bottom so a number input cannot render taller than the text input
   beside it. A name and a duration are entered in the same breath — they must
   not look like two different classes of control. */
.clock-input {
  height: var(--clock-control-h, 34px);
  min-height: var(--clock-control-h, 34px);
  max-height: var(--clock-control-h, 34px);
  min-width: 0;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: var(--container-color-alt);
  color: var(--text-color);
  font: inherit;
  font-size: var(--normal-font-size);
  line-height: normal;
  box-sizing: border-box;
  outline: none;
}
.clock-input:focus {
  border-color: var(--accent-color);
}
.clock-input.grow {
  flex: 1;
  width: 100%;
}
.clock-select.grow {
  flex: 1;
}
.clock-select--compact {
  flex: 0 1 150px;
  min-width: 0;
}

/* ---- City search (world clock) ------------------------------------------ */
/* The results overlay whatever is under the field, so opening the list never
   reflows the world rows beneath it. */
.clock-citysearch {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
}
.clock-citysearch.compact {
  flex: 1 1 auto;
  max-width: 60%;
  width: auto;
}
.clock-citysearch-results {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 240px;
  overflow-y: auto;
  padding: var(--space-1);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  background: var(--container-color);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
}
.clock-citysearch-list {
  display: flex;
  flex-direction: column;
}
.clock-citysearch-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.clock-citysearch-row:hover,
.clock-citysearch-row:focus-visible {
  background: var(--hover-bg);
  outline: none;
}
.clock-citysearch-empty {
  padding: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--smaller-font-size);
}
/* hh : mm : ss splits the field's width evenly rather than sitting in a 52px
   box with the rest of the row empty. */
.clock-input.num {
  flex: 1 1 0;
  width: auto;
  min-width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.clock-time-sep {
  color: var(--text-secondary);
}

/* ---- Repeat day picker -------------------------------------------------- */
.clock-days {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  flex: 1;
}
.clock-day-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  padding: 0;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--smaller-font-size);
  font-weight: var(--font-medium);
  line-height: 1;
  cursor: pointer;
  outline: none;
}
.clock-day-btn:hover {
  background: var(--hover-bg);
  color: var(--title-color);
}
.clock-day-btn.on {
  background: var(--accent-color);
  border-color: transparent;
  color: #fff;
}

/* ---- Toggle switch (panel-local; see file header) ----------------------- */
.clock-switch {
  flex-shrink: 0;
  position: relative;
  display: inline-block;
  width: 34px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--border-medium);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.clock-switch.on {
  background: var(--accent-color);
}
.clock-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--duration-fast) var(--ease-out);
}
.clock-switch.on .clock-switch-knob {
  transform: translateX(14px);
}

/* ---- Stopwatch laps ----------------------------------------------------- */
.clock-laps {
  width: 100%;
  max-height: 180px;
  overflow-y: auto;
  border-top: 1px solid var(--border-light);
}
.clock-lap {
  display: flex;
  justify-content: space-between;
  padding: 6px var(--space-1);
  border-bottom: 1px solid var(--border-light);
  font-size: var(--smaller-font-size);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

/* ---- Overlays on analog faces ------------------------------------------ */
.clock-face-stack {
  position: relative;
  width: 100%;
  max-width: 200px;
  aspect-ratio: 1 / 1;
}
.clock-face-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  pointer-events: none;
}
.clock-face-caption {
  position: absolute;
  bottom: 12%;
  left: 0;
  right: 0;
  text-align: center;
  pointer-events: none;
}
`

/** Inject (or refresh, on hot reload) the plugin stylesheet. */
export function injectStyles(): () => void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(STYLE_ID) === el) el.remove()
  }
}
