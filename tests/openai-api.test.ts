import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranslationBody, parseStructuredTranslations, performTranslationRequest,
  TranslationError, OpenAIResponse
} from "../src/openai-protocol.ts";

const parts = [
  { source: "問題", context: "" },
  { source: "手法", context: "" },
  { source: "結果", context: "" }
];
const parse = (content: string) => parseStructuredTranslations(content, parts, "English");
const response = (content: string, finish = "stop"): OpenAIResponse => ({
  status: 200, body: { choices: [{ finish_reason: finish, message: { content } }] }
});
const send = (result: OpenAIResponse) => performTranslationRequest(
  async () => result, "test-secret-not-real", "gpt-6-luna", "English", "", parts
);

test("strict response schema requires every explicit ID, not a variable-length positional array", () => {
  const body = buildTranslationBody("gpt-6-luna", "English", "", parts) as any;
  const schema = body.response_format.json_schema.schema;
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.store, false);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.translations.type, "object");
  assert.deepEqual(schema.properties.translations.required, ["t0", "t1", "t2"]);
  assert.equal(schema.properties.translations.additionalProperties, false);
  assert.equal(body.max_completion_tokens >= 2048, true);
});

test("request context is deduplicated and omitted when equal to its text", () => {
  const body = buildTranslationBody("gpt-6-luna", "English", "", [
    { source: "問題", context: "問題" },
    { source: "手法", context: "共通の文脈" },
    { source: "結果", context: "共通の文脈" }
  ]) as any;
  const sent = JSON.parse(body.messages[1].content);
  assert.deepEqual(sent.contexts, { c0: "共通の文脈" });
  assert.deepEqual(sent.texts, [
    { id: "t0", text: "問題" },
    { id: "t1", text: "手法", context_id: "c0" },
    { id: "t2", text: "結果", context_id: "c0" }
  ]);
});

test("does not send unsupported reasoning controls to arbitrary models", () => {
  assert.equal(buildTranslationBody("gpt-4.1-nano", "English", "", parts).reasoning_effort, undefined);
  assert.equal(buildTranslationBody("gpt-6.1-sol", "English", "", parts).reasoning_effort, "low");
  assert.equal(buildTranslationBody("gpt-6.1-terra", "English", "", parts).reasoning_effort, "none");
});

test("out-of-order explicit IDs map to the correct text", () => {
  assert.deepEqual(parse('{"translations":{"t2":"Results","t0":"Problem","t1":"Method"}}'),
    { translations: ["Problem", "Method", "Results"] });
});

test("partial and unknown IDs do not discard or misalign good translations", () => {
  const result = parse('{"translations":{"t2":"Results","t999":"Other","t0":"Problem"}}');
  assert.deepEqual(result.translations, ["Problem", null, "Results"]);
  assert.match(result.issue!, /Unexpected/);
});

test("rejects duplicates per ID, including escaped equivalents, but preserves neighbours", () => {
  const result = parse('{"translations":{"t0":"Problem","\\u00740":"Wrong","t1":"Method","t2":"Results"}}');
  assert.deepEqual(result.translations, [null, "Method", "Results"]);
  assert.match(result.issue!, /Duplicate/);
});

test("duplicate root translations objects cannot silently overwrite a previous map", () => {
  const result = parse('{"translations":{"t0":"Problem"},"translations":{"t1":"Method","t2":"Results"}}');
  assert.deepEqual(result.translations, [null, null, null]);
  assert.match(result.issue!, /Duplicate translations object/);
});

test("a truncated second occurrence still invalidates a duplicate ID or map", () => {
  assert.deepEqual(parse('{"translations":{"t0":"Problem","t1":"Method","t0":"Unfin').translations,
    [null, "Method", null]);
  assert.deepEqual(parse('{"translations":{"t0":"Problem"},"translations"').translations,
    [null, null, null]);
});

test("legacy arrays and unrelated text never become positional translations", () => {
  assert.deepEqual(parse('{"translations":["Problem","Method","Results"]}').translations, [null, null, null]);
  assert.deepEqual(parse('Here are the translations: Problem, Method, Results').translations, [null, null, null]);
});

test("English responses with untranslated Japanese or blank values are retried individually", () => {
  assert.deepEqual(parse('{"translations":{"t0":"問題","t1":" ","t2":"Results"}}').translations,
    [null, null, "Results"]);
  assert.deepEqual(parseStructuredTranslations('{"translations":{"t0":"問題"}}', [parts[0]], "Japanese").translations,
    ["問題"]);
});

test("malformed values do not destroy later well-formed entries", () => {
  assert.deepEqual(parse('{"translations":{"t0":null,"t1":{"bad":"x"},"t2":"Results"}}').translations,
    [null, null, "Results"]);
});

test("length-truncated JSON retains only completely decoded ID fields", () => {
  const result = parse('{"translations":{"t0":"Problem","t1":"Method","t2":"Resul');
  assert.deepEqual(result.translations, ["Problem", "Method", null]);
  assert.match(result.issue!, /Incomplete/);
});

test("escaped quotes, braces, commas and fake IDs inside strings are ordinary text", () => {
  const value = 'A "t1": "wrong", brace }, and \\ text';
  const content = JSON.stringify({ translations: { t0: value, t1: "Method", t2: "Results" } });
  assert.deepEqual(parse(content).translations, [value, "Method", "Results"]);
});

