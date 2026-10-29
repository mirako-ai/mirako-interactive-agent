import type { UIMessage } from "ai";
import { isRecord } from "../shared/guards";
import type { GenerationOptions, ThinkingMode } from "./models";
import { extractSessionIdFromBody } from "./session";

export const CHAT_PATH = "/v1/chat";

const FORBIDDEN_FIELDS = ["model", "mcp_servers", "stream", "n", "tools", "functions", "tool_choice"] as const;
const SUPPORTED_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);
const NUMERIC_GENERATION_FIELDS: Array<[source: string, target: keyof GenerationOptions]> = [
  ["temperature", "temperature"],
  ["top_p", "topP"],
  ["top_k", "topK"],
  ["seed", "seed"],
  ["frequency_penalty", "frequencyPenalty"],
  ["presence_penalty", "presencePenalty"],
];

export type NormalizedChatRequest = {
  sessionId: string;
  messages: UIMessage[];
  generationOptions: GenerationOptions;
  thinking: ThinkingMode;
};

export type ChatRequestError = {
  status: number;
  code: string;
  message: string;
  param?: string;
};

export type ChatRequestResult =
  | { ok: true; request: NormalizedChatRequest }
  | { ok: false; error: ChatRequestError };

export function normalizeChatRequestBody(body: unknown): ChatRequestResult {
  if (!isRecord(body)) {
    return invalid("Request body must be a JSON object");
  }

  const forbidden = firstForbiddenField(body);
  if (forbidden) {
    return invalid(`${forbidden} is not supported by ${CHAT_PATH}`, forbidden);
  }

  const sessionId = extractSessionIdFromBody(body);
  if (!sessionId.ok) {
    return invalid(sessionId.error, "session_id");
  }

  const messages = normalizeMessages(body.messages);
  if (!messages.ok) {
    return { ok: false, error: messages.error };
  }

  const generationOptions = pickGenerationOptions(body);
  if (!generationOptions.ok) {
    return { ok: false, error: generationOptions.error };
  }

  const thinking = normalizeThinking(body.thinking);
  if (!thinking.ok) {
    return { ok: false, error: thinking.error };
  }

  return {
    ok: true,
    request: {
      sessionId: sessionId.sessionId,
      messages: messages.messages,
      generationOptions: generationOptions.options,
      thinking: thinking.thinking,
    },
  };
}

export function normalizeChatOptionsBody(body: unknown, messages: UIMessage[]): ChatRequestResult {
  const withMessages = isRecord(body) ? { ...body, session_id: "agent", messages } : { session_id: "agent", messages };
  return normalizeChatRequestBody(withMessages);
}

export function getTurnMetadata(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body.metadata) ? body.metadata : undefined;
}

export function invalid(message: string, param?: string): { ok: false; error: ChatRequestError } {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message,
      param,
    },
  };
}

function firstForbiddenField(body: Record<string, unknown>) {
  for (const field of FORBIDDEN_FIELDS) {
    if (body[field] !== undefined) {
      return field;
    }
  }
  return null;
}

function normalizeMessages(value: unknown):
  | { ok: true; messages: UIMessage[] }
  | { ok: false; error: ChatRequestError } {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid("messages must be a non-empty AI SDK UIMessage array", "messages");
  }

  const messages: UIMessage[] = [];
  let hasUserMessage = false;

  for (const [index, message] of value.entries()) {
    const messageError = validateMessage(message, index);
    if (messageError) {
      return invalid(messageError, "messages");
    }

    const uiMessage = message as UIMessage;
    if (uiMessage.role === "user") {
      hasUserMessage = true;
    }

    messages.push(uiMessage);
  }

  if (!hasUserMessage) {
    return invalid("messages must include at least one user message", "messages");
  }

  return { ok: true, messages };
}

function validateMessage(message: unknown, index: number) {
  const path = `messages[${index}]`;
  if (!isRecord(message)) {
    return `${path} must be an object`;
  }
  if (typeof message.id !== "string" || message.id.trim().length === 0) {
    return `${path}.id must be a non-empty string`;
  }
  if (!SUPPORTED_MESSAGE_ROLES.has(message.role as string)) {
    return `${path}.role must be system, user, or assistant`;
  }
  if (!Array.isArray(message.parts)) {
    return `${path}.parts must be an array`;
  }

  for (const [partIndex, part] of message.parts.entries()) {
    const partError = validatePublicMessagePart(part, `${path}.parts[${partIndex}]`);
    if (partError) {
      return partError;
    }
  }

  return null;
}

function validatePublicMessagePart(part: unknown, path: string) {
  if (!isRecord(part) || typeof part.type !== "string") {
    return `${path} must be an object with a type`;
  }

  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
    return `${path}.type is not allowed in public requests`;
  }

  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? null : `${path}.text must be a string`;
    case "file":
      if (typeof part.url !== "string" || part.url.trim().length === 0) {
        return `${path}.url must be a non-empty string`;
      }
      if (typeof part.mediaType !== "string" || part.mediaType.trim().length === 0) {
        return `${path}.mediaType must be a non-empty string`;
      }
      return null;
    default:
      return `${path}.type is not supported`;
  }
}

function normalizeThinking(value: unknown):
  | { ok: true; thinking: ThinkingMode }
  | { ok: false; error: ChatRequestError } {
  if (value === undefined || value === null) {
    return { ok: true, thinking: "None" };
  }
  if (typeof value !== "string") {
    return invalid("thinking must be one of: None, Auto", "thinking");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "none") {
    return { ok: true, thinking: "None" };
  }
  if (normalized === "auto") {
    return { ok: true, thinking: "Auto" };
  }

  return invalid("thinking must be one of: None, Auto", "thinking");
}

function pickGenerationOptions(body: Record<string, unknown>):
  | { ok: true; options: GenerationOptions }
  | { ok: false; error: ChatRequestError } {
  const options: GenerationOptions = {};

  for (const [source, target] of NUMERIC_GENERATION_FIELDS) {
    const value = body[source];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid(`${source} must be a finite number`, source);
    }
    options[target] = value;
  }

  const maxOutputTokens = body.max_output_tokens;
  if (maxOutputTokens !== undefined) {
    if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
      return invalid("max_output_tokens must be a positive integer", "max_output_tokens");
    }
    options.maxOutputTokens = maxOutputTokens;
  }

  return { ok: true, options };
}
