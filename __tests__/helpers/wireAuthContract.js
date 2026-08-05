function exactScope(fields, presented, derived) {
  return (
    Object.keys(presented ?? {})
      .sort()
      .join(',') === [...fields].sort().join(',') &&
    Object.keys(derived ?? {})
      .sort()
      .join(',') === [...fields].sort().join(',') &&
    fields.every(
      (field) =>
        Object.prototype.hasOwnProperty.call(presented ?? {}, field) &&
        Object.prototype.hasOwnProperty.call(derived ?? {}, field) &&
        typeof presented[field] === 'string' &&
        presented[field] === derived[field]
    )
  );
}

const LINEARIZED_MUTATIONS = [
  'capability-mint',
  'capability-exchange',
  'manifest-registration',
  'upload-acceptance',
];
const LIFECYCLE_TRANSITIONS = [
  'subject-deletion',
  'consent-revocation',
  'tenant-or-binding-disable',
  'generation-change',
  'delivery-deadline',
];

function validRefusal(input) {
  const body = input.body;
  return (
    input.contentType === 'application/json' &&
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).sort().join(',') === 'code,contractVersion,operation' &&
    body.contractVersion === 1 &&
    body.operation === input.requestOperation &&
    body.code === 'refused'
  );
}

function evaluateVector(contract, group, row) {
  const input = row.input;
  if (group === 'scope') {
    return exactScope(contract.scope.fields, input.presented, input.derived)
      ? 'allow'
      : 'refuse';
  }
  if (group === 'mint') {
    if (input.operation === 'root-rotation') return 'refuse';
    if (input.newGeneration) return 'invalidate-old-then-mint';
    if (!['live-session', 'tenant-backend'].includes(input.authority))
      return 'refuse';
    if (
      input.scopeClaim &&
      input.derivedScope &&
      !exactScope(contract.scope.fields, input.scopeClaim, input.derivedScope)
    )
      return 'refuse';
    if (input.binding === 'consent-revoked') return 'refuse';
    if (input.existingMintId && input.existingMintId === input.mintId)
      return 'replay-exact-response';
    if (input.existingMintId && input.existingMintId !== input.mintId)
      return 'refuse';
    if (input.existingRoot === false) return 'mint-and-record';
    return 'mint-root';
  }
  if (group === 'exchange') {
    if (input.atDeadline || input.afterDeadline) return 'refuse';
    if (['forged', 'restored-consumed'].includes(input.credential))
      return 'refuse';
    if (input.binding === 'disabled') return 'refuse';
    if (
      input.recordedExchangeId &&
      input.recordedExchangeId === input.exchangeId
    )
      return 'replay-exact-response';
    if (input.recordedExchangeId) return 'refuse';
    if (input.deliveryDeadline)
      return 'successor-expires-no-later-than-delivery-deadline';
    return 'consume-mint-record';
  }
  if (group === 'registration') {
    if (input.uploads) return 'exercise-without-consuming';
    if (input.authority !== 'live-session') return 'refuse';
    if (
      input.scopeClaim &&
      input.derivedScope &&
      !exactScope(contract.scope.fields, input.scopeClaim, input.derivedScope)
    )
      return 'refuse';
    if (input.record === 'same-id-different-hash') return 'refuse';
    if (input.record === 'same-id-same-hash') return 'idempotent';
    return 'create';
  }
  if (group === 'responses') {
    if (input.status === 403)
      return validRefusal(input) ? 'terminal' : 'indeterminate-retry-same-id';
    if (input.status === 429 && input.remainingDeadlineSeconds === 0)
      return 'do-not-attempt';
    if (
      input.status === 429 &&
      !/^(?:[1-9]|[1-5][0-9]|60)$/.test(input.retryAfter ?? '')
    )
      return 'indeterminate-local-backoff';
    if (input.status === 429) {
      return `retry-after-${Math.min(
        Number(input.retryAfter),
        input.remainingDeadlineSeconds
      )}`;
    }
    return 'indeterminate-retry-same-id';
  }
  if (group === 'resourceControls') {
    return input.saturated ? 'generic-throttle' : 'allow';
  }
  if (group === 'audit') {
    if (input.wal === 'full') return 'non-droppable-aggregate-loss-signal';
    if (input.wal === 'available') return 'durable-refusal-event';
    if (input.publication === 'unavailable') return 'queue-and-retry';
    if (input.deliveryAttempts) return 'one-logical-event';
    if (input.stateCommit && input.auditIntentCommit) return 'acknowledge';
    return 'fail-without-success';
  }
  if (group === 'lifecycleRaces') {
    if (
      !LINEARIZED_MUTATIONS.includes(input.mutation) ||
      !LIFECYCLE_TRANSITIONS.includes(input.transition) ||
      !['mutation', 'transition'].includes(input.winner)
    )
      return 'invalid-vector';
    return input.winner === 'mutation'
      ? 'commit-then-invalidate'
      : 'no-new-authority-or-success-state';
  }
  if (group === 'crashRecovery') {
    if (input.crashAt === 'before-state-and-audit-commit')
      return 'no-root-no-success-event';
    if (
      input.crashAt === 'after-state-and-audit-commit' &&
      input.sameMintIdRetry === true
    )
      return 'replay-exact-root';
    if (input.crashAt === 'before-predecessor-consume')
      return 'predecessor-remains-live';
    if (
      input.crashAt === 'after-successor-and-audit-commit' &&
      input.sameExchangeIdRetry === true
    )
      return 'replay-exact-successor';
    if (input.crashAt === 'after-inbox-ledger-audit-commit')
      return 'replay-recorded-ack';
    if (input.crashAt === 'after-audit-intent-commit')
      return 'publish-idempotently-after-restart';
    return 'invalid-vector';
  }
  throw new Error(`unknown auth vector group ${group}`);
}

function evaluateResolution(input) {
  if (input.credentialOrScope === 'invalid') return 'refuse';
  if (input.ledger === 'same-id-same-hash') return 'replay-recorded-outcome';
  if (input.ledger === 'same-id-different-hash') return 'refuse';
  if (input.binding !== 'live') return 'refuse';
  if (input.manifest !== 'exact-match') return 'refuse';
  return 'commit-acceptance';
}

module.exports = { evaluateResolution, evaluateVector, exactScope };
