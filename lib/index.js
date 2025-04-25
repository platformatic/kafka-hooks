import { buildStackable } from '@platformatic/service'
import { plugin } from './plugin.js'
import { packageJson, schema } from './schema.js'

async function stackable (fastify, opts) {
  await fastify.register(plugin, opts)
}

stackable.configType = 'kafka-hooks'
stackable.schema = schema
stackable.configManagerConfig = {
  schemaOptions: {
    useDefaults: true,
    coerceTypes: true,
    allErrors: true,
    strict: false
  },
}

export default {
  configType: 'kafka-hooks',
  configManagerConfig: stackable.configManagerConfig,
  async buildStackable (opts) {
    return buildStackable(opts, stackable)
  },
  schema,
  version: packageJson.version
}
