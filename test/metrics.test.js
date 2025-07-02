import { test } from 'node:test'
import { strictEqual, deepStrictEqual, ok } from 'node:assert'
import { initMetrics } from '../lib/metrics.js'

function createMockPrometheusClient () {
  const registry = {
    register: () => {},
    clear: () => {},
    metrics: () => 'mock metrics',
    getSingleMetric: () => null
  }

  const client = {
    Counter: class MockCounter {
      constructor (config) {
        this.config = config
        this.values = new Map()
      }

      inc (labels = {}, value = 1) {
        const key = JSON.stringify(labels)
        this.values.set(key, (this.values.get(key) || 0) + value)
      }

      get (labels = {}) {
        const key = JSON.stringify(labels)
        return { value: this.values.get(key) || 0 }
      }
    },

    Gauge: class MockGauge {
      constructor (config) {
        this.config = config
        this.values = new Map()
      }

      inc (labels = {}, value = 1) {
        const key = JSON.stringify(labels)
        this.values.set(key, (this.values.get(key) || 0) + value)
      }

      dec (labels = {}, value = 1) {
        const key = JSON.stringify(labels)
        this.values.set(key, (this.values.get(key) || 0) - value)
      }

      set (labels = {}, value) {
        const key = JSON.stringify(labels)
        this.values.set(key, value)
      }

      get (labels = {}) {
        const key = JSON.stringify(labels)
        return { value: this.values.get(key) || 0 }
      }
    },

    Histogram: class MockHistogram {
      constructor (config) {
        this.config = config
        this.observations = []
      }

      observe (labels = {}, value) {
        this.observations.push({ labels, value })
      }

      get (labels = {}) {
        return {
          buckets: new Map(),
          count: this.observations.length,
          sum: this.observations.reduce((sum, obs) => sum + obs.value, 0)
        }
      }
    }
  }

  return { registry, client }
}

test('initMetrics should return null when prometheus is not provided', async () => {
  const result = initMetrics()
  strictEqual(result, null)
})

test('initMetrics should return null when prometheus is null', async () => {
  const result = initMetrics(null)
  strictEqual(result, null)
})

test('initMetrics should return null when prometheus.registry is missing', async () => {
  const prometheus = { client: {} }
  const result = initMetrics(prometheus)
  strictEqual(result, null)
})

test('initMetrics should return null when prometheus.client is missing', async () => {
  const prometheus = { registry: {} }
  const result = initMetrics(prometheus)
  strictEqual(result, null)
})

test('initMetrics should return metrics object when prometheus is properly configured', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  ok(metrics, 'Metrics object should be created')
  ok(metrics.messagesProcessed, 'messagesProcessed metric should exist')
  ok(metrics.messagesInFlight, 'messagesInFlight metric should exist')
  ok(metrics.httpRequestDuration, 'httpRequestDuration metric should exist')
  ok(metrics.dlqMessages, 'dlqMessages metric should exist')
})

test('messagesProcessed should be configured as Counter with correct properties', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  const counter = metrics.messagesProcessed
  strictEqual(counter.config.name, 'kafka_hooks_messages_processed_total')
  strictEqual(counter.config.help, 'Total number of messages successfully processed')
  deepStrictEqual(counter.config.labelNames, ['topic', 'status'])
  deepStrictEqual(counter.config.registers, [prometheus.registry])
})

test('messagesInFlight should be configured as Gauge with correct properties', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  const gauge = metrics.messagesInFlight
  strictEqual(gauge.config.name, 'kafka_hooks_messages_in_flight')
  strictEqual(gauge.config.help, 'Number of messages currently being processed')
  deepStrictEqual(gauge.config.labelNames, ['topic'])
  deepStrictEqual(gauge.config.registers, [prometheus.registry])
})

