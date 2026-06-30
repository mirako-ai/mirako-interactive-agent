import type { UIMessageChunk } from "ai";
import { isRecord } from "../shared/guards";

export type MetisDisplayMode = "pip" | "sbs";

export type MetisMediaResource = {
  url: string;
  displayMode?: MetisDisplayMode;
};

export type MetisToolClientPart =
  | { type: "file"; url: string; mediaType: string; filename?: string }
  | { type: "data-image"; id?: string; data: MetisMediaResource }
  | { type: "data-video"; id?: string; data: MetisMediaResource };

export const METIS_TOOL_RESULT_ACKNOWLEDGEMENT = "Tool executed successfully.";
export const METIS_TOOL_CLIENT_ACKNOWLEDGEMENT = { ok: true, message: METIS_TOOL_RESULT_ACKNOWLEDGEMENT } as const;

export function extractMetisToolClientParts(output: unknown): MetisToolClientPart[] {
  const direct = parseMetisToolClientParts(output);
  if (direct.length > 0) {
    return direct;
  }

  if (isRecord(output)) {
    return parseMetisToolClientParts(output.structured);
  }

  return [];
}

export function metisToolClientPartChunks(parts: readonly MetisToolClientPart[]): UIMessageChunk[] {
  return parts.map((part) => {
    if (part.type === "file") {
      return {
        type: "file",
        url: part.url,
        mediaType: part.mediaType,
      } satisfies UIMessageChunk;
    }

    return {
      type: part.type,
      id: part.id,
      data: {
        url: part.data.url,
        displayMode: part.data.displayMode ?? "pip",
      },
    } satisfies UIMessageChunk;
  });
}

function parseMetisToolClientParts(value: unknown): MetisToolClientPart[] {
  if (Array.isArray(value)) {
    const parts = value.map(parseMetisToolClientPart);
    return parts.length > 0 && parts.every((part) => part !== null) ? parts : [];
  }

  const part = parseMetisToolClientPart(value);
  return part ? [part] : [];
}

function parseMetisToolClientPart(value: unknown): MetisToolClientPart | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "file":
      return parseFilePart(value);
    case "data-image":
    case "data-video":
      return parseDataMediaPart(value);
    default:
      return null;
  }
}

function parseFilePart(value: Record<string, unknown>): MetisToolClientPart | null {
  if (typeof value.url !== "string" || typeof value.mediaType !== "string") {
    return null;
  }
  if (!isBrowserHttpUrl(value.url) || !isSupportedFileMediaType(value.mediaType)) {
    return null;
  }
  if (value.filename !== undefined && typeof value.filename !== "string") {
    return null;
  }

  return {
    type: "file",
    url: value.url,
    mediaType: value.mediaType,
    ...(value.filename ? { filename: value.filename } : {}),
  };
}

function parseDataMediaPart(value: Record<string, unknown>): MetisToolClientPart | null {
  if (!isRecord(value.data)) {
    return null;
  }
  if (value.id !== undefined && typeof value.id !== "string") {
    return null;
  }
  if (typeof value.data.url !== "string" || !isBrowserHttpUrl(value.data.url)) {
    return null;
  }
  if (value.data.displayMode !== undefined && value.data.displayMode !== "pip" && value.data.displayMode !== "sbs") {
    return null;
  }

  return {
    type: value.type as "data-image" | "data-video",
    ...(value.id ? { id: value.id } : {}),
    data: {
      url: value.data.url,
      ...(value.data.displayMode ? { displayMode: value.data.displayMode } : {}),
    },
  };
}

function isBrowserHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSupportedFileMediaType(value: string) {
  return value.startsWith("image/") || value.startsWith("video/");
}
