# Lit Runner

A VS Code extension for running [LLVM lit](https://llvm.org/docs/CommandGuide/lit.html) `RUN` commands interactively — on a single MLIR section, a text selection, or a Python lit test — with the output displayed in a side panel with full LSP support.

![demo](https://img.shields.io/badge/status-alpha-orange)

## Features

- **Run a single section** — Place your cursor inside a `// -----` delimited section in an MLIR file and press `Ctrl+Shift+M`. The extension extracts that section, runs the file's `RUN` command on it (stripping `-split-input-file` and `| FileCheck`), and shows the output alongside.

- **Run a selection** — Select any MLIR text and run the command on just that selection.

- **Run Python lit tests** — Works on `.py` files with `# RUN:` directives too.

- **LSP on output** — Output is written to a `.mlir` file, so your MLIR LSP server (e.g. `mlir-lsp-server`) attaches automatically. You get syntax highlighting, go-to-definition, hover info, and diagnostics on the transformed output.

- **Right-click menu** — "Lit: Run on selection/section" appears in the editor context menu for `.mlir` and `.py` files.

- **Automatic substitution resolution** — `%PYTHON` is resolved from VS Code's selected Python interpreter. Other lit substitutions are resolved dynamically at activation time.

## How It Works

### MLIR Section Extraction

MLIR lit tests use `// -----` separators with the `-split-input-file` flag to define independent test cases in a single file:

```mlir
// RUN: my-opt -some-pass -split-input-file %s | FileCheck %s

func.func @test_a() { ... }

// -----

func.func @test_b() { ... }
```

When you press `Ctrl+Shift+M` with your cursor in `@test_b`, the extension:

1. Extracts only the `@test_b` section
2. Writes it to a temp file
3. Runs `my-opt -some-pass <temp-file>` (no `-split-input-file`, no `FileCheck`)
4. Shows the output in a side-by-side `.mlir` tab named `filename → test_b`

### Substitution Resolution (Hybrid Approach)

Lit tests use `%`-substitutions like `%s`, `%t`, `%PYTHON`, and project-specific variables. The extension resolves these through three layers:

| Variable | Source |
|----------|--------|
| `%s` | Replaced with the input file path |
| `%t` | Replaced with a temp output path |
| `%PYTHON` | VS Code Python extension's selected interpreter |
| Other `%`-vars | **Lit echo trick**: creates a temp `.mlir` in `build/test/` with `// RUN: echo "MARKER:%var"`, runs `lit -a` on it, parses the output |
| Any variable | User override via `litRunner.substitutions` setting (highest priority) |

### Output as Real Files

Output is written to `/tmp/lit-runner-output/<name>.mlir`:

- **LSP support** — MLIR LSP servers only attach to `file:` scheme documents. Virtual documents (`lit-output:` scheme) get syntax highlighting but no go-to-def, hover, or diagnostics.
- **Re-running** — Same section → same filename → file gets overwritten and reverted in the editor automatically.

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `litRunner.substitutions` | `object` | `{}` | Extra `%`-substitution overrides as key-value pairs |

Example in `.vscode/settings.json`:

```json
{
  "litRunner.substitutions": {
    "%MY_CUSTOM_TOOL": "/opt/tools/bin/my-tool",
    "%PYTHON": "/usr/bin/python3.12"
  }
}
```

### Keybinding

Default: `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac)

To customize, add to `keybindings.json`:

```json
{
  "key": "ctrl+alt+r",
  "command": "lit-runner.run",
  "when": "editorTextFocus"
}
```

## Commands

| Command | Title | Description |
|---------|-------|-------------|
| `lit-runner.run` | Lit: Run on selection/section | Run the RUN command on the current section or selection |
| `lit-runner.refreshSubstitutions` | Lit: Refresh substitutions | Re-resolve all lit substitutions (useful after rebuilding) |

## Requirements

- **VS Code** ≥ 1.80
- **lit** on `PATH` (for the echo trick; falls back to static defaults if unavailable)
- The tool referenced in your `RUN` line (e.g. `mlir-opt`) must be on `PATH` or referenced by absolute path
- (Optional) [MLIR extension](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-mlir) for LSP on output files
- (Optional) [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) for `%PYTHON` resolution

## License

MIT
