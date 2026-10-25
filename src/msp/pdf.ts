import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * PDF attachments (#33). The pinned MSP turn schema has no PDF part and
 * in-plugin text extraction was rejected as duplicative, so the bytes are
 * staged under the session workspace and the agent reads them with its
 * own tools. Staged names are always generated (uuid + fixed suffix):
 * binary file parts carry no filename and none is accepted from
 * anywhere else. Retention: purge on session close (provider dispose);
 * crash orphans are documented manual cleanup.
 */

export const PDF_STAGING_DIR = ".opencode-muse-uploads";

export type StagePdfOutcome = { ok: true; path: string } | { ok: false; code: "pdf-stage-failed" };

/** Sealed seam: prompt extraction stages through this, never the fs directly. */
export type StagePdfAttachment = (bytes: Uint8Array) => Promise<StagePdfOutcome>;

export interface PdfFileSystem {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

const defaultFs: PdfFileSystem = { mkdir, writeFile, chmod, rm };

export function pdfStagingDir(workspaceDir: string): string {
  return join(workspaceDir, PDF_STAGING_DIR);
}

export function createPdfStager(workspaceDir: string, fs: PdfFileSystem = defaultFs): StagePdfAttachment {
  const directory = pdfStagingDir(workspaceDir);
  return async (bytes) => {
    try {
      await fs.mkdir(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}.pdf`);
      await fs.writeFile(path, bytes);
      // Intent signal only: the agent runs as the same user and could
      // override it, so a chmod failure must not fail the turn.
      await fs.chmod(path, 0o444).catch(() => {});
      return { ok: true, path };
    } catch {
      return { ok: false, code: "pdf-stage-failed" };
    }
  };
}

/** Retention enforcement; never throws (shutdown path). */
export async function purgePdfStaging(workspaceDir: string, fs: PdfFileSystem = defaultFs): Promise<void> {
  try {
    await fs.rm(pdfStagingDir(workspaceDir), { recursive: true, force: true });
  } catch {
    // Crash orphans and concurrent purges are documented manual cleanup.
  }
}
