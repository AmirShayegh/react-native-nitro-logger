'use strict';

const {
  isBuiltinNamespaceReference,
  isNamespaceMethod,
  isNamespaceReference,
  possibleEvalReference,
  staticPropertyName,
  unwrap,
} = require('./shared');
const {
  containerMemberName,
  forwardedCallableInvocation,
  trustedFactoryReference,
} = require('./event-factory');
const { EVENT_METHODS } = require('./event-options');
const { classifyReceiver } = require('./event-receiver');

/**
 * Compose the call-shape normalizer around the method-provenance resolver.
 *
 * Method provenance remains in event-method.js; this module owns only the
 * finite set of call/apply/Reflect/direct-receiver shapes that turn one
 * CallExpression into the normalized event argument list.
 */
function createEventCallNormalizer({
  eventReference,
  functionPrototypeMethod,
  hasSpread,
  methodReference,
  normalizedMethod,
  shadowedRevocableProxy,
  suspiciousWrappedReceiver,
}) {
  return function normalizeEventCall(context, node) {
    const callee = eventReference(context, node.callee);

    // Dynamic-code executors are not event calls. In particular, an
    // expression such as `globalThis[staticEvalKey](source)` poisons builtin
    // provenance for later calls, but must not itself acquire the resulting
    // fail-closed event diagnostic. Resolve event provenance first because it
    // initializes the source's shared static-container projection used to
    // recognize computed global eval keys.
    if (possibleEvalReference(context, node.callee)) return null;
    if (!callee) return null;

    const forwarding = forwardedCallableInvocation(context, node);
    if (forwarding) {
      const inner = forwarding.target
        ? methodReference(context, forwarding.target, [], node)
        : null;
      if (inner) {
        const args = [...inner.args, ...forwarding.args];
        return normalizedMethod(
          args,
          node,
          forwarding.opaque || inner.spreadArgs || hasSpread(args)
        );
      }
      if (
        forwarding.opaque &&
        forwarding.evidence.some((candidate) =>
          methodReference(context, candidate, [], node)
        )
      ) {
        return normalizedMethod([], node, true);
      }
      if (
        forwarding.opaque &&
        unwrap(forwarding.target)?.type === 'Identifier' &&
        unwrap(forwarding.target).name === 'Reflect' &&
        !isBuiltinNamespaceReference(context, forwarding.target, 'Reflect') &&
        node.arguments.some((candidate) =>
          trustedFactoryReference(context, candidate)
        )
      ) {
        return normalizedMethod([], node, true);
      }
    }

    if (callee.type === 'MemberExpression') {
      const method = staticPropertyName(context, callee);
      if (
        method === 'call' &&
        isNamespaceReference(context, callee.object, 'Reflect', 'apply') &&
        methodReference(context, node.arguments[1], [], node)
      ) {
        return normalizedMethod([], node, true);
      }
      if (
        method === 'call' &&
        functionPrototypeMethod(context, callee.object, 'call') &&
        methodReference(context, node.arguments[0], [], node)
      ) {
        const args = node.arguments.slice(2);
        return normalizedMethod(args, node, hasSpread(args));
      }
      if (
        method === 'call' &&
        functionPrototypeMethod(context, callee.object, 'apply') &&
        methodReference(context, node.arguments[0], [], node)
      ) {
        return normalizedMethod([], node, true);
      }
      if (method === 'call' || method === 'apply') {
        const inner = methodReference(context, callee.object, [], node);
        if (inner) {
          const forwarded = method === 'call' ? node.arguments.slice(1) : [];
          const args = [...inner.args, ...forwarded];
          return normalizedMethod(
            args,
            node,
            inner.spreadArgs || method === 'apply' || hasSpread(args)
          );
        }
      }

      if (
        method !== null &&
        EVENT_METHODS.has(method) &&
        suspiciousWrappedReceiver(context, callee.object)
      ) {
        return normalizedMethod([], node, true);
      }
      if (
        method !== null &&
        EVENT_METHODS.has(method) &&
        (classifyReceiver(context, callee.object, node) ||
          shadowedRevocableProxy(context, callee.object))
      ) {
        return normalizedMethod(node.arguments, node);
      }
      if (
        method === null &&
        callee.computed &&
        containerMemberName(context, callee) === null &&
        classifyReceiver(context, callee.object, node)
      ) {
        return normalizedMethod(node.arguments, node, true);
      }
    }

    if (
      isNamespaceMethod(context, node, 'Reflect', 'apply') &&
      methodReference(context, node.arguments[0], [], node)
    ) {
      return normalizedMethod([], node, true);
    }

    return methodReference(context, callee, node.arguments, node);
  };
}

module.exports = { createEventCallNormalizer };
