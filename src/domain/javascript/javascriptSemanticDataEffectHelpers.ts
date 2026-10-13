import * as t from "@babel/types";

import { semanticBuiltinNamespacePath } from "./javascriptSemanticProvenance.js";
import {
  semanticRequireOrigin,
  semanticRequireExportsIdentity,
} from "./javascriptSemanticRequireOrigin.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import { evaluateSemanticProvenance } from "./javascriptSemanticValues.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";

import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import { semanticTopLevelEffectFollowsCapture } from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

export interface SemanticProjectedBinding {
  readonly bindingId: string;
  readonly identifier: t.Identifier;
  readonly projectionPath: readonly (string | number | null)[];
  readonly resolution: "complete" | "partial";
}

/** Resolve bindings written by the nearest variable or assignment owner. */
export const assignedSemanticResultBindings = (
  node: t.Node,
  ancestors: readonly t.Node[],
  state: JavaScriptSemanticAnalysisState,
): SemanticProjectedBinding[] => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const owner = ancestors[index];
    if (owner === undefined) continue;
    let pattern: t.Node | undefined;
    let source: t.Node | null = null;
    if (t.isVariableDeclarator(owner)) {
      pattern = owner.id;
      source = owner.init ?? null;
    } else if (t.isAssignmentExpression(owner)) {
      pattern = owner.left;
      source = owner.right;
    }
    if (
      pattern !== undefined &&
      source !== null &&
      assignedSourceIs(node, source)
    )
      return projectedPatternBindings(pattern, state);
    if (semanticCallableIdForNode(owner) !== null) return [];
  }
  return [];
};

const assignedSourceIs = (node: t.Node, source: t.Node): boolean => {
  let value = source;
  while (true) {
    if (t.isAwaitExpression(value)) value = value.argument;
    else {
      const unwrapped = unwrapJavaScriptExpression(value).node;
      if (unwrapped === value) break;
      value = unwrapped;
    }
  }
  return value === node;
};

const projectedPatternBindings = (
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
): SemanticProjectedBinding[] => {
  const output: SemanticProjectedBinding[] = [];
  const visit = (
    current: t.Node,
    path: readonly (string | number | null)[],
    partial: boolean,
  ): void => {
    if (t.isIdentifier(current)) {
      const binding = resolveSemanticBindingState(state, current, current.name);
      if (binding !== undefined)
        output.push({
          bindingId: binding.bindingId,
          identifier: current,
          projectionPath: path,
          resolution: partial ? "partial" : "complete",
        });
      return;
    }
    if (t.isAssignmentPattern(current)) return visit(current.left, path, true);
    if (t.isRestElement(current))
      return visit(current.argument, [...path, null], true);
    if (t.isObjectPattern(current)) {
      for (const property of current.properties) {
        if (t.isRestElement(property))
          visit(property.argument, [...path, null], true);
        else
          visit(
            property.value,
            [
              ...path,
              semanticStaticPropertyKey(property.key, property.computed),
            ],
            partial ||
              semanticStaticPropertyKey(property.key, property.computed) ===
                null,
          );
      }
    } else if (t.isArrayPattern(current)) {
      current.elements.forEach((element, index) => {
        if (element !== null) visit(element, [...path, index], partial);
      });
    }
  };
  visit(pattern, [], false);
  return output;
};

export const semanticProjectedBindingFacts = (
  bindings: readonly SemanticProjectedBinding[],
): Omit<SemanticProjectedBinding, "identifier">[] =>
  bindings.map(({ identifier: _identifier, ...fact }) => fact);

/** Return a scalar owner only for an unprojected identifier result. */
export const scalarAssignedResultBinding = (
  bindings: readonly SemanticProjectedBinding[],
): string | null =>
  bindings.length === 1 && bindings[0]?.projectionPath.length === 0
    ? (bindings[0]?.bindingId ?? null)
    : null;

