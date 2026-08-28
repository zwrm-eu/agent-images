export function permissionDecisionPayload(requestId, body) {
  return {
    request_id: requestId,
    behavior: body.behavior,
    ...(body.message ? { message: body.message } : {}),
    ...(body.updated_input != null ? { updated_input: body.updated_input } : {}),
    ...(body.updated_input?.answers && typeof body.updated_input.answers === 'object'
      ? { answers: body.updated_input.answers }
      : {}),
  }
}
