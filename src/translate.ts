/**
 * Translate gateway SSE payloads with one stateful harness block per content,
 * reasoning, or tool-call index. An empty initial reasoning delta does not
 * open a block. Finish reason and the latest usage are deferred until
 * `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while ensuring no chunk follows `finish`.
 *
 * @module dsh-llm-newapi/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'
import type { SseEvent } from './sse.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. `prompt_tokens` INCLUDES cache hits; the harness
 * TokenUsage convention is DISJOINT counts, so cache reads are subtracted
 * out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: reasoning-capable upstreams interleave it before
      // text. The empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        // Non-empty guards: some gateways (glm-5.3 via qcplay) repeat
        // `id`/`name` on every delta as EMPTY strings instead of omitting
        // the field; a presence check alone would clobber the real values
        // carried by the first delta (issue #1).
        if (call.id !== undefined && call.id.length > 0) block.callId = call.id
        if (call.function?.name !== undefined && call.function.name.length > 0) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

/** Translate OpenAI Responses API named SSE events into DSH stream chunks. */
export async function* translateResponses(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let text: OpenBlock | undefined
  let reasoning: OpenBlock | undefined
  const calls = new Map<string, OpenBlock>()
  const order: OpenBlock[] = []
  let usage: TokenUsage | undefined
  let finish: FinishReason | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  const ensureCall = (itemId: string, callId?: string, name?: string): { block: OpenBlock; created: boolean } => {
    let block = calls.get(itemId)
    let created = false
    if (block === undefined) {
      block = open('tool-call')
      block.callId = callId ?? itemId
      if (name !== undefined && name.length > 0) block.name = name
      calls.set(itemId, block)
      created = true
    } else {
      if (callId !== undefined && callId.length > 0) block.callId = callId
      if (name !== undefined && name.length > 0) block.name = name
    }
    return { block, created }
  }
  const close = (): StreamChunk[] => order.map(block => ({ type: 'block-end', index: block.index, block: closeBlock(block) }))
  for await (const frame of events) {
    let data: any
    try { data = JSON.parse(frame.data) } catch { throw new LlmError(`malformed Responses SSE payload: ${frame.data.slice(0, 120)}`, 'MALFORMED_RESPONSE') }
    const event = frame.event ?? data.type
    if (event === 'response.output_text.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (delta.length > 0) {
        if (text === undefined) { text = open('text'); yield { type: 'block-start', index: text.index, blockType: 'text' } }
        text.text += delta; yield { type: 'text-delta', index: text.index, text: delta }
      }
    } else if (event === 'response.reasoning_summary_text.delta' || event === 'response.reasoning_text.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (delta.length > 0) {
        if (reasoning === undefined) { reasoning = open('reasoning'); yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' } }
        reasoning.text += delta; yield { type: 'reasoning-delta', index: reasoning.index, text: delta }
      }
    } else if (event === 'response.output_item.added' || event === 'response.output_item.done') {
      const item = data.item
      if (item?.type === 'function_call') {
        const itemId = String(item.id ?? item.item_id ?? item.call_id ?? '')
        const callId = typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : undefined
        if (itemId.length > 0) {
          const { block, created } = ensureCall(itemId, callId, typeof item.name === 'string' ? item.name : undefined)
          if (created) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          if (event === 'response.output_item.done' && typeof item.arguments === 'string' && block.text.length === 0) block.text = item.arguments
        }
      }
    } else if (event === 'response.function_call_arguments.delta') {
      const itemId = String(data.item_id ?? data.call_id ?? '')
      const callId = typeof data.call_id === 'string' && data.call_id.length > 0 ? data.call_id : undefined
      if (itemId.length > 0) {
        const { block, created } = ensureCall(itemId, callId)
        if (created) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        const delta = typeof data.delta === 'string' ? data.delta : ''
        block.text += delta
        yield { type: 'tool-call-delta', index: block.index, id: CallId(block.callId ?? itemId), ...block.name === undefined ? {} : { name: block.name }, argumentsDelta: delta }
      }
    } else if (event === 'response.completed' || event === 'response.incomplete' || event === 'response.failed') {
      const response = data.response ?? data
      const wireUsage = response.usage
      if (wireUsage !== undefined) usage = mapResponsesUsage(wireUsage)
      if (event === 'response.failed' || response.status === 'failed') {
        finish = { kind: 'error', failure: { message: response.error?.message ?? 'Responses API request failed', code: String(response.error?.code ?? 'RESPONSE_FAILED').toUpperCase() } }
      } else if (event === 'response.incomplete' || response.status === 'incomplete') {
        finish = { kind: 'max-tokens' }
      } else {
        finish = { kind: calls.size > 0 ? 'tool-calls' : 'stop' }
      }
    }
    if (usage === undefined && data.response?.usage !== undefined) usage = mapResponsesUsage(data.response.usage)
  }
  for (const chunk of close()) yield chunk
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish ?? (order.length === 0 ? { kind: 'error', failure: { message: 'model returned an empty Responses result', code: EMPTY_RESPONSE_CODE } } : { kind: 'stop' }) }
}

