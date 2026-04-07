import * as vscode from "vscode";
import { exec, execSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename, dirname } from "path";

/** Lit substitutions resolved asynchronously at activation. */
let litSubsPromise: Promise<Record<string, string>> | null = null;

/** Cache of resolved substitutions — grows as new %-vars are discovered. */
const resolvedCache: Record<string, string> = {};

/** Directory for output files — persists across runs for LSP support. */
const outputDir = join(tmpdir(), "lit-runner-output");

export function activate(context: vscode.ExtensionContext) {
  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Pre-resolve %PYTHON from VS Code at activation
  resolvedCache["%PYTHON"] = getPythonInterpreter();

  const runCommand = vscode.commands.registerCommand(
    "lit-runner.run",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;
      const fullText = document.getText();
      const filePath = document.fileName;
      const isMLIR = filePath.endsWith(".mlir");
      const isPython = filePath.endsWith(".py");

      // 1. Parse RUN lines and deduplicate by the executable part
      const runLines = parseRunLines(fullText, isPython);
      if (runLines.length === 0) {
        vscode.window.showWarningMessage("No RUN command found in file.");
        return;
      }

      const uniqueCommands = deduplicateRunLines(runLines);

      // 2. Pick command if multiple distinct ones exist
      let selectedRun: string;
      if (uniqueCommands.length === 1) {
        selectedRun = uniqueCommands[0];
      } else {
        const pick = await vscode.window.showQuickPick(
          uniqueCommands.map((cmd, i) => ({
            label: `RUN #${i + 1}`,
            description: cmd,
          })),
          { placeHolder: "Select which RUN command to execute" }
        );
        if (!pick) {
          return;
        }
        selectedRun = pick.description!;
      }

      // 3. Get the input: MLIR section/selection or full Python file
      let inputFile: string;
      let tmpFile: string | null = null;
      let sectionName: string | null;

      if (isMLIR) {
        let snippet: string;
        if (!editor.selection.isEmpty) {
          snippet = document.getText(editor.selection);
        } else {
          snippet = extractSection(fullText, editor.selection.active.line);
        }
        sectionName = extractName(snippet);
        tmpFile = join(tmpdir(), `lit-runner-${Date.now()}.mlir`);
        writeFileSync(tmpFile, snippet);
        inputFile = tmpFile;
      } else {
        inputFile = filePath;
        sectionName = extractName(fullText);
      }

      // 4. Resolve any %-substitutions in the RUN line, build command, and run
      const fileName = basename(filePath).replace(/\.[^.]+$/, "");
      const subs = await ensureSubstitutions(runLines);
      try {
        const cmd = buildCommand(selectedRun, inputFile, filePath, subs);
        const result = runShellCommand(cmd, dirname(filePath));
        const title = sectionName
          ? `${fileName} → ${sectionName}`
          : `${fileName} → output`;
        const ext = isMLIR ? ".mlir" : ".py";
        await showOutput(title, result, ext);
      } catch (err: any) {
        const title = `${fileName} → ERROR`;
        await showOutput(title, err.message || String(err), ".txt");
      } finally {
        if (tmpFile) {
          try { unlinkSync(tmpFile); } catch {}
        }
      }
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    "lit-runner.refreshSubstitutions",
    async () => {
      // Clear cache and re-resolve %PYTHON
      for (const key of Object.keys(resolvedCache)) {
        delete resolvedCache[key];
      }
      resolvedCache["%PYTHON"] = getPythonInterpreter();
      vscode.window.showInformationMessage(
        "Lit Runner: substitution cache cleared. Variables will be re-resolved on next run."
      );
    }
  );

  context.subscriptions.push(runCommand, refreshCommand);
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/**
 * Extract the `// -----` delimited section containing the cursor line.
 * MLIR lit tests use `// -----` (with -split-input-file) to separate
 * independent test cases within a single file.
 */
function extractSection(text: string, cursorLine: number): string {
  const lines = text.split("\n");
  const separator = /^\/\/ -----/;
  let start = 0;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (separator.test(lines[i])) {
      if (i <= cursorLine) {
        start = i + 1;
      } else {
        end = i;
        break;
      }
    }
  }
  return lines.slice(start, end).join("\n");
}

