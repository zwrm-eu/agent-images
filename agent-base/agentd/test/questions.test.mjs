// The one question contract across harnesses (#1559): the platform shape
// every driver emits, and the per-harness translation of answers keyed by id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  answerList,
  answeredQuestions,
  claudeQuestionDecision,
  claudeQuestionInput,
  codexQuestionInput,
  codexQuestionReply,
  hasAnswers,
  opencodeQuestionInput,
  opencodeQuestionReply,
  platformQuestion,
} from '../drivers/questions.mjs'

const opt = (...labels) => labels.map((label) => ({ label, description: `d-${label}` }))

test('platformQuestion renders the shared shape and drops empty or malformed options', () => {
  assert.deepEqual(platformQuestion({ question: 'A?', header: 'H', options: [{ label: 'x', description: 'dx', preview: 'p' }, { label: '' }, 'str', { nope: 1 }] }, 'q1'),
    { id: 'q1', question: 'A?', header: 'H', options: [{ label: 'x', description: 'dx' }], multiSelect: false })
  assert.deepEqual(platformQuestion({}, 'q2', true), { id: 'q2', question: '', header: '', options: [], multiSelect: true })
})

test('answerList keys by id only: a string is one answer, an array is a multi-select', () => {
  const q = platformQuestion({ question: 'Checks?', options: opt('lint', 'tests') }, 'q1')
  assert.deepEqual(answerList(q, { q1: 'lint' }), ['lint'])
  assert.deepEqual(answerList(q, { q1: 'lint, tests' }), ['lint, tests'])
  assert.deepEqual(answerList(q, { q1: ['tests', '', 7, 'lint'] }), ['tests', 'lint'])
  assert.deepEqual(answerList(q, { 'Checks?': 'lint' }), [])
  assert.deepEqual(answerList(q, undefined), [])
  assert.equal(hasAnswers({}), true)
  assert.equal(hasAnswers([]), false)
  assert.equal(hasAnswers('x'), false)
})

test('answeredQuestions is the refusal gate: nothing resolved means not answered', () => {
  const input = { questions: [platformQuestion({ question: 'A?' }, 'q1'), platformQuestion({ question: 'B?' }, 'q2')] }
  assert.equal(answeredQuestions(input, { q2: 'x' }), true)
  assert.equal(answeredQuestions(input, { q1: [''], q2: '' }), false)
  assert.equal(answeredQuestions(input, { 'A?': 'x' }), false)
  assert.equal(answeredQuestions(input, {}), false)
  assert.equal(answeredQuestions(input, undefined), false)
  assert.equal(answeredQuestions({}, { q1: 'x' }), false)
})

test('claude: ids on the way out, answers re-keyed by question text for the SDK on the way back', () => {
  const sdkInput = { questions: [
    { question: 'Deploy where?', header: 'Target', options: opt('staging', 'production'), multiSelect: false },
    { question: 'Which checks?', header: 'Checks', options: opt('lint', 'tests'), multiSelect: true },
  ] }
  const platform = claudeQuestionInput(sdkInput)
  assert.deepEqual(platform.questions.map((q) => [q.id, q.multiSelect]), [['q1', false], ['q2', true]])

  // Arrays reach the SDK comma-joined; ids never do.
  const d = claudeQuestionDecision(sdkInput, platform, { behavior: 'allow', updatedInput: { ...platform, answers: { q1: 'production', q2: ['lint', 'tests'] } } })
  assert.deepEqual(d, { behavior: 'allow', updatedInput: { ...sdkInput, answers: { 'Deploy where?': 'production', 'Which checks?': 'lint, tests' } } })
  assert.equal(JSON.stringify(d.updatedInput).includes('"id"'), false)

  // An unanswered question is simply absent; nothing answered is a deny.
  assert.deepEqual(claudeQuestionDecision(sdkInput, platform, { behavior: 'allow', updatedInput: { answers: { q2: 'lint' } } }).updatedInput.answers, { 'Which checks?': 'lint' })
  for (const updatedInput of [platform, { answers: {} }, { answers: { 'Deploy where?': 'production' } }]) {
    assert.deepEqual(claudeQuestionDecision(sdkInput, platform, { behavior: 'allow', updatedInput }),
      { behavior: 'deny', message: 'no answers were supplied', interrupt: false }, JSON.stringify(updatedInput))
  }
  const deny = { behavior: 'deny', message: 'no', interrupt: false }
  assert.equal(claudeQuestionDecision(sdkInput, platform, deny), deny)
})

test('codex: own ids kept, isOther/isSecret dropped; the reply is RequestUserInputResponse', () => {
  const input = codexQuestionInput([
    { id: 'env', header: 'Env', question: 'Which?', isOther: true, isSecret: false, options: opt('staging', 'production') },
    { id: 'pw', header: 'Password', question: 'Token?', isOther: false, isSecret: true },
  ])
  assert.deepEqual(input.questions, [
    { id: 'env', question: 'Which?', header: 'Env', options: opt('staging', 'production'), multiSelect: false },
    { id: 'pw', question: 'Token?', header: 'Password', options: [], multiSelect: false },
  ])
  assert.deepEqual(codexQuestionReply(input, { env: 'production', pw: ['s3cret'] }),
    { answers: { env: { answers: ['production'] }, pw: { answers: ['s3cret'] } } })
  assert.deepEqual(codexQuestionReply(input, { env: 'production' }),
    { answers: { env: { answers: ['production'] }, pw: { answers: [] } } })
  assert.equal(codexQuestionReply(input, {}), null)
  assert.equal(codexQuestionReply(input, undefined), null)
})

test('opencode: positional ids, multiple → multiSelect, custom dropped; ordered label arrays back', () => {
  const input = opencodeQuestionInput({ id: 'que_1', questions: [
    { question: 'A?', header: 'H', options: [{ label: 'x', description: 'dx' }, { label: 'y', description: '' }] },
    { question: 'B?', header: '', multiple: true, custom: false, options: [] },
    { question: 'C?', header: 'H3', options: [{ nope: true }, 'str', { label: '' }, { label: 'z' }] },
  ] })
  assert.deepEqual(input, { questions: [
    { id: 'q1', question: 'A?', header: 'H', options: [{ label: 'x', description: 'dx' }, { label: 'y', description: '' }], multiSelect: false },
    { id: 'q2', question: 'B?', header: '', options: [], multiSelect: true },
    { id: 'q3', question: 'C?', header: 'H3', options: [{ label: 'z', description: '' }], multiSelect: false },
  ] })
  assert.deepEqual(opencodeQuestionInput({}), { questions: [] })
  assert.deepEqual(opencodeQuestionReply(input, { q1: 'x', q2: ['y', 'z'], q3: 'free text' }), [['x'], ['y', 'z'], ['free text']])
  assert.deepEqual(opencodeQuestionReply(input, { q3: ['', 'z', 7] }), [[], [], ['z']])
  assert.equal(opencodeQuestionReply(input, { 'B?': ['y'] }), null)
  assert.equal(opencodeQuestionReply(input, undefined), null)
})
