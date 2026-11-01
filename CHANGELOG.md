# Change Log

All notable changes to the "cmake-workflow" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Host Fix: reviewed single-use plans, serialized installation, progress and
  post-install verification, plus workspace-scoped tool PATH activation.

- Read-only Host Doctor over local JSON-RPC, lazy per-folder Host ownership,
  external endpoint attachment, progress, cancellation and reconnect tests.
- Manual profile run, replay and analysis commands with cancellation and saved-result viewing.
- Profiling across multiple named build variants using the CLI's `--variant` contract.
- Native target build/invoke/run and two-target sequence actions.
- Tool installation planning and explicit application through the CLI.
- DagFlow mutation, weak-memory, fuzz seed/run/triage/merge parameter pickers.
- Multiple workflow node selection, configurable History limit and optional history recording.
- Raw measurement inspection and variant/scenario/alpha controls for History queries.
- Wizard regressions for workspace trust, cancellation, argument boundaries,
  multiple variants, installation consent and command/menu contributions.
- Preserve split UTF-8 output and return final-line parsing errors without
  leaving pending process calls. Failure notifications retain the execution
  error even when the CLI subsequently reports a successful History import.
