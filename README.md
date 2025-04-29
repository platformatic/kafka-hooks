# @platformatic/kafka-hooks

Wrap [Kafka](https://https://kafka.apache.org/) inside your application easily.

This assumes that you have a Kafka cluster server running.

Then you can:

- Export the messages published on one or more topics to a HTTP endpoint.
- Publish messages to a topic from a HTTP endpoint with a POST to the `/topics/:topic` endpoint.

## Features

- Consume messages from Kafka topics and forward to HTTP endpoints.
- Send messages to Kafka topics via HTTP API.
- Custom message serialization/deserialization.
- Configurable retries and concurrency.
- Dead Letter Queue (DLQ) for failed messages.

## Standalone Install & Setup

You can generate a standalone application with:

```bash
npx --package @platformatic/kafka-hooks -c create-platformatic-kafka-hooks
cd kafka-hooks-app
npm i
npx platformatic start
```

You can then edit your `.env` file and configure the `PLT_KAFKA_BROKER` env variable to select your Kafka broker.

## API Tutorial

To publish a message to Kafka:

```
curl --request POST \
  --url http://127.0.0.1:3042/topics/topic \
  --header 'Content-Type: application/json' \
  --header 'x-plt-kafka-hooks-key: my-key' \
  --data '{ "name": "my test" }'
```

If `x-plt-kafka-hooks-key` is omitted, then the message will have no key in Kafka.

### Requirements

You'll need a Kafka server running. If you don't have one, you can this `docker-compose.yml` file as a starter:

```
---
services:
  kafka:
    image: apache/kafka:3.9.0
    ports:
      - '9092:9092'
    environment:
      _JAVA_OPTIONS: '-XX:UseSVE=0'
      KAFKA_NODE_ID: 1
      KAFKA_LISTENERS: 'CONTROLLER://:29093,PLAINTEXT://:19092,MAIN://:9092'
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:19092,MAIN://localhost:9092'
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,MAIN:PLAINTEXT'
      KAFKA_PROCESS_ROLES: 'broker,controller'
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:29093'
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT'
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER'
      CLUSTER_ID: '4L6g3nShT-eMCtK--X86sw'
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: 1
      KAFKA_LOG_DIRS: '/tmp/kraft-combined-logs'
```

## Configuration

Configure your Kafka webhooks in the `platformatic.json` file:

```json
{
  "kafka": {
    "brokers": ["localhost:9092"],
    "topics": [
      {
        "topic": "events",
        "url": "https://service.example.com"
      }
    ],
    "consumer": {
      "groupId": "plt-kafka-hooks",
      "maxWaitTime": 500,
      "sessionTimeout": 10000,
      "rebalanceTimeout": 15000,
      "heartbeatInterval": 500
    }
  }
}
```

### Topics configuration

Each item in the `topics` array supports the following options:

| Option                     | Description                                                                                                | Default               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| `topic`                    | The topic to consume messages from.                                                                        |                       |
| `dlq`                      | The DLQ (Dead-Letter-Queue) topic to forward failed messages to. It can be disabled by setting to `false`. | `plt-kafka-hooks-dlq` |
| `url`                      | The URL to send messages to.                                                                               |                       |
| `method`                   | The method to use when hitting the URL above.                                                              | `POST`                |
| `headers`                  | Additional headers to send in the request.                                                                 |                       |
| `retries`                  | How many times to try the request before marking as failed.                                                | `3`                   |
| `retryDelay`               | How much to wait between retries, in milliseconds.                                                         | `1000` (1 second)     |
| `includeAttemptInRequests` | If to include the current attempt number in the requests in the `x-plt-kafka-hooks-attempt` header.        | `true`                |

### Additional configurations

| Option          | Description                                                                                        | Default |
| --------------- | -------------------------------------------------------------------------------------------------- | ------- |
| `brokers`       | The list of Kafka brokers in the form `host:port`.                                                 | None    |
| `consumer`      | Any option supported by a [@platformatic/kafka](https://github.com/platformatic/kafka) `Consumer`. | None    |
| `concurrency`   | How many messages to process in parallel.                                                          | `10`    |
| `serialization` | Configure custom serializers. See section below.                                                   | None    |

### Custom Serialization

You can provide custom serialization logic:

```javascript
// mediaTypes is optional
export const mediaTypes = 'application/binary'

export function serializer(value) {
  return Buffer.from(value.toString().toUpperCase(), 'utf-8')
}

export function deserializer(value) {
  return value.toString('utf-8').toLowerCase()
}
```

Then in your `platformatic.json` file:

```json
{
  "kafka": {
    "serialization": "serialization.js"
  }
}
```

## License

Apache-2.0
