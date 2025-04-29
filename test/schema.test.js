import {
  consumeOptionsProperties,
  groupOptionsProperties,
  MessagesStreamFallbackModes,
  MessagesStreamModes,
  topicWithPartitionAndOffsetProperties
} from '@platformatic/kafka'
import { deepStrictEqual, strictEqual } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { schema } from '../lib/schema.js'

test('should export stackable schema', async () => {
  const kafkaHooksPackageJson = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))

  strictEqual(
    schema.$id,
    `https://schemas.platformatic.dev/@platformatic/kafka-hooks/${kafkaHooksPackageJson.version}.json`
  )
  strictEqual(typeof schema.version, 'string')

  deepStrictEqual(schema.properties.kafka, {
    type: 'object',
    properties: {
      brokers: {
        type: 'array',
        items: {
          type: 'string'
        },
        minItems: 1
      },
      topics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            dlq: { oneOf: [{ type: 'string', default: 'plt-kafka-dlq' }, { type: 'boolean' }] },
            url: { type: 'string' },
            method: { type: 'string', default: 'POST', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
            headers: {
              type: 'object',
              additionalProperties: {
                type: 'string'
              }
            },
            retries: {
              type: 'integer',
              minimum: 1,
              default: 3
            },
            retryDelay: {
              type: 'integer',
              minimum: 250,
              default: 1000
            },
            includeAttemptInRequests: {
              type: 'boolean',
              default: true
            }
          },
          required: ['topic', 'url']
        },
        minItems: 1
      },
      consumer: {
        type: 'object',
        properties: {
          ...groupOptionsProperties,
          ...consumeOptionsProperties,
          groupId: {
            type: 'string'
          },
          mode: { type: 'string', enum: Object.values(MessagesStreamModes) },
          fallbackMode: { type: 'string', enum: Object.values(MessagesStreamFallbackModes) },
          offsets: {
            type: 'array',
            items: {
              type: 'object',
              properties: topicWithPartitionAndOffsetProperties,
              required: ['topic', 'partition', 'offset'],
              additionalProperties: false
            }
          }
        },
        required: ['groupId']
      },
      concurrency: {
        type: 'integer',
        minimum: 1,
        default: 1
      },
      serialization: {
        type: 'string',
        resolvePath: true
      }
    },
    required: ['brokers', 'topics', 'consumer']
  })
})
