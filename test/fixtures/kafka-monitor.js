import { Consumer } from '@platformatic/kafka'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { defaultDlqTopic } from '../../lib/definitions.js'

export function safeJsonDeserializer (value) {
  try {
    return JSON.parse(value)
  } catch (e) {
    return value
  }
}

export async function createMonitor (valueDeserializer = safeJsonDeserializer) {
  const consumer = new Consumer({
    groupId: randomUUID(),
    bootstrapBrokers: 'localhost:9092',
    maxWaitTime: 500,
    deserializers: {
      value: valueDeserializer
    }
  })

  const topics = ['plt-kafka-hooks-success', 'plt-kafka-hooks-fail', 'plt-kafka-hooks-retry', defaultDlqTopic]

  await consumer.metadata({ topics, autocreateTopics: true })
  const stream = await consumer.consume({ topics })

  return { consumer, stream }
}

async function main () {
  const { consumer, stream } = await createMonitor()
  const logger = pino({ transport: { target: 'pino-pretty' } })

  process.once('SIGINT', () => {
    logger.info('Kafka monitor stopped ...')
    consumer.close(true)
  })

  logger.info('Kafka monitor started ...')
  for await (const message of stream) {
    let level = 'info'

    switch (message.topic) {
      case 'fail':
        level = 'error'
        break
      case 'retry':
        level = 'warn'
        break
      case defaultDlqTopic:
        level = 'fatal'
        break
    }

    logger[level]({ message }, 'Message received')
  }
}

if (process.env.MAIN === 'true') {
  await main()
}
