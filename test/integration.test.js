import { Consumer, stringDeserializer } from '@platformatic/kafka'
import { buildServer } from '@platformatic/service'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { correlationIdHeader, pathParamsHeader, queryStringHeader } from '../lib/definitions.js'
import { stackable } from '../lib/index.js'

/**
 * Working integration test demonstrating request/response pattern
 * Uses the same pattern as existing tests but shows the complete flow
 */

async function startStackable (t, requestResponseConfig, topics = []) {
  const config = {
    $schema: '../schema.json',
    module: '../lib/index.js',
    kafka: {
      concurrency: 5,
      brokers: ['localhost:9092'],
      topics,
      requestResponse: requestResponseConfig,
      consumer: {
        groupId: randomUUID(),
        maxWaitTime: 500,
        sessionTimeout: 10000,
        rebalanceTimeout: 15000,
        heartbeatInterval: 500
      }
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
    await server.close()
  })

  return server
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

test('integration: complete request/response flow with path parameters and query strings', async t => {
  // Create consumer to monitor request messages
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['integration-requests'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['integration-requests'] })
  t.after(() => requestConsumer.close(true))

  // Start kafka-hooks server with request/response configuration
  const server = await startStackable(t, [
    {
      path: '/api/users/:userId/orders/:orderId',
      requestTopic: 'integration-requests',
      responseTopic: 'integration-responses',
      timeout: 15000
    }
  ], [
    {
      topic: 'integration-responses',
      url: 'http://localhost:3043/response'
    }
  ])

  // Make HTTP request with path parameters and query strings
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/users/user123/orders/order456?include=items&format=detailed&currency=USD',
    payload: JSON.stringify({
      action: 'get_order_details',
      fields: ['total', 'status', 'items'],
      options: { includeHistory: true }
    }),
    headers: {
      'content-type': 'application/json'
    }
  })

  // Wait for the request to be published to Kafka
  const [requestMessage] = await once(requestStream, 'data')

  // Verify the request message contains all expected data
  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  // Check correlation ID is present
  t.assert.ok(headers[correlationIdHeader], 'Should have correlation ID')

  // Check path parameters
  t.assert.ok(headers[pathParamsHeader], 'Should have path parameters')
  const pathParams = JSON.parse(headers[pathParamsHeader])
  t.assert.strictEqual(pathParams.userId, 'user123')
  t.assert.strictEqual(pathParams.orderId, 'order456')

  // Check query string parameters
  t.assert.ok(headers[queryStringHeader], 'Should have query string parameters')
  const queryParams = JSON.parse(headers[queryStringHeader])
  t.assert.strictEqual(queryParams.include, 'items')
  t.assert.strictEqual(queryParams.format, 'detailed')
  t.assert.strictEqual(queryParams.currency, 'USD')

  // Check request body
  const requestData = JSON.parse(requestMessage.value)
  t.assert.strictEqual(requestData.action, 'get_order_details')
  t.assert.deepStrictEqual(requestData.fields, ['total', 'status', 'items'])
  t.assert.strictEqual(requestData.options.includeHistory, true)

  // Simulate processing service response
  const correlationId = headers[correlationIdHeader]
  const processingResult = {
    userId: pathParams.userId,
    orderId: pathParams.orderId,
    order: {
      id: pathParams.orderId,
      total: 159.99,
      status: 'shipped',
      currency: queryParams.currency,
      items: [
        { name: 'Product A', price: 99.99 },
        { name: 'Product B', price: 59.99 }
      ]
    },
    requestedFields: requestData.fields,
    format: queryParams.format,
    includeHistory: requestData.options.includeHistory,
    history: [
      { status: 'created', timestamp: '2024-01-01T10:00:00Z' },
      { status: 'shipped', timestamp: '2024-01-02T15:30:00Z' }
    ]
  }

  // Publish response back via HTTP API (simulating external service)
  await publishMessage(server, 'integration-responses', JSON.stringify(processingResult), {
    [correlationIdHeader]: correlationId,
    'content-type': 'application/json',
    'x-status-code': '200'
  })

  // Verify the HTTP response
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')

  const responseData = response.json()
  t.assert.strictEqual(responseData.userId, 'user123')
  t.assert.strictEqual(responseData.orderId, 'order456')
  t.assert.strictEqual(responseData.order.id, 'order456')
  t.assert.strictEqual(responseData.order.total, 159.99)
  t.assert.strictEqual(responseData.order.status, 'shipped')
  t.assert.strictEqual(responseData.order.currency, 'USD')
  t.assert.strictEqual(responseData.order.items.length, 2)
  t.assert.strictEqual(responseData.format, 'detailed')
  t.assert.strictEqual(responseData.includeHistory, true)
  t.assert.strictEqual(responseData.history.length, 2)
})

