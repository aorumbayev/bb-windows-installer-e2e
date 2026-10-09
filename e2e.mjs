// End-to-end check of bb's real Windows installer: install, start, health, quit, uninstall.
// Usage: node e2e.mjs <path-to-bb-x.y.z-x64.exe>
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const installer = process.argv[2];
const installDir = join(process.env.LOCALAPPDATA, "Programs", "bb");
const app = join(installDir, "bb.exe");
const uninstaller = join(installDir, "Uninstall bb.exe");
const results = [];

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

function warn(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "WARN"} ${name}${detail ? `: ${detail}` : ""}`);
}

async function waitFor(what, timeoutMs, probe) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await probe();
    if (value) return { value, ms: Date.now() - start };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function ok(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function pidAlive(pid) {
  const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
  return stdout.includes(String(pid));
}

async function powershell(command) {
  // Started from PowerShell 7, Windows PowerShell inherits its module path and cannot load its own modules.
  const { PSModulePath: _, ...env } = process.env;
  const { stdout } = await run("powershell", ["-NoProfile", "-Command", command], { env });
  return stdout.trim();
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows only");
  if (!installer || !existsSync(installer)) throw new Error("pass the installer .exe path");

  const signature = await powershell(`(Get-AuthenticodeSignature '${installer}').Status`);
  // Upstream ships unsigned when its signing secrets are absent; report it without failing.
  warn("installer is code-signed", signature === "Valid", signature);

  let start = Date.now();
  await run(installer, ["/S"], { timeout: 15 * 60_000 });
  step("silent install", existsSync(app), `${Math.round((Date.now() - start) / 1000)} s, ${app}`);
  const registered = await powershell(
    "Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | % { Get-ItemProperty $_.PSPath } | ? { $_.DisplayName -like 'bb *' } | % { $_.DisplayName }",
  );
  step("uninstall entry registered", registered.startsWith("bb "), registered);

  const root = await mkdtemp(join(tmpdir(), "bb-e2e-"));
  const userDataDir = join(root, "user-data");
  const [serverPort, daemonPort] = [await freePort(), await freePort()];
  const env = {
    ...process.env,
    BB_DATA_DIR: join(root, "data"),
    BB_DESKTOP_AUTO_UPDATE: "0",
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
    BB_DESKTOP_VERSION_CHECK: "0",
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_SERVER_PORT: String(serverPort),
    BB_TELEMETRY: "false",
  };
  start = Date.now();
  const child = spawn(app, [`--user-data-dir=${userDataDir}`], { env, stdio: "ignore" });

  const runtime = await waitFor("owned-runtime.json", 180_000, async () => {
    try {
      return JSON.parse(await readFile(join(userDataDir, "owned-runtime.json"), "utf8"));
    } catch {
      return null;
    }
  });
  step("desktop starts its runtime", true, `${runtime.ms} ms, ${runtime.value.serverUrl}`);
  const serverUrl = runtime.value.serverUrl;

  const health = await waitFor("server /health", 120_000, () => ok(new URL("/health", serverUrl)));
  step("server healthy", true, `${Date.now() - start} ms after launch`);

  const daemon = await waitFor("host daemon connected", 120_000, async () => {
    const response = await ok(`http://127.0.0.1:${daemonPort}/status`);
    const status = response && (await response.json());
    return status?.connected === true;
  });
  step("host daemon connected", true, `${daemon.ms} ms after health`);

  const plugins = await waitFor("providers ready", 120_000, () =>
    ok(new URL("/api/v1/system/providers", serverUrl)),
  );
  step("plugins settled", true, `${plugins.ms} ms after daemon`);
  void health;

  // A polite quit closes the window like a person would. /T would also target
  // windowless helpers, which Windows only ends with /F, so the request fails.
  const asked = await run("taskkill", ["/PID", String(child.pid)]).then(
    () => "",
    (error) => String(error.stderr || error.message).trim(),
  );
  step("quit request accepted", asked === "", asked);
  const quit = await waitFor("app to exit after quit", 60_000, async () => !(await pidAlive(child.pid))).catch(
    (error) => ({ error }),
  );
  step("app exits on quit", !quit.error, quit.error?.message ?? `${quit.ms} ms`);

  const runtimeGone = await waitFor("runtime to exit", 30_000, async () => !(await pidAlive(runtime.value.pid))).catch(
    (error) => ({ error }),
  );
  step("server process stops with the app", !runtimeGone.error, runtimeGone.error?.message ?? "");
  step("server port is freed", await portIsFree(serverPort), `port ${serverPort}`);
  step("daemon port is freed", await portIsFree(daemonPort), `port ${daemonPort}`);

  await run("taskkill", ["/PID", String(runtime.value.pid), "/T", "/F"]).catch(() => {});
  await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => {});

  start = Date.now();
  await run(uninstaller, ["/S", "/currentuser"], { timeout: 5 * 60_000 });
  const removed = await waitFor("program files removed", 120_000, async () => !existsSync(app)).catch(
    (error) => ({ error }),
  );
  step("silent uninstall removes the app", !removed.error, `${Math.round((Date.now() - start) / 1000)} s`);
  await rm(root, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  step("run", false, error.message);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
