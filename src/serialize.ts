/**
 * Serialize harness messages into gateway chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool results become separate tool messages. Assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns, as required by
 * DeepSeek-family upstreams (other OpenAI-compatible upstreams ignore the
 * field). The legacy synchronous serializers reject image blocks; the async
 * `*WithImages` variants materialize verified attachment bytes for vision
 * models. Unknown declaration-merged block types retain the adapter's
 * documented extension fallback. No reasoning-control fields are emitted:
 * the adapter declares no reasoning efforts, so callers cannot pass one.
 * @module dsh-llm-newapi/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AnthropicContent, AnthropicMessage, AnthropicRequest, AnthropicTool, ResponsesContent, ResponsesInputItem, ResponsesRequest, ResponsesTool, WireContent, WireMessage, WireRequest, WireTool } from './types.ts'

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The NewAPI chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
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
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the gateway wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** Serialize messages with durable images materialized as OpenAI data URLs. */
async function serializeMessagesWithImages(
  messages: Message[],
  readImage: ReadImage | undefined,
  signal?: AbortSignal,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      assertTextOnly(message.content)
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    const images = await inlineImages(message.content, readImage, signal)
    if (text.length > 0 || images.length > 0 || toolResults.length === 0) {
      const content: string | WireContent[] = images.length === 0
        ? text
        : [
          ...text.length > 0 ? [{ type: 'text' as const, text }] : [],
          ...images.map(image => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } })),
        ]
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      assertTextOnly(result.content)
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * upstream defaults apply — including `max_tokens`, which this adapter has
 * no default for (heterogeneous upstreams each own their cap). An explicit
 * reasoning effort rides as OpenAI-compatible `reasoning_effort`; it only
 * ever arrives for a row whose catalog declares supported efforts.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the chat-completions request body.
 */
export function serializeRequest(options: GenerateOptions): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {},
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/** Build an OpenAI Chat Completions request with inline image attachment support. */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  readImage?: ReadImage,
  signal?: AbortSignal,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessagesWithImages(options.messages, readImage, signal))
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {},
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/** Read verified attachment bytes from the host attachment store. */
export type ReadImage = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<StoredImageAttachment>

interface InlineImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
  dataUrl: string
}

/** Encode attachment bytes without taking a Node.js type dependency. */
function base64Of(data: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let start = 0; start < data.length; start += chunkSize) {
    binary += String.fromCharCode(...data.subarray(start, Math.min(start + chunkSize, data.length)))
  }
  return btoa(binary)
}

async function inlineImages(
  blocks: readonly ContentBlock[],
  readImage: ReadImage | undefined,
  signal?: AbortSignal,
): Promise<InlineImage[]> {
  const imageBlocks = blocks.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
  if (imageBlocks.length === 0) return []
  if (readImage === undefined) {
    throw new LlmError('The active NewAPI route cannot read image attachments because the dsh attachment service is unavailable.', 'UNSUPPORTED_CONTENT')
  }
  return Promise.all(imageBlocks.map(async ({ attachment }) => {
    const stored = await readImage(attachment, signal)
    const data = base64Of(stored.data)
    return { mediaType: stored.ref.mediaType, data, dataUrl: `data:${stored.ref.mediaType};base64,${data}` }
  }))
}

/** Serialize the same harness conversation for the OpenAI Responses API. */
export function serializeResponsesRequest(options: GenerateOptions): ResponsesRequest {
  const input: ResponsesInputItem[] = []
  for (const message of options.messages) {
    assertTextOnly(message.content)
    const text = flattenText(message.content)
    const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
    const calls = message.content.filter(block => block.type === 'tool-call')
    const results = message.content.filter(block => block.type === 'tool-result')
    if (message.role === 'assistant') {
      if (text.length > 0 || calls.length === 0) input.push({ type: 'message', role: 'assistant', content: text })
      for (const call of calls) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
      continue
    }
    if (message.role === 'system') {
      input.push({ type: 'message', role: 'system', content: text })
      continue
    }
    if (text.length > 0 || results.length === 0) input.push({ type: 'message', role: 'user', content: text })
    for (const result of results) input.push({ type: 'function_call_output', call_id: result.toolCallId, output: flattenText(result.content) || '(no output)' })
  }
  const tools: ResponsesTool[] | undefined = options.tools?.map(tool => ({
    type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
  }))
  return {
    model: options.model,
    input,
    stream: true,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.system === undefined ? {} : { instructions: options.system },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
    ...options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort } },
    ...options.stop === undefined ? {} : { stop: options.stop },
  }
}

