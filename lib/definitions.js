export const keyHeader = 'x-plt-kafka-hooks-key'
export const attemptHeader = 'x-plt-kafka-hooks-attempt'
export const minimumRetryDelay = 250

export const defaultDlqTopic = 'plt-kafka-dlq'
export const defaultRetryDelay = 1000
export const defaultRetries = 3
export const defaultMethod = 'POST'
export const defaultIncludeAttemptInRequests = true
