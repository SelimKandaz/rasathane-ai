import { desktopCapturer } from "electron";
import { promises as fs } from "fs";
import path from "path";

import type { Observation } from "../../shared/types";

export interface CapturedObservation {
  observation: Observation;
  pngBase64: string;
}

function nextObservationId(): string {
  return `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function capturePrimaryScreen(
  userDataPath: string,
  persistToDisk: boolean
): Promise<CapturedObservation> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: 1920,
      height: 1080
    }
  });

  if (sources.length === 0) {
    throw new Error("No display sources were available for screen observation.");
  }

  const primarySource = sources[0];
  const thumbnail = primarySource.thumbnail;
  const size = thumbnail.getSize();
  const pngBuffer = thumbnail.toPNG();
  const id = nextObservationId();

  let imagePath: string | null = null;

  if (persistToDisk) {
    const observationDir = path.join(userDataPath, "observations");
    await fs.mkdir(observationDir, { recursive: true });
    imagePath = path.join(observationDir, `${id}.png`);
    await fs.writeFile(imagePath, pngBuffer);
  }

  return {
    observation: {
      id,
      createdAt: Date.now(),
      sourceName: primarySource.name,
      width: size.width,
      height: size.height,
      imagePath,
      previewDataUrl: thumbnail.resize({ width: 360 }).toDataURL(),
      persisted: persistToDisk,
      pendingForNextMessage: true,
      summary: null,
      visionModel: null,
      analysisStatus: "not_requested",
      warning: null
    },
    pngBase64: pngBuffer.toString("base64")
  };
}
