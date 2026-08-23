/**
 * TUI adapter for the permission prompt. The state machine lives in
 * prompt.ts — this file only translates keyboard events and renders.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { Key, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";

import {
  type PromptAction,
  type PromptKey,
  type PromptOption,
  type PromptState,
  initPromptState,
  stepPromptState,
} from "./prompt.ts";

export async function showPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
  options: PromptOption[],
): Promise<PromptAction> {
  if (!ctx.hasUI) return { kind: "abort" };

  const action = await ctx.ui.custom<PromptAction>((tui, theme, _kb, done) => {
    let state: PromptState = initPromptState(options);

    function feed(key: PromptKey): void {
      const step = stepPromptState(state, key);
      if (step.kind === "resolve") {
        done(step.action);
        return;
      }
      state = step.state;
      tui.requestRender();
    }

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(truncateToWidth(theme.fg("warning", title), width));
        lines.push("");

        for (let i = 0; i < state.options.length; i++) {
          const opt = state.options[i];
          if (!opt) continue;
          const isSelected = i === state.selectedIndex;
          const isPending = state.pendingIndex === i;
          const prefix = isSelected ? " → " : "   ";
          const keyHint = theme.fg("accent", `[${opt.key}]`);
          let label = opt.label;
          if ("hint" in opt) label += `  ${theme.fg("dim", opt.hint)}`;
          if (isPending) label += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
          lines.push(truncateToWidth(`${prefix}${keyHint} ${label}`, width));
        }

        lines.push("");
        const footer =
          state.pendingIndex !== null
            ? "↑↓ navigate  enter confirm  esc cancel"
            : "↑↓ navigate  enter select  esc/ctrl+c cancel  lowercase=confirm  UPPERCASE=immediate";
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          feed({ kind: "escape" });
          return;
        }
        if (matchesKey(data, Key.enter)) {
          feed({ kind: "enter" });
          return;
        }
        if (matchesKey(data, Key.up)) {
          feed({ kind: "up" });
          return;
        }
        if (matchesKey(data, Key.down)) {
          feed({ kind: "down" });
          return;
        }
        // Single-character keypress
        if (data.length === 1) {
          feed({ kind: "char", value: data });
        }
      },

      invalidate(): void {
        // no-op
      },
    };
  });

  return action ?? { kind: "abort" };
}
