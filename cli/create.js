#!/usr/bin/env node

import { join, basename } from 'node:path'
import { parseArgs } from 'node:util'
import { Generator } from '../lib/generator.js'

async function execute () {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      dir: {
        type: 'string',
        default: join(process.cwd(), 'kafka-hooks-app')
      },
      port: { type: 'string', default: '3042' },
      hostname: { type: 'string', default: '0.0.0.0' },
      broker: { type: 'string', default: ['localhost:9092'], multiple: true },
      topic: { type: 'string', default: 'events' },
      url: { type: 'string', default: 'http://localhost:3000' },
      'consumer-group': { type: 'string', default: 'plt-kafka-hooks' },
    }
  })

  const generator = new Generator()

  generator.setConfig({
    targetDirectory: args.values.dir,
    serviceName: basename(args.values.dir),
    port: parseInt(args.values.port),
    hostname: args.values.hostname,
    broker: args.values.broker,
    topic: args.values.topic,
    url: args.values.url,
    consumerGroup: args.values['consumer-group'],
  })

  await generator.run()

  console.log('Application created successfully! Run `npm run start` to start an application.')
}

execute()
