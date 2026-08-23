import { mkdir, writeFile } from "node:fs/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createSandboxedBashOps } from "./src/bash-ops.ts";

const cwd = "/home/hermes/omp-sandbox-dev/test-project";
const secret = "/home/hermes/omp-sandbox-dev/test-home/runtime-secret.txt";
await mkdir(cwd, { recursive: true });
await writeFile(secret, "RUNTIME_HOST_SECRET\n");
const hostPid = String(process.pid);
const config = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: {
    denyRead: ["/home"],
    allowRead: [cwd, "/home/hermes/omp-sandbox-dev/plugins/pi-sandbox-oddsjam/node_modules/@anthropic-ai/sandbox-runtime/vendor"],
    allowWrite: [cwd],
    denyWrite: [],
  },
  enableWeakerNetworkIsolation: true,
};
await SandboxManager.initialize(config, async () => false);
const ops = createSandboxedBashOps("/bin/bash");
const probes = [
  ["write-project", `printf RUNTIME_OK > ${cwd}/runtime-inside.txt`, "pass"],
  ["write-outside", `printf ESCAPE > /home/hermes/omp-sandbox-dev/test-result/runtime-outside.txt`, "deny"],
  ["read-host-secret", `test "$(cat ${secret})" = RUNTIME_HOST_SECRET`, "deny"],
  ["docker-socket-visible", `test -S /var/run/docker.sock`, "observe"],
  ["docker-socket-connect", `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(1); s.connect("/var/run/docker.sock")'`, "deny"],
  ["ssh-agent", `test -n "$SSH_AUTH_SOCK" && test -S "$SSH_AUTH_SOCK"`, "deny"],
  ["host-pid", `test -e /proc/${hostPid}`, "deny"],
  ["network", `curl --connect-timeout 2 --silent --show-error https://example.com >/dev/null`, "deny"],
  ["nested-eval", `eval 'printf NESTED_OK > ${cwd}/runtime-nested.txt'`, "pass"],
] as const;
const results = [];
for (const [name, command, expected] of probes) {
  let output = "";
  try {
    const result = await ops.exec(command, cwd, {
      onData: (chunk) => { output += chunk.toString(); },
      signal: undefined,
      timeout: 5,
      env: { ...process.env, HOST_PID: hostPid },
    });
    const passed = expected === "observe" ? true : expected === "pass" ? result.exitCode === 0 : result.exitCode !== 0;
    results.push({ name, expected, passed, exitCode: result.exitCode, output: output.slice(0, 300) });
  } catch (error) {
    results.push({ name, expected, passed: expected === "deny", error: String(error), output: output.slice(0, 300) });
  }
}
await SandboxManager.reset();
console.log(JSON.stringify({ results }, null, 2));
