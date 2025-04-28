import { Consumer, Producer, sleep, stringDeserializer, stringSerializer } from '@platformatic/kafka'
import { createRequire, ensureLoggableError, loadModule } from '@platformatic/utils'
import { ACCEPTED, BAD_REQUEST, HttpError, NotFoundError, UnsupportedMediaTypeError } from 'http-errors-enhanced'
import { forEach } from 'hwp'
import { request } from 'undici'
import { attemptHeader, defaultDlqTopic, defaultMethod, defaultRetries, defaultRetryDelay, keyHeader } from './definitions.js'

function valueSerializer (value, headers) {
  let serialized

  switch (headers.get('content-type')) {
    case 'application/json':
      serialized = JSON.stringify(value)
      break
    case 'text/plain':
      serialized = value
      break
    default:
      throw new UnsupportedMediaTypeError(`Unsupported message content-type ${headers['content-type']}.`)
  }

  return Buffer.from(serialized, 'utf-8')
}

function valueDeserializer (value, headers) {
  switch (headers.get('content-type')) {
    case 'application/json':
      return JSON.parse(Buffer.from(value, 'utf-8'))
    case 'text/plain':
      return value.toString('utf-8')
    default:
      throw new UnsupportedMediaTypeError(`Unsupported message content-type ${headers['content-type']}.`)
  }
}

export async function processMessage (logger, producer, mappings, message) {
  try {
    const topic = message.topic
    const { url, dlq, headers, method, retryDelay, retries, includeAttemptInRequests } = mappings[topic]

    // Perform the delivery
    const errors = []
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (includeAttemptInRequests) {
          headers[attemptHeader] = attempt + 1
        }

        headers['content-type'] = 'application/json'

        const requestedAt = new Date()
        const {
          statusCode,
          headers: responseHeaders,
          body
        } = await request(url, {
          method,
          headers,
          body: JSON.stringify({ key: message.key, value: message.value, headers: Object.fromEntries(message.headers.entries()) }),
        })

        // Success, nothing else to do
        if (statusCode < BAD_REQUEST) {
          return
        }

        const error = new HttpError(statusCode, 'Webhook replied with an error', {
          requestedAt: requestedAt.toISOString(),
          attempt,
          headers: responseHeaders,
          body: await (responseHeaders['content-type']?.startsWith('application/json') ? body.json() : body.text()),
        })

        // This is hidden by http-errors-enhanced by default
        Reflect.defineProperty(error, 'headers', { enumerable: true })
        errors.push(error)
      } catch (error) {
        errors.push(new HttpError(499, 'Generic error', { cause: error, attempt }))
      }

      await sleep(retryDelay)
    }

    // If we reach this point, all attempts failed, we send to the DLQ
    await producer.send({
      messages: [{
        topic: dlq,
        value: {
          key: message.key,
          message: message.value,
          headers: message.headers,
          topic: message.topic,
          partition: message.partition,
          offset: message.offset.toString(),
          errors: errors.map(e => e.serialize(true)),
          retries,
        }
      }]
    })
  } catch (error) {
    logger.error({ error: ensureLoggableError(error) }, 'Error while processing a message.')
  }
}

export async function setupKafka (server, configuration) {
  const topics = new Set()
  const dlqs = new Set()
  const topicsMappings = {}
  let serializer = valueSerializer
  let deserializer = valueDeserializer

  if (configuration.kafka.serialization) {
    try {
      const { serializer: customSerializer, deserializer: customDeserializer, mediaTypes, parseAs } = await loadModule(createRequire(import.meta.url), configuration.kafka.serialization)
      serializer = customSerializer
      deserializer = customDeserializer

      server.addContentTypeParser(mediaTypes, { parseAs: parseAs ?? 'buffer' }, function (_, payload, done) {
        done(null, payload)
      })
    } catch (e) {
      throw new Error(`Error while loading custom serialization file ${configuration.kafka.serialization}: ${e.message}.`, { cause: e })
    }
  }

  for (const topic of configuration.kafka.topics) {
    topic.dlq ??= defaultDlqTopic
    topic.method ??= defaultMethod
    topic.headers ??= {}
    topic.retryDelay ??= defaultRetryDelay
    topic.retries ??= defaultRetries
    topic.includeAttemptInRequests ??= true

    topics.add(topic.topic)
    dlqs.add(topic.dlq)
    topicsMappings[topic.topic] = topic
  }

  const producer = new Producer({
    bootstrapBrokers: configuration.kafka.brokers,
    serializers: {
      key: stringSerializer,
      value: serializer,
      headerKey: stringSerializer,
      headerValue: stringSerializer,
    },
    metrics: globalThis.platformatic?.prometheus
  })

  const { mode, fallbackMode, offsets, ...consumerOptions } = configuration.kafka.consumer
  const consumer = new Consumer({
    bootstrapBrokers: configuration.kafka.brokers,
    deserializers: {
      key: stringDeserializer,
      value: deserializer,
      headerKey: stringDeserializer,
      headerValue: stringDeserializer,
    },
    metrics: globalThis.platformatic?.prometheus,
    ...consumerOptions
  })

  // Create all allowed topics via metadata
  await producer.metadata({ topics: [...topics, ...dlqs], autocreateTopics: true, })

  // Start the consumer
  const stream = await consumer.consume({ topics: Array.from(topics), mode, fallbackMode, offsets, ...consumerOptions })
  server.log.info(`Kafka consumer started with concurrency ${configuration.kafka.concurrency} ...`)

  forEach(
    stream,
    message => {
      return processMessage(server.log, producer, topicsMappings, message)
    },
    configuration.kafka.concurrency ?? 10
  ).catch(error => {
    server.log.error({ error: ensureLoggableError(error) }, 'Error while processing messages.')
  })

  stream.on('error', error => {
    server.log.info({ error: ensureLoggableError(error) }, 'Error while receiving a message. Shutting down the service.')
  })

  server.addHook('onClose', async () => {
    server.log.info('Closing Kafka connections ...')
    await producer.close()
    await consumer.close(true)
  })

  server.decorate('kafkaProducer', producer)

  return topics
}

export async function plugin (server, opts) {
  const configuration = server.platformatic?.config ?? opts.context?.stackable.configManager.current
  const topics = await setupKafka(server, configuration)

  server.route({
    method: 'POST',
    url: '/topics/:topic',
    schema: {
      headers: {
        type: 'object',
        properties: {
          [keyHeader]: { type: 'string' },
        },
        additionalProperties: true
      },
      params: {
        type: 'object',
        properties: {
          topic: { type: 'string' }
        },
        required: ['topic']
      },

    },
    async handler (request, reply) {
      const topic = request.params.topic

      if (!topics.has(topic)) {
        const error = new NotFoundError(`Topic ${topic} not found.`)
        reply.status(error.status).send({ code: error.code, ...error.serialize() })
        return
      }

      server.kafkaProducer.send({
        messages: [{
          topic,
          key: request.headers[keyHeader],
          value: request.body,
          headers: {
            'content-type': request.headers['content-type'],
          }
        }]
      })
      return reply.status(ACCEPTED).send()
    }
  })
}
