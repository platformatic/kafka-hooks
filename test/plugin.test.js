import { sleep, stringDeserializer, jsonDeserializer, Consumer } from '@platformatic/kafka'
import promClient from 'prom-client'
import { buildServer } from '@platformatic/service'
import { NOT_FOUND } from 'http-errors-enhanced'
import { deepStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { attemptHeader, correlationIdHeader, defaultDlqTopic, keyHeader, pathParamsHeader, queryStringHeader } from '../lib/definitions.js'
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

test('should handle request/response pattern', async t => {
  // Create a custom monitor for the request topic
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['plt-kafka-hooks-request'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['plt-kafka-hooks-request'] })
  t.after(() => requestConsumer.close(true))

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-response',
        url: 'http://localhost:3043/response'
      }
    ],
    requestResponse: [
      {
        path: '/api/process',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 5000
      }
    ]
  })

  // Simulate a request
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/process',
    payload: 'test request data',
    headers: {
      'content-type': 'text/plain'
    }
  })

  // Wait for the request to be published to Kafka
  const [requestMessage] = await once(requestStream, 'data')

  // Convert headers map to object with string keys for easier access
  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  // Verify the request message has correlation ID
  t.assert.ok(headers[correlationIdHeader])
  t.assert.strictEqual(requestMessage.value, 'test request data')

  // Simulate a response by sending to response topic via HTTP API
  const correlationId = headers[correlationIdHeader]
  await publishMessage(server, 'plt-kafka-hooks-response', 'response data', {
    [correlationIdHeader]: correlationId,
    'content-type': 'text/plain',
    'x-status-code': '200'
  })

  // Wait for the HTTP response
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, 'response data')
  t.assert.strictEqual(response.headers['content-type'], 'text/plain')
})

test('should timeout request/response when no response is received', async t => {
  const server = await startStackable(t, '', {
    topics: [],
    requestResponse: [
      {
        path: '/api/timeout',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 1000
      }
    ]
  })

  const start = Date.now()
  const response = await server.inject({
    method: 'POST',
    url: '/api/timeout',
    payload: 'test request data'
  })
  const elapsed = Date.now() - start

  t.assert.strictEqual(response.statusCode, 504)
  t.assert.ok(elapsed >= 1000)
  const json = response.json()
  t.assert.strictEqual(json.code, 'HTTP_ERROR_GATEWAY_TIMEOUT')
})

test('should handle request/response pattern with path parameters', async t => {
  // Create a custom monitor for the request topic
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['plt-kafka-hooks-request'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['plt-kafka-hooks-request'] })
  t.after(() => requestConsumer.close(true))

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-response',
        url: 'http://localhost:3043/response'
      }
    ],
    requestResponse: [
      {
        path: '/api/users/:userId/orders/:orderId',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 5000
      }
    ]
  })

  // Simulate a request with path parameters
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/users/123/orders/456',
    payload: 'test request data',
    headers: {
      'content-type': 'text/plain'
    }
  })

  // Wait for the request to be published to Kafka
  const [requestMessage] = await once(requestStream, 'data')

  // Convert headers map to object with string keys for easier access
  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  // Verify the request message has correlation ID and path params
  t.assert.ok(headers[correlationIdHeader])
  t.assert.ok(headers[pathParamsHeader])
  t.assert.strictEqual(requestMessage.value, 'test request data')

  // Verify path parameters are correctly passed
  const pathParams = JSON.parse(headers[pathParamsHeader])
  t.assert.strictEqual(pathParams.userId, '123')
  t.assert.strictEqual(pathParams.orderId, '456')

  // Simulate a response
  const correlationId = headers[correlationIdHeader]
  await publishMessage(server, 'plt-kafka-hooks-response', 'response data', {
    [correlationIdHeader]: correlationId,
    'content-type': 'text/plain',
    'x-status-code': '200'
  })

  // Wait for the HTTP response
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, 'response data')
})