/** Build an OpenAI Responses request with inline image attachment support. */
export async function serializeResponsesRequestWithImages(
  options: GenerateOptions,
  readImage?: ReadImage,
  signal?: AbortSignal,
): Promise<ResponsesRequest> {
  const input: ResponsesInputItem[] = []
  for (const message of options.messages) {
    const text = flattenText(message.content)
    const calls = message.content.filter(block => block.type === 'tool-call')
    const results = message.content.filter(block => block.type === 'tool-result')
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      if (text.length > 0 || calls.length === 0) input.push({ type: 'message', role: 'assistant', content: text })
      for (const call of calls) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
      continue
    }
    if (message.role === 'system') {
      assertTextOnly(message.content)
      input.push({ type: 'message', role: 'system', content: text })
      continue
    }
    const images = await inlineImages(message.content, readImage, signal)
    if (text.length > 0 || images.length > 0 || results.length === 0) {
      const content: string | ResponsesContent[] = images.length === 0
        ? text
        : [
          ...text.length > 0 ? [{ type: 'input_text' as const, text }] : [],
          ...images.map(image => ({ type: 'input_image' as const, image_url: image.dataUrl })),
        ]
      input.push({ type: 'message', role: 'user', content })
    }
    for (const result of results) {
      assertTextOnly(result.content)
      input.push({ type: 'function_call_output', call_id: result.toolCallId, output: flattenText(result.content) || '(no output)' })
    }
  }
  const tools: ResponsesTool[] | undefined = options.tools?.map(tool => ({
    type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
  }))
  return {
    model: options.model,
    input,
    stream: true,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.system === undefined ? {} : { instructions: options.system },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
    ...options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort } },
    ...options.stop === undefined ? {} : { stop: options.stop },
  }
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsText)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Serialize the harness conversation for Anthropic Messages. */
export function serializeAnthropicRequest(options: GenerateOptions): AnthropicRequest {
  const messages: AnthropicMessage[] = []
  const systemParts: string[] = options.system === undefined ? [] : [options.system]
  for (const message of options.messages) {
    assertTextOnly(message.content)
    const text = flattenText(message.content)
    if (message.role === 'system') {
      if (text.length > 0) systemParts.push(text)
      continue
    }
    const blocks: AnthropicContent[] = []
    if (text.length > 0) blocks.push({ type: 'text', text })
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: parseToolArguments(block.arguments) })
      } else if (block.type === 'tool-result') {
        blocks.push({ type: 'tool_result', tool_use_id: block.toolCallId, content: flattenText(block.content) || '(no output)' })
      }
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  const tools: AnthropicTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    messages,
    stream: true,
    ...systemParts.length === 0 ? {} : { system: systemParts.join('\n\n') },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
  }
}

/** Build an Anthropic Messages request with base64 image source blocks. */
export async function serializeAnthropicRequestWithImages(
  options: GenerateOptions,
  readImage?: ReadImage,
  signal?: AbortSignal,
): Promise<AnthropicRequest> {
  const messages: AnthropicMessage[] = []
  const systemParts: string[] = options.system === undefined ? [] : [options.system]
  for (const message of options.messages) {
    const text = flattenText(message.content)
    if (message.role === 'system') {
      assertTextOnly(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    const blocks: AnthropicContent[] = []
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
    } else {
      const images = await inlineImages(message.content, readImage, signal)
      blocks.push(...images.map(image => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
      })))
    }
    if (text.length > 0) blocks.unshift({ type: 'text', text })
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: parseToolArguments(block.arguments) })
      } else if (block.type === 'tool-result') {
        assertTextOnly(block.content)
        blocks.push({ type: 'tool_result', tool_use_id: block.toolCallId, content: flattenText(block.content) || '(no output)' })
      }
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  const tools: AnthropicTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name, description: tool.description, input_schema: tool.parameters,
  }))
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    messages,
    stream: true,
    ...systemParts.length === 0 ? {} : { system: systemParts.join('\n\n') },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
  }
}
