# Clock integration rules

- Read `README.md` and the workspace plugin skill before changes.
- The backend Clock owner is the only writer and scheduler for alarms and timers. Renderer stores mirror its snapshots and issue mutations through the SDK; closing a surface must not stop its background operation.
- Preserve JSON/JSONL storage, stopwatch and Pomodoro sessions, UI undo, timer limits, and existing settings. Never introduce a dataset migration.
- Refill recurring alarm schedules after occurrences. Use host occurrence IDs for persisted deduplication; repeated ring ticks and missed catch-up occurrences must not trigger Workflow.
- Preserve opaque host causal receipts on records and restore them when publishing completion events. Report uncertain side effects without automatic retries.
- Verify `tests/backendOwner.test.ts`, `tests/workflow.test.ts`, and affected timer/alarm/interface tests. Integrations must use only public SDK contracts, never another plugin's source or files.

- Notification schedules and completion handling belong to the backend. Calendar/To-Do reminder offsets preserve Off, explicit choices and absolute reminders; date-only items require an explicit time. Persist occurrence recovery before notification and never replay a missed alarm or timer. Pomodoro recovery advances once into a paused phase. The host owns notification audio; UI sound players are for previews only.
