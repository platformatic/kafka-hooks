import { Consumer, jsonSerializer, Producer, sleep, stringDeserializer, stringSerializer } from '@platformatic/kafka'
import { ensureLoggableError } from '@platformatic/utils'
import { ACCEPTED, BAD_REQUEST, HttpError, NotFoundError, REQUEST_TIMEOUT } from 'http-errors-enhanced'
import { forEach } from 'hwp'
import { request } from 'undici'
import { randomUUID } from 'node:crypto'
import {
  attemptHeader,
  correlationIdHeader,
  defaultConcurrency,
  defaultDlqTopic,
  defaultMethod,
  defaultRequestResponseTimeout,
  defaultRetries,
  defaultRetryDelay,
  keyHeader
} from './definitions.js'

export async function processMessage (logger, dlqProducer, mappings, message) {
  const topic = message.topic
  const value = message.value
  const { url, dlq, method, retryDelay, headers: protoHeaders, retries, includeAttemptInRequests } = mappings[topic]
  const headers = {
    ...protoHeaders,
    ...Object.fromEntries(message.headers),
    [keyHeader]: message.key
  }

  // Perform the delivery
  const errors = []
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (includeAttemptInRequests) {
        headers[attemptHeader] = attempt + 1
      }

      headers['content-length'] = Buffer.byteLength(value)

      const requestedAt = new Date()
      const {
        statusCode,
        headers: responseHeaders,
        body
      } = await request(url, {
        method,
        headers,
        body: value
      })

      // Success, nothing else to do
      if (statusCode < BAD_REQUEST) {
        await body.dump()
        return
      }

      const error = new HttpError(statusCode, 'Webhook replied with an error', {
        requestedAt: requestedAt.toISOString(),
        attempt,
        headers: responseHeaders,
        /* c8 ignore next */
        body: await (responseHeaders['content-type']?.startsWith('application/json') ? body.json() : body.text())
      })

      logger.error({ err: error }, 'Error while processing message')

      // This is hidden by http-errors-enhanced by default
      Reflect.defineProperty(error, 'headers', { enumerable: true })
      errors.push(error)
    } catch (error) {
      logger.warn({ err: error }, 'Error while processing message')
      errors.push(new HttpError(499, 'Generic error', { cause: error, attempt }))
    }

    await sleep(retryDelay)
  }

  const dlqMessage = {
    topic: dlq,
    value: {
      key: message.key,
      value: message.value.toString('base64'),
      headers: message.headers,
      topic: message.topic,
      partition: message.partition,
      offset: message.offset.toString(),
      errors: errors.map(e => e.serialize(true)),
      retries
    }
  }

  if (!dlq) {
    logger.error({ dlqMessage }, 'Error while processing message')
    return
  }

  const toSend = {
    messages: [dlqMessage]
  }

  // If we reach this point, all attempts failed, we send to the DLQ
  await dlqProducer.send(toSend)
}

function createResponseProcessor (logger, pendingRequests) {
  return async function processResponseMessage (message) {
    // Convert headers map to object with string keys
    const headers = {}
    for (const [key, value] of message.headers) {
      headers[key.toString()] = value.toString()
    }

    const correlationId = headers[correlationIdHeader]

    if (!correlationId) {
      logger.warn({ topic: message.topic }, 'Response message missing correlation ID')
      return
    }

    const pendingRequest = pendingRequests.get(correlationId)
    if (!pendingRequest) {
      logger.warn({ correlationId, topic: message.topic }, 'No pending request found for correlation ID')
      return
    }

    clearTimeout(pendingRequest.timeout)
    pendingRequests.delete(correlationId)

    const statusCode = parseInt(headers['x-status-code'] || '200', 10)
    const contentType = headers['content-type'] || 'application/octet-stream'

    pendingRequest.reply
      .status(statusCode)
      .header('content-type', contentType)
      .send(message.value)
  }
}

