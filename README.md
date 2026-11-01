# CMakeWorkflow for VS Code

Run `npm install`, open this folder in VS Code, then press **F5** and select **Run Extension**. This builds the extension and opens an Extension Development Host window. Open the project containing your workflow in that new window. Alternatively, build with `npm run package` and package it as a VSIX. Install the [CMakeWorkflow CLI](https://github.com/cpp20120/CMakeWorkflow) on the workspace host. Remote SSH, WSL, and Dev Container workspaces run the CLI remotely.

Set `cmakeWorkflow.executable` to a native binary path, or leave it as `CMakeWorkflow` when available on PATH. For a development build, set the executable to `dotnet` and `cmakeWorkflow.prefixArgs` to an array containing the absolute path to `CMakeWorkflow.dll`.

By default, history uses the CLI's default database. Set `cmakeWorkflow.historyDb` to an absolute path or a path relative to the workspace folder to use another catalog for both new workflow runs and history queries. The History toolbar also has **Choose History Database**.

Open the **CMakeWorkflow** icon in the Activity Bar. Its toolbar has buttons to select a workflow, plan, run, open the last report, browse history, and choose the CLI executable. Expand a node to see its target, build tree, dependencies, diagnostics, and available artifacts; click an artifact to open it. Optional `cmakeWorkflow.jobs` and `cmakeWorkflow.resultsDir` settings map to `--jobs` and `--results-dir`.

**Open Last Report** opens the saved `run.json` from the latest run in this VS Code session. In **History & Comparison**, refresh the indexed runs and click a run to inspect its nodes, artifacts and sample charts. Choose Baseline and Candidate (or use the buttons beside a run), then choose **Compare Runs**. This opens a comparison table and raw sample plot; the CLI supplies status and medians. **Detect Regression** asks for a metric, worse direction and minimum percentage effect, then displays the CLI's statistical result and adjusted p-value. The CLI needs at least 10 individual samples per run for a verdict; missing or incompatible measurements appear as diagnostics. Workflow `invoke` campaigns may be indexed as runs without indexed measurements. The extension does not configure or schedule builds itself. Workspace trust is required for every CLI command.

## Chart presets and DagFlow harness results

The History toolbar provides **Select Chart Preset** and **Create Chart Preset**. Presets filter chart metric names and optional case/scenario name fragments. The built-in choices cover all CLI history measurements, process time, all DagFlow metrics, public API throughput, runtime throughput, graph/scheduler cases, and latency. The selected preset is remembered separately for CLI history and DagFlow harness charts in each workspace folder. Presets filter presentation only; the CLI comparison table and its verdict remain complete. Custom presets are saved in that folder's `cmakeWorkflow.chartPresets` setting. Use Settings JSON to edit or remove them. Metric names must match exactly; case fragments are case insensitive. `*` selects all metrics.

For DagFlow's `invoke` campaigns, choose **Compare DagFlow Harness Results** in the same toolbar. Select the baseline and candidate `summary.json` files from saved `harness-results` directories. The extension reads each adjacent `runs.jsonl`, plots successful non-warmup samples, and shows the scaled medians recorded by the harness. It never calls these plots a statistical regression verdict. Missing files, malformed records and manifest hash mismatches are reported. You can compare two saved harness result directories without importing them into CLI history. For the existing DagFlow campaign, files are typically under `out/build/runtime-campaign/harness-results/Release/`; select the actual files because the extension does not infer result paths from workflow runs.

## More CLI tools in the UI

- Expand a planned workflow and use the play button beside a node to run that node and its dependency closure. The extension first calls `workflow plan FILE --only NODE --json`, shows the resulting nodes, then asks you to confirm before `workflow run FILE --only NODE --json`.
- In **History & Comparison**, use **Filter History** for status, start/end time, workflow text, or variant. **Import Saved Results** calls `history import` on a selected directory, optionally recursively. Run details now show recorded host and build environments alongside charts and artifacts.
- In the Workflow toolbar, **Check Tools** lists CLI profiles and runs the read-only `tooling doctor --profile NAME --json`. **Inspect Build Tree** displays the CLI's observed state, diagnostics and File API targets. **Resolve Executable Target** asks the CLI for the executable path without building.
- In the History toolbar, **Open Profile Results** opens a saved profile directory. It displays timing comparisons, counters, capture details and available trace/report links from existing `comparison.json`, `counter-comparison.json`, `analysis.json` and `*.results.json` files. Opening the view does not rerun profiling or analysis.

## Manual profiling

The command palette and the **…** menus of both Workflow and History provide:

- **CMakeWorkflow: Run Profile** — choose a configured build tree, an executable
  target/configuration observed by CMake File API, capture mode, timing repeats,
  backend, timeout and results directory. The CLI builds that target and runs
  its profiling campaign. Program arguments use a JSON array such as
  `["--case", "chain-4", "--output", "path with spaces"]`; each string is passed
  as one argument. No shell parsing is used. This wizard profiles one build tree.
- **CMakeWorkflow: Profile Multiple Build Variants** — add at least two named,
  separately configured build trees (for example `normal`, `o3`, `lto`). The
  wizard offers executable targets/configurations present in every tree and
  passes repeated `--variant NAME=DIR` options to `profile run`. All variants
  share the selected program arguments, configuration, repetitions and capture
  settings. CMakeWorkflow owns scheduling, alternating timing passes and the
  saved comparison. Build trees must already be configured; the wizard does
  not change compiler flags or enable LTO implicitly.
- **CMakeWorkflow: Replay Profile Comparison** — uses the History baseline and
  candidate (or asks you to select them), then offers shared direct-run nodes
  and indexed DagFlow harness cases. Select the backend, timeout and results
  directory. A statistical regression is not required for a manual replay.
  The CLI checks original arguments, binary hashes, saved harness replay
  descriptors and provenance; an offered case is not a guarantee of replayability.
  Replay requires the CLI implementation of `profile replay`, currently in the
  local CLI patches. Older executables reject that command. Missing snapshots
  or changed binaries are reported through the CLI diagnostics.
- **CMakeWorkflow: Analyze Saved Profile** — select a directory containing saved
  captures. Calls `profile analyze` to regenerate analysis files and opens the
  result. It does not rerun the benchmark. The existing **Open Profile Results**
  command only reads saved results.

These commands require workspace trust and use the selected workspace's CLI
and environment. Run and Replay honor its `historyDb`; the results-directory
prompt defaults to `resultsDir` or `out/profiles`. Backend choices refer to the
workspace host, including Remote SSH/WSL/containers. Required profiler tools and
permissions must already be available; profiling does not install them implicitly.

Progress notifications support cancellation with the same process cancellation
policy as workflow runs. Errors and live CLI output go to **CMakeWorkflow** output.
Only a successful command opens the result viewer; canceled or failed commands
may leave partial artifacts. Since these CLI commands currently have no JSON
completion protocol, the extension reads their explicit `Profile analysis:` and
`Profile replay:` completion paths and never guesses a generated run directory.

## Targets, tool installation and campaigns

The **…** menus contain **CMake Targets**, **Tool Installation** and **DagFlow
Campaigns** submenus. All actions also appear in the command palette.

- **Build CMake Target**, **Invoke CMake Target**, **Build and Run CMake Target**
  inspect the selected build tree before selecting a target/configuration.
  Build accepts native executable/library targets; Run accepts executables.
  Invoke intentionally executes native targets, including utility/campaign
  targets, and supports entering a target absent from File API. Run accepts
  program arguments as a JSON array. **Run Two-Target Sequence** calls
  `workflow sequence`: the CLI builds/runs the first target before building
  and running the second. These commands do not create workflow manifests or
  automatically configure build trees.
- **Plan Tool Installation** selects one or more CLI tooling profiles, package
  manager, optional installation directory and fallback policy. The plan shows
  tools, executable/argument arrays, download sources and diagnostics.
  **Install Tools from Plan** shows that plan and requires explicit **Apply Plan**
  before passing `--yes` to `tooling setup`. It operates on the workspace host
  (including Remote SSH/containers). The CLI recomputes the plan at application
  time; installing system packages may require host permissions. Interactive
  privilege prompts are not provided by the extension's OutputChannel.
- **Run DagFlow Mutation Campaign**, **Run DagFlow Weak-Memory Campaign**,
  **Generate DagFlow Fuzz Seeds**, **Run DagFlow Fuzz Campaign**, **Triage DagFlow
  Fuzz Run**, and **Merge DagFlow Fuzz Corpus** open parameter pickers. Edit the
  fields and select **Run campaign**. Optional blank fields use CLI defaults;
  required fields must be selected. Source/build/Relacy directories, budgets,
  backend, corpus, replay-only and coverage-merge options map to their existing
  CLI contracts. Coverage merge can execute the fuzzer. The CLI validates layer,
  suite and protocol names and owns all corpus operations. Results/diagnostics
  appear in Output; **Open Campaign Report or Log** opens a file you select.

Long-running actions support cancellation and report nonzero exits. Canceling
tool installation or a campaign does not roll back changes already made by the
CLI. No campaign or installation starts automatically.

## Workflow selection and History controls

- **Run Selected Nodes and Dependencies** selects several nodes, plans with
  repeated `--only NODE`, and displays the CLI dependency closure before launch.
- **Set History Run Limit** changes workspace setting `cmakeWorkflow.historyLimit`
  (default 50). It also controls the pool used for automatic baseline selection.
- **Toggle History Recording** changes `cmakeWorkflow.noHistory` (default false).
  New workflow and manual profile runs then pass `--no-history` instead of
  `--history-db`. Saved reports remain available, and existing History can still
  be browsed. Automatic result comparison is skipped for unindexed workflow runs.
- **Inspect Run Measurements** calls `history metrics` with selected run, metric,
  variant and scenario, and displays the CLI's raw measurements. Large tables
  explicitly show at most 1000 rows; narrow the filters to inspect the rest.
- **Detect Regression** now exposes variant/scenario filters and significance
  level `alpha`. Statistical decisions remain in the CLI.
- **Show History Trend** allows selecting one run or the current History list,
  with server-side variant/scenario filters. The current-list view displays only
  loaded runs; the CLI query may return additional runs. The 32 MB response cap
  still applies, so narrow the query or choose one run for large catalogs.

## Visualizations

- **Show Workflow Graph** in the Workflow toolbar calls `workflow plan --json` and draws the CLI's dependency edges and node diagnostics. An invalid plan is still shown, so its errors can be inspected.
- Open an indexed workflow run in History to see an execution timeline, dependency graph and failed/blocked/canceled nodes. The extension loads the authoritative saved `workflow report RUN_DIRECTORY --json`; the failure section links to indexed stdout and stderr logs. If the report is unavailable, indexed run details remain visible.
- **Show History Trend** asks for an exact metric name, calls `history query --metric NAME --json` and plots raw samples from the current History run list in time order. It separates units, variants, scenarios and methods; it does not calculate a trend statistic or regression verdict. Large CLI JSON responses are rejected at 32 MB, with a request to narrow the query.
- The CLI comparison view highlights differing recorded host and build-environment fields beside the CLI's comparison status. Highlighting describes a difference; it does not override the CLI's comparability decision.
- The DagFlow harness comparison has a case-by-metric matrix colored by the direction and size of the difference between saved medians. Clicking a cell jumps to its raw sample chart. The matrix explicitly reports when the selected results have no common case/metric pairs. Color never implies a statistical verdict or that a larger value is better.

## Performance distributions and cancellation

Run comparisons now provide a full-range raw-sample plot, an optional p10–p90
focus view (with explicit counts of points outside its range) and a full-range
ECDF. Saved workflow reports also provide a logarithmic *duration breakdown*;
that view is not a concurrency timeline. These charts are descriptive: the CLI
remains authoritative for comparable measurements and statistical verdicts.

For workflows with explicitly declared `harnessDirectory` (supported by the
corresponding CLI patch), the CLI snapshots DagFlow harness outputs and imports
them into History; no build-tree scanning is performed by the VS Code extension.
See the CLI README for the required fresh-output-directory contract.

On Linux and macOS, Cancel first sends SIGINT to CMakeWorkflow so that it can
persist `canceled` state and clean up subprocesses, with a process-group kill
fallback after five seconds. On Windows the extension calls `taskkill /T /F` to
terminate descendants; this is forced termination and may leave the saved report
incomplete. An incomplete report must never be displayed as a successful run.

## Development checks

`npm test` compiles TypeScript, lints, bundles the extension and runs the Node
tests. Process tests use mocked children; command wizard tests drive a mocked
VS Code UI, including trust, cancellation, variant selection, installation
consent, argument arrays and menu contributions. They do not install tools or
require a CMakeWorkflow binary. `npm run package` produces the production
JavaScript bundle; it does not itself create a VSIX.

For an integration check, use a temporary configured CMake project with File
API metadata and the actual CLI. Exercise target build/run/invoke, a two-target
sequence, multiple `--only` selections, History filters and profile variants.
Profiler permissions depend on the workspace host: successful `perf stat`
captures do not imply that `perf record` or scheduler tracing is permitted.
If a capture fails, inspect **CMakeWorkflow** output for the original error;
a subsequent History import does not make that capture successful.

## Local Host Doctor and Fix

**CMakeWorkflow: Host Doctor (IPC Preview)** is available in the command palette
and **Workflow → … → Tools & Environment**. It checks tools through a local CMakeWorkflow Host
and displays progress and the resulting plan. It requires a CLI build containing
`host serve`; configure `cmakeWorkflow.executable` and `prefixArgs` as usual.

On first use the extension starts a private Host for the chosen workspace folder.
Subsequent checks reuse that process. **Stop Local Host** stops only a process
owned by this extension. The endpoint is printed in the CMakeWorkflow output and
can also be used by `CMakeWorkflow host doctor --endpoint ENDPOINT --profile cmake
--json`. Set `cmakeWorkflow.hostEndpoint` to attach to an existing Unix socket or
Windows named pipe instead; externally managed Hosts are never stopped by the
extension. In Remote SSH, WSL and containers, both the client and Host run on the
workspace host. Workspace trust is required.

When Doctor finds missing tools, click **Fix Missing Tools**. Alternatively use
**CMakeWorkflow: Fix Tools (Host)** from the command palette or **Tools & Environment**.
The extension displays the Host installation plan and asks for **Fix Tools**
confirmation. Installation, progress and the final verification run in Host using
the existing CLI installer. A changed, expired or already used plan cannot install
anything. Other Host installations are serialized; failures are never retried by
the extension.

After verified success, the extension sets the resource-scoped
`cmakeWorkflow.toolingInstallDirectory` and prepends it to PATH for this workspace's
CLI child processes. Global environment and shell startup files are untouched.
Existing CMake trees keep their recorded toolchain. The same setting selects a
custom directory for Host Doctor and Fix (relative paths resolve from the folder).

Linux system packages use noninteractive `sudo -n`. If authorization is unavailable,
review the diagnostic, install the shown packages in a terminal, and check again.
There is no password collection or automatic privilege elevation. Manual-only tools
remain explicit failures. Verified-release fallback is included in the displayed
plan when supported. The CLI provides advanced policy selection:

```sh
CMakeWorkflow host fix --endpoint ENDPOINT --profile native --dry-run --json
CMakeWorkflow host fix --endpoint ENDPOINT --profile native --yes --json
# Verification/manual diagnostics only; never installs or downloads:
CMakeWorkflow host fix --endpoint ENDPOINT --profile native --pm none --no-fallback --yes --json
```

Cancellation/disconnect or stopping an owned Host may leave a partial installation;
no rollback or durable resume is promised. Keep VS Code open during Fix and run
Doctor if the final result is lost. CLI previews and later `--yes` calls use different
connections: `--yes` authorizes a freshly calculated plan, revalidated before applying.
Package versions remain selected by the package manager/release source.

The existing Check Tools and Install Tools commands remain available. Presence and
version checks do not certify compiler features/profiler permissions, and no workflow
is automatically checked or installed on first Run.

Tests use mock IPC and mock VS Code UI by default. To additionally exercise a
published NativeAOT CLI, run:

```sh
CMAKEWORKFLOW_HOST_TEST_BINARY=/absolute/path/to/CMakeWorkflow npm test
npm run package
```

The real integration test is explicitly skipped without that variable. It checks
both clients against the same Host, separate workspaces, progress, errors,
reconnect, duplicate endpoints and cleanup. Unix additionally verifies that an
actual canceled probe exits. Fix integration uses `--pm none --no-fallback`, so no
package installation or downloads occur. Mocked UI tests cover explicit consent,
older Hosts, partial results, and workspace-only environment activation.
