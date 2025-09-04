'use strict'

import { deepStrictEqual, ok } from 'node:assert'
import test from 'node:test'
import { Generator } from '../lib/generator.js'
import * as kafkaHooks from '../lib/index.js'
import { schema } from '../lib/schema.js'

test('should export stackable interface', async () => {
  deepStrictEqual(kafkaHooks.Generator, Generator)
  deepStrictEqual(kafkaHooks.schema, schema)

  ok(typeof kafkaHooks.packageJson, 'object')
  ok(typeof kafkaHooks.schemaComponents, 'object')
  ok(typeof kafkaHooks.version, 'string')

  ok(typeof kafkaHooks.create, 'function')
  ok(typeof kafkaHooks.transform, 'function')
})
