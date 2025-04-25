import { Consumer, jsonDeserializer, jsonSerializer, Producer, sleep } from '@platformatic/kafka'
import { ensureLoggableError } from '@platformatic/utils'
import { ACCEPTED, BAD_REQUEST, HttpError, NotFoundError } from 'http-errors-enhanced'
import { request } from 'undici'
import { attemptHeader, defaultDlqTopic, defaultMethod, defaultRetries, defaultRetryDelay } from './definitions.js'

export async function processMessage (logger, producer, mappings, message) {
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
        body: JSON.stringify(message.value),
      })

      logger.info(`COMPLETED ${statusCode}`)

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
        message: message.value,
        topic: message.topic,
        partition: message.partition,
        offset: message.offset.toString(),
        errors: errors.map(e => e.serialize(true)),
        retries,
      }
    }]
  })
}

export async function setupKafka (server, configuration) {
  const topics = new Set()
  const dlqs = new Set()
  const topicsMappings = {}

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
    bootstrapBrokers: configuration.kafka.brokers, serializers: { value: jsonSerializer }
  })

  const { mode, fallbackMode, offsets, ...consumerOptions } = configuration.kafka.consumer
  const consumer = new Consumer({
    bootstrapBrokers: configuration.kafka.brokers,
    deserializers: { value: jsonDeserializer },
    ...consumerOptions,
  })

  // Create all allowed topics via metadata
  await producer.metadata({ topics: [...topics, ...dlqs], autocreateTopics: true, })

  // Start the consumer
  const stream = await consumer.consume({ topics: Array.from(topics), mode, fallbackMode, offsets, ...consumerOptions })
  server.log.info('Kafka consumer started ...')

  stream.on('data', (message) => {
    processMessage(server.log, producer, topicsMappings, message).catch(error => {
      server.log.error({ error: ensureLoggableError(error) }, 'Error while processing a message.')
    })
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
  const configuration = opts.context.stackable.configManager.current
  const topics = await setupKafka(server, configuration)

  server.route({
    method: 'POST',
    url: '/topics/:topic',
    schema: {
      params: {
        type: 'object',
        properties: {
          topic: { type: 'string' }
        },
        required: ['topic']
      },
      body: {
        type: 'object',
        additionalProperties: true
      }
    },
    async handler (request, reply) {
      const topic = request.params.topic

      if (!topics.has(topic)) {
        const error = new NotFoundError(`Topic ${topic} not found.`)
        reply.status(error.status).send({ code: error.code, ...error.serialize() })
        return
      }

      server.kafkaProducer.send({ messages: [{ topic, value: request.body }] })
      return reply.status(ACCEPTED).send()
    }
  })
}