export async function setupKafka (server, configuration) {
  const topics = new Set()
  const dlqs = new Set()
  const topicsMappings = {}
  const responseMappings = {}
  const pendingRequests = new Map()

  for (const topic of configuration.kafka.topics) {
    topic.dlq ??= defaultDlqTopic
    topic.method ??= defaultMethod
    topic.headers ??= {}
    topic.retryDelay ??= defaultRetryDelay
    topic.retries ??= defaultRetries
    topic.includeAttemptInRequests ??= true

    topics.add(topic.topic)

    if (topic.dlq) {
      dlqs.add(topic.dlq)
    }

    topicsMappings[topic.topic] = topic
  }

  // Handle request/response mappings
  if (configuration.kafka.requestResponse) {
    for (const mapping of configuration.kafka.requestResponse) {
      topics.add(mapping.responseTopic)
      responseMappings[mapping.responseTopic] = mapping
    }
  }

  const producer = new Producer({
    bootstrapBrokers: configuration.kafka.brokers,
    serializers: {
      key: stringSerializer,
      headerKey: stringSerializer,
      headerValue: stringSerializer
    },
    /* c8 ignore next */
    metrics: globalThis.platformatic?.prometheus
  })

  const dlqProducer = new Producer({
    bootstrapBrokers: configuration.kafka.brokers,
    serializers: {
      key: stringSerializer,
      value: jsonSerializer,
      headerKey: stringSerializer,
      headerValue: stringSerializer
    },
    /* c8 ignore next */
    metrics: globalThis.platformatic?.prometheus
  })

  const { mode, fallbackMode, offsets, ...consumerOptions } = configuration.kafka.consumer
  const consumer = new Consumer({
    bootstrapBrokers: configuration.kafka.brokers,
    deserializers: {
      key: stringDeserializer,
      headerKey: stringDeserializer,
      headerValue: stringDeserializer
    },
    /* c8 ignore next */
    metrics: globalThis.platformatic?.prometheus,
    ...consumerOptions
  })

  // Create all allowed topics via metadata
  const topicsList = Array.from(topics)
  await producer.metadata({ topics: topicsList, autocreateTopics: true })
  await dlqProducer.metadata({ topics: Array.from(dlqs), autocreateTopics: true })

  // Start the consumer
  const stream = await consumer.consume({ topics: topicsList, mode, fallbackMode, offsets, ...consumerOptions })
  server.log.info(`Kafka consumer started with concurrency ${configuration.kafka.concurrency} ...`)

  const responseProcessor = createResponseProcessor(server.log, pendingRequests)

  forEach(
    stream,
    message => {
      if (responseMappings[message.topic]) {
        return responseProcessor(message)
      } else {
        return processMessage(server.log, dlqProducer, topicsMappings, message)
      }
    },
    /* c8 ignore next 8 */
    configuration.kafka.concurrency ?? defaultConcurrency
  ).catch(error => {
    server.log.error({ error: ensureLoggableError(error) }, 'Error while processing messages. Aborting ...')

    // Throwing an unrecoverable error will stop the server, but
    // it allows for a graceful shutdown so we can process all the
    // in flight requests.
    throw error
  })

  server.addHook('onClose', async () => {
    server.log.info('Closing Kafka connections ...')
    await producer.close()
    await dlqProducer.close()
    await consumer.close(true)
  })

  server.decorate('kafkaProducer', producer)

  return { topics, pendingRequests, responseMappings }
}

export async function plugin (server, opts) {
  /* c8 ignore next */
  const configuration = server.platformatic?.config ?? opts.context?.stackable.configManager.current
  const { topics, pendingRequests } = await setupKafka(server, configuration)

  server.removeContentTypeParser('application/json')
  server.removeContentTypeParser('application/json; charset=utf-8')
  server.removeContentTypeParser('text/plain')

  server.addContentTypeParser(/^.*$/, { parseAs: 'buffer' }, (request, payload, done) => {
    done(null, payload)
  })

  server.route({
    method: 'POST',
    url: '/topics/:topic',
    schema: {
      headers: {
        type: 'object',
        properties: {
          [keyHeader]: { type: 'string' }
        },
        additionalProperties: true
      },
      params: {
        type: 'object',
        properties: {
          topic: { type: 'string' }
        },
        required: ['topic']
      }
    },
    async handler (request, reply) {
      const topic = request.params.topic

      if (!topics.has(topic)) {
        const error = new NotFoundError(`Topic ${topic} not found.`)
        reply.status(error.status).send({ code: error.code, ...error.serialize() })
        return
      }

      await server.kafkaProducer.send({
        messages: [
          {
            topic,
            key: request.headers[keyHeader],
            value: request.body,
            headers: {
              'content-type': request.headers['content-type'],
              ...Object.fromEntries(Object.entries(request.headers).filter(([key]) => key !== 'content-type' && key !== keyHeader))
            }
          }
        ]
      })

      return reply.status(ACCEPTED).send()
    }
  })

  // Request/Response endpoint
  if (configuration.kafka.requestResponse) {
    for (const mapping of configuration.kafka.requestResponse) {
      server.route({
        method: 'POST',
        url: mapping.path,
        schema: {
          headers: {
            type: 'object',
            properties: {
              [keyHeader]: { type: 'string' }
            },
            additionalProperties: true
          }
        },
        async handler (request, reply) {
          const correlationId = randomUUID()
          const timeout = mapping.timeout || defaultRequestResponseTimeout

          const timeoutHandle = setTimeout(() => {
            pendingRequests.delete(correlationId)
            if (!reply.sent) {
              const error = new HttpError(REQUEST_TIMEOUT, 'Request timeout')
              reply.status(error.status).send({ code: error.code, ...error.serialize() })
            }
          }, timeout)

          pendingRequests.set(correlationId, {
            reply,
            timeout: timeoutHandle,
            requestedAt: Date.now()
          })

          await server.kafkaProducer.send({
            messages: [
              {
                topic: mapping.requestTopic,
                key: request.headers[keyHeader],
                value: request.body,
                headers: {
                  'content-type': request.headers['content-type'],
                  [correlationIdHeader]: correlationId
                }
              }
            ]
          })

          return reply
        }
      })
    }
  }
}
