import { describe, expect, test } from 'bun:test'
import { classifyAccountFailure } from '../core/request/account-failure-classifier.js'
import { SdkEventStreamIterationError } from '../core/request/stream-error.js'

describe('classifyAccountFailure', () => {
  test('classifies raw ServiceQuotaExceededException as quota or rate limit', () => {
    const error = new Error('You have reached the limit.')
    error.name = 'ServiceQuotaExceededException'

    expect(classifyAccountFailure(error)).toBe('quota_or_rate_limit')
  })

  test('classifies HTTP 402 and 429 as quota or rate limit', () => {
    expect(classifyAccountFailure(new Error('quota'), 402)).toBe('quota_or_rate_limit')
    expect(classifyAccountFailure(new Error('rate limited'), 429)).toBe('quota_or_rate_limit')
  })

  test('classifies a wrapped SDK HTTP 429 failure as quota or rate limit', () => {
    const wrapped = new SdkEventStreamIterationError({
      name: 'TooManyRequestsException',
      $metadata: { httpStatusCode: 429 }
    })

    expect(classifyAccountFailure(wrapped)).toBe('quota_or_rate_limit')
  })

  test('leaves unrelated failures unclassified', () => {
    expect(classifyAccountFailure(new Error('socket closed'))).toBe('other')
  })
})
