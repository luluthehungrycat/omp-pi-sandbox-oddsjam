/**
 * TUI adapter for /sandbox-configure.
 *
 * Flow:
 *   1. Scope picker (auto-skipped when only one option).
 *   2. Main editor — list of top-level fields with current values.
 *      Keys: ↑↓ navigate, enter open/toggle, a/d/x on lists, s save,
 *      t change scope, ? advanced toggle, esc/q quit.
 *   3. List editor — shown when entering a list field.
 */

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { Key, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";

import type { ScopeOption as ScopeOptionT } from "./wizard.ts";

import {
  type ConfigPaths,
  type ProjectsConfig,
  type SandboxConfig,
  BUILTIN_DEFAULT_CONFIG,
  findProjectKey,
  readDefault,
  readProjects,
  seedNewProjectEntry,
  validateConfig,
  writeDefault,
  writeProjects,
} from "./config.ts";
import { canonicalizePath } from "./paths.ts";
import {
  type FieldDef,
  type ScopeChoice,
  type ScopeOption,
  type ScopeSituation,
  DEFAULT_RECORD_VALUE,
  FIELDS,
  addListEntry,
  addRecordKey,
  buildScopeOptions,
  formatFieldValue,
  getField,
  recordKeys,
  recordValue,
  removeField,
  removeListEntry,
  removeRecordKey,
  setField,
  toggleBool,
} from "./wizard.ts";

interface WizardConfigDeps {
  cwd: string;
  home: string;
  paths: ConfigPaths;
}

/**
 * Compute the project situation for the current cwd.
 */
export function computeSituation(deps: WizardConfigDeps, projects: ProjectsConfig): ScopeSituation {
  const cwd = canonicalizePath(deps.cwd, deps.home);
  const match = findProjectKey(cwd, projects);
  if (match === null) return { kind: "none", cwd };
  if (match === cwd) return { kind: "exact", key: cwd };
  return { kind: "parent", parent: match, cwd };
}

/**
 * Top-level entry: prompts for scope (if needed), then runs the editor loop.
 *
 * On save:
 *  - "default"          → validates draft and writes default.json
 *  - "project-existing" → writes projects.json[key] = draft
 *  - "project-new"      → seeds projects.json[key] from sourceKey-or-default,
 *                         then on save writes projects.json[key] = draft.
 */
/**
 * A non-scope action that the user can pick from the top of the scope picker.
 * Used by /sandbox to expose "Disable sandbox" / "Enable sandbox" as the
 * first option, so hitting Enter immediately at the menu toggles the
 * sandbox state without entering the editor.
 */
export interface LeadAction {
  id: string;
  label: string;
  hint: string;
  /** Optional theme colour for the label (defaults to no special colour). */
  emphasis?: "accent" | "warning" | "error" | "success";
}

export interface WizardOptions {
  /**
   * Optional summary lines rendered above the scope picker. Used by
   * /sandbox to show the current effective config before the user picks
   * which scope to edit.
   */
  summary?: readonly string[];
  /**
   * Optional action rows rendered ABOVE the scope options. If the user picks
   * one, runWizard returns immediately with the action id (no editor opens).
   */
  leadActions?: readonly LeadAction[];
}

export type WizardResult =
  | { kind: "cancelled" }
  | { kind: "edited" }
  | { kind: "lead-action"; id: string };

export async function runWizard(
  ctx: ExtensionCommandContext,
  deps: WizardConfigDeps,
  opts: WizardOptions = {},
): Promise<WizardResult> {
  const projects = readProjects(deps.home);
  const defaults = readDefault(deps.home);
  const situation = computeSituation(deps, projects);
  const options = buildScopeOptions(situation, {
    defaultPath: deps.paths.defaultPath,
    projectsPath: deps.paths.projectsPath,
  });

  const pickResult = await pickScope(ctx, options, opts.summary ?? [], opts.leadActions ?? []);
  if (!pickResult) return { kind: "cancelled" };
  if (pickResult.kind === "lead-action") return { kind: "lead-action", id: pickResult.id };
  const scope = pickResult.scope;

  // Build the initial draft based on scope choice.
  let draft: Partial<SandboxConfig>;
  if (scope.choice.kind === "default") {
    draft = Object.keys(defaults).length === 0 ? structuredClone(BUILTIN_DEFAULT_CONFIG) : structuredClone(defaults);
  } else if (scope.choice.kind === "project-existing") {
    const entry = projects[scope.choice.key];
    draft = entry ? structuredClone(entry) : structuredClone(defaults);
  } else {
    // project-new: seed but don't persist until save
    const seeded = seedNewProjectEntry(
      projects,
      Object.keys(defaults).length === 0 ? BUILTIN_DEFAULT_CONFIG : defaults,
      scope.choice.sourceKey,
      scope.choice.key,
      (msg) => ctx.ui.notify(msg, "warning"),
    );
    draft = structuredClone(seeded[scope.choice.key] ?? defaults);
  }

  await editorLoop(ctx, deps, scope.choice, draft);
  return { kind: "edited" };
}

type PickResult =
  | { kind: "scope"; scope: ScopeOptionT }
  | { kind: "lead-action"; id: string };

/**
 * Scope picker rendered as a custom TUI component. Renders, in order:
 *   1. Summary lines (effective config), if any
 *   2. A separator (if both summary and rows are present)
 *   3. Lead-action rows (e.g. "Disable sandbox") — selected first, so
 *      hitting Enter immediately at the menu fires the first one
 *   4. Scope options (Edit project / Create new / Edit default)
 *
 * Returns either a scope option or a lead-action id. Esc cancels.
 */
async function pickScope(
  ctx: ExtensionCommandContext,
  options: readonly ScopeOptionT[],
  summary: readonly string[],
  leadActions: readonly LeadAction[],
): Promise<PickResult | undefined> {
  if (options.length === 0 && leadActions.length === 0) return undefined;

  const result = await ctx.ui.custom<PickResult | null>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    const totalRows = leadActions.length + options.length;

    function resolveSelection(): PickResult | null {
      if (selectedIndex < leadActions.length) {
        const action = leadActions[selectedIndex];
        if (!action) return null;
        return { kind: "lead-action", id: action.id };
      }
      const opt = options[selectedIndex - leadActions.length];
      if (!opt) return null;
      return { kind: "scope", scope: opt };
    }

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        for (const line of summary) {
          lines.push(truncateToWidth(line, width));
        }
        if (summary.length > 0) {
          lines.push("");
          lines.push(truncateToWidth(theme.fg("dim", "─".repeat(Math.max(20, Math.min(width, 60)))), width));
          lines.push("");
        }
        lines.push(truncateToWidth(theme.fg("accent", "Sandbox — pick an action:"), width));
        lines.push("");

        // Lead actions first.
        for (let i = 0; i < leadActions.length; i++) {
          const a = leadActions[i];
          if (!a) continue;
          const isSel = i === selectedIndex;
          const prefix = isSel ? " → " : "   ";
          const label = a.emphasis ? theme.fg(a.emphasis, a.label) : a.label;
          const styledLabel = isSel ? theme.fg("accent", a.label) : label;
          lines.push(truncateToWidth(`${prefix}${styledLabel}`, width));
          lines.push(truncateToWidth(`     ${theme.fg("dim", a.hint)}`, width));
        }
        if (leadActions.length > 0 && options.length > 0) {
          lines.push("");
        }

        // Scope options.
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          if (!opt) continue;
          const rowIdx = leadActions.length + i;
          const isSel = rowIdx === selectedIndex;
          const prefix = isSel ? " → " : "   ";
          const label = isSel ? theme.fg("accent", opt.label) : opt.label;
          lines.push(truncateToWidth(`${prefix}${label}`, width));
          lines.push(truncateToWidth(`     ${theme.fg("dim", opt.hint)}`, width));
        }

        lines.push("");
        lines.push(truncateToWidth(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), width));
        return lines;
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(null);
          return;
        }
        if (matchesKey(data, Key.up)) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          selectedIndex = Math.min(totalRows - 1, selectedIndex + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          done(resolveSelection());
          return;
        }
      },

      invalidate(): void {},
    };
  });

  return result ?? undefined;
}

