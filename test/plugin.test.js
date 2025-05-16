import { Producer, sleep, stringDeserializer, stringSerializers } from '@platformatic/kafka'
import { buildServer } from '@platformatic/service'
import { NOT_FOUND, UNSUPPORTED_MEDIA_TYPE } from 'http-errors-enhanced'
import { deepStrictEqual, ok } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { attemptHeader, contentTypeHeader, defaultDlqTopic, keyHeader } from '../lib/definitions.js'
import { stackable } from '../lib/index.js'
import { createMonitor, safeJsonDeserializer } from './fixtures/kafka-monitor.js'
import { createTargetServer } from './fixtures/target-server.js'

async function startStackable (t, url = 'http://localhost:3043', opts = {}) {
  const config = {
    $schema: '../../schema.json',
    module: '../../lib/index.js',
    kafka: {
      concurrency: 5,
      brokers: ['localhost:9092'],
      topics: [
        {
          topic: 'plt-kafka-hooks-success',
          url: `${url}/success`,
          retries: 1,
          retryDelay: 100
        },
        {
          topic: 'plt-kafka-hooks-fail',
          url: `${url}/fail`,
          retries: 1,
          retryDelay: 100
        },
        {
          topic: 'plt-kafka-hooks-retry',
          url: `${url}/retry`,
          retries: 3,
          retryDelay: 100
        }
      ],
      consumer: {
        groupId: randomUUID(),
        maxWaitTime: 500,
        sessionTimeout: 10000,
        rebalanceTimeout: 15000,
        heartbeatInterval: 500
      },
      ...opts
    },
    port: 0,
    server: {
      logger: {
        level: 'fatal'
      }
    }
  }

  const server = await buildServer(config, stackable)
  t.after(async () => {
    t.diagnostic('Stopping server')
    await server.close()
    t.diagnostic('server stopped')
  })

  return server
}

async function startTargetServer (t) {
  const { server, events } = await createTargetServer()
  t.after(() => server.close())
  await server.listen({ port: 0 })
  const url = `http://localhost:${server.server.address().port}`

  return { server, events, url }
}

function publishMessage (server, topic, message, headers = {}) {
  if (!headers['content-type']) {
    if (typeof message === 'object') {
      headers['content-type'] = 'application/json'
    } else {
      headers['content-type'] = 'text/plain'
    }
  }

  return server.inject({ method: 'POST', url: `/topics/${topic}`, headers, payload: message })
}

test('should produce messages to Kafka and then forward them to the target server', async t => {
  // Start the monitor
  const { consumer, stream } = await createMonitor(stringDeserializer)
  t.after(() => consumer.close(true))

  // Start the target server
  const { events, url } = await startTargetServer(t)

  const server = await startStackable(t, url)
  const value = randomUUID()
  await publishMessage(server, 'plt-kafka-hooks-success', value)

  t.diagnostic('Waiting for messages ...')
  const [[kafkaMessage], [message]] = await Promise.all([once(stream, 'data'), once(events, 'success')])
  t.diagnostic('Received message from Kafka')

  deepStrictEqual(kafkaMessage.key, Buffer.alloc(0))
  deepStrictEqual(kafkaMessage.value, value)
  deepStrictEqual(message.body.key, '')
  deepStrictEqual(message.body.value, value)
  deepStrictEqual(message.headers[attemptHeader], '1')
})

test('should return an error for non existing errors', async t => {
  const server = await startStackable(t)
  const { statusCode, json } = await publishMessage(server, 'invalid', 'test')

  deepStrictEqual(statusCode, NOT_FOUND)
  deepStrictEqual(await json(), {
    code: 'HTTP_ERROR_NOT_FOUND',
    error: 'Not Found',
    message: 'Topic invalid not found.',
    statusCode: NOT_FOUND
  })
})

test('should use the special header as the key', async t => {
  // Start the monitor
  const { consumer, stream } = await createMonitor(stringDeserializer)
  t.after(() => consumer.close(true))

  // Start the target server
  const { events, url } = await startTargetServer(t)

  const server = await startStackable(t, url)
  const key = randomUUID()
  const value = randomUUID()
  await publishMessage(server, 'plt-kafka-hooks-success', value, { [keyHeader]: key })

  const [[kafkaMessage], [message]] = await Promise.all([once(stream, 'data'), once(events, 'success')])

  deepStrictEqual(kafkaMessage.key.toString('utf-8'), key)
  deepStrictEqual(message.body.key, key)
})

test('should retry a message several times', async t => {
  // Start the target server
  const { events, url } = await startTargetServer(t)

  const server = await startStackable(t, url)
  const value = randomUUID()
  await publishMessage(server, 'plt-kafka-hooks-retry', value)

  const [message] = await once(events, 'success')

  deepStrictEqual(message.headers[attemptHeader], '3')
})

