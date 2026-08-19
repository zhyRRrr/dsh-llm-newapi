/** Vision serialization regression checks for all supported wire protocols. */
import assert from 'node:assert/strict'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

const attachment = {
  attachmentId: 'vision-smoke',
  mediaType: 'image/png',
  byteLength: 4,
  sha256: '0'.repeat(64),
}
const image = {
  ref: attachment,
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
}
const options = {
  provider: 'newapi',
  model: 'vision-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image', attachment }] }],
}
let reads = 0
const readImage = async (ref) => {
  reads += 1
  assert.equal(ref, attachment)
  return image
}
const dataUrl = 'data:image/png;base64,iVBORw=='

const chat = await plugin.serializeRequestWithImages(options, readImage)
assert.deepEqual(chat.messages, [{
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this image.' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ],
}])

const responses = await plugin.serializeResponsesRequestWithImages(options, readImage)
assert.deepEqual(responses.input, [{
  type: 'message',
  role: 'user',
  content: [
    { type: 'input_text', text: 'Describe this image.' },
    { type: 'input_image', image_url: dataUrl },
  ],
}])

const anthropic = await plugin.serializeAnthropicRequestWithImages(options, readImage)
assert.deepEqual(anthropic.messages, [{
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this image.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
  ],
}])
assert.equal(reads, 3)

const adapter = new plugin.NewApiAdapter({
  options: () => ({
    baseURL: 'http://gw.local:3000/v1',
    apiKeyRef: 'newapi',
    models: [
      { id: 'vision-model', input: ['text', 'image'] },
      { id: 'text-model' },
    ],
    modelExcludePatterns: [],
    defaultContextWindow: 128_000,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'vision-smoke'),
  }),
  resolveApiKey: async () => 'smoke-key',
  readImage,
})
assert.deepEqual((await adapter.resolveModel('newapi', 'vision-model')).inputModalities, ['text', 'image'])
assert.deepEqual((await adapter.resolveModel('newapi', 'text-model')).inputModalities, ['text'])
assert.deepEqual((await adapter.resolveModel('newapi', 'unlisted-model')).inputModalities, ['text'])

console.log('vision: OpenAI Chat, Responses, Anthropic image bodies and model capabilities OK')