async function editorLoop(
  ctx: ExtensionCommandContext,
  deps: WizardConfigDeps,
  scope: ScopeChoice,
  initialDraft: Partial<SandboxConfig>,
): Promise<void> {
  let draft = initialDraft;
  let showAdvanced = false;
  let savedAt: string | null = null;

  while (true) {
    const visibleFields = FIELDS.filter((f) => showAdvanced || !f.advanced);
    const result = await runMainView(ctx, deps, scope, draft, visibleFields, savedAt, showAdvanced);

    if (result.kind === "quit") return;
    if (result.kind === "toggle-advanced") {
      showAdvanced = !showAdvanced;
      continue;
    }
    if (result.kind === "save") {
      const validation = validateConfig(draft);
      if (!validation.ok) {
        ctx.ui.notify(`Save failed (validation): ${validation.error}`, "error");
        continue;
      }
      await persist(scope, validation.config, deps);
      savedAt = new Date().toLocaleTimeString();
      ctx.ui.notify("Sandbox config saved", "info");
      continue;
    }
    if (result.kind === "select-field") {
      const field = result.field;
      if (!field) continue;
      if (field.kind === "bool") {
        draft = toggleBool(draft, field);
        continue;
      }
      if (field.kind === "list") {
        draft = await runListEditor(ctx, deps, scope, draft, field);
        continue;
      }
      if (field.kind === "record") {
        draft = await runRecordEditor(ctx, deps, scope, draft, field);
        continue;
      }
      if (field.kind === "number" || field.kind === "string") {
        const cur = getField(draft, field);
        const input = await ctx.ui.input(`Set ${field.label}:`, cur === undefined ? "" : String(cur));
        if (input === undefined) continue;
        if (input.trim() === "") {
          // Empty input removes the field.
          draft = removeField(draft, field);
        } else if (field.kind === "number") {
          const n = Number(input);
          if (!Number.isFinite(n)) {
            ctx.ui.notify("Not a valid number", "error");
            continue;
          }
          draft = setField(draft, field, n);
        } else {
          draft = setField(draft, field, input);
        }
        continue;
      }
    }
  }
}

