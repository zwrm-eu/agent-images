// One question contract across harnesses (#1559). A structured question
// leaves this daemon as a permission.request {kind: "question"} whose input
// is always
//
//   { questions: [{ id, question, header, options: [{label, description}], multiSelect }] }
//
// and comes back as updated_input.answers keyed by that id: one string (a
// label or free text) per single-select question, an array of labels per
// multi-select. The harness shapes differ — claude's AskUserQuestion has no
// ids and wants answers keyed by question text with multi-selects
// comma-joined; codex wants {answers: {id: {answers: [..]}}}; opencode has
// neither ids nor a flat answer map — so each driver translates here, in
// pure functions the unit suite covers without a harness. server.mjs uses
// answeredQuestions to refuse an approval that answers nothing before the
// decision is recorded, so the timeline never says "allowed" for a question
// the harness saw refused.

// platformQuestion renders one harness question in the platform shape.
export function platformQuestion(q, id, multiSelect = false) {
  return {
    id,
    question: typeof q?.question === 'string' ? q.question : '',
    header: typeof q?.header === 'string' ? q.header : '',
    options: (Array.isArray(q?.options) ? q.options : [])
      .filter((o) => o && typeof o === 'object' && typeof o.label === 'string' && o.label !== '')
      .map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
    multiSelect,
  }
}

// hasAnswers reports whether a decision carried an answers object at all.
export function hasAnswers(answers) {
  return !!answers && typeof answers === 'object' && !Array.isArray(answers)
}

// answerList resolves one platform question's answer to a list of strings,
// keyed by id only: an array is a multi-select's labels, a string is one
// answer. Unanswered → [].
export function answerList(q, answers) {
  const raw = hasAnswers(answers) ? answers[q?.id] : undefined
  if (Array.isArray(raw)) return raw.filter((a) => typeof a === 'string' && a !== '')
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

// answeredQuestions reports whether at least one of the platform-shaped
// input's questions has a non-empty answer. An approval that answers nothing
// is not an answer: delivering it would let the model continue on fabricated
// certainty (the claude-code #30983 failure mode), so it is refused instead.
export function answeredQuestions(input, answers) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  return questions.some((q) => answerList(q, answers).length > 0)
}

// ---- claude (AskUserQuestion) -----------------------------------------------

// claudeQuestionInput renders the SDK's AskUserQuestion input for the
// platform: positional ids, options without the SDK's preview field.
export function claudeQuestionInput(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  return { questions: questions.map((q, i) => platformQuestion(q, `q${i + 1}`, q?.multiSelect === true)) }
}

// claudeQuestionDecision maps the platform decision back onto what the SDK
// expects from canUseTool: the ORIGINAL input (ids never reach the SDK) plus
// `answers` keyed by question text, multi-selects comma-joined — the
// documented AskUserQuestion answer shape. An approval that answers nothing
// is a deny: the SDK would otherwise auto-resolve with empty answers.
export function claudeQuestionDecision(input, platformInput, decision) {
  if (decision?.behavior !== 'allow') return decision
  const answers = decision.updatedInput?.answers
  if (!answeredQuestions(platformInput, answers)) {
    return { behavior: 'deny', message: 'no answers were supplied', interrupt: false }
  }
  const byText = {}
  for (const [i, q] of platformInput.questions.entries()) {
    const list = answerList(q, answers)
    if (list.length > 0) byText[input.questions[i].question] = list.join(', ')
  }
  return { behavior: 'allow', updatedInput: { ...input, answers: byText } }
}

// ---- codex (request_user_input) ---------------------------------------------

// codexQuestionInput renders codex's questions (which carry their own ids and
// no multi-select) in the platform shape. isOther and isSecret are dropped:
// the platform always offers free text, and nothing masks a secret yet.
export function codexQuestionInput(questions) {
  return { questions: (Array.isArray(questions) ? questions : []).map((q) => platformQuestion(q, q?.id)) }
}

// codexQuestionReply renders the platform answers as codex's
// RequestUserInputResponse: {answers: {[id]: {answers: string[]}}}. Null
// when nothing was answered (the caller refuses).
export function codexQuestionReply(platformInput, answers) {
  if (!answeredQuestions(platformInput, answers)) return null
  const out = {}
  for (const q of platformInput.questions) out[q.id] = { answers: answerList(q, answers) }
  return { answers: out }
}

// ---- opencode (question) ----------------------------------------------------

// opencodeQuestionInput renders a `question.asked` request in the platform
// shape: positional ids (OpenCode questions carry none), `multiple` →
// multiSelect. OpenCode's `custom` flag is not forwarded.
export function opencodeQuestionInput(req) {
  const questions = Array.isArray(req?.questions) ? req.questions : []
  return { questions: questions.map((q, i) => platformQuestion(q, `q${i + 1}`, q?.multiple === true)) }
}

// opencodeQuestionReply renders the platform answers as OpenCode's reply:
// one label array per question, in question order; unanswered → []
// (OpenCode renders "Unanswered"). Null when nothing was answered.
export function opencodeQuestionReply(platformInput, answers) {
  if (!answeredQuestions(platformInput, answers)) return null
  return platformInput.questions.map((q) => answerList(q, answers))
}