/** Shared mutable stacks reset before each deterministic data-effect pass. */
export interface DataEffectTraversalContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableIds: ReadonlySet<string>;
  readonly callableStack: string[];
  readonly ancestors: t.Node[];
}

/** Resolve built-in methods from the shared, unambiguous binding provenance. */
export const builtinDataEffectMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
): string | null => {
  const required = semanticRequireOrigin(callee, state);
  if (required !== undefined) {
    const origin = builtinNamespaceOrigin(required.origin);
    return origin.importedPath.length === 1 &&
      specifiers.some(
        (specifier) => specifier.replace(/^node:/u, "") === origin.specifier,
      ) &&
      !requiredModuleChanged(
        required.origin.specifier,
        required.origin.importedPath,
        callee,
        undefined,
        state,
        specifiers,
        true,
      )
      ? (origin.importedPath[0] ?? null)
      : null;
  }
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    const path = builtinBindingPath(
      binding,
      state,
      specifiers,
      callee,
      [],
      true,
    );
    return path?.length === 1 ? (path[0] ?? null) : null;
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return null;
  if (!t.isIdentifier(callee.object)) return null;
  const binding = resolveSemanticBindingState(
    state,
    callee.object,
    callee.object.name,
  );
  const method = semanticStaticPropertyName(callee.property, callee.computed);
  return method !== null &&
    builtinBindingPath(binding, state, specifiers, callee, [method], true)
      ?.length === 0
    ? method
    : null;
};

const builtinBindingPath = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
  capture: t.Node,
  selectedPath: readonly string[] = [],
  callableValue = false,
  visited: ReadonlySet<string> = new Set(),
): readonly string[] | null => {
  if (binding === undefined || visited.has(binding.bindingId)) return null;
  // Provenance identifies the module, independently of whether a selected slot
  // still refers to its original built-in after member mutation or escape.
  if (
    binding.memberWrites.some(
      ({ path, node }) =>
        affectsBuiltinPath(path, selectedPath) &&
        !semanticTopLevelEffectFollowsCapture(
          capture,
          node,
          state.parentsByNode,
        ),
    ) ||
    binding.escapedPaths.some(
      ({ path, node }) =>
        affectsBuiltinPath(path, selectedPath) &&
        // A function-value escape cannot replace its native [[Call]]. An
        // escaped containing object can still replace the selected method.
        (!callableValue || path.length < selectedPath.length) &&
        !semanticTopLevelEffectFollowsCapture(
          capture,
          node,
          state.parentsByNode,
        ) &&
        !originalBuiltinReceiver(node, binding, state, specifiers),
    )
  )
    return null;
  const provenance = evaluateSemanticProvenance(binding, state);
  if (provenance.status !== "module") return null;
  const { importedPath } = provenance.origins[0];
  const namespace = builtinNamespaceOrigin(provenance.origins[0]);
  if (
    !specifiers.some(
      (item) => item.replace(/^node:/u, "") === namespace.specifier,
    )
  )
    return null;
  let resolvedPath: readonly string[] = importedPath;
  for (const origin of binding.directOrigins)
    if (
      origin.resolutionMode === "require" &&
      origin.importedPath.length === 0 &&
      requiredModuleChanged(
        origin.specifier,
        selectedPath,
        capture,
        binding,
        state,
        specifiers,
        callableValue,
      )
    )
      return null;
  const ancestors = new Set([...visited, binding.bindingId]);
  for (const initializer of binding.initializers) {
    const pending = [
      {
        node: initializer.node,
        path: [...initializer.projection.map(String), ...selectedPath],
        capture: initializer.projection.length > 0 ? initializer.node : capture,
      },
    ];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const node = unwrapJavaScriptExpression(current.node).node;
      if (t.isIdentifier(node)) {
        const source = resolveSemanticBindingState(state, node, node.name);
        const sourcePath = builtinBindingPath(
          source,
          state,
          specifiers,
          current.capture,
          current.path,
          callableValue,
          ancestors,
        );
        if (sourcePath === null) return null;
        // Normalize ESM default namespaces at their owner before projecting an alias.
        resolvedPath = [...sourcePath, ...current.path].slice(
          0,
          sourcePath.length + current.path.length - selectedPath.length,
        );
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const key = semanticStaticPropertyName(node.property, node.computed);
        if (key === null) return null;
        pending.push({
          node: node.object,
          path: [key, ...current.path],
          capture: node,
        });
      } else if (t.isConditionalExpression(node)) {
        pending.push(
          { ...current, node: node.consequent },
          { ...current, node: node.alternate },
        );
      } else if (t.isLogicalExpression(node)) {
        pending.push(
          { ...current, node: node.left },
          { ...current, node: node.right },
        );
      } else {
        const required = semanticRequireOrigin(node, state);
        if (
          required !== undefined &&
          requiredModuleChanged(
            required.origin.specifier,
            [...required.origin.importedPath, ...current.path],
            current.capture,
            binding,
            state,
            specifiers,
            callableValue,
          )
        )
          return null;
      }
    }
  }
  // Only a direct ESM default import denotes the built-in namespace;
  // require("node:fs").default is a literal property, not interop syntax.
  return binding.directOrigins.length > 0 &&
    semanticBuiltinNamespacePath(importedPath)
    ? []
    : builtinNamespaceOrigin({
        ...provenance.origins[0],
        importedPath: resolvedPath,
      }).importedPath;
};

