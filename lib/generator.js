import { Generator as ServiceGenerator } from '@platformatic/service'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

export class Generator extends ServiceGenerator {
  constructor (opts = {}) {
    super({
      ...opts,
      module: '@platformatic/kafka-hooks'
    })
  }

  getDefaultConfig () {
    const res = {
      ...super.getDefaultConfig(),
      plugin: false,
      tests: false
    }

    return res
  }

  getConfigFieldsDefinitions () {
    const serviceConfigFieldsDefs = super.getConfigFieldsDefinitions()

    return [
      ...serviceConfigFieldsDefs,
      {
        var: 'PLT_KAFKA_BROKER',
        label: 'Which is the address of one of the Kafka brokers?',
        default: 'localhost:9092',
        type: 'string'
      },
      {
        var: 'PLT_KAFKA_TOPIC',
        label: 'Which Kafka topic do you want to use?',
        default: 'events',
        type: 'string'
      },
      {
        var: 'PLT_KAFKA_URL',
        label: 'Which URL you want to forward messages to?',
        default: 'http://localhost:3000',
        type: 'string'
      },
      {
        var: 'PLT_KAFKA_CONSUMER_GROUP',
        label: 'Which Kafka consumer group do you want to use?',
        default: 'plt-kafka-hooks-consumer',
        type: 'string'
      }
    ]
  }

  async generatePackageJson () {
    const template = await super.generatePackageJson()

    template.name = basename(this.config.targetDirectory)
    template.devDependencies = undefined
    template.scripts.test = 'echo "No tests defined".'
    template.engines.node = '>= 22.14.0'

    return template
  }

  async _getConfigFileContents () {
    const packageJson = await this._getStackablePackageJson()
    const { server, watch } = await super._getConfigFileContents()

    return {
      $schema: `https://schemas.platformatic.dev/@platformatic/kafka-hooks/${packageJson.version}.json`,
      module: `${packageJson.name}@${packageJson.version}`,
      kafka: {
        brokers: [`{${this.getEnvVarName('PLT_KAFKA_BROKER')}}`],
        topics: [
          {
            topic: `{${this.getEnvVarName('PLT_KAFKA_TOPIC')}}`,
            url: `{${this.getEnvVarName('PLT_KAFKA_URL')}}`
          }
        ],
        consumer: {
          groupId: `{${this.getEnvVarName('PLT_KAFKA_CONSUMER_GROUP')}}`,
          maxWaitTime: 500,
          sessionTimeout: 10000,
          rebalanceTimeout: 15000,
          heartbeatInterval: 500
        }
      },
      server,
      watch
    }
  }

  async _beforePrepare () {
    super._beforePrepare()

    delete this.config.env.PLT_TYPESCRIPT
    delete this.config.defaultEnv.PLT_TYPESCRIPT

    this.addEnvVars(
      {
        PLT_KAFKA_BROKER: this.config.broker,
        PLT_KAFKA_TOPIC: this.config.topic,
        PLT_KAFKA_URL: this.config.url,
        PLT_KAFKA_CONSUMER_GROUP: this.config.consumerGroup
      },
      { overwrite: false }
    )

    const packageJson = await this._getStackablePackageJson()

    this.config.dependencies = {
      [packageJson.name]: `^${packageJson.version}`
    }
  }

  _afterPrepare () {
    delete this.files['global.d.ts']
    delete this.files['.gitignore']
  }

  async _getStackablePackageJson () {
    if (!this._packageJson) {
      this._packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf-8'))
    }

    return this._packageJson
  }
}