// ---------------------------------------------------------------------------
// Name extraction for tab title
// ---------------------------------------------------------------------------

/**
 * Extract a meaningful name from the snippet for the output tab title.
 * Looks for func.func @name, module @name, def name(), or any @name.
 */
function extractName(snippet: string): string | null {
  const funcMatch = snippet.match(/func(?:\.func)?\s+@(\w+)/);
  if (funcMatch) { return funcMatch[1]; }
  const moduleMatch = snippet.match(/module\s+@(\w+)/);
  if (moduleMatch) { return moduleMatch[1]; }
  const defMatch = snippet.match(/def\s+(\w+)\s*\(/);
  if (defMatch) { return defMatch[1]; }
  const anyMatch = snippet.match(/@(\w+)/);
  if (anyMatch) { return anyMatch[1]; }
  return null;
}

// ---------------------------------------------------------------------------
// RUN line parsing and deduplication
// ---------------------------------------------------------------------------

/** Parse all RUN lines from the file. Supports both `// RUN:` and `# RUN:`. */
function parseRunLines(text: string, isPython: boolean): string[] {
  const prefix = isPython ? "#" : "//";
  const escaped = prefix.replace(/\//g, "\\/");
  const pattern = new RegExp(
    `^\\s*${escaped}\\s*RUN:\\s*(.+)$`, "gm"
  );
  const results: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/**
 * Strip the FileCheck tail from a RUN line to get just the executable part.
 * Used for deduplication: two RUN lines that only differ in FileCheck
 * flags (e.g. --check-prefix) are considered the same command.
 */
function stripFileCheck(runLine: string): string {
  return runLine.replace(/\s*\|\s*FileCheck.*$/, "").trim();
}

/**
 * Deduplicate RUN lines by their executable portion.
 * Only shows the picker when commands actually differ.
 */
function deduplicateRunLines(runLines: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of runLines) {
    const key = stripFileCheck(line);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(line);
    }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Substitution resolution
// ---------------------------------------------------------------------------

/** Built-in %-variables handled directly (not sent to lit echo). */
const BUILTIN_VARS = new Set(["%s", "%t", "%S"]);

/**
 * Extract %-variables from RUN lines. Returns variables like %PYTHON,
 * etc. — excluding builtins (%s, %t) that are
 * handled directly in buildCommand.
 */
function extractSubstitutionVars(runLines: string[]): string[] {
  const vars = new Set<string>();
  for (const line of runLines) {
    for (const m of line.matchAll(/%[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!BUILTIN_VARS.has(m[0])) {
        vars.add(m[0]);
      }
    }
  }
  return Array.from(vars);
}

/**
 * Ensure all %-variables needed by the RUN lines are resolved.
 * Uses a cache so each variable is only probed once per session.
 *
 * Resolution priority:
 * 1. User-configured overrides in litRunner.substitutions (highest)
 * 2. %PYTHON from VS Code Python extension
 * 3. Other variables probed via the lit echo trick
 */
async function ensureSubstitutions(
  runLines: string[]
): Promise<Record<string, string>> {
  const userSubs =
    vscode.workspace
      .getConfiguration("litRunner")
      .get<Record<string, string>>("substitutions") || {};

  const needed = extractSubstitutionVars(runLines);
  const missing = needed.filter((v) => !resolvedCache[v] && !userSubs[v]);

  if (missing.length > 0) {
    const probed = await runLitEchoProbe(getWorkspaceRoot(), missing);
    Object.assign(resolvedCache, probed);
  }

  return { ...resolvedCache, ...userSubs };
}

/**
 * Get the Python interpreter from VS Code's Python extension.
 * Priority: active environment API → defaultInterpreterPath setting → "python3".
 */
function getPythonInterpreter(): string {
  const pythonExt = vscode.extensions.getExtension("ms-python.python");
  if (pythonExt?.isActive) {
    try {
      const envPath = pythonExt.exports?.environments?.getActiveEnvironmentPath?.();
      if (envPath?.path) {
        return envPath.path;
      }
    } catch {}
  }

  const configured = vscode.workspace
    .getConfiguration("python")
    .get<string>("defaultInterpreterPath");
  if (configured && configured !== "python") {
    return configured;
  }

  return "python3";
}

/**
 * Probe lit substitutions by creating a temp .mlir in build/test/,
 * running `lit -a` on it, and parsing echoed values. Runs async so
 * it doesn't block the VS Code event loop.
 */
function runLitEchoProbe(
  workspaceRoot: string,
  probeVars: string[]
): Promise<Record<string, string>> {
  if (probeVars.length === 0) {
    return Promise.resolve({});
  }

  const buildTestDir = join(workspaceRoot, "build", "test");
  const marker = "LIT_SUBST_PROBE";
  const echoLines = probeVars
    .map((v, i) => `// RUN: echo "${marker}:${i}:${v}"`)
    .join("\n");

  const probeBuildFile = join(buildTestDir, `_lit_probe_${Date.now()}.mlir`);

  return new Promise((resolve) => {
    try {
      writeFileSync(probeBuildFile, echoLines + "\n");
    } catch {
      resolve({});
      return;
    }

    exec(
      `lit --no-progress-bar -a '${probeBuildFile}' 2>&1`,
      { encoding: "utf-8", timeout: 15000, cwd: workspaceRoot },
      (err, stdout) => {
        try { unlinkSync(probeBuildFile); } catch {}

        const resolved: Record<string, string> = {};
        const output = stdout || "";

        for (const line of output.split("\n")) {
          const m = line.match(new RegExp(`${marker}:(\\d+):(.*)`));
          if (m) {
            const idx = parseInt(m[1], 10);
            const value = m[2].trim();
            if (idx < probeVars.length && value !== probeVars[idx]) {
              resolved[probeVars[idx]] = value;
            }
          }
        }

        resolve(resolved);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

/**
 * Build a shell command from a RUN line:
 * - Strips `| FileCheck ...` suffix (we want raw output, not validation)
 * - Strips `-split-input-file` when running a single extracted section
 * - Replaces %s with the input file, %t with a temp path
 * - Applies resolved lit substitutions (longest key first)
 */
function buildCommand(
  runLine: string,
  inputFile: string,
  originalFile: string,
  subs: Record<string, string>
): string {
  let cmd = stripFileCheck(runLine);

  // Strip -split-input-file only when running a single section
  if (inputFile !== originalFile) {
    cmd = cmd.replace(/\s+--?split-input-file\b/g, "");
  }

  // Replace %s with input file
  cmd = cmd.replace(/%s/g, `'${inputFile}'`);

  // Replace %t with a temp output path
  const tmpOut = join(tmpdir(), `lit-runner-out-${Date.now()}`);
  cmd = cmd.replace(/%t\b/g, tmpOut);

  // Apply substitutions (longest key first to avoid partial matches)
  const sortedKeys = Object.keys(subs).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    cmd = cmd.split(key).join(subs[key]);
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return "";
}

function runShellCommand(cmd: string, cwd: string): string {
  try {
    return execSync(`${cmd} 2>&1`, {
      encoding: "utf-8",
      timeout: 60000,
      cwd,
    });
  } catch (err: any) {
    if (err.stdout || err.stderr) {
      return (err.stdout || "") + (err.stderr || "");
    }
    throw err;
  }
}

/**
 * Show output in a real file (not a virtual document) so that LSP servers
 * (e.g. mlir-lsp-server) can attach and provide full language features
 * like go-to-definition and hover.
 */
async function showOutput(
  title: string,
  content: string,
  ext: string
) {
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  const filePath = join(outputDir, `${safeName}${ext}`);
  writeFileSync(filePath, content);

  const uri = vscode.Uri.file(filePath);

  // If the document is already open, revert it to pick up fresh content
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.fsPath === uri.fsPath && !doc.isDirty) {
      await vscode.commands.executeCommand("workbench.action.files.revert", uri);
      break;
    }
  }

  const doc = await vscode.workspace.openTextDocument(uri);

  // Ensure correct language ID so the LSP activates
  const langId = ext === ".mlir" ? "mlir" : ext === ".py" ? "python" : "plaintext";
  if (doc.languageId !== langId) {
    await vscode.languages.setTextDocumentLanguage(doc, langId);
  }

  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    preserveFocus: false,
  });
}

export function deactivate() {}
