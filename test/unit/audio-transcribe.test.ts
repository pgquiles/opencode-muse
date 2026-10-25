import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  createCliTranscriber,
  TRANSCRIBE_BASE_TIMEOUT_MS,
  wavDurationMs,
  type TranscribeSpawn,
} from "../../src/msp/transcribe.js";
import { extractTurnInput } from "../../src/model/prompt.js";

const audioPart = (mediaType: string, data: Uint8Array) =>
  [{ role: "user", content: [{ type: "file", mediaType, data }] }] as unknown as LanguageModelV3Prompt;

function wavBytes({ seconds, sampleRate = 16000 }: { seconds: number; sampleRate?: number }): Uint8Array {
  const dataSize = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buffer);
}

describe("audio transcription via muse voice transcribe", () => {
  test("transcribe.successBecomesLabeledTextAndTempClipIsCleanedUp", async () => {
    const seen: Array<{ clipPath: string; timeoutMs: number }> = [];
    const spawn: TranscribeSpawn = async (_bin, clipPath, timeoutMs) => {
      seen.push({ clipPath, timeoutMs });
      return { exit: 0, stdout: "hello there\n", stderr: "" };
    };
    const transcribe = createCliTranscriber({ museBin: "muse-test", spawn });
    const result = await extractTurnInput(audioPart("audio/wav", Uint8Array.from([1, 2, 3, 4])), [], [], {
      transcribeAudio: transcribe,
    });

    expect(result).toMatchObject({
      ok: true,
      parts: [{ type: "text", text: '[Transcription of attached audio (audio/wav, 4 bytes): "hello there"]' }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.clipPath.startsWith(tmpdir())).toBe(true);
    expect(seen[0]!.clipPath.endsWith(".wav")).toBe(true);
    expect(existsSync(dirname(seen[0]!.clipPath))).toBe(false);
  });

  test("transcribe.unreadableClipFailsLoudlyWithCleanup", async () => {
    let clipPath = "";
    const spawn: TranscribeSpawn = async (_bin, clip, _timeout) => {
      clipPath = clip;
      return { exit: 3, stdout: "\n", stderr: "error: unreadable clip: the file is empty" };
    };
    const transcribe = createCliTranscriber({ spawn });
    const result = await extractTurnInput(audioPart("audio/mpeg", Uint8Array.from([9, 9])), [], [], {
      transcribeAudio: transcribe,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "transcription-failed", mediaType: "audio/mpeg" } });
    expect(clipPath.endsWith(".mp3")).toBe(true);
    expect(existsSync(dirname(clipPath))).toBe(false);
  });

  test("transcribe.wordlessClipMapsToNoSpeechHeard", async () => {
    const spawn: TranscribeSpawn = async () => ({ exit: 7, stdout: "\n", stderr: "error: no words heard" });
    const transcribe = createCliTranscriber({ spawn });
    const result = await extractTurnInput(audioPart("audio/ogg", Uint8Array.from([7])), [], [], {
      transcribeAudio: transcribe,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "no-speech-heard", mediaType: "audio/ogg" } });
  });

  test("transcribe.emptyTranscriptOnSuccessIsNoSpeechHeard", async () => {
    const spawn: TranscribeSpawn = async () => ({ exit: 0, stdout: "  \n", stderr: "" });
    const transcribe = createCliTranscriber({ spawn });
    const result = await extractTurnInput(audioPart("audio/wav", Uint8Array.from([7])), [], [], {
      transcribeAudio: transcribe,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "no-speech-heard" } });
  });

  test("transcribe.spawnThrowIsTranscriptionFailed", async () => {
    const spawn: TranscribeSpawn = async () => {
      throw new Error("boom");
    };
    const transcribe = createCliTranscriber({ spawn });
    const result = await extractTurnInput(audioPart("audio/wav", Uint8Array.from([7])), [], [], {
      transcribeAudio: transcribe,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "transcription-failed", mediaType: "audio/wav" } });
  });

  test("transcribe.hungSpawnTimesOut", async () => {
    const spawn: TranscribeSpawn = () => new Promise(() => {});
    const transcribe = createCliTranscriber({ spawn, timeoutMs: 50 });
    const result = await extractTurnInput(audioPart("audio/wav", Uint8Array.from([7])), [], [], {
      transcribeAudio: transcribe,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "transcription-timeout" } });
  });

  test("transcribe.multipleClipsTranscribeInOrder", async () => {
    const spawn: TranscribeSpawn = async (_bin, clip) => ({
      exit: 0,
      stdout: clip.endsWith(".wav") ? "first" : "second",
      stderr: "",
    });
    const transcribe = createCliTranscriber({ spawn });
    const prompt = [
      {
        role: "user",
        content: [
          { type: "file", mediaType: "audio/wav", data: Uint8Array.from([1]) },
          { type: "file", mediaType: "audio/ogg", data: Uint8Array.from([2, 2]) },
        ],
      },
    ] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], [], { transcribeAudio: transcribe });

    expect(result).toMatchObject({
      ok: true,
      parts: [
        { type: "text", text: '[Transcription of attached audio (audio/wav, 1 bytes): "first"]' },
        { type: "text", text: '[Transcription of attached audio (audio/ogg, 2 bytes): "second"]' },
      ],
    });
  });

  test("transcribe.oversizeAudioFailsBeforeSpawning", async () => {
    let calls = 0;
    const spawn: TranscribeSpawn = async () => {
      calls += 1;
      return { exit: 0, stdout: "x", stderr: "" };
    };
    const transcribe = createCliTranscriber({ spawn });
    const result = await extractTurnInput(audioPart("audio/wav", new Uint8Array(9)), [], [], {
      transcribeAudio: transcribe,
      maxMediaBytes: 8,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "media-too-large" } });
    expect(calls).toBe(0);
  });

  test("transcribe.abortedSignalSkipsTranscription", async () => {
    let calls = 0;
    const spawn: TranscribeSpawn = async () => {
      calls += 1;
      return { exit: 0, stdout: "x", stderr: "" };
    };
    const controller = new AbortController();
    controller.abort();
    const transcribe = createCliTranscriber({ spawn });
    const result = await extractTurnInput(audioPart("audio/wav", Uint8Array.from([1])), [], [], {
      transcribeAudio: transcribe,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(calls).toBe(0);
  });

  test("transcribe.timeoutScalesWithWavDuration", async () => {
    const seen: number[] = [];
    const spawn: TranscribeSpawn = async (_bin, _clip, timeoutMs) => {
      seen.push(timeoutMs);
      return { exit: 0, stdout: "x", stderr: "" };
    };
    const transcribe = createCliTranscriber({ spawn });
    await transcribe(new Uint8Array([1, 2, 3]), "audio/mpeg");
    await transcribe(wavBytes({ seconds: 30 }), "audio/wav");

    expect(seen).toEqual([TRANSCRIBE_BASE_TIMEOUT_MS, 90_000]);
  });

  test("transcribe.wavDurationParsesHeader", () => {
    expect(wavDurationMs(wavBytes({ seconds: 2 }))!).toBe(2000);
    expect(wavDurationMs(wavBytes({ seconds: 1, sampleRate: 8000 }))!).toBe(1000);
    expect(wavDurationMs(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(wavDurationMs(wavBytes({ seconds: 1 }).slice(0, 20))).toBeUndefined();
  });
});
