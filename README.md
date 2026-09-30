# Clock

Clock with world times, alarms, stopwatch, multiple timers and Pomodoro — in the right sidebar and the footer.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

Clock installs as an independent plugin. It uses the shared sandbox, permissions, and SDK/IPC contract. Saved data stays in `.valley/plugins/data/clock/`, separate from the replaceable plugin package: settings in `config.json`, ordered alarm and timer records in `alarms.jsonl` and `timers.jsonl`, and session snapshots in `stopwatch.json` (including laps) and `pomodoro.json`. Writes atomically replace each file through the injected file API; Clock does not declare or use SQL datasets.

Alarm audio lives in `.valley/assets/alarm-sounds/`. Clock seeds five WAV tones without overwriting existing files. Add WAV, MP3, M4A, AAC, OGG, Opus, FLAC, or WebM audio files to this folder; the sound selectors refresh automatically while open. Playback depends on the audio codecs supported by Valley. Settings → Clock → Alarm opens the folder. Timer settings show one `hr : min : sec` control per preset, with an optional name beside each duration and a matching-width `+` button to add another row. Hours are limited to 999; named presets carry their name into timers started from the sidebar. Edit the digits or paste a duration such as `1h30min3s`. Changes save when leaving the row or pressing Enter; invalid or duplicate durations keep the saved presets unchanged.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.

## Workflow integration

The backend publishes `workflow.provider` version `1.0.0` through the injected SDK. Workflow can start, pause, resume, or cancel timers, and create, enable, or disable alarms. Timer-finished and alarm-fired triggers contain `record`, `occurrenceId`, `scheduledAt`, and `firedAt`. Use Workflow conditions for filtering.

One backend owner serializes alarm and timer writes, notification scheduling, and changes from every Clock surface. Closing a surface leaves the owner active while Valley runs; disabling Clock unloads it. Recurring alarm schedules are replenished after each occurrence. Stopwatch and Pomodoro retain their existing session formats and behavior.

Clock preserves optional opaque causal receipts in timer and alarm records. Finished occurrences are deduplicated in the bounded `workflow-occurrences.json` ledger, including host replay during backend startup. Ring repeats do not retrigger workflows, and occurrences missed while Valley was not running do not start catch-up runs. Delivery and partial persistence failures are surfaced; Workflow must not automatically retry actions with uncertain outcomes. The ledger and event dispatch are separate operations, so a crash between them can lose an event rather than replay a potentially duplicated action.
