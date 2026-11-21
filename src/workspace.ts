import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

/** Day stamp in the given IANA time zone (host default when omitted). */
export function memoryDayStamp(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function clockStamp(now: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

/**
 * Appends one entry to memory/YYYY-MM-DD.md in the agent workspace, the same daily file
 * memory-core's own flush writes and indexes. Never rewrites existing content.
 */
export async function appendWorkspaceMemory(params: {
  workspaceDir: string;
  text: string;
  title?: string;
  tags?: readonly string[];
  now?: Date;
  timeZone?: string;
}): Promise<string> {
  const now = params.now ?? new Date();
  const relativePath = `memory/${memoryDayStamp(now, params.timeZone)}.md`;
  // Confine the write: no symlinked memory directory or day file may redirect it.
  const root = await realpath(params.workspaceDir);
  const dir = path.join(root, "memory");
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat && !dirStat.isDirectory()) {
    throw new Error("workspace memory/ is not a plain directory");
  }
  if (!dirStat) await mkdir(dir);
  const realDir = await realpath(dir);
  if (realDir !== dir || !realDir.startsWith(root + path.sep)) {
    throw new Error("workspace memory/ resolves outside the workspace");
  }
  const target = path.join(dir, path.basename(relativePath));
  const heading = `## ${clockStamp(now, params.timeZone)}${params.title ? ` ${params.title.replace(/\s+/g, " ").trim()}` : ""}`;
  const tags = params.tags?.length ? `\n\nTags: ${params.tags.join(", ")}` : "";
  // O_NOFOLLOW refuses a symlinked day file; O_APPEND never rewrites existing entries.
  const handle = await open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.appendFile(`\n${heading}\n\n${params.text.trim()}${tags}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return relativePath;
}
