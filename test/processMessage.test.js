import { sleep, stringDeserializer, jsonDeserializer, Consumer, Producer, stringSerializer, jsonSerializer } from '@platformatic/kafka'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { strictEqual, ok } from 'node:assert'
import { processMessage } from '../lib/plugin.js'
import { defaultDlqTopic } from '../lib/definitions.js'

// Mock metrics implementation
function createMockMetrics () {
  const counters = {}
  const gauges = {}
  const histograms = {}

  return {
    messagesProcessed: {
      inc: ({ topic, status }) => {
        const key = `${topic}-${status}`
        counters[key] = (counters[key] || 0) + 1
      },
      getCount: (topic, status) => counters[`${topic}-${status}`] || 0
    },
    messagesInFlight: {
      inc: ({ topic }) => {
        gauges[topic] = (gauges[topic] || 0) + 1
      },
      dec: ({ topic }) => {
        gauges[topic] = (gauges[topic] || 0) - 1
      },
      getValue: (topic) => gauges[topic] || 0
    },
    httpRequestDuration: {
      observe: ({ topic, method, code }, duration) => {
        const key = `${topic}-${method}-${code}`
        if (!histograms[key]) {
          histograms[key] = []
        }
        histograms[key].push(duration)
      },
      getObservations: (topic, method, code) => histograms[`${topic}-${method}-${code}`] || []
    },
    dlqMessages: {
      inc: ({ topic, reason }) => {
        const key = `dlq-${topic}-${reason}`
        counters[key] = (counters[key] || 0) + 1
      },
      getCount: (topic, reason) => counters[`dlq-${topic}-${reason}`] || 0
    }
  }
}

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

test('processMessage should handle failed requests and update metrics', async t => {
  const metrics = createMockMetrics()
  const logger = createMockLogger()
  const dlqProducer = await createDlqProducer()
  t.after(() => dlqProducer.close())

  const { stream } = await createDlqConsumer(t)

  const mappings = {
    'test-topic': {
      url: 'http://127.0.0.1:1/fail', // Non-existent server
      dlq: defaultDlqTopic,
      method: 'POST',
      retryDelay: 100,
      headers: {},
      retries: 2,
      includeAttemptInRequests: true
    }
  }

  const message = createMockMessage('test-topic', 'test-value', 'test-key')

  await processMessage(logger, dlqProducer, mappings, message, metrics)

  // Wait for DLQ message
  const [dlqMessage] = await once(stream, 'data')

  // Verify failure metrics
  strictEqual(metrics.messagesProcessed.getCount('test-topic', 'failed'), 1)
  strictEqual(metrics.messagesInFlight.getValue('test-topic'), 0)
  strictEqual(metrics.dlqMessages.getCount('test-topic', 'network_error'), 1)

  // Verify DLQ message content
  strictEqual(dlqMessage.topic, defaultDlqTopic)
  strictEqual(dlqMessage.value.retries, 2)
  strictEqual(dlqMessage.value.errors.length, 2)
  strictEqual(Buffer.from(dlqMessage.value.value, 'base64').toString(), 'test-value')
})

test('processMessage should not send to DLQ when dlq is false', async t => {
  const metrics = createMockMetrics()
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

  await processMessage(logger, dlqProducer, mappings, message, metrics)
  await sleep(1000) // Wait to ensure no DLQ message is sent

  // Verify failure metrics but no DLQ metrics
  strictEqual(metrics.messagesProcessed.getCount('test-topic', 'failed'), 1)
  strictEqual(metrics.dlqMessages.getCount('test-topic', 'network_error'), 0)
  strictEqual(dlqMessageReceived, false)

  // Verify error was logged instead
  const logs = logger.getLogs()
  ok(logs.some(log => log.level === 'error' && log.obj.dlqMessage))
})
