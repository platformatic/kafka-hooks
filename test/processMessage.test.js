import { stringDeserializer, jsonDeserializer, Consumer, Producer, stringSerializer, jsonSerializer } from '@platformatic/kafka'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { strictEqual, ok } from 'node:assert'
import { processMessage } from '../lib/plugin.js'
import { defaultDlqTopic } from '../lib/definitions.js'
import { MockAgent, setGlobalDispatcher, Agent } from 'undici'
import promClient from 'prom-client'
import { initMetrics } from '../lib/metrics.js'

const metrics = initMetrics({ client: promClient, registry: promClient.register })

async function createDlqProducer () {
  const producer = new Producer({
    bootstrapBrokers: ['localhost:9092'],
    serializers: {
      key: stringSerializer,
      value: jsonSerializer,
      headerKey: stringSerializer,
      headerValue: stringSerializer
    }
  })

  return producer
}

async function createDlqConsumer (t, topics = [defaultDlqTopic]) {
  const consumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: ['localhost:9092'],
    maxWaitTime: 500,
    deserializers: {
      key: stringDeserializer,
      value: jsonDeserializer,
      headerKey: stringDeserializer,
      headerValue: stringDeserializer
    }
  })

  await consumer.metadata({ topics, autocreateTopics: true })
  const stream = await consumer.consume({ topics })

  t.after(() => consumer.close(true))

  return { consumer, stream }
}

function createMockMessage (topic, value, key = '', headers = {}) {
  return {
    topic,
    value: Buffer.isBuffer(value) ? value : Buffer.from(value),
    key: Buffer.from(key),
    headers: new Map(Object.entries(headers)),
    partition: 0,
    offset: BigInt(Date.now())
  }
}

function createMockLogger () {
  const logs = []
  return {
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    getLogs: () => logs,
    clearLogs: () => {
      logs.length = 0
    }
  }
}

// Helper functions to get metric values
function getGaugeValue (gaugeName, labels) {
  const metric = promClient.register.getSingleMetric(gaugeName)
  if (!metric) return 0

  const result = metric.get()
  if (!result || !result.values || !Array.isArray(result.values)) return 0

  const match = result.values.find(v => {
    return Object.keys(labels).every(key => v.labels[key] === labels[key])
  })
  return match ? match.value : 0
}

function getCounterValue (counterName, labels) {
  const metric = promClient.register.getSingleMetric(counterName)
  if (!metric) return 0

  const result = metric.get()
  if (!result || !result.values || !Array.isArray(result.values)) return 0

  const match = result.values.find(v => {
    return Object.keys(labels).every(key => v.labels[key] === labels[key])
  })
  return match ? match.value : 0
}

test('processMessage should update success metrics when request succeeds', async t => {
  const logger = createMockLogger()
  const dlqProducer = await createDlqProducer()
  t.after(() => dlqProducer.close())

  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)

  t.after(async () => {
    await mockAgent.close()
    setGlobalDispatcher(new Agent())
  })

  const mockPool = mockAgent.get('http://127.0.0.1:8080')
  mockPool
    .intercept({
      path: '/success',
      method: 'POST'
    })
    .reply(200, { success: true })

  const mappings = {
    'test-topic': {
      url: 'http://127.0.0.1:8080/success',
      dlq: defaultDlqTopic,
      method: 'POST',
      retryDelay: 100,
      headers: {},
      retries: 2,
      includeAttemptInRequests: true
    }
  }

  const message = createMockMessage('test-topic', 'test-value', 'test-key')

  const initialInflightCount = getGaugeValue('kafka_hooks_messages_in_flight', { topic: 'test-topic' })
  await processMessage(logger, dlqProducer, mappings, message, metrics)

  strictEqual(getGaugeValue('kafka_hooks_messages_in_flight', { topic: 'test-topic' }), initialInflightCount)
  strictEqual(getCounterValue('kafka_hooks_dlq_messages_total', { topic: 'test-topic', reason: 'network_error' }), 0)

  mockAgent.assertNoPendingInterceptors()
})

test('processMessage should not send to DLQ when dlq is false', async t => {
  const logger = createMockLogger()
  const dlqProducer = await createDlqProducer()
  t.after(() => dlqProducer.close())

  const { stream } = await createDlqConsumer(t)

  const mappings = {
    'test-topic': {
      url: 'http://127.0.0.1:1/fail', // Non-existent server
      dlq: false, // DLQ disabled
      method: 'POST',
      retryDelay: 100,
      headers: {},
      retries: 1,
      includeAttemptInRequests: true
    }
  }

  const message = createMockMessage('test-topic', 'test-value')

  let dlqMessageReceived = false
  stream.on('data', () => {
    dlqMessageReceived = true
  })

  const initialNetworkErrorCount = getCounterValue('kafka_hooks_dlq_messages_total', { topic: 'test-topic', reason: 'network_error' })

  await processMessage(logger, dlqProducer, mappings, message, metrics)

  strictEqual(getCounterValue('kafka_hooks_dlq_messages_total', { topic: 'test-topic', reason: 'network_error' }), initialNetworkErrorCount)
  strictEqual(dlqMessageReceived, false)

  const logs = logger.getLogs()
  ok(logs.some(log => log.level === 'error' && log.obj.dlqMessage))
})
