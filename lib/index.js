var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : Symbol.for("Symbol." + name2);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function") __typeError("Object expected");
    var dispose, inner;
    if (async) dispose = value[__knownSymbol("asyncDispose")];
    if (dispose === void 0) {
      dispose = value[__knownSymbol("dispose")];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") __typeError("Object not disposable");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    stack.push([async, dispose, value]);
  } else if (async) {
    stack.push([async]);
  }
  return value;
};
var __callDispose = (stack, error, hasError) => {
  var E = typeof SuppressedError === "function" ? SuppressedError : function(e, s, m, _) {
    return _ = Error(m), _.name = "SuppressedError", _.error = e, _.suppressed = s, _;
  };
  var fail = (e) => error = hasError ? new E(e, error, "An error was suppressed during disposal") : (hasError = true, e);
  var next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError) throw error;
  };
  return next();
};

// src/index.ts
import z from "@deepseek-ai/schemastery";
import { assertUsableApiKey as assertUsableApiKey2, LlmError as LlmError5, resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";

// src/adapter.ts
import {
  assertUsableApiKey,
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError as LlmError4,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { fetch as undiciFetch, ProxyAgent } from "undici";

// src/serialize.ts
import { contentHasImage, LlmError } from "@deepseek-ai/dsh-llm";
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("The NewAPI chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
  }
}
function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
  const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: block.arguments }
  }));
  return {
    role: "assistant",
    // Text-less turns send "" — NEVER null. Pure tool-call turns: some
    // gateways reject null outright. Reasoning-ONLY turns (the model can
    // answer entirely in the reasoning channel): the wire API rejects
    // null-content/no-tool_calls assistant messages with a 400, and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // DeepSeek-family upstream passback rule: reasoning_content must return
    // on tool-call turns; it is ignored on plain turns, so we drop it there
    // to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
  };
}
function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || "(no output)"
      });
    }
  }
  return wire;
}
async function serializeMessagesWithImages(messages, readImage, signal) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") {
      assertTextOnly(message.content);
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      assertTextOnly(message.content);
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    const images = await inlineImages(message.content, readImage, signal);
    if (text.length > 0 || images.length > 0 || toolResults.length === 0) {
      const content = images.length === 0 ? text : [
        ...text.length > 0 ? [{ type: "text", text }] : [],
        ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } }))
      ];
      wire.push({ role: "user", content });
    }
    for (const result of toolResults) {
      assertTextOnly(result.content);
      wire.push({ role: "tool", tool_call_id: result.toolCallId, content: flattenText(result.content) || "(no output)" });
    }
  }
  return wire;
}
function serializeRequest(options) {
  const messages = [];
  if (options.system !== void 0) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push(...serializeMessages(options.messages));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
    ...options.reasoningEffort !== void 0 ? { reasoning_effort: options.reasoningEffort } : {},
    ...options.stop !== void 0 ? { stop: options.stop } : {}
  };
}
async function serializeRequestWithImages(options, readImage, signal) {
  const messages = [];
  if (options.system !== void 0) messages.push({ role: "system", content: options.system });
  messages.push(...await serializeMessagesWithImages(options.messages, readImage, signal));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
    ...options.reasoningEffort !== void 0 ? { reasoning_effort: options.reasoningEffort } : {},
    ...options.stop !== void 0 ? { stop: options.stop } : {}
  };
}
function base64Of(data) {
  const chunkSize = 32768;
  let binary = "";
  for (let start = 0; start < data.length; start += chunkSize) {
    binary += String.fromCharCode(...data.subarray(start, Math.min(start + chunkSize, data.length)));
  }
  return btoa(binary);
}
async function inlineImages(blocks, readImage, signal) {
  const imageBlocks = blocks.filter((block) => block.type === "image");
  if (imageBlocks.length === 0) return [];
  if (readImage === void 0) {
    throw new LlmError("The active NewAPI route cannot read image attachments because the dsh attachment service is unavailable.", "UNSUPPORTED_CONTENT");
  }
  return Promise.all(imageBlocks.map(async ({ attachment }) => {
    const stored = await readImage(attachment, signal);
    const data = base64Of(stored.data);
    return { mediaType: stored.ref.mediaType, data, dataUrl: `data:${stored.ref.mediaType};base64,${data}` };
  }));
}
function serializeResponsesRequest(options) {
  const input = [];
  for (const message of options.messages) {
    assertTextOnly(message.content);
    const text = flattenText(message.content);
    const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
    const calls = message.content.filter((block) => block.type === "tool-call");
    const results = message.content.filter((block) => block.type === "tool-result");
    if (message.role === "assistant") {
      if (text.length > 0 || calls.length === 0) input.push({ type: "message", role: "assistant", content: text });
      for (const call of calls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      continue;
    }
    if (message.role === "system") {
      input.push({ type: "message", role: "system", content: text });
      continue;
    }
    if (text.length > 0 || results.length === 0) input.push({ type: "message", role: "user", content: text });
    for (const result of results) input.push({ type: "function_call_output", call_id: result.toolCallId, output: flattenText(result.content) || "(no output)" });
  }
  const tools = options.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  return {
    model: options.model,
    input,
    stream: true,
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.system === void 0 ? {} : { instructions: options.system },
    ...options.temperature === void 0 ? {} : { temperature: options.temperature },
    ...options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
    ...options.reasoningEffort === void 0 ? {} : { reasoning: { effort: options.reasoningEffort } },
    ...options.stop === void 0 ? {} : { stop: options.stop }
  };
}
async function serializeResponsesRequestWithImages(options, readImage, signal) {
  const input = [];
  for (const message of options.messages) {
    const text = flattenText(message.content);
    const calls = message.content.filter((block) => block.type === "tool-call");
    const results = message.content.filter((block) => block.type === "tool-result");
    if (message.role === "assistant") {
      assertTextOnly(message.content);
      if (text.length > 0 || calls.length === 0) input.push({ type: "message", role: "assistant", content: text });
      for (const call of calls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      continue;
    }
    if (message.role === "system") {
      assertTextOnly(message.content);
      input.push({ type: "message", role: "system", content: text });
      continue;
    }
    const images = await inlineImages(message.content, readImage, signal);
    if (text.length > 0 || images.length > 0 || results.length === 0) {
      const content = images.length === 0 ? text : [
        ...text.length > 0 ? [{ type: "input_text", text }] : [],
        ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl }))
      ];
      input.push({ type: "message", role: "user", content });
    }
    for (const result of results) {
      assertTextOnly(result.content);
      input.push({ type: "function_call_output", call_id: result.toolCallId, output: flattenText(result.content) || "(no output)" });
    }
  }
  const tools = options.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  return {
    model: options.model,
    input,
    stream: true,
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.system === void 0 ? {} : { instructions: options.system },
    ...options.temperature === void 0 ? {} : { temperature: options.temperature },
    ...options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
    ...options.reasoningEffort === void 0 ? {} : { reasoning: { effort: options.reasoningEffort } },
    ...options.stop === void 0 ? {} : { stop: options.stop }
  };
}
function parseToolArguments(argumentsText) {
  try {
    const value = JSON.parse(argumentsText);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function serializeAnthropicRequest(options) {
  const messages = [];
  const systemParts = options.system === void 0 ? [] : [options.system];
  for (const message of options.messages) {
    assertTextOnly(message.content);
    const text = flattenText(message.content);
    if (message.role === "system") {
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    const blocks = [];
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const block of message.content) {
      if (block.type === "tool-call") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: parseToolArguments(block.arguments) });
      } else if (block.type === "tool-result") {
        blocks.push({ type: "tool_result", tool_use_id: block.toolCallId, content: flattenText(block.content) || "(no output)" });
      }
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: blocks });
  }
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    messages,
    stream: true,
    ...systemParts.length === 0 ? {} : { system: systemParts.join("\n\n") },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature === void 0 ? {} : { temperature: options.temperature },
    ...options.stop === void 0 ? {} : { stop_sequences: options.stop }
  };
}
async function serializeAnthropicRequestWithImages(options, readImage, signal) {
  const messages = [];
  const systemParts = options.system === void 0 ? [] : [options.system];
  for (const message of options.messages) {
    const text = flattenText(message.content);
    if (message.role === "system") {
      assertTextOnly(message.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    const blocks = [];
    if (message.role === "assistant") {
      assertTextOnly(message.content);
    } else {
      const images = await inlineImages(message.content, readImage, signal);
      blocks.push(...images.map((image) => ({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data }
      })));
    }
    if (text.length > 0) blocks.unshift({ type: "text", text });
    for (const block of message.content) {
      if (block.type === "tool-call") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: parseToolArguments(block.arguments) });
      } else if (block.type === "tool-result") {
        assertTextOnly(block.content);
        blocks.push({ type: "tool_result", tool_use_id: block.toolCallId, content: flattenText(block.content) || "(no output)" });
      }
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: blocks });
  }
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    messages,
    stream: true,
    ...systemParts.length === 0 ? {} : { system: systemParts.join("\n\n") },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature === void 0 ? {} : { temperature: options.temperature },
    ...options.stop === void 0 ? {} : { stop_sequences: options.stop }
  };
}

