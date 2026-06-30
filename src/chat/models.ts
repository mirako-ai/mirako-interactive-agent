import { createGoogleGenerativeAI, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { CallSettings, LanguageModel } from "ai";

export type Provider = "google";

export type ThinkingMode = "None" | "Auto";

export type SupportedModel = {
  id: string;
  provider: Provider;
  upstreamModel: string;
};

export type LanguageModelResult =
  | { ok: true; model: LanguageModel }
  | { ok: false; error: string };

type ProviderEnv = {
  GOOGLE_API_KEY?: string;
};

export function resolveLanguageModel(env: ProviderEnv, model: SupportedModel): LanguageModelResult {
  const apiKey = env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "GOOGLE_API_KEY is not configured" };
  }
  return { ok: true, model: createGoogleGenerativeAI({ apiKey }).chat(model.upstreamModel) };
}

export function providerOptionsFor(model: SupportedModel, thinking: ThinkingMode): any {
  const thinkingConfig = googleThinkingConfig(model, thinking);
  if (!thinkingConfig) {
    return undefined;
  }

  return {
    google: {
      thinkingConfig,
    } satisfies GoogleLanguageModelOptions,
  };
}

export function generationSettings(options: GenerationOptions): Partial<CallSettings> {
  const settings: Partial<CallSettings> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      settings[key as keyof GenerationOptions] = value;
    }
  }
  return settings;
}

export type GenerationOptions = Pick<
  Partial<CallSettings>,
  "temperature" | "topP" | "topK" | "seed" | "frequencyPenalty" | "presencePenalty" | "maxOutputTokens"
>;

function googleThinkingConfig(model: SupportedModel, thinking: ThinkingMode): GoogleLanguageModelOptions["thinkingConfig"] | undefined {
  if (model.upstreamModel.startsWith("gemini-3")) {
    return thinking === "None"
      ? {
          thinkingLevel: "minimal",
          includeThoughts: false,
        }
      : { includeThoughts: false };
  }

  return undefined;
}
