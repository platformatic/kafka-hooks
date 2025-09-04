export function initMetrics (prometheus) {
  if (!prometheus?.registry || !prometheus?.client) return null
  const { client, registry } = prometheus

  const messagesInFlight =
    registry.getSingleMetric('kafka_hooks_messages_in_flight') ??
    new client.Gauge({
      name: 'kafka_hooks_messages_in_flight',
      help: 'Number of messages currently being processed',
      labelNames: ['topic'],
      registers: [registry]
    })

  const httpRequestDuration =
    registry.getSingleMetric('kafka_hooks_http_request_duration_seconds') ??
    new client.Histogram({
      name: 'kafka_hooks_http_request_duration_seconds',
      help: 'HTTP request duration for webhook deliveries',
      labelNames: ['topic', 'method', 'status_code'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [registry]
    })

  const dlqMessages =
    registry.getSingleMetric('kafka_hooks_dlq_messages_total') ??
    new client.Counter({
      name: 'kafka_hooks_dlq_messages_total',
      help: 'Total number of messages sent to the DLQ (Dead Letter Queue)',
      labelNames: ['topic', 'reason'],
      registers: [registry]
    })

  return { messagesInFlight, httpRequestDuration, dlqMessages }
}
