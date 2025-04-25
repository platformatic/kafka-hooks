import { Consumer, jsonDeserializer } from '@platformatic/kafka'
import pino from 'pino'
import { defaultDlqTopic } from '../../lib/definitions.js'

const consumer = new Consumer({ groupId: 'plt-kafka-hooks-topics-monitor', bootstrapBrokers: 'localhost:9092', maxWaitTime: 500, deserializers: { value: jsonDeserializer } })
const stream = await consumer.consume({ topics: ['success', 'fail', 'retry', defaultDlqTopic] })
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