/** Translate Anthropic Messages SSE events into DSH stream chunks. */
export async function* translateAnthropic(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, OpenBlock>()
  let usage: TokenUsage | undefined
  let finish: FinishReason | undefined
  for await (const frame of events) {
    let data: any
    try { data = JSON.parse(frame.data) } catch {
      throw new LlmError(`malformed Anthropic SSE payload: ${frame.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    const event = frame.event ?? data.type
    if (event === 'message_start') {
      if (data.message?.usage !== undefined) usage = mapAnthropicUsage(data.message.usage)
    } else if (event === 'content_block_start') {
      const index = Number(data.index)
      const item = data.content_block
      if (!Number.isInteger(index) || item === undefined) continue
      if (item.type === 'text') {
        const block: OpenBlock = { index, kind: 'text', text: '' }
        blocks.set(index, block)
        yield { type: 'block-start', index, blockType: 'text' }
      } else if (item.type === 'tool_use') {
        const block: OpenBlock = {
          index,
          kind: 'tool-call',
          text: '',
          callId: typeof item.id === 'string' ? item.id : '',
          name: typeof item.name === 'string' ? item.name : '',
        }
        blocks.set(index, block)
        yield { type: 'block-start', index, blockType: 'tool-call' }
      } else if (item.type === 'thinking') {
        const block: OpenBlock = { index, kind: 'reasoning', text: '' }
        blocks.set(index, block)
        yield { type: 'block-start', index, blockType: 'reasoning' }
      }
    } else if (event === 'content_block_delta') {
      const index = Number(data.index)
      const block = blocks.get(index)
      if (block === undefined) continue
      const delta = data.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        block.text += delta.text
        yield { type: 'text-delta', index, text: delta.text }
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.text += delta.thinking
        yield { type: 'reasoning-delta', index, text: delta.thinking }
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.text += delta.partial_json
        yield {
          type: 'tool-call-delta',
          index,
          id: CallId(block.callId ?? ''),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: delta.partial_json,
        }
      }
    } else if (event === 'content_block_stop') {
      const index = Number(data.index)
      const block = blocks.get(index)
      if (block !== undefined) yield { type: 'block-end', index, block: closeBlock(block) }
    } else if (event === 'message_delta') {
      if (data.usage !== undefined) usage = mapAnthropicUsage(data.usage, usage)
      const reason = data.delta?.stop_reason
      if (typeof reason === 'string') finish = mapAnthropicFinishReason(reason)
    } else if (event === 'message_stop') {
      // The terminal message_delta carries the finish reason; message_stop is
      // only the transport delimiter.
    } else if (event === 'error') {
      finish = { kind: 'error', failure: { message: data.error?.message ?? 'Anthropic API request failed', code: String(data.error?.type ?? 'ANTHROPIC_ERROR').toUpperCase() } }
    }
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: finish ?? (blocks.size === 0
      ? { kind: 'error', failure: { message: 'model returned an empty Anthropic result', code: EMPTY_RESPONSE_CODE } }
      : { kind: 'stop' }),
  }
}

function mapAnthropicFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

function mapAnthropicUsage(value: any, previous?: TokenUsage): TokenUsage {
  return {
    inputTokens: Number(value?.input_tokens ?? previous?.inputTokens ?? 0),
    outputTokens: Number(value?.output_tokens ?? previous?.outputTokens ?? 0),
    ...value?.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: Number(value.cache_read_input_tokens) },
  }
}

function mapResponsesUsage(value: any): TokenUsage {
  const input = Number(value?.input_tokens ?? value?.prompt_tokens ?? 0)
  const output = Number(value?.output_tokens ?? value?.completion_tokens ?? 0)
  const cached = value?.input_tokens_details?.cached_tokens ?? value?.prompt_tokens_details?.cached_tokens
  const reasoning = value?.output_tokens_details?.reasoning_tokens ?? value?.completion_tokens_details?.reasoning_tokens
  return { inputTokens: input - (typeof cached === 'number' ? cached : 0), outputTokens: output, ...typeof cached === 'number' ? { cacheReadTokens: cached } : {}, ...typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {} }
}