test('should publish a permanently failed message to the DLQ', async t => {
  // Start the monitor
  const { consumer, stream } = await createMonitor(safeJsonDeserializer)
  t.after(() => consumer.close(true))

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-fail',
        url: 'http://127.0.0.1:1/fail',
        dlq: true,
        retries: 3,
        retryDelay: 100
      }
    ]
  })

  await publishMessage(server, 'plt-kafka-hooks-fail', { a: 1 })

  // Discard the first message, which is the enqueue one
  await once(stream, 'data')
  const [message] = await once(stream, 'data')

  deepStrictEqual(message.topic, defaultDlqTopic)
  deepStrictEqual(message.value.message, { a: 1 })
  deepStrictEqual(message.value.retries, 3)
  deepStrictEqual(message.value.errors.length, 3)
  deepStrictEqual(message.value.errors[0].statusCode, 499)
})

test('should not publish a permanently failed message to the DLQ if asked to', async t => {
  // Start the monitor
  const { consumer, stream } = await createMonitor(stringDeserializer)
  t.after(() => consumer.close(true))

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-fail',
        url: 'http://127.0.0.1:1/fail',
        dlq: false,
        retries: 1,
        retryDelay: 100
      }
    ]
  })
  const value = randomUUID()

  let dlqMessages = 0
  stream.on('data', message => {
    if (message.topic === defaultDlqTopic) {
      dlqMessages++
    }
  })

  await publishMessage(server, 'plt-kafka-hooks-fail', value)
  await sleep(3000)
  deepStrictEqual(dlqMessages, 0)
})

test('should throw an error when serialization fails', async t => {
  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-fail',
        url: 'http://127.0.0.1:1/fail',
        dlq: false,
        retries: 1,
        retryDelay: 100
      }
    ]
  })
  const value = randomUUID()

  const { statusCode, json } = await publishMessage(server, 'plt-kafka-hooks-fail', value, {
    [contentTypeHeader]: 'application/invalid'
  })

  deepStrictEqual(statusCode, UNSUPPORTED_MEDIA_TYPE)
  deepStrictEqual(await json(), {
    code: 'HTTP_ERROR_UNSUPPORTED_MEDIA_TYPE',
    error: 'Unsupported Media Type',
    message: 'Unsupported message content-type application/invalid.',
    statusCode: UNSUPPORTED_MEDIA_TYPE
  })
})

test('should crash the process when error processing fails', async t => {
  t.plan(1)

  function onError (error) {
    t.assert.equal(error.message, 'Failed to deserialize a message.')
  }

  const unhandledRejectionList = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', onError)
  t.after(() => {
    process.removeListener('unhandledRejection', onError)
    process.on('unhandledRejection', ...unhandledRejectionList)
  })

  await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-fail',
        url: 'http://127.0.0.1:1/fail',
        dlq: false,
        retries: 1,
        retryDelay: 100
      }
    ]
  })

  const producer = new Producer({ bootstrapBrokers: ['localhost:9092'], serializers: stringSerializers })
  await producer.send({
    messages: [
      { topic: 'plt-kafka-hooks-fail', value: randomUUID(), headers: { [contentTypeHeader]: 'application/invalid' } }
    ]
  })
  await producer.close()
})

test('should support custom serializer', async t => {
  // Start the monitor
  const { consumer, stream } = await createMonitor(stringDeserializer)
  t.after(() => consumer.close(true))

  // Start the target server
  const { events, url } = await startTargetServer(t)

  const server = await startStackable(t, url, {
    serialization: resolve(import.meta.dirname, './fixtures/serialization.js')
  })
  const value = randomUUID()
  await publishMessage(server, 'plt-kafka-hooks-success', value, { 'content-type': 'application/binary' })

  const [[kafkaMessage], [message]] = await Promise.all([once(stream, 'data'), once(events, 'success')])

  deepStrictEqual(kafkaMessage.key, Buffer.alloc(0))
  deepStrictEqual(kafkaMessage.value, value.toUpperCase())
  deepStrictEqual(message.body.key, '')
  deepStrictEqual(message.body.value, value)
  deepStrictEqual(message.headers[attemptHeader], '1')
})

test('should handle custom serializer loading errors', async t => {
  try {
    await startStackable(t, 'http://localhost:3000', {
      serialization: resolve(import.meta.dirname, './fixtures/non-existent.js')
    })
    throw new Error('Expected error not thrown')
  } catch (error) {
    ok(error.message.startsWith('Error while loading custom serialization file'), error)
  }
})
