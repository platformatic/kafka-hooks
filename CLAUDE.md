# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

```bash
# Install dependencies
npm install

# Generate schema.json and config.d.ts
npm run build

# Run tests (with coverage)
npm test

# Run tests with CI coverage configuration
npm run test:ci

# Lint code
npm run lint

# Format code with Prettier
npm run format

# Run CI (lint + tests)
npm run ci
```

### Helper Scripts

```bash
# Run a target server for testing
npm run helpers:target-server

# Run a Kafka monitor for testing
npm run helpers:kafka-monitor
```

## Architecture

Kafka-hooks is a library that integrates Kafka messaging with HTTP endpoints, providing the following functionality:

1. **Consume to HTTP**: Consume messages from Kafka topics and forward them to HTTP endpoints
2. **HTTP to Produce**: Publish messages to Kafka topics via HTTP API
3. **Message Processing**: Direct passing of message content with configurable retries and concurrency
4. **Error Handling**: Dead Letter Queue (DLQ) for failed messages

### Core Components

1. **Plugin (`lib/plugin.js`)**: 
   - Main plugin exposing HTTP API for publishing messages
   - Handles Kafka consumer setup and message processing
   - Manages DLQ for failed messages
   - Passes message content directly without custom serialization

2. **Schema (`lib/schema.js`)**: 
   - Defines configuration schema for the library
   - Includes options for brokers, topics, consumer settings, concurrency, etc.

3. **Generator (`lib/generator.js`)**: 
   - Extends ServiceGenerator to create new applications
   - Generates configuration files and project structure

4. **Index (`lib/index.js`)**: 
   - Exports stackable interface for use with Platformatic
   - Sets up configuration management

5. **Definitions (`lib/definitions.js`)**: 
   - Contains default values and constants

### Processing Flow

1. Kafka messages are consumed via the Consumer
2. Messages are processed and sent to configured HTTP endpoints
3. Retries are performed according to configuration
4. Failed messages (after retries) are sent to DLQ if configured
5. HTTP API allows publishing new messages to Kafka topics

### Configuration

Configuration is defined in `platformatic.json` with:
- Kafka broker settings
- Topic mappings to HTTP endpoints
- Consumer group configuration
- Retry and concurrency settings