test('integration: error handling with custom status codes', async t => {
  // Create consumer to monitor request messages
  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['integration-error-requests'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['integration-error-requests'] })
  t.after(() => requestConsumer.close(true))

  // Start kafka-hooks server
  const server = await startStackable(t, [
    {
      path: '/api/products/:productId',
      requestTopic: 'integration-error-requests',
      responseTopic: 'integration-error-responses',
      timeout: 15000
    }
  ], [
    {
      topic: 'integration-error-responses',
      url: 'http://localhost:3043/response'
    }
  ])

  // Make HTTP request for non-existent product
  const requestPromise = server.inject({
    method: 'POST',
    url: '/api/products/nonexistent123?source=catalog',
    payload: JSON.stringify({
      action: 'get_product',
      details: ['price', 'availability']
    }),
    headers: {
      'content-type': 'application/json'
    }
  })

  // Wait for the request to be published to Kafka
  const [requestMessage] = await once(requestStream, 'data')

  const headers = {}
  for (const [key, value] of requestMessage.headers) {
    headers[key.toString()] = value.toString()
  }

  const correlationId = headers[correlationIdHeader]
  const pathParams = JSON.parse(headers[pathParamsHeader])
  const queryParams = JSON.parse(headers[queryStringHeader])

  // Simulate service returning error
  const errorResponse = {
    error: 'Product not found',
    code: 'PRODUCT_NOT_FOUND',
    productId: pathParams.productId,
    source: queryParams.source,
    timestamp: new Date().toISOString(),
    details: {
      message: 'The requested product could not be found in the catalog',
      suggestion: 'Please check the product ID and try again'
    }
  }

  // Publish error response with 404 status
  await publishMessage(server, 'integration-error-responses', JSON.stringify(errorResponse), {
    [correlationIdHeader]: correlationId,
    'content-type': 'application/json',
    'x-status-code': '404'
  })

  // Verify the HTTP error response
  const response = await requestPromise
  t.assert.strictEqual(response.statusCode, 404)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')

  const errorData = response.json()
  t.assert.strictEqual(errorData.error, 'Product not found')
  t.assert.strictEqual(errorData.code, 'PRODUCT_NOT_FOUND')
  t.assert.strictEqual(errorData.productId, 'nonexistent123')
  t.assert.strictEqual(errorData.source, 'catalog')
  t.assert.ok(errorData.timestamp)
  t.assert.strictEqual(errorData.details.message, 'The requested product could not be found in the catalog')
  t.assert.strictEqual(errorData.details.suggestion, 'Please check the product ID and try again')
})

