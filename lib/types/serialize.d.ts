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
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { AnthropicRequest, ResponsesRequest, WireMessage, WireRequest } from './types.js';
/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export declare function serializeMessages(messages: Message[]): WireMessage[];
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
export declare function serializeRequest(options: GenerateOptions): WireRequest;
/** Build an OpenAI Chat Completions request with inline image attachment support. */
export declare function serializeRequestWithImages(options: GenerateOptions, readImage?: ReadImage, signal?: AbortSignal): Promise<WireRequest>;
/** Read verified attachment bytes from the host attachment store. */
export type ReadImage = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<StoredImageAttachment>;
/** Serialize the same harness conversation for the OpenAI Responses API. */
export declare function serializeResponsesRequest(options: GenerateOptions): ResponsesRequest;
/** Build an OpenAI Responses request with inline image attachment support. */
export declare function serializeResponsesRequestWithImages(options: GenerateOptions, readImage?: ReadImage, signal?: AbortSignal): Promise<ResponsesRequest>;
/** Serialize the harness conversation for Anthropic Messages. */
export declare function serializeAnthropicRequest(options: GenerateOptions): AnthropicRequest;
/** Build an Anthropic Messages request with base64 image source blocks. */
export declare function serializeAnthropicRequestWithImages(options: GenerateOptions, readImage?: ReadImage, signal?: AbortSignal): Promise<AnthropicRequest>;
