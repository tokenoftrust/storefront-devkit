import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./validate-page-browser.mjs", import.meta.url));

function run(args, { killAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = killAfterMs > 0 ? setTimeout(() => child.kill("SIGTERM"), killAfterMs) : null;
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const pageArgs = ["http://127.0.0.1:9", "/missing", "--provider", "cloudflare"];

test("omitting --store fails and names the flag", async () => {
  const { code, stderr } = await run(pageArgs);
  assert.equal(code, 2);
  assert.match(stderr, /--store/);
  assert.match(stderr, /\.tot\/config\.json/);
});

test("a checkout without .tot/config.json fails and names that path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "page-check-nostore-"));
  try {
    const { code, stderr } = await run([...pageArgs, "--store", dir]);
    assert.equal(code, 2);
    assert.match(stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(stderr, /\.tot\/config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout with .tot/config.json gets past argument parsing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "page-check-store-"));
  mkdirSync(join(dir, ".tot"));
  writeFileSync(join(dir, ".tot", "config.json"), "{}\n");
  try {
    const { code, signal, stderr } = await run([...pageArgs, "--store", dir], { killAfterMs: 2500 });
    assert.doesNotMatch(stderr, /--store <checkout> is required/);
    assert.doesNotMatch(stderr, /has no \.tot\/config\.json/);
    assert.notEqual(code, 2, stderr);
    assert.ok(signal === "SIGTERM" || code === 1 || code === 0, `unexpected exit ${code} ${signal}: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
