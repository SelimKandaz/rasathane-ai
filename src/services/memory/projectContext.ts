import { promises as fs } from "fs";
import path from "path";

import type { ProjectContextItem } from "../../shared/types";

const DEFAULT_CONTEXT_FILES = [
  "README.md",
  "DEVELOPMENT_REPORT.md",
  path.join("reports", "SELIM_RASATHANE_BRIEF.md"),
  path.join("reports", "LOCAL_AI_CAPABILITY_REPORT.md"),
  path.join("reports", "SMOKE_TEST_REPORT.md"),
  path.join("reports", "BUILD_TEST_REPORT.md")
];

function summarizeText(text: string): string {
  const compact = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return compact.slice(0, 2200);
}

export async function loadDefaultProjectContext(projectRoot: string): Promise<ProjectContextItem[]> {
  const items: ProjectContextItem[] = [];

  for (const relativePath of DEFAULT_CONTEXT_FILES) {
    const sourcePath = path.join(projectRoot, relativePath);

    try {
      const text = await fs.readFile(sourcePath, "utf8");
      items.push({
        id: relativePath.replace(/[\\/:.]/g, "_"),
        sourcePath,
        title: relativePath,
        summary: summarizeText(text),
        updatedAt: Date.now()
      });
    } catch {
      // Missing docs should not block the app; the report will show the loaded count.
    }
  }

  return items;
}
