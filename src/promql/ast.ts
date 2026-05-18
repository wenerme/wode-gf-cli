export type PromQLNode =
  | PromQLExpression
  | PromQLLabelMatcher
  | PromQLAggregateGrouping
  | PromQLVectorMatching
  | PromQLDurationLiteral
  | PromQLDurationPart
  | PromQLTemplateRef
  | PromQLStringText;

export type PromQLExpression =
  | PromQLNumberLiteral
  | PromQLStringLiteral
  | PromQLTemplateRef
  | PromQLVectorSelector
  | PromQLMatrixSelector
  | PromQLSubqueryExpression
  | PromQLCallExpression
  | PromQLAggregateExpression
  | PromQLBinaryExpression
  | PromQLUnaryExpression
  | PromQLParenthesizedExpression;

export type PromQLNumberLiteral = {
  type: "NumberLiteral";
  raw: string;
  value: number;
};

export type PromQLStringText = {
  type: "StringText";
  raw: string;
  value: string;
};

export type PromQLStringPart = PromQLStringText | PromQLTemplateRef;

export type PromQLStringLiteral = {
  type: "StringLiteral";
  raw: string;
  value: string;
  quote: "'" | '"';
  parts: PromQLStringPart[];
};

export type PromQLTemplateRef = {
  type: "TemplateRef";
  raw: string;
  name: string;
  /** Grafana template variable format, e.g. `${env:regex}` -> `regex`. */
  format?: string;
  braced: boolean;
};

export type PromQLDurationUnit = "ms" | "s" | "m" | "h" | "d" | "w" | "y";

export type PromQLDurationPart = {
  type: "DurationPart";
  raw: string;
  value: number;
  unit: PromQLDurationUnit;
};

export type PromQLDurationLiteral = {
  type: "DurationLiteral";
  raw: string;
  parts: PromQLDurationPart[];
};

export type PromQLRangeExpression = PromQLDurationLiteral | PromQLTemplateRef;

export type PromQLLabelMatchOperator = "=" | "!=" | "=~" | "!~";

export type PromQLLabelMatcher = {
  type: "LabelMatcher";
  label: string;
  operator: PromQLLabelMatchOperator;
  value: PromQLStringLiteral;
};

export type PromQLVectorSelector = {
  type: "VectorSelector";
  metricName?: string;
  matchers: PromQLLabelMatcher[];
};

export type PromQLMatrixSelector = {
  type: "MatrixSelector";
  vector: PromQLVectorSelector;
  range: PromQLRangeExpression;
};

export type PromQLSubqueryExpression = {
  type: "SubqueryExpression";
  expression: PromQLExpression;
  range: PromQLRangeExpression;
  resolution?: PromQLRangeExpression;
};

export type PromQLCallExpression = {
  type: "CallExpression";
  callee: string;
  arguments: PromQLExpression[];
};

export type PromQLAggregateGrouping = {
  type: "AggregateGrouping";
  modifier: "by" | "without";
  labels: string[];
};

export type PromQLAggregateExpression = {
  type: "AggregateExpression";
  operator: string;
  arguments: PromQLExpression[];
  grouping?: PromQLAggregateGrouping;
};

export type PromQLVectorMatching = {
  type: "VectorMatching";
  returnBool?: boolean;
  labelMatching?: {
    operator: "on" | "ignoring";
    labels: string[];
  };
  groupModifier?: {
    operator: "group_left" | "group_right";
    labels: string[];
  };
};

export type PromQLBinaryOperator =
  | "or"
  | "unless"
  | "and"
  | "=="
  | "!="
  | "<="
  | ">="
  | "<"
  | ">"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^";

export type PromQLBinaryExpression = {
  type: "BinaryExpression";
  operator: PromQLBinaryOperator;
  left: PromQLExpression;
  right: PromQLExpression;
  vectorMatching?: PromQLVectorMatching;
};

export type PromQLUnaryExpression = {
  type: "UnaryExpression";
  operator: "+" | "-";
  argument: PromQLExpression;
};

export type PromQLParenthesizedExpression = {
  type: "ParenthesizedExpression";
  expression: PromQLExpression;
};
