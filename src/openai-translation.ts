import { requestUrl } from "obsidian";
import { BatchTranslationResult, TranslationPart } from "./translation-core";
import { performTranslationRequest, TranslationRequestOptions } from "./openai-protocol";

export { TranslationError } from "./openai-protocol";
export type { TranslationRequestOptions } from "./openai-protocol";

export async function translateWithOpenAI(
  apiKey: string,
  model: string,
  target: string,
  glossary: string,
  parts: TranslationPart[],
  options: TranslationRequestOptions = {}
): Promise<BatchTranslationResult> {
  return performTranslationRequest(async request => {
    const response = await requestUrl({ ...request, contentType: "application/json", throw: false });
    let body: unknown = null;
    try { body = JSON.parse(response.text) as unknown; }
    catch { /* The protocol handles malformed bodies without exposing raw responses. */ }
    return { status: response.status, headers: response.headers, body };
  }, apiKey, model, target, glossary, parts, options);
}
