'use strict'

import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import test from 'node:test'
import { Generator } from '../lib/generator.js'
import { stackable } from '../lib/index.js'
import { schema } from '../lib/schema.js'

test('should export stackable interface', async () => {
  strictEqual(typeof stackable, 'function')
  strictEqual(stackable.configType, 'kafka-hooks')
  deepStrictEqual(stackable.schema, schema)
  deepStrictEqual(stackable.Generator, Generator)
  ok(stackable.configManagerConfig)
  ok(typeof stackable.transformConfig, 'function')
})
