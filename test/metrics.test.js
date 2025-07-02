import { test } from 'node:test'
import { strictEqual, deepStrictEqual, ok } from 'node:assert'
import { initMetrics } from '../lib/metrics.js'
import promClient from 'prom-client'

test('initMetrics should return null when prometheus is not provided', async () => {
  const result = initMetrics()
  strictEqual(result, null)
})

test('initMetrics should return null when prometheus is null', async () => {
  const result = initMetrics(null)
  strictEqual(result, null)
})

test('initMetrics should return null when prometheus.registry is missing', async () => {
  const prometheus = { client: promClient }
  const result = initMetrics(prometheus)
  strictEqual(result, null)
})

test('initMetrics should return null when prometheus.client is missing', async () => {
  const prometheus = { registry: new promClient.Registry() }
  const result = initMetrics(prometheus)
  strictEqual(result, null)
})

test('initMetrics should return metrics object when prometheus is properly configured', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  ok(metrics, 'Metrics object should be created')
  ok(metrics.messagesProcessed, 'messagesProcessed metric should exist')
  ok(metrics.messagesInFlight, 'messagesInFlight metric should exist')
  ok(metrics.httpRequestDuration, 'httpRequestDuration metric should exist')
  ok(metrics.dlqMessages, 'dlqMessages metric should exist')
})

test('messagesProcessed should be configured as Counter with correct properties', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  const counter = metrics.messagesProcessed
  strictEqual(counter.name, 'kafka_hooks_messages_processed_total')
  strictEqual(counter.help, 'Total number of messages successfully processed')
  deepStrictEqual(counter.labelNames, ['topic', 'status'])
})

test('messagesInFlight should be configured as Gauge with correct properties', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  const gauge = metrics.messagesInFlight
  strictEqual(gauge.name, 'kafka_hooks_messages_in_flight')
  strictEqual(gauge.help, 'Number of messages currently being processed')
  deepStrictEqual(gauge.labelNames, ['topic'])
})

test('httpRequestDuration should be configured as Histogram with correct properties', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  const histogram = metrics.httpRequestDuration
  strictEqual(histogram.name, 'kafka_hooks_http_request_duration_seconds')
  strictEqual(histogram.help, 'HTTP request duration for webhook deliveries')
  deepStrictEqual(histogram.labelNames, ['topic', 'method', 'status_code'])
  deepStrictEqual(histogram.buckets, [0.1, 0.5, 1, 2, 5, 10])
})

test('dlqMessages should be configured as Counter with correct properties', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  const counter = metrics.dlqMessages
  strictEqual(counter.name, 'kafka_hooks_dlq_messages_total')
  strictEqual(counter.help, 'Total number of messages sent to the DLQ (Dead Letter Queue)')
  deepStrictEqual(counter.labelNames, ['topic', 'reason'])
})

test('metrics should be functional - Counter operations', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  metrics.messagesProcessed.inc({ topic: 'test-topic', status: 'success' })
  metrics.messagesProcessed.inc({ topic: 'test-topic', status: 'success' }, 2)
  metrics.messagesProcessed.inc({ topic: 'test-topic', status: 'failed' })

  // Get metric values from registry
  const registryMetrics = await registry.getMetricsAsJSON()
  const messagesProcessedMetric = registryMetrics.find(m => m.name === 'kafka_hooks_messages_processed_total')

  const successValue = messagesProcessedMetric.values.find(v =>
    v.labels.topic === 'test-topic' && v.labels.status === 'success'
  ).value
  const failedValue = messagesProcessedMetric.values.find(v =>
    v.labels.topic === 'test-topic' && v.labels.status === 'failed'
  ).value

  strictEqual(successValue, 3)
  strictEqual(failedValue, 1)

  metrics.dlqMessages.inc({ topic: 'test-topic', reason: 'http_500' })
  metrics.dlqMessages.inc({ topic: 'test-topic', reason: 'network_error' }, 3)

  const updatedMetrics = await registry.getMetricsAsJSON()
  const dlqMetric = updatedMetrics.find(m => m.name === 'kafka_hooks_dlq_messages_total')

  const http500Value = dlqMetric.values.find(v =>
    v.labels.topic === 'test-topic' && v.labels.reason === 'http_500'
  ).value
  const networkErrorValue = dlqMetric.values.find(v =>
    v.labels.topic === 'test-topic' && v.labels.reason === 'network_error'
  ).value

  strictEqual(http500Value, 1)
  strictEqual(networkErrorValue, 3)
})

