import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import type { LocalSttStatus, RasathaneSettings, VoiceTranscriptionResult } from "../../shared/types";

const execFileAsync = promisify(execFile);

const COMMON_LOCAL_STT_PATHS = [
  "C:\\Program Files\\whisper.cpp\\whisper-cli.exe",
  "C:\\Program Files\\whisper.cpp\\main.exe",
  "C:\\whisper.cpp\\whisper-cli.exe",
  "C:\\whisper.cpp\\main.exe"
];

const COMMON_LOCAL_STT_MODEL_PATHS = [
  "C:\\Users\\selim\\Desktop\\rasathane-ai\\tools\\whisper.cpp\\models\\ggml-small.bin",
  "C:\\Users\\selim\\Desktop\\rasathane-ai\\tools\\whisper.cpp\\models\\ggml-base.bin",
  "C:\\Program Files\\whisper.cpp\\models\\ggml-small.bin",
  "C:\\Program Files\\whisper.cpp\\models\\ggml-base.bin",
  "C:\\whisper.cpp\\models\\ggml-small.bin",
  "C:\\whisper.cpp\\models\\ggml-base.bin"
];

function normalizeConfiguredPath(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function findPathCommand(commandName: string): string {
  const pathValue = process.env.PATH ?? "";
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
    .split(";")
    .map((extension) => extension.toLowerCase());

  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = path.join(segment, `${commandName}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function findBundledWhisperCommand(): string {
  const projectCandidate = path.join(
    "C:\\Users\\selim\\Desktop\\rasathane-ai",
    "tools",
    "whisper.cpp",
    "Release",
    "whisper-cli.exe"
  );

  return fs.existsSync(projectCandidate) ? projectCandidate : "";
}

function resolveSttExecutable(settings: RasathaneSettings): string {
  const configuredPath = normalizeConfiguredPath(settings.localSttExecutablePath);
  if (configuredPath) {
    return configuredPath;
  }

  return (
    findBundledWhisperCommand() ||
    COMMON_LOCAL_STT_PATHS.find((candidate) => fs.existsSync(candidate)) ||
    findPathCommand("whisper-cli") ||
    findPathCommand("main")
  );
}

function resolveSttModel(settings: RasathaneSettings): string {
  const configuredPath = normalizeConfiguredPath(settings.localSttModelPath);
  if (configuredPath) {
    return configuredPath;
  }

  return COMMON_LOCAL_STT_MODEL_PATHS.find((candidate) => fs.existsSync(candidate)) ?? "";
}

function splitArgumentTemplate(template: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | "" = "";

  for (let index = 0; index < template.length; index++) {
    const char = template[index];

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = "";
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function buildSttArguments(template: string, modelPath: string, audioPath: string): string[] {
  const expanded = template
    .split("{model}")
    .join(modelPath)
    .split("{audio}")
    .join(audioPath);

  return splitArgumentTemplate(expanded);
}

function cleanWhisperTranscript(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*\[[^\]]+\]\s*/g, "")
        .replace(/^whisper_[^:]+:\s*/i, "")
        .trim()
    )
    .filter((line) => line && !/^system_info:/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAudioBase64(value: string): Buffer {
  const base64 = value.includes(",") ? value.split(",").pop() ?? "" : value;
  if (!base64.trim()) {
    throw new Error("Voice recording was empty.");
  }

  return Buffer.from(base64, "base64");
}

export function getLocalSttStatus(settings: RasathaneSettings): LocalSttStatus {
  const configuredPath = normalizeConfiguredPath(settings.localSttExecutablePath);
  const executablePath = resolveSttExecutable(settings);
  const modelPath = resolveSttModel(settings);
  const executableAvailable = Boolean(executablePath) && fs.existsSync(executablePath);
  const modelAvailable = Boolean(modelPath) && fs.existsSync(modelPath);

  if (configuredPath) {
    return {
      configured: true,
      available: executableAvailable && modelAvailable,
      executablePath,
      modelPath,
      modelAvailable,
      argumentsTemplate: settings.localSttArguments,
      tested: false,
      message:
        executableAvailable && modelAvailable
          ? "Local STT is configured. Voice comments can be transcribed locally."
          : "Configured local STT executable or model path does not exist."
    };
  }

  if (executableAvailable || modelAvailable) {
    return {
      configured: false,
      available: executableAvailable && modelAvailable,
      executablePath,
      modelPath,
      modelAvailable,
      argumentsTemplate: settings.localSttArguments,
      tested: false,
      message: executableAvailable && modelAvailable
        ? "Detected local whisper.cpp STT. Voice comments can be transcribed locally."
        : "Detected partial local STT setup. Both whisper-cli.exe and a ggml model are required."
    };
  }

  return {
    configured: false,
    available: false,
    executablePath: "",
    modelPath: "",
    modelAvailable: false,
    argumentsTemplate: settings.localSttArguments,
    tested: false,
    message:
      "Voice input is not configured. Rasathane needs a local STT executable such as whisper.cpp; no cloud speech recognition is used."
  };
}

export async function transcribeVoiceComment(
  settings: RasathaneSettings,
  audioWavBase64: string,
  userDataPath: string
): Promise<VoiceTranscriptionResult> {
  const status = getLocalSttStatus(settings);
  if (!status.available) {
    throw new Error(status.message);
  }

  const started = Date.now();
  const tempDir = path.join(userDataPath, "voice-comments");
  await fs.promises.mkdir(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, `voice-${Date.now()}.wav`);
  await fs.promises.writeFile(audioPath, normalizeAudioBase64(audioWavBase64));

  const args = buildSttArguments(
    settings.localSttArguments || "-m \"{model}\" -f \"{audio}\" -nt -l auto",
    status.modelPath,
    audioPath
  );

  const { stdout } = await execFileAsync(status.executablePath, args, {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });

  const transcript = cleanWhisperTranscript(stdout);
  if (!transcript) {
    throw new Error("Local STT completed but returned no transcript.");
  }

  return {
    transcript,
    executablePath: status.executablePath,
    modelPath: status.modelPath,
    elapsedMs: Date.now() - started
  };
}
