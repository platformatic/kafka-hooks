# @platformatic/kafka-hooks

Wrap [Kafka](https://https://kafka.apache.org/) inside your application easily.

## Features

- **Consume to HTTP**: Consume messages from Kafka topics and forward to HTTP endpoints
- **HTTP to Produce**: Send messages to Kafka topics via HTTP API
- **Request/Response pattern over Kafka topics**: Build HTTP-style request/response patterns routed through Kafka
- **Direct binary message passing**: Pass message content directly without custom serialization
- **Configurable retries and concurrency**: Handle failures with customizable retry logic and parallel processing
- **Dead Letter Queue (DLQ)**: Failed messages are sent to DLQ topics for later inspection
- **Path parameters and query strings**: Automatic handling of URL parameters via Kafka headers
- **Error handling**: Comprehensive timeout and error management

## Install with Watt

```bash
npx wattpm@latest create
```

And select `@platformatic/kafka-hooks` from the list of available packages.

## Install Standalone

```bash
npx --package=@platformatic/kafka-hooks create-platformatic-kafka-hooks
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
    "requestResponse": [
      {
        "path": "/api/process",
        "requestTopic": "request-topic",
        "responseTopic": "response-topic",
        "timeout": 5000
      }
    ],
    "consumer": {
      "groupId": "plt-kafka-hooks",
      "maxWaitTime": 500,
      "sessionTimeout": 10000,
      "rebalanceTimeout": 15000,
      "heartbeatInterval": 500
    },
    "concurrency": 10
  }
}
```

### Core Options

| Option          | Description                                                                                        | Default |
| --------------- | -------------------------------------------------------------------------------------------------- | ------- |
| `brokers`       | The list of Kafka brokers in the form `host:port`.                                                 | Required |
| `consumer`      | Any option supported by a [@platformatic/kafka](https://github.com/platformatic/kafka) `Consumer`. | None    |
| `concurrency`   | How many messages to process in parallel.                                                          | `10`    |

### Topics Configuration

Each item in the `topics` array supports the following options:

| Option                     | Description                                                                                                | Default               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| `topic`                    | The topic to consume messages from.                                                                        | Required              |
| `url`                      | The URL to send messages to.                                                                               | Required              |
| `method`                   | The HTTP method to use when hitting the URL above.                                                         | `POST`                |
| `headers`                  | Additional headers to send in the request.                                                                 | None                  |
| `retries`                  | How many times to try the request before marking as failed.                                                | `3`                   |
| `retryDelay`               | How much to wait between retries, in milliseconds.                                                         | `1000` (1 second)     |
| `dlq`                      | The DLQ (Dead-Letter-Queue) topic to forward failed messages to. Set to `false` to disable.               | `plt-kafka-hooks-dlq` |
| `includeAttemptInRequests` | If to include the current attempt number in the requests in the `x-plt-kafka-hooks-attempt` header.        | `true`                |

### Request/Response Configuration

Each item in the `requestResponse` array supports these options:

| Option          | Description                                           | Default    |
| --------------- | ----------------------------------------------------- | ---------- |
| `path`          | HTTP endpoint path to expose (supports path parameters) | Required   |
| `requestTopic`  | Kafka topic to publish requests to                   | Required   |
| `responseTopic` | Kafka topic to consume responses from                | Required   |
| `timeout`       | Request timeout in milliseconds                      | `30000`    |

### Dead Letter Queue (DLQ)

When a message fails to be delivered after the configured number of retries, it's sent to a Dead Letter Queue (DLQ) topic for later inspection or processing.

By default, failed messages are sent to the `plt-kafka-hooks-dlq` topic. You can:

- Change the DLQ topic name by setting the `dlq` option in the topic configuration
- Disable DLQ entirely by setting `dlq: false` in the topic configuration

```json
{
  "kafka": {
    "topics": [
      {
        "topic": "events",
        "url": "https://service.example.com",
        "dlq": "custom-dlq-topic"  // Custom DLQ topic name
      },
      {
        "topic": "notifications",
        "url": "https://service.example.com/notifications",
        "dlq": false  // Disable DLQ for this topic
      }
    ]
  }
}
```

#### DLQ Message Format

Messages sent to the DLQ contain detailed information about the failure:

```json
{
  "key": "original-message-key",
  "value": "base64-encoded-original-message",
  "headers": {
    "original-header-key": "original-header-value"
  },
  "topic": "original-topic",
  "partition": 0,
  "offset": "1234",
  "errors": [
    {
      "statusCode": 500,
      "error": "Internal Server Error",
      "message": "Failed to process message"
    }
  ],
  "retries": 3
}
```

The original message value is preserved as a base64-encoded string to maintain its exact binary content.

## APIs

### HTTP to Kafka Publishing

Publish messages to Kafka topics via HTTP POST requests:

```bash
curl --request POST \
  --url http://127.0.0.1:3042/topics/topic \
  --header 'Content-Type: application/json' \
  --header 'x-plt-kafka-hooks-key: my-key' \
  --data '{ "name": "my test" }'
```

If `x-plt-kafka-hooks-key` is omitted, then the message will have no key in Kafka.

### Request/Response Pattern

The kafka-hooks library supports HTTP request/response patterns routed through Kafka topics. This enables building responsive microservices that communicate asynchronously via Kafka while maintaining HTTP-style request/response semantics.

#### How It Works

1. **HTTP Request**: Client makes a POST request to a configured endpoint
2. **Kafka Request**: The request is published to a Kafka request topic with a unique correlation ID
3. **Service Processing**: External service consumes from the request topic, processes the message
4. **Kafka Response**: Service publishes response to a response topic with the same correlation ID
5. **HTTP Response**: The original HTTP request completes with the response data

#### Path Parameters and Query Strings

The request/response pattern supports both path parameters and query strings, which are automatically passed to Kafka consumers via headers.

**Path Parameters:**
```json
{
  "path": "/api/users/:userId/orders/:orderId"
}
```

**Request with path parameters:**
```bash
curl -X POST http://localhost:3042/api/users/123/orders/456 \
  -H "Content-Type: application/json" \
  -d '{"action": "cancel"}'
```

**Kafka message headers include:**
```json
{
  "x-plt-kafka-hooks-path-params": "{\"userId\":\"123\",\"orderId\":\"456\"}"
}
```

**Query String Parameters:**
```bash
curl -X POST http://localhost:3042/api/search?q=coffee&limit=10&sort=price \
  -H "Content-Type: application/json" \
  -d '{"filters": {...}}'
```

**Kafka message headers include:**
```json
{
  "x-plt-kafka-hooks-query-string": "{\"q\":\"coffee\",\"limit\":\"10\",\"sort\":\"price\"}"
}
```

#### Usage Example

**Make a request:**
```bash
curl -X POST http://localhost:3042/api/process \
  -H "Content-Type: application/json" \
  -d '{"userId": 123, "action": "process"}'
```

**Request message published to Kafka:**
```json
{
  "headers": {
    "content-type": "application/json",
    "x-plt-kafka-hooks-correlation-id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "value": "{\"userId\": 123, \"action\": \"process\"}"
}
```

**Service processes and responds:**
```bash
# External service publishes response
curl -X POST http://localhost:3042/topics/response-topic \
  -H "Content-Type: application/json" \
  -H "x-plt-kafka-hooks-correlation-id: 550e8400-e29b-41d4-a716-446655440000" \
  -H "x-status-code: 200" \
  -d '{"result": "success", "data": {...}}'
```

**HTTP response returned to client:**
```json
{
  "result": "success",
  "data": {...}
}
```

#### Request Headers

Request messages automatically include these headers when published to Kafka:

| Header                               | Description                                    | When Added |
| ------------------------------------ | ---------------------------------------------- | ---------- |
| `x-plt-kafka-hooks-correlation-id`   | Unique correlation ID for request matching    | Always     |
| `x-plt-kafka-hooks-path-params`      | JSON string of path parameters                | When path parameters present |
| `x-plt-kafka-hooks-query-string`     | JSON string of query string parameters        | When query parameters present |
| `content-type`                       | Content type of the request                   | Always     |

#### Response Headers

Response messages support these special headers:

| Header                               | Description                                    | Default |
| ------------------------------------ | ---------------------------------------------- | ------- |
| `x-plt-kafka-hooks-correlation-id`   | Must match the original request correlation ID | Required|
| `x-status-code`                      | HTTP status code for the response             | `200`   |
| `content-type`                       | Content type of the response                  | Preserved |

#### Error Handling

**Timeout Response:**
If no response is received within the configured timeout:
```json
{
  "code": "HTTP_ERROR_GATEWAY_TIMEOUT",
  "error": "Gateway Timeout",
  "message": "Request timeout",
  "statusCode": 504
}
```

**Missing Correlation ID:**
Responses without correlation IDs are logged as warnings and ignored.

**No Pending Request:**
Responses for non-existent correlation IDs are logged as warnings and ignored.

#### Use Cases

- **Microservice Communication**: Route requests through Kafka for reliable delivery
- **Async Processing**: Handle long-running tasks with HTTP-like interface
- **Event-Driven APIs**: Build responsive APIs on event-driven architecture
- **Service Decoupling**: Maintain HTTP contracts while decoupling services via Kafka

## Standalone Install & Setup

You can generate a standalone application with:

```bash
npx --package @platformatic/kafka-hooks -c create-platformatic-kafka-hooks
cd kafka-hooks-app
npm i
npx platformatic start
```

You can then edit your `.env` file and configure the `PLT_KAFKA_BROKER` env variable to select your Kafka broker.

### Requirements

You'll need a Kafka server running. If you don't have one, you can use this `docker-compose.yml` file as a starter:

```yaml
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

## License

Apache-2.0