/** Interpret known Node namespace aliases without changing source provenance. */
const builtinNamespaceOrigin = (
  origin: JavaScriptModuleOrigin,
): JavaScriptModuleOrigin => {
  const specifier = origin.specifier.replace(/^node:/u, "");
  const importedPath =
    origin.resolutionMode !== "require" && origin.importedPath[0] === "default"
      ? origin.importedPath.slice(1)
      : origin.importedPath;
  return specifier === "fs" && importedPath[0] === "promises"
    ? {
        ...origin,
        specifier: "fs/promises",
        importedPath: importedPath.slice(1),
      }
    : { ...origin, specifier, importedPath };
};

const affectsBuiltinPath = (
  path: JavaScriptSemanticPropertyPath,
  selected: readonly string[],
): boolean =>
  path.length <= selected.length &&
  path.every((key, index) =>
    semanticPropertyPathKeyMatches(key, selected[index]!),
  );

/** Check shared exports at the use or method-capture point, not at every later call. */
const requiredModuleChanged = (
  specifier: string,
  selected: readonly string[],
  capture: t.Node,
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
  callableValue = false,
): boolean => {
  const identity = semanticRequireExportsIdentity(specifier, selected);
  return (state.requiredModuleEffects.get(identity.specifier) ?? []).some(
    ({ path, node, kind }) =>
      affectsBuiltinPath(path, identity.path) &&
      !semanticTopLevelEffectFollowsCapture(
        capture,
        node,
        state.parentsByNode,
      ) &&
      (kind === "write" ||
        ((!callableValue || path.length < identity.path.length) &&
          !originalBuiltinReceiver(node, binding, state, specifiers))),
  );
};