test('integration: demonstrates microservice communication pattern', async t => {
  /*
   * This test demonstrates how kafka-hooks enables a microservice architecture:
   *
   * 1. API Gateway (kafka-hooks) exposes HTTP endpoints
   * 2. Gateway publishes requests to Kafka topics
   * 3. Processing services consume from Kafka topics
   * 4. Processing services publish responses to Kafka topics
   * 5. Gateway consumes responses and returns to HTTP clients
   *
   * Benefits:
   * - Decoupling: Services communicate via Kafka, not direct HTTP
   * - Reliability: Kafka provides durability and retry semantics
   * - Scalability: Multiple instances can process from same topic
   * - Observability: All communication flows through Kafka
   */

  const requestConsumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: stringDeserializer
    }
  })

  await requestConsumer.metadata({ topics: ['user-profile-requests'], autocreateTopics: true })
  const requestStream = await requestConsumer.consume({ topics: ['user-profile-requests'] })
  t.after(() => requestConsumer.close(true))

  // Gateway service configuration
  const gateway = await startStackable(t, [
    {
      path: '/api/users/:userId/profile',
      requestTopic: 'user-profile-requests',
      responseTopic: 'user-profile-responses',
      timeout: 15000
    }
  ], [
    {
      topic: 'user-profile-responses',
      url: 'http://localhost:3043/response'
    }
  ])

  // Client makes HTTP request to gateway
  const clientRequest = gateway.inject({
    method: 'POST',
    url: '/api/users/emp789/profile?expand=permissions&include=recent_activity',
    payload: JSON.stringify({
      requestedBy: 'admin-user',
      reason: 'security_audit',
      fields: ['name', 'email', 'role', 'last_login']
    }),
    headers: {
      'content-type': 'application/json'
    }
  })

  // Gateway publishes to Kafka - "User Profile Service" would consume this
  const [kafkaRequest] = await once(requestStream, 'data')

  // Extract request data (as a microservice would)
  const headers = {}
  for (const [key, value] of kafkaRequest.headers) {
    headers[key.toString()] = value.toString()
  }

  const correlationId = headers[correlationIdHeader]
  const pathParams = JSON.parse(headers[pathParamsHeader])
  const queryParams = JSON.parse(headers[queryStringHeader])
  const requestBody = JSON.parse(kafkaRequest.value)

  // Verify microservice receives complete context
  t.assert.strictEqual(pathParams.userId, 'emp789')
  t.assert.strictEqual(queryParams.expand, 'permissions')
  t.assert.strictEqual(queryParams.include, 'recent_activity')
  t.assert.strictEqual(requestBody.requestedBy, 'admin-user')
  t.assert.strictEqual(requestBody.reason, 'security_audit')

  // Simulate microservice processing and response
  const serviceResponse = {
    userId: pathParams.userId,
    profile: {
      name: 'Jane Smith',
      email: 'jane.smith@company.com',
      role: 'senior_developer',
      last_login: '2024-01-15T08:30:00Z'
    },
    permissions: ['code_review', 'deploy_staging', 'access_logs'],
    recent_activity: [
      { action: 'code_commit', timestamp: '2024-01-15T09:15:00Z' },
      { action: 'pr_review', timestamp: '2024-01-15T10:30:00Z' }
    ],
    audit: {
      requestedBy: requestBody.requestedBy,
      reason: requestBody.reason,
      processedAt: new Date().toISOString(),
      service: 'user-profile-service'
    }
  }

  // Microservice publishes response to Kafka
  await publishMessage(gateway, 'user-profile-responses', JSON.stringify(serviceResponse), {
    [correlationIdHeader]: correlationId,
    'content-type': 'application/json',
    'x-status-code': '200'
  })

  // Gateway returns response to client
  const clientResponse = await clientRequest

  t.assert.strictEqual(clientResponse.statusCode, 200)
  const data = clientResponse.json()

  // Verify complete data flow
  t.assert.strictEqual(data.userId, 'emp789')
  t.assert.strictEqual(data.profile.name, 'Jane Smith')
  t.assert.strictEqual(data.profile.role, 'senior_developer')
  t.assert.deepStrictEqual(data.permissions, ['code_review', 'deploy_staging', 'access_logs'])
  t.assert.strictEqual(data.recent_activity.length, 2)
  t.assert.strictEqual(data.audit.requestedBy, 'admin-user')
  t.assert.strictEqual(data.audit.reason, 'security_audit')
  t.assert.strictEqual(data.audit.service, 'user-profile-service')
  t.assert.ok(data.audit.processedAt)
})
