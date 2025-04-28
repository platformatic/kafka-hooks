import { consumeOptionsProperties, groupOptionsProperties, MessagesStreamFallbackModes, MessagesStreamModes, topicWithPartitionAndOffsetProperties } from '@platformatic/kafka'
import { schema as serviceSchema } from '@platformatic/service'
import { readFileSync } from 'node:fs'
import { defaultDlqTopic, defaultIncludeAttemptInRequests, defaultMethod, defaultRetries, defaultRetryDelay, minimumRetryDelay } from './definitions.js'

export const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export const schema = {
  $id: `https://schemas.platformatic.dev/@platformatic/kafka-hooks/${packageJson.version}.json`,
  title: 'Platformatic kafka-hooks configuration',
  type: 'object',
  properties: {
    ...serviceSchema.properties,
    kafka: {
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
              dlq: { type: 'string', default: defaultDlqTopic },
              url: { type: 'string' },
              method: { type: 'string', default: defaultMethod, enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
              headers: {
                type: 'object',
                additionalProperties: {
                  type: 'string'
                }
              },
              retries: {
                type: 'integer',
                minimum: 1,
                default: defaultRetries,
              },
              retryDelay: {
                type: 'integer',
                minimum: minimumRetryDelay,
                default: defaultRetryDelay
              },
              includeAttemptInRequests: {
                type: 'boolean',
                default: defaultIncludeAttemptInRequests
              }
            },
            required: ['topic', 'url'],
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
            },

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
      required: ['brokers', 'topics', 'consumer'],
    }
  },
  additionalProperties: false,
  $defs: serviceSchema.$defs,
}