test('should handle request/response pattern with query string parameters', async t => {
  // Create a custom monitor for the request topic
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['plt-kafka-hooks-request'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['plt-kafka-hooks-request'] })
  t.after(() => requestConsumer.close(true))

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-response',
        url: 'http://localhost:3043/response'
      }
    ],
    requestResponse: [
      {
        path: '/api/search',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 5000
      }
    ]
  })

  // Simulate a request with query string parameters
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/search?q=test&limit=10&sort=date',
    payload: 'search request',
    headers: {
      'content-type': 'text/plain'
    }
  })

  // Wait for the request to be published to Kafka
  const [requestMessage] = await once(requestStream, 'data')

  // Convert headers map to object with string keys for easier access
  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  // Verify the request message has correlation ID and query string
  t.assert.ok(headers[correlationIdHeader])
  t.assert.ok(headers[queryStringHeader])
  t.assert.strictEqual(requestMessage.value, 'search request')

  // Verify query string parameters are correctly passed
  const queryParams = JSON.parse(headers[queryStringHeader])
  t.assert.strictEqual(queryParams.q, 'test')
  t.assert.strictEqual(queryParams.limit, '10')
  t.assert.strictEqual(queryParams.sort, 'date')

  // Simulate a response
  const correlationId = headers[correlationIdHeader]
  await publishMessage(server, 'plt-kafka-hooks-response', 'search results', {
    [correlationIdHeader]: correlationId,
    'content-type': 'text/plain',
    'x-status-code': '200'
  })

  // Wait for the HTTP response
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, 'search results')
})

test('should handle request/response pattern with both path and query parameters', async t => {
  // Create a custom monitor for the request topic
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['plt-kafka-hooks-request'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['plt-kafka-hooks-request'] })
  t.after(() => requestConsumer.close(true))

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-response',
        url: 'http://localhost:3043/response'
      }
    ],
    requestResponse: [
      {
        path: '/api/users/:userId',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 5000
      }
    ]
  })

  // Simulate a request with both path and query parameters
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/users/789?include=profile&expand=orders',
    payload: '{"action": "update"}',
    headers: {
      'content-type': 'application/json'
    }
  })

  // Wait for the request to be published to Kafka
  const [requestMessage] = await once(requestStream, 'data')

  // Convert headers map to object with string keys for easier access
  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  // Verify the request message has correlation ID, path params, and query string
  t.assert.ok(headers[correlationIdHeader])
  t.assert.ok(headers[pathParamsHeader])
  t.assert.ok(headers[queryStringHeader])
  t.assert.strictEqual(requestMessage.value, '{"action": "update"}')

  // Verify path parameters
  const pathParams = JSON.parse(headers[pathParamsHeader])
  t.assert.strictEqual(pathParams.userId, '789')

  // Verify query string parameters
  const queryParams = JSON.parse(headers[queryStringHeader])
  t.assert.strictEqual(queryParams.include, 'profile')
  t.assert.strictEqual(queryParams.expand, 'orders')

  // Simulate a response
  const correlationId = headers[correlationIdHeader]
  await publishMessage(server, 'plt-kafka-hooks-response', '{"status": "updated"}', {
    [correlationIdHeader]: correlationId,
    'content-type': 'application/json',
    'x-status-code': '200'
  })

  // Wait for the HTTP response
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, '{"status": "updated"}')
})

test('should ignore response message missing correlation ID', async t => {
  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-response',
        url: 'http://localhost:3043/response'
      }
    ],
    requestResponse: [
      {
        path: '/api/process',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 1000 // Short timeout for this test
      }
    ]
  })

  // Start a legitimate request that will timeout
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/process',
    payload: 'test request',
    headers: {
      'content-type': 'text/plain'
    }
  })

  // Send a response message without correlation ID - this should be ignored
  await publishMessage(server, 'plt-kafka-hooks-response', 'response without correlation', {
    'content-type': 'text/plain',
    'x-status-code': '200'
    // No correlationIdHeader
  })

  // The request should still timeout because the invalid response was ignored
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 504) // Gateway timeout

  const json = response.json()
  t.assert.strictEqual(json.code, 'HTTP_ERROR_GATEWAY_TIMEOUT')
})