test("an exact JSON fence can be recovered without guessing around arbitrary prose", () => {
  const result = parse('```json\n{"translations":{"t0":"Problem","t1":"Method","t2":"Results"}}\n```');
  assert.deepEqual(result.translations, ["Problem", "Method", "Results"]);
});

test("HTTP request contains expected endpoint and secret only in its authorization header", async () => {
  const output = await performTranslationRequest(async request => {
    assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(request.headers.Authorization, "Bearer test-secret-not-real");
    assert.equal(request.body.includes("test-secret-not-real"), false);
    return response('{"translations":{"t0":"Problem","t1":"Method","t2":"Results"}}');
  }, "test-secret-not-real", "gpt-6-luna", "English", "", parts);
  assert.deepEqual(output.translations, ["Problem", "Method", "Results"]);
});

test("length finish reason preserves complete segments and reports its cause", async () => {
  const output = await send(response('{"translations":{"t0":"Problem","t1":"Method","t2":"Resu', "length"));
  assert.deepEqual(output.translations, ["Problem", "Method", null]);
  assert.match(output.issue!, /Output limit/);
});

test("a refusal is local and nonretryable, not a fatal global configuration error", async () => {
  await assert.rejects(send({ status: 200, body: { choices: [{ message: { refusal: "No", content: null } }] } }),
    (error: TranslationError) => error.code === "model_refusal" && !error.fatal && !error.retryable);
});

test("authentication/configuration errors are fatal and do not echo raw response messages", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    await assert.rejects(send({ status, body: { error: { message: "test-secret-not-real and private note", code: "bad" } } }),
      (error: TranslationError) => error.fatal && !error.retryable && error.status === status && !error.message.includes("private") && !error.message.includes("test-secret"));
  }
});

test("quota errors do not create a rate-limit retry storm", async () => {
  await assert.rejects(send({ status: 429, body: { error: { code: "insufficient_quota" } } }),
    (error: TranslationError) => error.fatal && !error.retryable && error.code === "insufficient_quota");
});

test("429 and temporary server failures carry bounded Retry-After", async () => {
  await assert.rejects(send({ status: 429, headers: { "Retry-After": "2" }, body: {} }),
    (error: TranslationError) => !error.fatal && error.retryable && error.retryAfterMs === 2000);
  await assert.rejects(send({ status: 503, headers: { "Retry-After-Ms": "900000" }, body: {} }),
    (error: TranslationError) => !error.fatal && error.retryable && error.retryAfterMs === 300000);
});

test("network failure is safe and retryable with no transport-level hidden retries", async () => {
  let calls = 0;
  await assert.rejects(performTranslationRequest(async () => {
    calls++;
    throw new Error("test-secret-not-real appeared in raw transport error");
  }, "test-secret-not-real", "gpt-6-luna", "English", "", parts),
  (error: TranslationError) => !error.fatal && error.retryable && !error.message.includes("test-secret"));
  assert.equal(calls, 1);
});

test("bad completion envelopes return partial failures instead of throwing away queue state", async () => {
  assert.deepEqual((await send({ status: 200, body: null })).translations, [null, null, null]);
  assert.deepEqual((await send({ status: 200, body: { choices: [] } })).translations, [null, null, null]);
});

test("cancellation is checked before and after the non-abortable native request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(performTranslationRequest(async () => {
    calls++;
    return response('{}');
  }, "test-secret-not-real", "gpt-6-luna", "English", "", parts, { signal: controller.signal }),
  (error: TranslationError) => error.code === "cancelled");
  assert.equal(calls, 0);
  const second = new AbortController();
  await assert.rejects(performTranslationRequest(async () => {
    second.abort();
    return response('{"translations":{"t0":"Problem","t1":"Method","t2":"Results"}}');
  }, "test-secret-not-real", "gpt-6-luna", "English", "", parts, { signal: second.signal }),
  (error: TranslationError) => error.code === "cancelled");
});

test("every prefix of a structured response can recover only a complete, correct ID value", () => {
  const expected = ['A "quoted" result', "A brace } and comma, here", "A backslash \\ and newline\nnext"];
  const text = JSON.stringify({ translations: { t2: expected[2], t0: expected[0], t1: expected[1] } });
  for (let length = 0; length <= text.length; length++) {
    const actual = parse(text.slice(0, length)).translations;
    actual.forEach((value, index) => assert.ok(value === null || value === expected[index], `bad prefix at ${length}`));
  }
});

test("JSON trailing commas are reported as malformed even if useful IDs are salvageable", () => {
  const result = parse('{"translations":{"t0":"Problem","t1":"Method","t2":"Results",}}');
  assert.deepEqual(result.translations, ["Problem", "Method", "Results"]);
  assert.match(result.issue!, /malformed/);
});

test("leading-zero, negative, unsafe and prototype IDs cannot address a translation", () => {
  const result = parse('{"translations":{"t00":"Wrong","t-1":"Wrong","t9007199254740992":"Wrong","__proto__":"Wrong","t2":"Results"}}');
  assert.deepEqual(result.translations, [null, null, "Results"]);
});
