// Structural copies of the OpenClaw memory provider contract (openclaw/plugin-sdk
// memory-host-search and the slot owner's providerRuntime). Kept local so the
// plugin type-checks against hosts that predate the memory backend SDK types.

export type MemoryReference = {
  providerId: string;
  id: string;
  revision?: string;
  fragment?: string;
};

export type MemoryCitation = {
  label: string;
  reference?: MemoryReference;
  url?: string;
  startLine?: number;
  endLine?: number;
};

export type MemorySearchHit = {
  reference: MemoryReference;
  excerpt: string;
  score?: number;
  source?: string;
  citations?: MemoryCitation[];
  automaticRecall?: {
    eligible: boolean;
    projectKeys?: readonly string[];
    triggers?: string;
    importance?: number;
  };
};

export type MemorySearchPage = {
  hits: MemorySearchHit[];
  nextCursor?: string;
  coverage?: "complete" | "partial";
  warning?: string;
};

export type MemorySource = "memory" | "sessions";

export type MemorySearchRequest = {
  query: string;
  maxResults?: number;
  minScore?: number;
  cursor?: string;
  sources?: MemorySource[];
  lexicalOnly?: boolean;
  activeProjectKeys?: readonly string[];
};

export type MemoryGetRequest = { reference: MemoryReference; from?: number; lines?: number };

export type MemoryGetResult =
  | {
      status: "ok";
      reference: MemoryReference;
      text: string;
      citations?: MemoryCitation[];
      truncated?: boolean;
      from?: number;
      lines?: number;
      nextFrom?: number;
    }
  | { status: "not_found" };

export type MemoryHealth = {
  status: "ready" | "degraded" | "unavailable";
  message?: string;
  details?: Record<string, unknown>;
};

export type MemoryCandidateKind = "trigger" | "project";

export type MemoryCandidateRequest = {
  kind: MemoryCandidateKind;
  limit?: number;
  activeProjectKeys?: readonly string[];
};

export type MemoryProviderCapabilities = {
  sources: readonly MemorySource[];
  pagination: boolean;
  candidates: readonly MemoryCandidateKind[];
  projectFilter: boolean;
  /** The provider accepts new entries through store(). */
  store?: boolean;
};

export type MemoryStoreRequest = {
  text: string;
  title?: string;
  tags?: readonly string[];
  origin?: "tool" | "flush" | "capture";
};

export type MemoryStoreResult =
  | { status: "stored"; reference: MemoryReference }
  | { status: "rejected"; reason: string };

export type MemoryProviderHandle = {
  capabilities: MemoryProviderCapabilities;
  search(request: MemorySearchRequest): Promise<MemorySearchPage>;
  get(request: MemoryGetRequest): Promise<MemoryGetResult>;
  health(): Promise<MemoryHealth>;
  candidates?(request: MemoryCandidateRequest): Promise<MemorySearchPage>;
  refresh?(): Promise<void>;
  store?(request: MemoryStoreRequest): Promise<MemoryStoreResult>;
  close(): Promise<void>;
};

export type MemoryCallerAuthority =
  | { kind: "operator"; scopes: readonly string[]; connId?: string }
  | {
      kind: "session";
      sessionKey: string;
      sandboxed: boolean;
      conversationRecall?: unknown;
      sessionId?: string;
      audience?: unknown;
    }
  | { kind: "host"; operation: string };

export type MemoryCallerContext = {
  authority: MemoryCallerAuthority;
  assertCurrent(): void;
  signal?: AbortSignal;
};

export type ActiveMemoryProviderResult = {
  provider: MemoryProviderHandle | null;
  error?: string;
  providerId?: string;
  adapter?: "native" | "legacy";
};

export type MemoryBackendAccess = {
  list(): { id: string; name?: string }[];
  open(backendId: string): Promise<ActiveMemoryProviderResult>;
};

export type MemoryProviderOpenParams = {
  cfg: unknown;
  agentId: string;
  context: MemoryCallerContext;
  purpose?: "default" | "status" | "cli";
  backends?: MemoryBackendAccess;
};

export type MemoryProviderOpenResult = {
  provider: MemoryProviderHandle | null;
  error?: string;
};

/** Plugin config, validated by the manifest schema. */
export type MemfusionConfig = {
  /** Reciprocal-rank-fusion constant; larger values flatten rank differences. */
  rrfK?: number;
  /** Per-backend rank weight, keyed by backend plugin id. Defaults to 1. */
  weights?: Record<string, number>;
  /** Per-backend deadline for search, get and candidates calls, in milliseconds. */
  timeoutMs?: number;
  /**
   * Where new memories go. "auto" (default): every backend that accepts writes, or the
   * workspace memory files when none does. "all": every writable backend plus the workspace.
   * A list names backend plugin ids and/or "workspace".
   */
  store?: "auto" | "all" | string[];
};

/** The workspace memory files (memory/YYYY-MM-DD.md) that memory-core indexes. */
export const WORKSPACE_TARGET = "workspace";