test('httpRequestDuration should be configured as Histogram with correct properties', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  const histogram = metrics.httpRequestDuration
  strictEqual(histogram.config.name, 'kafka_hooks_http_request_duration_seconds')
  strictEqual(histogram.config.help, 'HTTP request duration for webhook deliveries')
  deepStrictEqual(histogram.config.labelNames, ['topic', 'method', 'status_code'])
  deepStrictEqual(histogram.config.buckets, [0.1, 0.5, 1, 2, 5, 10])
  deepStrictEqual(histogram.config.registers, [prometheus.registry])
})

test('dlqMessages should be configured as Counter with correct properties', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  const counter = metrics.dlqMessages
  strictEqual(counter.config.name, 'kafka_hooks_dlq_messages_total')
  strictEqual(counter.config.help, 'Total number of messages sent to the DLQ (Dead Letter Queue)')
  deepStrictEqual(counter.config.labelNames, ['topic', 'reason'])
  deepStrictEqual(counter.config.registers, [prometheus.registry])
})

test('metrics should be functional - Counter operations', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  metrics.messagesProcessed.inc({ topic: 'test-topic', status: 'success' })
  metrics.messagesProcessed.inc({ topic: 'test-topic', status: 'success' }, 2)
  metrics.messagesProcessed.inc({ topic: 'test-topic', status: 'failed' })

  strictEqual(metrics.messagesProcessed.get({ topic: 'test-topic', status: 'success' }).value, 3)
  strictEqual(metrics.messagesProcessed.get({ topic: 'test-topic', status: 'failed' }).value, 1)

  metrics.dlqMessages.inc({ topic: 'test-topic', reason: 'http_500' })
  metrics.dlqMessages.inc({ topic: 'test-topic', reason: 'network_error' }, 3)

  strictEqual(metrics.dlqMessages.get({ topic: 'test-topic', reason: 'http_500' }).value, 1)
  strictEqual(metrics.dlqMessages.get({ topic: 'test-topic', reason: 'network_error' }).value, 3)
})

test('metrics should be functional - Gauge operations', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  metrics.messagesInFlight.inc({ topic: 'test-topic' })
  metrics.messagesInFlight.inc({ topic: 'test-topic' }, 2)
  strictEqual(metrics.messagesInFlight.get({ topic: 'test-topic' }).value, 3)

  metrics.messagesInFlight.dec({ topic: 'test-topic' })
  strictEqual(metrics.messagesInFlight.get({ topic: 'test-topic' }).value, 2)

  metrics.messagesInFlight.set({ topic: 'test-topic' }, 5)
  strictEqual(metrics.messagesInFlight.get({ topic: 'test-topic' }).value, 5)
})

test('metrics should be functional - Histogram operations', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  metrics.httpRequestDuration.observe({ topic: 'test-topic', method: 'POST', status_code: '200' }, 0.5)
  metrics.httpRequestDuration.observe({ topic: 'test-topic', method: 'POST', status_code: '200' }, 1.2)
  metrics.httpRequestDuration.observe({ topic: 'test-topic', method: 'POST', status_code: '500' }, 2.1)

  const result = metrics.httpRequestDuration.get({ topic: 'test-topic', method: 'POST', status_code: '200' })
  strictEqual(result.count, 3) // Total observations
  strictEqual(result.sum, 3.8) // Sum of all observations (0.5 + 1.2 + 2.1)
})

test('metrics should handle different label combinations', async () => {
  const prometheus = createMockPrometheusClient()
  const metrics = initMetrics(prometheus)

  metrics.messagesProcessed.inc({ topic: 'topic-1', status: 'success' })
  metrics.messagesProcessed.inc({ topic: 'topic-2', status: 'success' })
  metrics.messagesProcessed.inc({ topic: 'topic-1', status: 'failed' })

  strictEqual(metrics.messagesProcessed.get({ topic: 'topic-1', status: 'success' }).value, 1)
  strictEqual(metrics.messagesProcessed.get({ topic: 'topic-2', status: 'success' }).value, 1)
  strictEqual(metrics.messagesProcessed.get({ topic: 'topic-1', status: 'failed' }).value, 1)
  strictEqual(metrics.messagesProcessed.get({ topic: 'topic-2', status: 'failed' }).value, 0)
})
