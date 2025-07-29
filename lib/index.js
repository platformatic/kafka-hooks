import { create as createService, platformaticService, transform as serviceTransform } from '@platformatic/service'
import { defaultDlqTopic } from './definitions.js'
import { plugin } from './plugin.js'
import { schema } from './schema.js'

export async function kafkaHooks (app, stackable) {
  await platformaticService(app, stackable)
  await app.register(plugin, stackable)
}

export async function transform (config, schema, options) {
  config = await serviceTransform(config, schema, options)

  for (const topic of config.kafka.topics) {
    if (topic.dlq === true) {
      topic.dlq = defaultDlqTopic
    }
  }

  return config
}

export async function create (configOrRoot, sourceOrConfig, context) {
  return createService(configOrRoot, sourceOrConfig, { schema, applicationFactory: kafkaHooks, transform, ...context })
}

export { Generator } from './generator.js'
export { packageJson, schema, schemaComponents, version } from './schema.js'
