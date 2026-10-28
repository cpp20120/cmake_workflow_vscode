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