interface MainViewResult {
  kind: "quit" | "save" | "toggle-advanced" | "select-field";
  field?: FieldDef;
}

function describeScope(scope: ScopeChoice): string {
  if (scope.kind === "default") return "default config";
  if (scope.kind === "project-existing") return `project ${scope.key}`;
  return `new project ${scope.key} (unsaved until save)`;
}

async function runMainView(
  ctx: ExtensionCommandContext,
  deps: WizardConfigDeps,
  scope: ScopeChoice,
  draft: Partial<SandboxConfig>,
  visibleFields: readonly FieldDef[],
  savedAt: string | null,
  showAdvanced: boolean,
): Promise<MainViewResult> {
  const result = await ctx.ui.custom<MainViewResult>((tui, theme, _kb, done) => {
    let selectedIndex = 0;

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(truncateToWidth(theme.fg("accent", `Sandbox configure — ${describeScope(scope)}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `cwd: ${deps.cwd}`), width));
        if (savedAt) lines.push(truncateToWidth(theme.fg("dim", `last saved: ${savedAt}`), width));
        lines.push("");

        for (let i = 0; i < visibleFields.length; i++) {
          const f = visibleFields[i];
          if (!f) continue;
          const isSel = i === selectedIndex;
          const prefix = isSel ? " → " : "   ";
          const value = formatFieldValue(f, getField(draft, f));
          const label = f.advanced ? theme.fg("dim", f.label) : f.label;
          const valueStr = theme.fg(f.kind === "list" ? "accent" : "dim", value);
          lines.push(truncateToWidth(`${prefix}${label.padEnd(36)} ${valueStr}`, width));
        }

        lines.push("");
        const helpKeys = [
          "↑↓ navigate",
          "enter open/toggle",
          "s save",
          "t change scope",
          showAdvanced ? "? hide advanced" : "? show advanced",
          "esc/q quit",
        ];
        lines.push(truncateToWidth(theme.fg("dim", helpKeys.join("  ")), width));
        return lines;
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
          done({ kind: "quit" });
          return;
        }
        if (matchesKey(data, Key.up)) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          selectedIndex = Math.min(visibleFields.length - 1, selectedIndex + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const f = visibleFields[selectedIndex];
          if (f) done({ kind: "select-field", field: f });
          return;
        }
        if (data === "s") {
          done({ kind: "save" });
          return;
        }
        if (data === "t") {
          // "change scope" — close and restart wizard from scratch
          done({ kind: "quit" });
          // Schedule a re-run on next tick — caller doesn't currently handle it,
          // so user just gets a notification to re-run the command.
          ctx.ui.notify("Run /sandbox-configure again to pick a different scope", "info");
          return;
        }
        if (data === "?") {
          done({ kind: "toggle-advanced" });
          return;
        }
      },

      invalidate(): void {},
    };
  });

  return result ?? { kind: "quit" };
}

async function runListEditor(
  ctx: ExtensionCommandContext,
  _deps: WizardConfigDeps,
  _scope: ScopeChoice,
  draft: Partial<SandboxConfig>,
  field: FieldDef,
): Promise<Partial<SandboxConfig>> {
  let current = draft;

  while (true) {
    const action = await ctx.ui.custom<{ kind: "back" } | { kind: "add" } | { kind: "delete"; index: number }>(
      (tui, theme, _kb, done) => {
        let selectedIndex = 0;

        function listLen(): number {
          const cur = getField(current, field);
          return Array.isArray(cur) ? cur.length : 0;
        }

        return {
          render(width: number): string[] {
            const lines: string[] = [];
            lines.push(truncateToWidth(theme.fg("accent", `Editing ${field.label}`), width));
            lines.push("");
            const cur = getField(current, field);
            const arr = Array.isArray(cur) ? (cur as string[]) : [];
            if (arr.length === 0) {
              lines.push(truncateToWidth(theme.fg("dim", "  (empty)"), width));
            } else {
              for (let i = 0; i < arr.length; i++) {
                const prefix = i === selectedIndex ? " → " : "   ";
                lines.push(truncateToWidth(`${prefix}${arr[i] ?? ""}`, width));
              }
            }
            lines.push("");
            lines.push(truncateToWidth(theme.fg("dim", "↑↓ navigate  a add  d delete  esc/b back"), width));
            return lines;
          },

          handleInput(data: string): void {
            if (matchesKey(data, Key.escape) || data === "b") {
              done({ kind: "back" });
              return;
            }
            if (matchesKey(data, Key.up)) {
              selectedIndex = Math.max(0, selectedIndex - 1);
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.down)) {
              selectedIndex = Math.min(Math.max(0, listLen() - 1), selectedIndex + 1);
              tui.requestRender();
              return;
            }
            if (data === "a") {
              done({ kind: "add" });
              return;
            }
            if (data === "d") {
              if (listLen() > 0) done({ kind: "delete", index: selectedIndex });
              return;
            }
          },

          invalidate(): void {},
        };
      },
    );

    if (!action || action.kind === "back") return current;
    if (action.kind === "add") {
      const value = await ctx.ui.input(`Add to ${field.label}:`, "");
      if (value === undefined) continue;
      current = addListEntry(current, field, value);
      continue;
    }
    if (action.kind === "delete") {
      current = removeListEntry(current, field, action.index);
      continue;
    }
  }
}

/**
 * Editor for `Record<string, string[]>` fields (currently just
 * `ignoreViolations`).
 *
 * The UX intentionally only exposes add/remove of the top-level key (the
 * command-prefix pattern). New keys are seeded with `["*"]`, which matches
 * every path the prefix could emit — the common case the user wants when
 * silencing a noisy command.
 *
 * Existing values are displayed beside their key so the user can see when
 * they aren't the default; editing the value array itself is left to raw
 * JSON, matching the philosophy used elsewhere for niche nested shapes.
 */
async function runRecordEditor(
  ctx: ExtensionCommandContext,
  _deps: WizardConfigDeps,
  _scope: ScopeChoice,
  draft: Partial<SandboxConfig>,
  field: FieldDef,
): Promise<Partial<SandboxConfig>> {
  let current = draft;

  while (true) {
    const action = await ctx.ui.custom<
      | { kind: "back" }
      | { kind: "add" }
      | { kind: "delete"; key: string }
    >((tui, theme, _kb, done) => {
      let selectedIndex = 0;

      function keys(): string[] {
        return recordKeys(current, field);
      }

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          lines.push(truncateToWidth(theme.fg("accent", `Editing ${field.label}`), width));
          lines.push(
            truncateToWidth(
              theme.fg("dim", `New prefixes default to ${JSON.stringify(DEFAULT_RECORD_VALUE)}`),
              width,
            ),
          );
          lines.push("");
          const ks = keys();
          if (ks.length === 0) {
            lines.push(truncateToWidth(theme.fg("dim", "  (empty)"), width));
          } else {
            // Clamp selection in case the list shrank after a delete.
            if (selectedIndex >= ks.length) selectedIndex = ks.length - 1;
            for (let i = 0; i < ks.length; i++) {
              const k = ks[i] ?? "";
              const value = recordValue(current, field, k);
              const prefix = i === selectedIndex ? " → " : "   ";
              const valueStr = theme.fg("dim", JSON.stringify(value));
              lines.push(truncateToWidth(`${prefix}${k}  ${valueStr}`, width));
            }
          }
          lines.push("");
          lines.push(truncateToWidth(theme.fg("dim", "↑↓ navigate  a add prefix  d delete  esc/b back"), width));
          return lines;
        },

        handleInput(data: string): void {
          if (matchesKey(data, Key.escape) || data === "b") {
            done({ kind: "back" });
            return;
          }
          if (matchesKey(data, Key.up)) {
            selectedIndex = Math.max(0, selectedIndex - 1);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down)) {
            selectedIndex = Math.min(Math.max(0, keys().length - 1), selectedIndex + 1);
            tui.requestRender();
            return;
          }
          if (data === "a") {
            done({ kind: "add" });
            return;
          }
          if (data === "d") {
            const ks = keys();
            const k = ks[selectedIndex];
            if (k !== undefined) done({ kind: "delete", key: k });
            return;
          }
        },

        invalidate(): void {},
      };
    });

    if (!action || action.kind === "back") return current;
    if (action.kind === "add") {
      const value = await ctx.ui.input(
        `Add prefix to ${field.label} (value defaults to ${JSON.stringify(DEFAULT_RECORD_VALUE)}):`,
        "",
      );
      if (value === undefined) continue;
      current = addRecordKey(current, field, value);
      continue;
    }
    if (action.kind === "delete") {
      current = removeRecordKey(current, field, action.key);
      continue;
    }
  }
}

async function persist(scope: ScopeChoice, config: SandboxConfig, deps: WizardConfigDeps): Promise<void> {
  if (scope.kind === "default") {
    writeDefault(config, deps.home);
    return;
  }
  // project-existing or project-new: read latest, set the key, write back.
  const projects = readProjects(deps.home);
  const key = scope.key;
  projects[key] = config;
  writeProjects(projects, deps.home);
}
