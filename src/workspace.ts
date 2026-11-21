import { mkdir, appendFile } from "node:fs/promises";
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
  const target = path.join(params.workspaceDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const heading = `## ${clockStamp(now, params.timeZone)}${params.title ? ` ${params.title.replace(/\s+/g, " ").trim()}` : ""}`;
  const tags = params.tags?.length ? `\n\nTags: ${params.tags.join(", ")}` : "";
  await appendFile(target, `\n${heading}\n\n${params.text.trim()}${tags}\n`, "utf8");
  return relativePath;
}
