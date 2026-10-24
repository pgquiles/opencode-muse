import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readRepositoryJson, repositoryPath } from "./helpers.ts";
import "./unit/msp-client.test.ts";
import "./unit/msp-approvals.test.ts";
import "./unit/msp-host.test.ts";
import "./unit/msp-schema-diff.test.ts";
import "./unit/session-registry.test.ts";
import "./unit/workspace-lock.test.ts";
import "./unit/catalog.test.ts";
import "./integration/provider-registration.test.ts";
import "./unit/request-context.test.ts";
import "./unit/agent-context.test.ts";
import "./unit/prompt.test.ts";
import "./unit/stream-mapping.test.ts";
import "./unit/language-model.test.ts";
import "./unit/session-manager.test.ts";
import "./unit/meta-request.test.ts";
import "./unit/fingerprint.test.ts";
import "./integration/turn-bridge.test.ts";
import "./integration/session-recovery.test.ts";
import "./integration/rewind-fork.test.ts";
import "./unit/provider-list-smoke.test.ts";

interface PackageMetadata {
  exports?: {
    "."?: {
      import?: string;
      types?: string;
    };
  };
}

interface TypeScriptConfig {
  compilerOptions?: {
    strict?: boolean;
  };
}

test("published package entry exposes the OpenCode v2 plugin shape", async () => {
  const packageMetadata = readRepositoryJson<PackageMetadata>("package.json");
  const importPath = packageMetadata.exports?.["."]?.import;

  expect(importPath).toBe("./dist/index.js");
  expect(existsSync(repositoryPath(importPath ?? ""))).toBe(true);

  const entry = await import(repositoryPath(importPath ?? ""));
  expect(entry.default.id).toBe("opencode-muse");
  expect(typeof entry.default.setup).toBe("function");
});

test("TypeScript configuration enables strict checking", () => {
  const tsconfig = readRepositoryJson<TypeScriptConfig>("tsconfig.json");
  expect(tsconfig.compilerOptions?.strict).toBe(true);
});
