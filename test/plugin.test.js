import { sleep, stringDeserializer, jsonDeserializer } from '@platformatic/kafka'
import { buildServer } from '@platformatic/service'
import { NOT_FOUND } from 'http-errors-enhanced'
import { deepStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { attemptHeader, defaultDlqTopic, keyHeader } from '../lib/definitions.js'
import { stackable } from '../lib/index.js'
import { createMonitor } from './fixtures/kafka-monitor.js'
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

async function publishMessage (server, topic, message, headers = {}) {
  if (!headers['content-type']) {
    if (typeof message === 'object') {
      headers['content-type'] = 'application/json'
      message = JSON.stringify(message)
    } else {
      headers['content-type'] = 'text/plain'
    }
  }

  headers['content-length'] = '' + Buffer.byteLength(message)

  const res = await server.inject({
    method: 'POST',
    url: `/topics/${topic}`,
    headers,
    payload: message
  })
  if (res.statusCode >= 400) {
    const json = await res.json()
    const err = new Error(`Failed to publish message: ${json.message}`)
    err.code = res.statusCode
    err.json = json
    throw err
  }

  return res
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
  deepStrictEqual(message.body, value)
  deepStrictEqual(message.headers[keyHeader], '')
  deepStrictEqual(message.headers[attemptHeader], '1')
  deepStrictEqual(message.headers['content-type'], 'text/plain')
})

test('should produce messages to Kafka and then forward them to the target server (JSON)', async t => {
  // Start the monitor
  const { consumer, stream } = await createMonitor(stringDeserializer)
  t.after(() => consumer.close(true))

  // Start the target server
  const { events, url } = await startTargetServer(t)

  const server = await startStackable(t, url)
  const value = { a: 1, b: 2 }
  await publishMessage(server, 'plt-kafka-hooks-success', value)

  t.diagnostic('Waiting for messages ...')
  const [[kafkaMessage], [message]] = await Promise.all([once(stream, 'data'), once(events, 'success')])
  t.diagnostic('Received message from Kafka')

  deepStrictEqual(kafkaMessage.key, Buffer.alloc(0))
  deepStrictEqual(JSON.parse(kafkaMessage.value), value)
  deepStrictEqual(message.body, value)
  deepStrictEqual(message.headers[keyHeader], '')
  deepStrictEqual(message.headers[attemptHeader], '1')
  deepStrictEqual(message.headers['content-type'], 'application/json')
})

test('should return an error for non existing errors', async t => {
  t.plan(2)

  const server = await startStackable(t)
  try {
    await publishMessage(server, 'invalid', 'test')
  } catch (err) {
    t.assert.deepStrictEqual(err.code, NOT_FOUND)
    t.assert.deepStrictEqual(err.json, {
      code: 'HTTP_ERROR_NOT_FOUND',
      error: 'Not Found',
      message: 'Topic invalid not found.',
      statusCode: NOT_FOUND
    })
  }
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
  deepStrictEqual(message.headers[keyHeader], key)
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
  const { consumer, stream } = await createMonitor(jsonDeserializer)
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
  deepStrictEqual(JSON.parse(Buffer.from(message.value.value, 'base64')), { a: 1 })
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

test('should support binary data', async t => {
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
  deepStrictEqual(kafkaMessage.value, value)
  deepStrictEqual(message.body, value)
  deepStrictEqual(message.headers[keyHeader], '')
  deepStrictEqual(message.headers[attemptHeader], '1')
})
