import fastify from 'fastify'
import { NO_CONTENT, NOT_IMPLEMENTED, TOO_MANY_REQUESTS } from 'http-errors-enhanced'
import { EventEmitter } from 'node:events'

function collectBody (request) {
  return {
    body: request.body,
    headers: request.headers,
    method: request.method,
    url: request.url
  }
}

const server = fastify({
  logger: process.env.START_HOOK_RECIPIENT
    ? {
        transport: {
          target: 'pino-pretty'
        },
      }
    : false
})
const eventEmitter = new EventEmitter()

await server.post('/success', async (request, reply) => {
  eventEmitter.emit('success', collectBody(request), 1)
  reply.status(NO_CONTENT).send()
})

await server.post('/fail', async (request, reply) => {
  eventEmitter.emit('fail', collectBody(request), 1)
  reply.status(NOT_IMPLEMENTED).send()
})

await server.post('/retry', (request, reply) => {
  const message = collectBody(request)
  const attempt = parseInt(request.headers['x-plt-kafka-hooks-attempt'] ?? '1', 10)

  if (attempt < 3) {
    eventEmitter.emit('retry', message, attempt)
    reply.status(TOO_MANY_REQUESTS).send()
    return
  }

  eventEmitter.emit('success', message, attempt)
  reply.status(NO_CONTENT).send()
})

if (process.env.START_HOOK_RECIPIENT) {
  await server.listen({ port: parseInt(process.env.PORT ?? '3043', 10) })

  eventEmitter.on('success', (message, attempt) => {
    server.log.info({ message, attempt }, 'Message marked as succeeded')
  })

  eventEmitter.on('fail', (message, attempt) => {
    server.log.error({ message, attempt }, 'Message marked as failed')
  })

  eventEmitter.on('retry', (message, attempt) => {
    server.log.error({ message, attempt }, 'Message marked as to retry')
  })
}
