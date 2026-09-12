import { hasAnswers } from './drivers/questions.mjs'

export function permissionDecisionPayload(requestId, body) {
  return {
    request_id: requestId,
    behavior: body.behavior,
    ...(body.message ? { message: body.message } : {}),
    ...(body.updated_input != null ? { updated_input: body.updated_input } : {}),
    ...(hasAnswers(body.updated_input?.answers) ? { answers: body.updated_input.answers } : {}),
  }
}
