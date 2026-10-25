import { describe, expect, test } from "bun:test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  PDF_STAGING_DIR,
  createPdfStager,
  purgePdfStaging,
  type PdfFileSystem,
} from "../../src/msp/pdf.js";
import { extractTurnInput } from "../../src/model/prompt.js";

function fakeFs(): PdfFileSystem & { files: Map<string, Uint8Array>; chmodCalls: string[]; rmCalls: string[] } {
  const files = new Map<string, Uint8Array>();
  const chmodCalls: string[] = [];
  const rmCalls: string[] = [];
  return {
    files,
    chmodCalls,
    rmCalls,
    async mkdir(_dir: string, _opts?: { recursive?: boolean }): Promise<void> {},
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      files.set(path, data);
    },
    async chmod(path: string, _mode: number): Promise<void> {
      chmodCalls.push(path);
    },
    async rm(path: string, _opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
      rmCalls.push(path);
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
    },
  };
}

const pdfPart = (data: Uint8Array) =>
  [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data }] }] as unknown as LanguageModelV3Prompt;

describe("PDF workspace staging (#33)", () => {
  test("stage.savesUuidPdfAndLabelsTheTurn", async () => {
    const fs = fakeFs();
    const stage = createPdfStager("/ws", fs);
    const result = await extractTurnInput(pdfPart(Uint8Array.from([1, 2, 3])), [], [], { stagePdfAttachment: stage });

    expect(result.ok).toBe(true);
    const paths = [...fs.files.keys()];
    expect(paths).toHaveLength(1);
    expect(paths[0]!.startsWith(`/ws/${PDF_STAGING_DIR}/`)).toBe(true);
    expect(paths[0]!.endsWith(".pdf")).toBe(true);
    expect(fs.chmodCalls).toEqual(paths);
    expect(result).toMatchObject({
      ok: true,
      parts: [{ type: "text", text: `[Attached PDF saved to ${paths[0]} (3 bytes): read it with your tools if needed]` }],
    });
  });

  test("stage.uuidNamesAreUnique", async () => {
    const fs = fakeFs();
    const stage = createPdfStager("/ws", fs);
    await stage(Uint8Array.from([1]));
    await stage(Uint8Array.from([2]));
    expect([...fs.files.keys()]).toHaveLength(2);
  });

  test("stage.writeFailureFailsLoudly", async () => {
    const fs = fakeFs();
    fs.writeFile = async () => {
      throw new Error("EACCES");
    };
    const stage = createPdfStager("/ws", fs);
    const result = await extractTurnInput(pdfPart(Uint8Array.from([1])), [], [], { stagePdfAttachment: stage });

    expect(result).toMatchObject({ ok: false, error: { code: "pdf-stage-failed", mediaType: "application/pdf" } });
  });

  test("stage.oversizePdfFailsBeforeStaging", async () => {
    const fs = fakeFs();
    const stage = createPdfStager("/ws", fs);
    const result = await extractTurnInput(pdfPart(new Uint8Array(9)), [], [], {
      stagePdfAttachment: stage,
      maxMediaBytes: 8,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "media-too-large" } });
    expect(fs.files.size).toBe(0);
  });

  test("stage.multiplePdfsKeepOrder", async () => {
    const fs = fakeFs();
    const stage = createPdfStager("/ws", fs);
    const prompt = [
      {
        role: "user",
        content: [
          { type: "file", mediaType: "application/pdf", data: Uint8Array.from([1]) },
          { type: "file", mediaType: "application/pdf", data: Uint8Array.from([2, 2]) },
        ],
      },
    ] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], [], { stagePdfAttachment: stage });

    expect(result.ok).toBe(true);
    const parts = (result.ok && result.parts) || [];
    expect(parts).toHaveLength(2);
    expect((parts[0] as { text: string }).text).toContain("(1 bytes)");
    expect((parts[1] as { text: string }).text).toContain("(2 bytes)");
  });

  test("stage.purgeRemovesStagingDirAndToleratesAbsence", async () => {
    const fs = fakeFs();
    const stage = createPdfStager("/ws", fs);
    await stage(Uint8Array.from([1]));
    expect(fs.files.size).toBe(1);
    await purgePdfStaging("/ws", fs);
    expect(fs.files.size).toBe(0);
    expect(fs.rmCalls).toEqual([`/ws/${PDF_STAGING_DIR}`]);
    await purgePdfStaging("/ws", fs);
  });
});
