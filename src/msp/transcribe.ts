import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Audio attachments (#32). The pinned MSP turn schema has no audio part,
 * so attached clips are transcribed through the official
 * `muse voice transcribe` CLI and the transcript enters the turn as
 * declared text. Voice mode is included in every subscription plan;
 * the CLI owns authentication end to end.
 */

export const TRANSCRIBE_BASE_TIMEOUT_MS = 60_000;

/** Latency runs ~0.7x clip duration on the pinned CLI; triple it, floored at the base. */
export function transcribeTimeoutMs(durationMs?: number): number {
  if (durationMs === undefined) return TRANSCRIBE_BASE_TIMEOUT_MS;
  return Math.max(TRANSCRIBE_BASE_TIMEOUT_MS, Math.ceil(durationMs * 3));
}

export type TranscribeFailureCode = "transcription-failed" | "transcription-timeout" | "no-speech-heard";

export type TranscribeOutcome = { ok: true; transcript: string } | { ok: false; code: TranscribeFailureCode };

/** Sealed seam: prompt extraction calls this, never the CLI directly. */
export type TranscribeAudio = (bytes: Uint8Array, mediaType: string) => Promise<TranscribeOutcome>;

export interface TranscribeSpawnResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type TranscribeSpawn = (
  museBin: string,
  clipPath: string,
  timeoutMs: number,
) => Promise<TranscribeSpawnResult>;

export interface CliTranscriberOptions {
  museBin?: string;
  spawn?: TranscribeSpawn;
  /** Escape hatch (tests); otherwise computed from the clip duration. */
  timeoutMs?: number;
}

function clipExtension(mediaType: string): string {
  switch (mediaType) {
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/ogg":
    case "audio/vorbis":
      return ".ogg";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/aac":
      return ".m4a";
    case "audio/webm":
      return ".webm";
    case "audio/flac":
      return ".flac";
    default:
      return ".audio";
  }
}

/** PCM header duration only; anything else (mp3/ogg/containers) yields undefined. */
export function wavDurationMs(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") return undefined;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  if (channels === 0 || sampleRate === 0 || bitsPerSample === 0) return undefined;
  const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
  return Math.round((dataSize / bytesPerSecond) * 1000);
}

function defaultSpawn(museBin: string, clipPath: string, timeoutMs: number): Promise<TranscribeSpawnResult> {
  return new Promise((resolve) => {
    // The deadline is enforced by the timer below (not the spawn `timeout`
    // option) so a kill is always recorded as a timeout, never as a bare
    // null exit.
    const child = spawn(museBin, ["voice", "transcribe", clipPath]);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exit: null, stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit: code, stdout, stderr, timedOut });
    });
  });
}

export function createCliTranscriber(options: CliTranscriberOptions = {}): TranscribeAudio {
  const museBin = options.museBin ?? "muse";
  const run = options.spawn ?? defaultSpawn;
  return async (bytes, mediaType) => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-muse-transcribe-"));
    try {
      const clipPath = join(directory, `clip${clipExtension(mediaType.toLowerCase())}`);
      await writeFile(clipPath, bytes);
      const timeoutMs = options.timeoutMs ?? transcribeTimeoutMs(wavDurationMs(bytes));
      // The deadline is enforced here, not in the spawn: a custom runner
      // may ignore timeoutMs, and only this race guarantees termination.
      let fireTimeout: () => void = () => {};
      const timeoutPromise = new Promise<TranscribeSpawnResult>((resolve) => {
        fireTimeout = () => resolve({ exit: null, stdout: "", stderr: "", timedOut: true });
      });
      const timer = setTimeout(fireTimeout, timeoutMs);
      let result: TranscribeSpawnResult;
      try {
        result = await Promise.race([run(museBin, clipPath, timeoutMs), timeoutPromise]);
      } catch {
        clearTimeout(timer);
        return { ok: false, code: "transcription-failed" };
      }
      clearTimeout(timer);
      if (result.timedOut) return { ok: false, code: "transcription-timeout" };
      if (result.exit === 0) {
        const transcript = result.stdout.trim();
        return transcript ? { ok: true, transcript } : { ok: false, code: "no-speech-heard" };
      }
      // Observed: exit 3 on unreadable input, exit 7 on wordless audio.
      if (result.exit === 7) return { ok: false, code: "no-speech-heard" };
      return { ok: false, code: "transcription-failed" };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
