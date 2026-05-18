import type {
  PromQLExpression,
  PromQLLabelMatcher,
  PromQLRangeExpression,
  PromQLStringPart,
  PromQLTemplateRef,
} from "./ast";
import type { SyntaxError as PeggySyntaxError } from "./parser.js";
import { parse as parseGeneratedPromQL } from "./parser.js";

export type * from "./ast";

export class PromQLParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number, input: string) {
    super(`${message} at ${formatLocation(input, offset)}`);
    this.name = "PromQLParseError";
    this.offset = offset;
  }
}

function formatLocation(input: string, offset: number) {
  const before = input.slice(0, offset);
  const line = before.split(/\r?\n/).length;
  const column = before.length - before.lastIndexOf("\n");
  return `${line}:${column}`;
}

export function parsePromQL(input: string): PromQLExpression {
  try {
    return parseGeneratedPromQL(input) as PromQLExpression;
  } catch (error) {
    if (isPeggySyntaxError(error)) {
      const offset = error.location?.start.offset ?? 0;
      throw new PromQLParseError(error.message, offset, input);
    }
    throw error;
  }
}

function isPeggySyntaxError(error: unknown): error is PeggySyntaxError {
  return error instanceof SyntaxError && "location" in error;
}

export function validatePromQLSyntax(input: string) {
  parsePromQL(input);
}

export function collectPromQLTemplateRefs(expr: PromQLExpression): PromQLTemplateRef[] {
  const refs: PromQLTemplateRef[] = [];
  const visit = (node: PromQLExpression | PromQLLabelMatcher | PromQLRangeExpression | PromQLStringPart) => {
    switch (node.type) {
      case "TemplateRef":
        refs.push(node);
        return;
      case "StringText":
      case "NumberLiteral":
      case "DurationLiteral":
      case "DurationPart":
        return;
      case "StringLiteral":
        for (const part of node.parts) visit(part);
        return;
      case "LabelMatcher":
        visit(node.value);
        return;
      case "VectorSelector":
        for (const matcher of node.matchers) visit(matcher);
        return;
      case "MatrixSelector":
        visit(node.vector);
        visit(node.range);
        return;
      case "SubqueryExpression":
        visit(node.expression);
        visit(node.range);
        if (node.resolution) visit(node.resolution);
        return;
      case "CallExpression":
        for (const arg of node.arguments) visit(arg);
        return;
      case "AggregateExpression":
        for (const arg of node.arguments) visit(arg);
        return;
      case "BinaryExpression":
        visit(node.left);
        visit(node.right);
        return;
      case "UnaryExpression":
        visit(node.argument);
        return;
      case "ParenthesizedExpression":
        visit(node.expression);
        return;
    }
  };
  visit(expr);
  return refs;
}
