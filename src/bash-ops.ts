/**
 * Custom bash operations that wrap commands with SandboxManager.wrapWithSandbox
 * (OS-level sandbox-exec on macOS, bubblewrap on Linux).
 *
 * Mirrors the implementation in pi-sandbox.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { getShellConfig } from "@oh-my-pi/pi-utils/procmgr";

export function createSandboxedBashOps(shellPath?: string): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      const { shell, args } = getShellConfig(shellPath);
      const wrappedCommand = await SandboxManager.wrapWithSandbox(command, shell);
      const sandboxEnv = Object.fromEntries(
        Object.entries(env ?? process.env).filter(([key]) =>
          !/^(SSH_AUTH_SOCK|SSH_AGENT_PID|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS|GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|HF_TOKEN|HUGGING_FACE_HUB_TOKEN)/.test(key),
        ),
      ) as NodeJS.ProcessEnv;

      return new Promise((resolve, reject) => {
        const child = spawn(shell, [...args, wrappedCommand], {
          cwd,
          env: sandboxEnv,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = (): void => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}
