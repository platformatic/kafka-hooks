import { Consumer, stringDeserializer } from '@platformatic/kafka'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { correlationIdHeader, pathParamsHeader, queryStringHeader } from '../lib/definitions.js'
import { create } from '../lib/index.js'

/**
 * Working integration test demonstrating request/response pattern
 * Uses the same pattern as existing tests but shows the complete flow
 */

async function startStackable (t, requestResponseConfig, topics = []) {
  const server = await create(process.cwd(), {
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
    server: {
      logger: {
        level: 'fatal'
      }
    }
  })

  t.after(async () => {
    await server.close()
  })

  await server.init()
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
    const json = JSON.parse(res.body)
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
  const server = await startStackable(
    t,
    [
      {
        path: '/api/users/:userId/orders/:orderId',
        requestTopic: 'integration-requests',
        responseTopic: 'integration-responses',
        timeout: 15000
      }
    ],
    [
      {
        topic: 'integration-responses',
        url: 'http://localhost:3043/response'
      }
    ]
  )

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
  ok(headers[correlationIdHeader], 'Should have correlation ID')

  // Check path parameters
  ok(headers[pathParamsHeader], 'Should have path parameters')
  const pathParams = JSON.parse(headers[pathParamsHeader])
  strictEqual(pathParams.userId, 'user123')
  strictEqual(pathParams.orderId, 'order456')

  // Check query string parameters
  ok(headers[queryStringHeader], 'Should have query string parameters')
  const queryParams = JSON.parse(headers[queryStringHeader])
  strictEqual(queryParams.include, 'items')
  strictEqual(queryParams.format, 'detailed')
  strictEqual(queryParams.currency, 'USD')

  // Check request body
  const requestData = JSON.parse(requestMessage.value)
  strictEqual(requestData.action, 'get_order_details')
  deepStrictEqual(requestData.fields, ['total', 'status', 'items'])
  strictEqual(requestData.options.includeHistory, true)

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
  strictEqual(response.statusCode, 200)
  strictEqual(response.headers['content-type'], 'application/json')

  const responseData = JSON.parse(response.body)
  strictEqual(responseData.userId, 'user123')
  strictEqual(responseData.orderId, 'order456')
  strictEqual(responseData.order.id, 'order456')
  strictEqual(responseData.order.total, 159.99)
  strictEqual(responseData.order.status, 'shipped')
  strictEqual(responseData.order.currency, 'USD')
  strictEqual(responseData.order.items.length, 2)
  strictEqual(responseData.format, 'detailed')
  strictEqual(responseData.includeHistory, true)
  strictEqual(responseData.history.length, 2)
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
  const server = await startStackable(
    t,
    [
      {
        path: '/api/products/:productId',
        requestTopic: 'integration-error-requests',
        responseTopic: 'integration-error-responses',
        timeout: 15000
      }
    ],
    [
      {
        topic: 'integration-error-responses',
        url: 'http://localhost:3043/response'
      }
    ]
  )

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
  strictEqual(response.statusCode, 404)
  strictEqual(response.headers['content-type'], 'application/json')

  const errorData = JSON.parse(response.body)
  strictEqual(errorData.error, 'Product not found')
  strictEqual(errorData.code, 'PRODUCT_NOT_FOUND')
  strictEqual(errorData.productId, 'nonexistent123')
  strictEqual(errorData.source, 'catalog')
  ok(errorData.timestamp)
  strictEqual(errorData.details.message, 'The requested product could not be found in the catalog')
  strictEqual(errorData.details.suggestion, 'Please check the product ID and try again')
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
  const gateway = await startStackable(
    t,
    [
      {
        path: '/api/users/:userId/profile',
        requestTopic: 'user-profile-requests',
        responseTopic: 'user-profile-responses',
        timeout: 15000
      }
    ],
    [
      {
        topic: 'user-profile-responses',
        url: 'http://localhost:3043/response'
      }
    ]
  )

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
  strictEqual(pathParams.userId, 'emp789')
  strictEqual(queryParams.expand, 'permissions')
  strictEqual(queryParams.include, 'recent_activity')
  strictEqual(requestBody.requestedBy, 'admin-user')
  strictEqual(requestBody.reason, 'security_audit')

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

  strictEqual(clientResponse.statusCode, 200)
  const data = JSON.parse(clientResponse.body)

  // Verify complete data flow
  strictEqual(data.userId, 'emp789')
  strictEqual(data.profile.name, 'Jane Smith')
  strictEqual(data.profile.role, 'senior_developer')
  deepStrictEqual(data.permissions, ['code_review', 'deploy_staging', 'access_logs'])
  strictEqual(data.recent_activity.length, 2)
  strictEqual(data.audit.requestedBy, 'admin-user')
  strictEqual(data.audit.reason, 'security_audit')
  strictEqual(data.audit.service, 'user-profile-service')
  ok(data.audit.processedAt)
})