/** Calling an unchanged built-in as a member is not an escape to unknown code. */
const originalBuiltinReceiver = (
  node: t.Node | undefined,
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
): boolean => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = node.callee;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const receiver = t.isIdentifier(callee.object)
    ? resolveSemanticBindingState(state, callee.object, callee.object.name)
    : undefined;
  const provenance =
    receiver === undefined
      ? undefined
      : evaluateSemanticProvenance(receiver, state);
  const sourceOrigin =
    provenance?.status === "module"
      ? provenance.origins[0]
      : semanticRequireOrigin(callee.object, state)?.origin;
  if (sourceOrigin === undefined) return false;
  const origin = builtinNamespaceOrigin(sourceOrigin);
  if (
    !specifiers.some(
      (specifier) => specifier.replace(/^node:/u, "") === origin.specifier,
    ) ||
    origin.importedPath.length !== 0
  )
    return false;
  const method = semanticStaticPropertyName(callee.property, callee.computed);
  const identity = semanticRequireExportsIdentity(sourceOrigin.specifier, [
    ...sourceOrigin.importedPath,
    method ?? "",
  ]);
  if (
    method === null ||
    receiver?.memberWrites.some(
      ({ path, node: write }) =>
        affectsBuiltinPath(path, [method]) &&
        !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
    ) ||
    (state.requiredModuleEffects.get(identity.specifier) ?? []).some(
      ({ path, node: write, kind }) =>
        kind === "write" &&
        affectsBuiltinPath(path, identity.path) &&
        !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
    )
  )
    return false;
  return !node.arguments.some((argument) => {
    if (!t.isIdentifier(argument)) return false;
    const passed = resolveSemanticBindingState(state, argument, argument.name);
    if (passed === undefined) return false;
    if (passed.bindingId === binding?.bindingId) return true;
    const passedOrigin = evaluateSemanticProvenance(passed, state);
    return (
      passedOrigin.status === "module" &&
      builtinNamespaceOrigin(passedOrigin.origins[0]).specifier ===
        origin.specifier &&
      builtinNamespaceOrigin(passedOrigin.origins[0]).importedPath.length === 0
    );
  });
};

/** Recognize global or node:process aliases without accepting shadowing. */
export const isSemanticProcessObject = (
  node: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
  family: "env" | "argv",
): boolean => {
  if (!t.isIdentifier(node)) return false;
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined)
    return (
      node.name === "process" &&
      !semanticResolutionBlocked(state, node, node.name)
    );
  return (
    builtinBindingPath(binding, state, ["process", "node:process"], node, [
      family,
    ])?.length === 0
  );
};

/** Resolve the nearest direct variable/assignment owner before a callable. */
export const outerDataEffectBinding = (
  node: t.Node,
  context: DataEffectTraversalContext,
): string | null => {
  return scalarAssignedResultBinding(
    assignedSemanticResultBindings(node, context.ancestors, context.state),
  );
};

/** Traverse with exact callable and ancestor stacks. */
export const traverseDataEffects = (
  program: t.Program,
  context: DataEffectTraversalContext,
  visit: (node: t.Node, parent: t.Node | null) => void,
): void => {
  context.callableStack.length = 0;
  context.ancestors.length = 0;
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && context.callableIds.has(callableId))
        context.callableStack.push(callableId);
      visit(node, parent);
      context.ancestors.push(node);
    },
    exit: (node) => {
      context.ancestors.pop();
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && context.callableStack.at(-1) === callableId)
        context.callableStack.pop();
    },
  });
};

/** Resolve one direct identifier argument to a lexical binding. */
export const dataEffectArgumentBindingId = (
  node:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
  state: JavaScriptSemanticAnalysisState,
): string | null =>
  t.isIdentifier(node)
    ? (resolveSemanticBindingState(state, node, node.name)?.bindingId ?? null)
    : null;

/** Read one JSON primitive default without evaluating code. */
export const dataEffectPrimitive = (
  node: t.Node,
): string | number | boolean | null => {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  return null;
};

/** Read one static string or expression-free template. */
export const dataEffectLiteralString = (
  node:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
): string | null => {
  if (node === undefined) return null;
  const literal = readExactJavaScriptLiteral(node);
  if (literal.found && typeof literal.value === "string") return literal.value;
  return t.isTemplateLiteral(node) && node.expressions.length === 0
    ? (node.quasis[0]?.value.raw ?? null)
    : null;
};

/** Read a member callee from call or construction syntax. */
export const dataEffectMemberCallee = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): t.MemberExpression | t.OptionalMemberExpression | null =>
  t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)
    ? node.callee
    : null;

/** Read a parent member's object when present. */
export const dataEffectMemberObject = (
  node: t.Node | null,
): t.Expression | t.Super | null =>
  node !== null &&
  (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    ? node.object
    : null;
