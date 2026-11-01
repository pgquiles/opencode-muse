import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBridgeSettings,
  sweepHostConfigs,
  writeHostConfig,
} from "../../src/msp/host-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-muse-hostcfg-"));
  roots.push(root);
  return root;
}

describe("opencode backend host config", () => {
  test("hostConfig.buildsBridgeOnlySettings", () => {
    const settings = buildBridgeSettings({
      systemPrompt: "Bridge protocol prompt.",
      toolset: ["opencode_write"],
    });

    expect(settings).toEqual({
      schema_version: 1,
      run: {
        system_prompt: "Bridge protocol prompt.",
        toolset: ["opencode_write"],
      },
      context: { foreign_personal_rules: false },
      context_compaction: { soft_threshold: 0.99, hard_threshold: 0.995 },
    });
    expect(JSON.stringify(settings)).not.toContain("sk-");
  });

  test("hostConfig.writesPrivateDirAndLinksAuthWhenPresent", () => {
    const root = makeRoot();
    const userDir = join(root, "user-muse");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "auth.json"), "{\"token\":\"probe-fake\"}");

    const xdg = writeHostConfig(root, "ses_test_1", { authSourceDir: userDir, toolset: ["opencode_write"] });

    expect(xdg).toBe(join(root, "hosts", "ses_test_1"));
    const settingsPath = join(xdg, "muse", "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).run.toolset).toEqual(["opencode_write"]);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(xdg, "muse")).mode & 0o777).toBe(0o700);
    const link = join(xdg, "muse", "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("hostConfig.skipsMissingAuthWithoutReading", () => {
    const root = makeRoot();
    const userDir = join(root, "empty-muse");
    mkdirSync(userDir, { recursive: true });

    const xdg = writeHostConfig(root, "ses_test_2", { authSourceDir: userDir });

    expect(lstatSync(join(xdg, "muse", "auth.json"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("hostConfig.rejectsUnsafeSessionKeys", () => {
    const root = makeRoot();

    expect(() => writeHostConfig(root, "../escape", { authSourceDir: root })).toThrow();
    expect(() => writeHostConfig(root, "", { authSourceDir: root })).toThrow();
  });

  test("hostConfig.sweepsOnlyStaleEntries", () => {
    const root = makeRoot();
    const hosts = join(root, "hosts");
    const now = Date.now();
    for (const name of ["old-one", "fresh-one"]) {
      const dir = join(hosts, name, "muse");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "settings.json"), "{}");
    }

    const past = new Date(now - 120_000);
    utimesSync(join(hosts, "old-one"), past, past);

    const removed = sweepHostConfigs(root, 60_000, now);

    expect(removed).toEqual(["old-one"]);
  });
});
