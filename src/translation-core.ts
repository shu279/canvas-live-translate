export interface TranslationPart {
  source: string;
  context: string;
}

export interface TranslationBatch {
  parts: TranslationPart[];
}

/** Indices refer to the input parts; a null can be retried without losing its neighbours. */
export interface BatchTranslationResult {
  translations: Array<string | null>;
  issue?: string;
}

const JAPANESE_TEXT = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/u;

export function containsJapanese(value: string): boolean {
  return JAPANESE_TEXT.test(value);
}

export function splitWhitespace(value: string): { prefix: string; core: string; suffix: string } {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(value);
  return {
    prefix: match?.[1] ?? "",
    core: match?.[2] ?? value,
    suffix: match?.[3] ?? ""
  };
}

export function makeBatches(
  parts: TranslationPart[],
  maxItems = 15,
  maxCharacters = 3500
): TranslationBatch[] {
  const batches: TranslationBatch[] = [];
  let batch: TranslationPart[] = [];
  let characterCount = 0;

  for (const part of parts) {
    const size = part.source.length + part.context.length;
    if (batch.length > 0 && (batch.length >= maxItems || characterCount + size > maxCharacters)) {
      batches.push({ parts: batch });
      batch = [];
      characterCount = 0;
    }
    batch.push(part);
    characterCount += size;
  }

  if (batch.length > 0) batches.push({ parts: batch });
  return batches;
}

export function parseTranslations(payload: unknown, expectedCount: number): string[] {
  if (typeof payload !== "object" || payload === null || !("translations" in payload)) {
    throw new Error("No translations field in model response");
  }
  const values = (payload as { translations: unknown }).translations;
  if (!Array.isArray(values) || values.length !== expectedCount ||
      values.some((value: unknown) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("Translation count or content did not match the request");
  }
  return values as string[];
}

export async function makeCacheKey(model: string, target: string, glossary: string, part: TranslationPart): Promise<string> {
  // v0.1 used unkeyed output arrays. Do not reuse a potentially misaligned entry.
  const encoded = new TextEncoder().encode(JSON.stringify(["translation-v2", model, target, glossary, part.source, part.context]));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const SKIP_SELECTOR = [
  "script", "style", "textarea", "input", "select", "option", "button", "svg", "code", "pre",
  ".katex", ".math", ".math-block", ".math-inline", ".MathJax", ".cm-editor", ".cm-content",
  ".markdown-source-view", ".canvas-node-toolbar", ".canvas-node-resizer", ".clickable-icon",
  ".is-editing", "[contenteditable='true']", "[role='textbox']"
].join(", ");