// src/sse.ts
import { EventSourceParserStream } from "eventsource-parser/stream";
import { LlmError as LlmError2 } from "@deepseek-ai/dsh-llm";
var DONE = "[DONE]";
async function* parseSseEvents(stream, onComment) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
  const reader = events.getReader();
  try {
    while (true) {
      const { done, value: event } = await reader.read();
      if (done) return;
      yield {
        ...event.event === void 0 ? {} : { event: event.event },
        data: event.data
      };
    }
  } finally {
    reader.releaseLock();
  }
}
async function* parseSse(stream, onComment) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
  const reader = events.getReader();
  try {
    while (true) {
      const { done, value: event } = await reader.read();
      if (done) break;
      yield event.data;
      if (event.data === DONE) return;
    }
  } finally {
    reader.releaseLock();
  }
  throw new LlmError2("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

// src/translate.ts
import { CallId, EMPTY_RESPONSE_CODE, LlmError as LlmError3 } from "@deepseek-ai/dsh-llm";
function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return {
        kind: "error",
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() }
      };
  }
}
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
  };
}
function closeBlock(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return {
        type: "tool-call",
        id: CallId(block.callId ?? ""),
        name: block.name ?? "",
        arguments: block.text
      };
  }
}
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = /* @__PURE__ */ new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }
  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
      }
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0 ? {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
        } : reason
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError3(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== void 0 && call.id.length > 0) block.callId = call.id;
        if (call.function?.name !== void 0 && call.function.name.length > 0) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...block.name !== void 0 ? { name: block.name } : {},
          argumentsDelta: fragment
        };
      }
      if (typeof choice.finish_reason === "string") {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError3("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
async function* translateResponses(events) {
  let nextIndex = 0;
  let text;
  let reasoning;
  const calls = /* @__PURE__ */ new Map();
  const order = [];
  let usage;
  let finish;
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };
  const ensureCall = (itemId, callId, name2) => {
    let block = calls.get(itemId);
    let created = false;
    if (block === void 0) {
      block = open("tool-call");
      block.callId = callId ?? itemId;
      if (name2 !== void 0 && name2.length > 0) block.name = name2;
      calls.set(itemId, block);
      created = true;
    } else {
      if (callId !== void 0 && callId.length > 0) block.callId = callId;
      if (name2 !== void 0 && name2.length > 0) block.name = name2;
    }
    return { block, created };
  };
  const close = () => order.map((block) => ({ type: "block-end", index: block.index, block: closeBlock(block) }));
  for await (const frame of events) {
    let data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      throw new LlmError3(`malformed Responses SSE payload: ${frame.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    const event = frame.event ?? data.type;
    if (event === "response.output_text.delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (delta.length > 0) {
        if (text === void 0) {
          text = open("text");
          yield { type: "block-start", index: text.index, blockType: "text" };
        }
        text.text += delta;
        yield { type: "text-delta", index: text.index, text: delta };
      }
    } else if (event === "response.reasoning_summary_text.delta" || event === "response.reasoning_text.delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (delta.length > 0) {
        if (reasoning === void 0) {
          reasoning = open("reasoning");
          yield { type: "block-start", index: reasoning.index, blockType: "reasoning" };
        }
        reasoning.text += delta;
        yield { type: "reasoning-delta", index: reasoning.index, text: delta };
      }
    } else if (event === "response.output_item.added" || event === "response.output_item.done") {
      const item = data.item;
      if (item?.type === "function_call") {
        const itemId = String(item.id ?? item.item_id ?? item.call_id ?? "");
        const callId = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : void 0;
        if (itemId.length > 0) {
          const { block, created } = ensureCall(itemId, callId, typeof item.name === "string" ? item.name : void 0);
          if (created) yield { type: "block-start", index: block.index, blockType: "tool-call" };
          if (event === "response.output_item.done" && typeof item.arguments === "string" && block.text.length === 0) block.text = item.arguments;
        }
      }
    } else if (event === "response.function_call_arguments.delta") {
      const itemId = String(data.item_id ?? data.call_id ?? "");
      const callId = typeof data.call_id === "string" && data.call_id.length > 0 ? data.call_id : void 0;
      if (itemId.length > 0) {
        const { block, created } = ensureCall(itemId, callId);
        if (created) yield { type: "block-start", index: block.index, blockType: "tool-call" };
        const delta = typeof data.delta === "string" ? data.delta : "";
        block.text += delta;
        yield { type: "tool-call-delta", index: block.index, id: CallId(block.callId ?? itemId), ...block.name === void 0 ? {} : { name: block.name }, argumentsDelta: delta };
      }
    } else if (event === "response.completed" || event === "response.incomplete" || event === "response.failed") {
      const response = data.response ?? data;
      const wireUsage = response.usage;
      if (wireUsage !== void 0) usage = mapResponsesUsage(wireUsage);
      if (event === "response.failed" || response.status === "failed") {
        finish = { kind: "error", failure: { message: response.error?.message ?? "Responses API request failed", code: String(response.error?.code ?? "RESPONSE_FAILED").toUpperCase() } };
      } else if (event === "response.incomplete" || response.status === "incomplete") {
        finish = { kind: "max-tokens" };
      } else {
        finish = { kind: calls.size > 0 ? "tool-calls" : "stop" };
      }
    }
    if (usage === void 0 && data.response?.usage !== void 0) usage = mapResponsesUsage(data.response.usage);
  }
  for (const chunk of close()) yield chunk;
  if (usage !== void 0) yield { type: "usage", usage };
  yield { type: "finish", reason: finish ?? (order.length === 0 ? { kind: "error", failure: { message: "model returned an empty Responses result", code: EMPTY_RESPONSE_CODE } } : { kind: "stop" }) };
}
async function* translateAnthropic(events) {
  const blocks = /* @__PURE__ */ new Map();
  let usage;
  let finish;
  for await (const frame of events) {
    let data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      throw new LlmError3(`malformed Anthropic SSE payload: ${frame.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    const event = frame.event ?? data.type;
    if (event === "message_start") {
      if (data.message?.usage !== void 0) usage = mapAnthropicUsage(data.message.usage);
    } else if (event === "content_block_start") {
      const index = Number(data.index);
      const item = data.content_block;
      if (!Number.isInteger(index) || item === void 0) continue;
      if (item.type === "text") {
        const block = { index, kind: "text", text: "" };
        blocks.set(index, block);
        yield { type: "block-start", index, blockType: "text" };
      } else if (item.type === "tool_use") {
        const block = {
          index,
          kind: "tool-call",
          text: "",
          callId: typeof item.id === "string" ? item.id : "",
          name: typeof item.name === "string" ? item.name : ""
        };
        blocks.set(index, block);
        yield { type: "block-start", index, blockType: "tool-call" };
      } else if (item.type === "thinking") {
        const block = { index, kind: "reasoning", text: "" };
        blocks.set(index, block);
        yield { type: "block-start", index, blockType: "reasoning" };
      }
    } else if (event === "content_block_delta") {
      const index = Number(data.index);
      const block = blocks.get(index);
      if (block === void 0) continue;
      const delta = data.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        block.text += delta.text;
        yield { type: "text-delta", index, text: delta.text };
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.text += delta.thinking;
        yield { type: "reasoning-delta", index, text: delta.thinking };
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.text += delta.partial_json;
        yield {
          type: "tool-call-delta",
          index,
          id: CallId(block.callId ?? ""),
          ...block.name === void 0 ? {} : { name: block.name },
          argumentsDelta: delta.partial_json
        };
      }
    } else if (event === "content_block_stop") {
      const index = Number(data.index);
      const block = blocks.get(index);
      if (block !== void 0) yield { type: "block-end", index, block: closeBlock(block) };
    } else if (event === "message_delta") {
      if (data.usage !== void 0) usage = mapAnthropicUsage(data.usage, usage);
      const reason = data.delta?.stop_reason;
      if (typeof reason === "string") finish = mapAnthropicFinishReason(reason);
    } else if (event === "message_stop") {
    } else if (event === "error") {
      finish = { kind: "error", failure: { message: data.error?.message ?? "Anthropic API request failed", code: String(data.error?.type ?? "ANTHROPIC_ERROR").toUpperCase() } };
    }
  }
  if (usage !== void 0) yield { type: "usage", usage };
  yield {
    type: "finish",
    reason: finish ?? (blocks.size === 0 ? { kind: "error", failure: { message: "model returned an empty Anthropic result", code: EMPTY_RESPONSE_CODE } } : { kind: "stop" })
  };
}
function mapAnthropicFinishReason(reason) {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return { kind: "stop" };
    case "tool_use":
      return { kind: "tool-calls" };
    case "max_tokens":
      return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}
function mapAnthropicUsage(value, previous) {
  return {
    inputTokens: Number(value?.input_tokens ?? previous?.inputTokens ?? 0),
    outputTokens: Number(value?.output_tokens ?? previous?.outputTokens ?? 0),
    ...value?.cache_read_input_tokens === void 0 ? {} : { cacheReadTokens: Number(value.cache_read_input_tokens) }
  };
}
function mapResponsesUsage(value) {
  const input = Number(value?.input_tokens ?? value?.prompt_tokens ?? 0);
  const output = Number(value?.output_tokens ?? value?.completion_tokens ?? 0);
  const cached = value?.input_tokens_details?.cached_tokens ?? value?.prompt_tokens_details?.cached_tokens;
  const reasoning = value?.output_tokens_details?.reasoning_tokens ?? value?.completion_tokens_details?.reasoning_tokens;
  return { inputTokens: input - (typeof cached === "number" ? cached : 0), outputTokens: output, ...typeof cached === "number" ? { cacheReadTokens: cached } : {}, ...typeof reasoning === "number" ? { reasoningTokens: reasoning } : {} };
}

// src/adapter.ts
var PKG = "llm-newapi";
var DEFAULT_MODEL_EXCLUDE_PATTERNS = ["embed", "rerank", "ranker"];
var DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
var DEFAULT_CONTEXT_WINDOW = 128e3;
var STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
var MODELS_DEV_API_URL = "https://models.dev/api.json";
var MODELS_DEV_TIMEOUT_MS = 3e4;
function modelsDevMatch(provider, entry) {
  const contextWindow = entry.limit?.context;
  const maxTokens = entry.limit?.output;
  const reasoningEfforts = entry.reasoning_options?.filter((option) => option?.type === "effort").flatMap((option) => (option.values ?? []).filter((value) => typeof value === "string" && value.length > 0));
  if (contextWindow === void 0 && maxTokens === void 0) return void 0;
  return {
    provider,
    ...entry.name !== void 0 && entry.name.length > 0 ? { name: entry.name } : {},
    ...contextWindow !== void 0 ? { contextWindow } : {},
    ...maxTokens !== void 0 ? { maxTokens } : {},
    ...reasoningEfforts !== void 0 && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}
  };
}
var DEFAULT_PROVIDER_HINTS = {
  defaults: {
    glm: "zai",
    gpt: "openai",
    o: "openai",
    claude: "anthropic",
    deepseek: "deepseek",
    gemini: "google",
    grok: "xai",
    hunyuan: "tencent",
    qwen: "alibaba",
    kimi: "moonshotai",
    // xiaomi is the vendor key mimo models live under (mimo-v2* family);
    // no separate xiaomimimo provider exists in the catalog.
    mimo: "xiaomi",
    minimax: "minimax"
  }
};
function hintedProvider(id, bare, hints) {
  const exact = hints?.models?.[id] ?? hints?.models?.[bare];
  if (exact !== void 0) return exact;
  const lower = bare.toLowerCase();
  const entries = Object.entries({ ...DEFAULT_PROVIDER_HINTS.defaults, ...hints?.defaults });
  const hit = entries.filter(([prefix]) => lower.startsWith(prefix.toLowerCase())).sort((a, b) => b[0].length - a[0].length)[0];
  return hit?.[1];
}
function matchModelsDev(api, id, hints) {
  const bare = id.slice(id.lastIndexOf("/") + 1);
  const keys = /* @__PURE__ */ new Set([id, bare]);
  const hinted = hintedProvider(id, bare, hints);
  const exact = /* @__PURE__ */ new Map();
  const near = /* @__PURE__ */ new Map();
  for (const [provider, catalog] of Object.entries(api)) {
    const models = catalog?.models;
    if (models === void 0 || typeof models !== "object") continue;
    for (const key of keys) {
      const entry = models[key];
      if (entry === void 0 || typeof entry !== "object") continue;
      const match = modelsDevMatch(provider, entry);
      if (match !== void 0) exact.set(provider, match);
    }
    if (provider === hinted && !exact.has(provider)) {
      const hit = Object.keys(models).filter((key) => key.includes(bare) || bare.includes(key)).map((key) => ({ key, entry: models[key] })).sort((a, b) => a.key.length - b.key.length)[0];
      const entry = hit?.entry;
      const match = entry === void 0 ? void 0 : modelsDevMatch(provider, entry);
      if (match !== void 0) near.set(provider, match);
    }
  }
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (match, official) => {
    if (seen.has(match.provider)) return;
    seen.add(match.provider);
    ordered.push(official ? { ...match, official: true } : match);
  };
  const hintedMatch = exact.get(hinted ?? "") ?? near.get(hinted ?? "");
  if (hinted !== void 0 && hintedMatch !== void 0) push(hintedMatch, true);
  for (const match of exact.values()) push(match, false);
  for (const match of near.values()) push(match, false);
  return ordered;
}
function normalizeBaseUrl(raw) {
  const base = raw.trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages)$/i, "");
  if (!/^https?:\/\//.test(base)) {
    throw new Error(`${PKG}: baseURL must be an absolute http(s) URL including the /v1 prefix (got: ${raw.trim()})`);
  }
  return base;
}
function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === void 0 ? {} : { description: model.description },
    inputModalities: model.input?.includes("image") ? ["text", "image"] : ["text"]
  };
}
var EFFORT_RUNG = {
  max: 7,
  xhigh: 6,
  high: 5,
  medium: 4,
  low: 3,
  minimal: 2,
  none: 1,
  default: 0
};
function highestEffort(efforts) {
  return [...efforts].sort((a, b) => (EFFORT_RUNG[b] ?? -1) - (EFFORT_RUNG[a] ?? -1))[0];
}
var BRAND_SPELLING = {
  glm: "GLM",
  gpt: "GPT",
  deepseek: "DeepSeek"
};
function modelNameFromId(id) {
  const slash = id.lastIndexOf("/");
  const prefix = slash === -1 ? void 0 : id.slice(0, slash);
  const words = id.slice(slash + 1).split("-").filter((word) => word.length > 0);
  const spelled = words.map((word, at) => {
    if (word.length === 1) return word.toUpperCase();
    const brand = BRAND_SPELLING[word];
    if (brand !== void 0) return brand;
    let result = word.charAt(0).toUpperCase() + word.slice(1);
    if (at === words.length - 1) {
      result = result.replace(/([0-9.])([bkm])$/, (_match, head, tail) => head + tail.toUpperCase());
    }
    return result;
  }).join(" ");
  return prefix === void 0 ? spelled : `${spelled}[${prefix}]`;
}
function displayModelName(id, listed) {
  if (listed !== void 0 && listed.length > 0) return listed;
  return modelNameFromId(id);
}
function providerRetryAfterMs(value) {
  if (value === null) return void 0;
  if (/^\d+$/.test(value)) {
    const delay2 = Number(value) * 1e3;
    return Number.isFinite(delay2) && delay2 > 0 ? delay2 : void 0;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
function requestId(headers) {
  const value = headers.get("x-request-id");
  return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
var NewApiAdapter = class extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }
  providerInfo(provider) {
    const connection = this.config.options(provider);
    return { id: provider, name: connection.displayName || "NewAPI" };
  }
  providerRetryPolicy(provider) {
    return this.config.options(provider).retryPolicy;
  }
  listModels(provider) {
    return Promise.resolve(this.config.options(provider).models.map((model) => modelInfo(provider, model)));
  }
  resolveModel(provider, model, _signal) {
    const connection = this.config.options(provider);
    const configured = connection.models.find((entry) => entry.id === model);
    const defaultMaxTokens = configured?.maxTokens ?? connection.maxTokens;
    return Promise.resolve({
      // Unknown models remain text-only. A catalog model explicitly opts into
      // images with input: ['text', 'image'], keeping admission and wire
      // serialization aligned.
      ...configured === void 0 ? { provider, id: model, name: model, inputModalities: ["text"] } : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      // Reasoning efforts arrive as catalog facts (from models.dev via the
      // update action): a row that carries them offers the effort selector,
      // and an explicit effort rides the wire as `reasoning_effort`. The
      // default is the row's configured preset, falling back to the highest
      // rung the catalog declared (max > xhigh > high > medium > low > …), so
      // switching into reasoning mode selects a level automatically. Rows
      // without the fact keep declaring nothing — an explicit effort then
      // rejects before provider I/O, same as before.
      ...configured?.reasoningEfforts !== void 0 && configured.reasoningEfforts.length > 0 ? {
        reasoning: {
          efforts: configured.reasoningEfforts.map((effort) => ({
            id: ReasoningEffortId(effort),
            name: effort.charAt(0).toUpperCase() + effort.slice(1)
          })),
          ...configured.defaultReasoningEffort !== void 0 && configured.reasoningEfforts.includes(configured.defaultReasoningEffort) ? { defaultEffort: ReasoningEffortId(configured.defaultReasoningEffort) } : { defaultEffort: ReasoningEffortId(highestEffort(configured.reasoningEfforts)) }
        }
      } : {},
      ...defaultMaxTokens === void 0 ? {} : { defaultMaxTokens }
    });
  }
  /**
   * Interrogate one gateway endpoint for the models it advertises, serving
   * the settings-namespace discovery the plugin registered. A draft being
   * edited supplies its own base and one-shot credential; otherwise both
   * come from the current connection snapshot.
   * @param request - the discovery draft (endpoint, protocol, credential, cancellation).
   * @returns the advertised models, deduplicated by the runtime, enriched
   *   with context/maxTokens facts from the configured catalog when ids match.
   */
  async discoverModels(request) {
    const connection = this.config.options(request.provider);
    const protocol = request.api === "responses" || request.api === "anthropic-messages" ? request.api : "chat-completions";
    const base = request.baseURL !== void 0 && request.baseURL.length > 0 ? normalizeBaseUrl(request.baseURL) : connection.baseURL;
    const apiKey = request.apiKey !== void 0 ? assertUsableApiKey(request.apiKey, PKG, "the draft credential") : await this.config.resolveApiKey(connection);
    let response;
    try {
      response = await fetch(`${base}/models`, {
        method: "GET",
        headers: {
          ...protocol === "anthropic-messages" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` },
          "accept": "application/json",
          ...attributionHeaders()
        },
        ...request.signal === void 0 ? {} : { signal: request.signal }
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new LlmError4(`NewAPI model discovery request to ${base} failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let providerError;
      try {
        providerError = (await response.json()).error;
      } catch {
      }
      const id = requestId(response.headers);
      throw new LlmError4(
        providerError?.message ?? `NewAPI model discovery error (HTTP ${response.status})`,
        httpErrorCode(response.status, providerError),
        {
          status: response.status,
          ...id === void 0 ? {} : { requestId: id }
        }
      );
    }
    let list;
    try {
      list = await response.json();
    } catch {
      throw new LlmError4(`NewAPI model discovery from ${base} returned a malformed body`, "MALFORMED_RESPONSE");
    }
    const catalog = new Map(connection.models.map((model) => [model.id, model]));
    const excludes = connection.modelExcludePatterns.map((pattern) => pattern.toLowerCase());
    const models = [];
    for (const entry of list.data ?? []) {
      if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
      const id = entry.id.toLowerCase();
      if (excludes.some((pattern) => id.includes(pattern))) continue;
      const known = catalog.get(entry.id);
      models.push({
        id: entry.id,
        name: displayModelName(entry.id, entry.name),
        ...known?.contextWindow !== void 0 ? { contextWindow: known.contextWindow } : {},
        ...known?.maxTokens !== void 0 ? { maxTokens: known.maxTokens } : {}
      });
    }
    models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return models;
  }
  /**
   * Download the models.dev catalog (optionally through the configured
   * forward proxy) and match every requested gateway id against it, serving
   * the `models-dev-params` RPC endpoint. Runs host-side on purpose: the
   * browser only names the ids and the proxy, so no cross-origin download
   * happens and the proxy is a plain HTTP forward proxy Node can use.
   * @param request - gateway model ids and an optional proxy URL.
   * @param signal - caller cancellation.
   * @returns per id: every provider entry that matched it (possibly several —
   *   the user resolves which provider's facts to adopt), possibly none.
   */
  async fetchModelsDevParams(request, signal) {
    const proxyUrl = request.proxyUrl !== void 0 && request.proxyUrl.length > 0 ? request.proxyUrl : this.config.options().proxyUrl;
    const dispatcher = proxyUrl !== void 0 ? new ProxyAgent(proxyUrl) : void 0;
    let api;
    try {
      const request_ = {
        headers: { accept: "application/json", ...attributionHeaders() },
        signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS)])
      };
      const response = dispatcher === void 0 ? await fetch(MODELS_DEV_API_URL, request_) : await undiciFetch(MODELS_DEV_API_URL, { ...request_, dispatcher });
      if (!response.ok) {
        throw new LlmError4(
          `models.dev catalog fetch failed (HTTP ${response.status})`,
          httpErrorCode(response.status),
          { status: response.status }
        );
      }
      api = await response.json();
    } catch (error) {
      if (error instanceof LlmError4) throw error;
      if (signal.aborted) throw error;
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : error instanceof Error ? `: ${error.message}` : "";
      const remedy = proxyUrl !== void 0 ? ` \u2014 the proxy at ${proxyUrl} is unreachable; check that it is running, or change or disable the proxy setting` : " \u2014 if the direct route cannot reach models.dev, enable the proxy";
      throw new LlmError4(
        `models.dev catalog fetch failed${cause}${remedy}`,
        "TRANSPORT",
        { cause: error }
      );
    } finally {
      void dispatcher?.close().catch(() => {
      });
    }
    const hints = this.config.options().providerHints;
    return {
      models: await Promise.all(request.modelIds.map(async (id) => ({
        id,
        matches: await this.prioritizeOfficial(id, matchModelsDev(api, id, hints))
      })))
    };
  }
  /**
   * Registry-based official priority, complementing the hint-driven one
   * inside {@link matchModelsDev}: when the hints did NOT flag a match
   * official yet, a route registered on ctx.llm that officially serves the
   * id (bare, or the last segment of a routed id) still leads. Runs only
   * when nothing is flagged, so the two mechanisms never fight.
   * @param id - the gateway model id.
   * @param matches - every catalog match, hinted order already applied.
   * @returns matches with the registry-official one first, flagged.
   */
  async prioritizeOfficial(id, matches) {
    const hook = this.config.officialProviderOf;
    if (hook === void 0 || matches.length < 2 || matches.some((match) => match.official === true)) return matches;
    const slash = id.lastIndexOf("/");
    const official = await hook(id) ?? (slash === -1 ? void 0 : await hook(id.slice(slash + 1)));
    if (official === void 0) return matches;
    const at = matches.findIndex((match) => match.provider === official);
    const hit = at === -1 ? void 0 : matches[at];
    if (hit === void 0) return matches;
    const rest = matches.filter((_match, index) => index !== at);
    return [{ ...hit, official: true }, ...rest];
  }
  async *stream(options) {
    var _stack = [];
    try {
      const connection = this.config.options(options.provider);
      const apiKey = await this.config.resolveApiKey(connection);
      const consumer = new AbortController();
      const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
      const watchdog = __using(_stack, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE));
      const iterator = this.request(
        options,
        watchdog.signal,
        connection,
        apiKey,
        () => {
          watchdog.pulse();
        }
      )[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const result = await watchdog.next(iterator);
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } catch (error) {
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) {
          throw new LlmError4(
            `NewAPI stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
            "TIMEOUT",
            { cause: error }
          );
        }
        if (options.signal?.aborted) {
          throw new LlmError4("NewAPI request aborted by caller", "ABORTED", { cause: error });
        }
        if (error instanceof LlmError4) throw error;
        throw new LlmError4(`NewAPI stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
      } finally {
        consumer.abort("NewAPI stream consumer stopped");
        if (!exhausted && iterator.return !== void 0) {
          try {
            await iterator.return();
          } catch (_abortedTransportTeardown) {
          }
        }
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  async *request(options, signal, connection, apiKey, onComment) {
    const body = connection.protocol === "responses" ? await serializeResponsesRequestWithImages(options, this.config.readImage, signal) : connection.protocol === "anthropic-messages" ? await serializeAnthropicRequestWithImages(options, this.config.readImage, signal) : await serializeRequestWithImages(options, this.config.readImage, signal);
    const payload = JSON.stringify(body);
    const headers = {
      ...connection.protocol === "anthropic-messages" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` },
      "content-type": "application/json",
      "accept": "text/event-stream",
      // The mandatory product attribution; nothing per-request or per-user
      // rides on a third-party gateway request.
      ...attributionHeaders()
    };
    let response;
    try {
      const endpoint = connection.protocol === "responses" ? "/responses" : connection.protocol === "anthropic-messages" ? "/messages" : "/chat/completions";
      response = await fetch(`${connection.baseURL}${endpoint}`, {
        method: "POST",
        headers,
        body: payload,
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError4(
        `NewAPI request to ${connection.baseURL} failed`,
        "TRANSPORT",
        { cause: error }
      );
    }
    if (!response.ok) {
      let message = `NewAPI error (HTTP ${response.status})`;
      let providerError;
      try {
        const parsed = await response.json();
        providerError = parsed.error;
        if (providerError?.message) message = providerError.message;
      } catch {
      }
      const delay = providerRetryAfterMs(response.headers.get("retry-after"));
      const id = requestId(response.headers);
      throw new LlmError4(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === void 0 ? {} : { providerRetryAfterMs: delay },
        ...id === void 0 ? {} : { requestId: id }
      });
    }
    if (!response.body) {
      throw new LlmError4("NewAPI returned no response body", "EMPTY_RESPONSE");
    }
    if (connection.protocol === "responses") {
      yield* translateResponses(parseSseEvents(response.body, onComment));
    } else if (connection.protocol === "anthropic-messages") {
      yield* translateAnthropic(parseSseEvents(response.body, onComment));
    } else {
      yield* translate(parseSse(response.body, onComment));
    }
  }
};

// src/index.ts
var name = "llm-newapi";
var inject = ["llm"];
var NS = settingsNamespace("llm-newapi");
var API_KEY_REF = "newapi";
var BASE_URL_ENV = "NEWAPI_BASE_URL";
var DEFAULT_BASE_URL = "https://newapi.example.com/v1";
var PROVIDER = "newapi";
var catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string(),
  input: z.array(z.union(["text", "image"]))
});
var channelSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  baseURL: z.string(),
  protocol: z.union(["chat-completions", "responses", "anthropic-messages"]),
  apiKeyRef: z.string(),
  models: z.array(catalogModel),
  modelExcludePatterns: z.array(z.string()),
  defaultContextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  retryPolicy: RetryPolicySchema
});
var DEFAULT_PROXY_URL = "http://127.0.0.1:7890";
var proxySchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(DEFAULT_PROXY_URL)
});
var Config = z.object({
  baseURL: z.string(),
  protocol: z.union(["chat-completions", "responses", "anthropic-messages"]).default("chat-completions"),
  models: z.array(catalogModel).default([]),
  modelExcludePatterns: z.array(z.string()).default([...DEFAULT_MODEL_EXCLUDE_PATTERNS]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  proxy: proxySchema.default({ enabled: false, url: DEFAULT_PROXY_URL }),
  providerHints: z.object({
    defaults: z.object({}),
    models: z.object({})
  }),
  retryPolicy: RetryPolicySchema,
  channels: z.array(channelSchema).default([])
});
function resolveModels(models) {
  const seen = /* @__PURE__ */ new Set();
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error(`${PKG}: catalog model ids must be non-empty`);
    if (model.name !== void 0 && model.name.length === 0) {
      throw new Error(`${PKG}: catalog model "${model.id}" has an empty name`);
    }
    if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `${PKG}: catalog model "${model.id}" contextWindow must be a positive integer`
      );
    }
    if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `${PKG}: catalog model "${model.id}" maxTokens must be a positive integer`
      );
    }
    if (seen.has(model.id)) throw new Error(`${PKG}: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    for (const effort of model.reasoningEfforts ?? []) {
      if (effort.length === 0) throw new Error(`${PKG}: catalog model "${model.id}" has an empty reasoning effort`);
    }
    if (model.defaultReasoningEffort !== void 0 && !(model.reasoningEfforts ?? []).includes(model.defaultReasoningEffort)) {
      throw new Error(
        `${PKG}: catalog model "${model.id}" default reasoning effort "${model.defaultReasoningEffort}" is not among its reasoning efforts`
      );
    }
    if (model.input !== void 0 && model.input.length > 0) {
      if (!model.input.includes("text")) throw new Error(`${PKG}: catalog model "${model.id}" input must include text`);
      if (new Set(model.input).size !== model.input.length) throw new Error(`${PKG}: catalog model "${model.id}" has duplicate input modalities`);
    }
    return {
      id: model.id,
      ...model.name === void 0 ? {} : { name: model.name },
      ...model.description === void 0 ? {} : { description: model.description },
      ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
      ...model.reasoningEfforts === void 0 || model.reasoningEfforts.length === 0 ? {} : { reasoningEfforts: model.reasoningEfforts },
      ...model.defaultReasoningEffort === void 0 ? {} : { defaultReasoningEffort: model.defaultReasoningEffort },
      ...model.input === void 0 ? {} : { input: [...model.input] }
    };
  });
}
function resolveSingleAdapterOptions(config, environment, channel) {
  const source = channel === void 0 ? config : {
    ...config,
    ...channel.baseURL === void 0 ? {} : { baseURL: channel.baseURL },
    ...channel.protocol === void 0 ? {} : { protocol: channel.protocol },
    ...channel.models === void 0 ? {} : { models: channel.models },
    ...channel.modelExcludePatterns === void 0 ? {} : { modelExcludePatterns: channel.modelExcludePatterns },
    ...channel.defaultContextWindow === void 0 ? {} : { defaultContextWindow: channel.defaultContextWindow },
    ...channel.maxTokens === void 0 ? {} : { maxTokens: channel.maxTokens },
    ...channel.streamIdleTimeoutMs === void 0 ? {} : { streamIdleTimeoutMs: channel.streamIdleTimeoutMs },
    ...channel.retryPolicy === void 0 ? {} : { retryPolicy: channel.retryPolicy }
  };
  config = source;
  const named = config.baseURL !== void 0 && config.baseURL.trim().length > 0 ? config.baseURL : environment?.get(BASE_URL_ENV)?.value;
  const rawBase = named !== void 0 && named.trim().length > 0 ? named : DEFAULT_BASE_URL;
  const modelExcludePatterns = config.modelExcludePatterns ?? [...DEFAULT_MODEL_EXCLUDE_PATTERNS];
  for (const pattern of modelExcludePatterns) {
    if (pattern.length === 0) throw new Error(`${PKG}: modelExcludePatterns entries must be non-empty`);
  }
  if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error(`${PKG}: defaultContextWindow must be a positive integer`);
  }
  if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error(`${PKG}: maxTokens must be a positive safe integer`);
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `${PKG}: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`
    );
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const proxyEnabled = config.proxy?.enabled === true;
  const proxyUrlRaw = config.proxy?.url ?? DEFAULT_PROXY_URL;
  if (proxyEnabled) {
    try {
      new URL(proxyUrlRaw);
    } catch {
      throw new Error(`${PKG}: proxy.url must be an absolute URL (got: ${proxyUrlRaw})`);
    }
    if (!/^https?:$/.test(new URL(proxyUrlRaw).protocol)) {
      throw new Error(`${PKG}: proxy.url must be an http(s) URL (got: ${proxyUrlRaw})`);
    }
  }
  return {
    provider: channel?.provider ?? PROVIDER,
    displayName: channel?.displayName ?? "NewAPI",
    baseURL: normalizeBaseUrl(rawBase),
    protocol: config.protocol ?? "chat-completions",
    apiKeyRef: credentialRef(channel?.apiKeyRef ?? (channel?.provider === void 0 || channel.provider === PROVIDER ? API_KEY_REF : `newapi_${channel.provider.replaceAll("-", "_")}`)),
    models: resolveModels(config.models),
    modelExcludePatterns,
    defaultContextWindow,
    streamIdleTimeoutMs,
    ...proxyEnabled ? { proxyUrl: proxyUrlRaw } : {},
    providerHints: {
      defaults: { ...config.providerHints?.defaults },
      models: { ...config.providerHints?.models }
    },
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${PKG}: retryPolicy`),
    ...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens }
  };
}
function providerFromUrl(raw) {
  try {
    const hostname = new URL(normalizeBaseUrl(raw)).hostname.toLowerCase();
    const value = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return value.length > 0 ? value : PROVIDER;
  } catch {
    return PROVIDER;
  }
}
function displayNameFromUrl(raw) {
  try {
    return new URL(normalizeBaseUrl(raw)).hostname;
  } catch {
    return "NewAPI";
  }
}
function resolvedChannels(config, environment) {
  const channels = config.channels ?? [];
  if (channels.length === 0) return [resolveSingleAdapterOptions(config, environment)];
  const used = /* @__PURE__ */ new Set();
  return channels.map((channel, index) => {
    const baseURL = channel.baseURL ?? config.baseURL ?? DEFAULT_BASE_URL;
    const derived = providerFromUrl(baseURL);
    const provider = channel.provider?.trim() || derived;
    if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
      throw new Error(`${PKG}: channel provider "${provider}" must start with a lowercase letter and contain only a-z, 0-9, or -`);
    }
    if (used.has(provider)) throw new Error(`${PKG}: duplicate channel provider "${provider}"`);
    used.add(provider);
    const normalized = {
      ...channel,
      provider,
      displayName: channel.displayName?.trim() || displayNameFromUrl(baseURL),
      baseURL
    };
    return resolveSingleAdapterOptions(config, environment, normalized);
  });
}
function resolveAdapterOptions(config, environment) {
  return resolvedChannels(config, environment)[0];
}
function resolveAdapterChannels(config, environment) {
  return resolvedChannels(config, environment);
}
function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolvedChannels(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      lastRaw = raw;
      ctx.logger.error(`${PKG}: keeping the last good configuration after an invalid settings section`);
      ctx.logger.error(error);
      return lastGood;
    }
  };
  const initial = options();
  const optionFor = (provider) => {
    const all = options();
    return all.find((connection) => connection.provider === provider) ?? all[0];
  };
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyRef;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey2(hit.value, PKG, ref);
    }
    throw new LlmError5(
      `${PKG}: no API key for provider route "${connection.provider}"; configure it on the NewAPI settings page in dsh web (credentials reference "${ref}")`,
      "MISSING_CREDENTIAL"
    );
  };
  let indexCache;
  const officialProviderOf = async (modelId) => {
    const routes = ctx.llm.listProviders().map((provider) => provider.id).sort().join(",");
    if (indexCache === void 0 || indexCache.routes !== routes) {
      const byModel = /* @__PURE__ */ new Map();
      for (const provider of ctx.llm.listProviders()) {
        if (options().some((connection) => connection.provider === provider.id)) continue;
        try {
          for (const model of await ctx.llm.listModels(provider.id)) {
            byModel.set(model.id, provider.id);
          }
        } catch {
        }
      }
      indexCache = { routes, byModel };
    }
    return indexCache.byModel.get(modelId);
  };
  const readImage = async (ref, signal) => {
    const attachments = ctx.get("attachments");
    if (attachments === void 0) {
      throw new LlmError5(`${PKG}: image input needs the dsh attachment service`, "UNSUPPORTED_CONTENT");
    }
    return attachments.readImage(ref, signal);
  };
  const adapter = new NewApiAdapter({ options: optionFor, resolveApiKey, readImage, officialProviderOf });
  const directoryEntries = (connections) => connections.map((connection) => ({
    provider: connection.provider,
    displayName: connection.displayName,
    settingsNs: NS,
    settingsPath: [],
    declared: true
  }));
  const directory = ctx.llm.registerConfigurableProviders(directoryEntries(initial));
  const registration = ctx.llm.registerAdapter(initial.map((connection) => connection.provider), adapter);
  let registered = initial;
  const ensureRegistrationFacts = () => {
    const next = options();
    if (deepEqualJson(next, registered)) return;
    directory.replace(directoryEntries(next));
    registration.replace(next.map((connection) => connection.provider));
    registered = next;
  };
  ctx.llm.registerModelDiscovery(NS, (request) => adapter.discoverModels(request));
  ctx.inject(["connection"], (cctx) => {
    const connection = cctx.get("connection");
    cctx.effect(() => connection.rpc.handle(
      "/llm-newapi",
      (endpoint, payload, signal) => {
        if (endpoint !== "models-dev-params") {
          return Promise.resolve({
            ok: false,
            error: { code: "internal", message: `llm-newapi: unknown endpoint ${endpoint}`, details: {} }
          });
        }
        const request = payload;
        return adapter.fetchModelsDevParams(request, signal).then((value) => ({ ok: true, value })).catch((error) => ({
          ok: false,
          error: {
            code: "internal",
            message: error instanceof Error ? error.message : String(error),
            details: {}
          }
        }));
      },
      { authority: "loopback" }
    ), "llm-newapi: models-dev RPC channel");
  });
  installSettingsSection(ctx, NS, Config, config, {
    // Refuse an unserviceable section where it is written: without this a
    // schema-valid value the adapter cannot serve (a non-http(s) baseURL,
    // an empty exclude-pattern entry) stores with a success notice and
    // then silently keeps the last good facts at every request.
    validate: (value) => {
      resolvedChannels(value, launchEnvironmentOf(ctx));
    },
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts
  });
}
export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_EXCLUDE_PATTERNS,
  DEFAULT_PROVIDER_HINTS,
  DEFAULT_PROXY_URL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  NewApiAdapter,
  PKG,
  apply,
  inject,
  matchModelsDev,
  modelNameFromId,
  name,
  normalizeBaseUrl,
  resolveAdapterChannels,
  resolveAdapterOptions,
  serializeAnthropicRequest,
  serializeAnthropicRequestWithImages,
  serializeRequest,
  serializeRequestWithImages,
  serializeResponsesRequest,
  serializeResponsesRequestWithImages
};
//# sourceMappingURL=index.js.map