test('metrics should be functional - Gauge operations', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  metrics.messagesInFlight.inc({ topic: 'test-topic' })
  metrics.messagesInFlight.inc({ topic: 'test-topic' }, 2)

  let registryMetrics = await registry.getMetricsAsJSON()
  let gaugeMetric = registryMetrics.find(m => m.name === 'kafka_hooks_messages_in_flight')
  let value = gaugeMetric.values.find(v => v.labels.topic === 'test-topic').value
  strictEqual(value, 3)

  metrics.messagesInFlight.dec({ topic: 'test-topic' })

  registryMetrics = await registry.getMetricsAsJSON()
  gaugeMetric = registryMetrics.find(m => m.name === 'kafka_hooks_messages_in_flight')
  value = gaugeMetric.values.find(v => v.labels.topic === 'test-topic').value
  strictEqual(value, 2)

  metrics.messagesInFlight.set({ topic: 'test-topic' }, 5)

  registryMetrics = await registry.getMetricsAsJSON()
  gaugeMetric = registryMetrics.find(m => m.name === 'kafka_hooks_messages_in_flight')
  value = gaugeMetric.values.find(v => v.labels.topic === 'test-topic').value
  strictEqual(value, 5)
})

test('metrics should be functional - Histogram operations', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  metrics.httpRequestDuration.observe({ topic: 'test-topic', method: 'POST', status_code: '200' }, 0.5)
  metrics.httpRequestDuration.observe({ topic: 'test-topic', method: 'POST', status_code: '200' }, 1.2)
  metrics.httpRequestDuration.observe({ topic: 'test-topic', method: 'POST', status_code: '500' }, 2.1)

  const registryMetrics = await registry.getMetricsAsJSON()
  const histogramMetric = registryMetrics.find(m => m.name === 'kafka_hooks_http_request_duration_seconds')

  const countValue = histogramMetric.values.find(v =>
    v.labels.topic === 'test-topic' &&
    v.labels.method === 'POST' &&
    v.labels.status_code === '200' &&
    v.metricName === 'kafka_hooks_http_request_duration_seconds_count'
  ).value

  const sumValue = histogramMetric.values.find(v =>
    v.labels.topic === 'test-topic' &&
    v.labels.method === 'POST' &&
    v.labels.status_code === '200' &&
    v.metricName === 'kafka_hooks_http_request_duration_seconds_sum'
  ).value

  strictEqual(countValue, 2) // Two observations for 200 status code
  strictEqual(sumValue, 1.7) // 0.5 + 1.2 = 1.7
})

test('metrics should handle different label combinations', async () => {
  const registry = new promClient.Registry()
  const prometheus = { registry, client: promClient }
  const metrics = initMetrics(prometheus)

  metrics.messagesProcessed.inc({ topic: 'topic-1', status: 'success' })
  metrics.messagesProcessed.inc({ topic: 'topic-2', status: 'success' })
  metrics.messagesProcessed.inc({ topic: 'topic-1', status: 'failed' })

  const registryMetrics = await registry.getMetricsAsJSON()
  const messagesProcessedMetric = registryMetrics.find(m => m.name === 'kafka_hooks_messages_processed_total')

  const topic1Success = messagesProcessedMetric.values.find(v =>
    v.labels.topic === 'topic-1' && v.labels.status === 'success'
  )?.value || 0

  const topic2Success = messagesProcessedMetric.values.find(v =>
    v.labels.topic === 'topic-2' && v.labels.status === 'success'
  )?.value || 0

  const topic1Failed = messagesProcessedMetric.values.find(v =>
    v.labels.topic === 'topic-1' && v.labels.status === 'failed'
  )?.value || 0

  const topic2Failed = messagesProcessedMetric.values.find(v =>
    v.labels.topic === 'topic-2' && v.labels.status === 'failed'
  )?.value || 0

  strictEqual(topic1Success, 1)
  strictEqual(topic2Success, 1)
  strictEqual(topic1Failed, 1)
  strictEqual(topic2Failed, 0)
})