test('should handle no pending request found for correlation ID', async t => {
  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-response',
        url: 'http://localhost:3043/response'
      }
    ],
    requestResponse: [
      {
        path: '/api/process',
        requestTopic: 'plt-kafka-hooks-request',
        responseTopic: 'plt-kafka-hooks-response',
        timeout: 5000
      }
    ]
  })

  // Random correlation ID that doesn't correspond to any pending request
  const nonExistentCorrelationId = randomUUID()

  // Send a response message with a correlation ID that has no pending request
  await publishMessage(server, 'plt-kafka-hooks-response', 'orphaned response', {
    [correlationIdHeader]: nonExistentCorrelationId,
    'content-type': 'text/plain',
    'x-status-code': '200'
  })

  // Verify the system still works normally by doing a proper request/response cycle
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['plt-kafka-hooks-request'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['plt-kafka-hooks-request'] })
  t.after(() => requestConsumer.close(true))

  // Start a legitimate request
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/process',
    payload: 'legitimate request',
    headers: {
      'content-type': 'text/plain'
    }
  })

  // Wait for the request to be published
  const [requestMessage] = await once(requestStream, 'data')

  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  // Send proper response with the correct correlation ID
  const correctCorrelationId = headers[correlationIdHeader]
  await publishMessage(server, 'plt-kafka-hooks-response', 'legitimate response', {
    [correlationIdHeader]: correctCorrelationId,
    'content-type': 'text/plain',
    'x-status-code': '200'
  })

  // Verify the legitimate request still works properly
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.payload, 'legitimate response')
})

test('should increment DLQ metrics with network_error reason when network error occurs', async t => {
  const registry = new promClient.Registry()

  const originalPrometheus = globalThis.platformatic?.prometheus
  globalThis.platformatic = {
    prometheus: { registry, client: promClient }
  }

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-network-error',
        url: 'http://127.0.0.1:1/fail', // Invalid URL that will cause network error
        dlq: true,
        retries: 1,
        retryDelay: 100
      }
    ]
  })

  // Get the DLQ counter metric before sending the message
  const dlqMetric = registry.getSingleMetric('kafka_hooks_dlq_messages_total')
  await publishMessage(server, 'plt-kafka-hooks-network-error', 'test message')
  await sleep(1500)

  // Get the metric value after processing
  const finalValue = await dlqMetric.get()

  // Find the specific metric for our topic and reason
  const networkErrorMetric = finalValue.values.find(v =>
    v.labels.topic === 'plt-kafka-hooks-network-error' &&
    v.labels.reason === 'network_error'
  )

  t.assert.ok(networkErrorMetric, 'DLQ metric with network_error reason should exist')
  t.assert.strictEqual(networkErrorMetric.value, 1, 'DLQ metric should be incremented by 1')

  // Restore original prometheus
  if (originalPrometheus) {
    globalThis.platformatic.prometheus = originalPrometheus
  } else {
    delete globalThis.platformatic
  }
})

test('should increment DLQ metrics with http status code reason when HTTP error occurs', async t => {
  const { url: targetUrl } = await startTargetServer(t)

  // Create a real Prometheus registry
  const registry = new promClient.Registry()

  // Set up global prometheus
  const originalPrometheus = globalThis.platformatic?.prometheus
  globalThis.platformatic = {
    prometheus: {
      registry,
      client: promClient
    }
  }

  const server = await startStackable(t, '', {
    topics: [
      {
        topic: 'plt-kafka-hooks-http-error',
        url: `${targetUrl}/fail`, // Use the existing /fail endpoint
        dlq: true,
        retries: 1,
        retryDelay: 100
      }
    ]
  })

  await publishMessage(server, 'plt-kafka-hooks-http-error', 'test message')

  // Wait for processing to complete
  await sleep(1500)

  // Get the DLQ counter metric
  const dlqMetric = registry.getSingleMetric('kafka_hooks_dlq_messages_total')
  const metricValue = await dlqMetric.get()

  // Find the specific metric for our topic - we need to check what status code /fail returns
  // Looking at existing tests, it might return 500 or another status code
  const httpErrorMetric = metricValue.values.find(v =>
    v.labels.topic === 'plt-kafka-hooks-http-error' &&
    v.labels.reason.startsWith('http_')
  )

  t.assert.ok(httpErrorMetric, 'DLQ metric with http status code reason should exist')
  t.assert.strictEqual(httpErrorMetric.value, 1, 'DLQ metric should be incremented by 1')

  // Log the actual reason for debugging
  t.diagnostic(`DLQ reason: ${httpErrorMetric.labels.reason}`)

  // Restore original prometheus
  if (originalPrometheus) {
    globalThis.platformatic.prometheus = originalPrometheus
  } else {
    delete globalThis.platformatic
  }
})
