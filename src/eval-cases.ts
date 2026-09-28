export const EVAL_CASE_EXPECTED_FIRST_PATHS = ["code_execution", "direct"] as const;
export const EVAL_CASE_ACCEPTANCE_TYPES = ["exact", "structural", "behavioral"] as const;
// Known acceptance rule keys. Kept in sync with evaluateRule() in benchmark-runner.ts;
// validateEvalCase rejects rules with unknown keys so a typo fails at load time.
export const EVAL_CASE_ACCEPTANCE_RULE_KEYS = [
  "observed_first_path",
  "success",
  "recovery_attempted",
  "failure_class",
  "output_json",
] as const;

export type EvalCaseExpectedFirstPath = (typeof EVAL_CASE_EXPECTED_FIRST_PATHS)[number];
export type EvalCaseAcceptanceType = (typeof EVAL_CASE_ACCEPTANCE_TYPES)[number];
export type EvalCaseAcceptanceRuleKey = (typeof EVAL_CASE_ACCEPTANCE_RULE_KEYS)[number];

export interface EvalCaseAcceptance {
  type: EvalCaseAcceptanceType;
  rules: string[];
}

export interface EvalCase {
  id: string;
  prompt: string;
  expected_first_path: EvalCaseExpectedFirstPath;
  acceptance: EvalCaseAcceptance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isExpectedFirstPath(value: unknown): value is EvalCaseExpectedFirstPath {
  return typeof value === "string" && EVAL_CASE_EXPECTED_FIRST_PATHS.includes(value as EvalCaseExpectedFirstPath);
}

function isAcceptanceType(value: unknown): value is EvalCaseAcceptanceType {
  return typeof value === "string" && EVAL_CASE_ACCEPTANCE_TYPES.includes(value as EvalCaseAcceptanceType);
}

/**
 * Validate one raw eval-case object; returns a list of human-readable errors
 * (empty means valid). Also rejects acceptance rules whose key is not one of
 * EVAL_CASE_ACCEPTANCE_RULE_KEYS so typos fail at load time.
 */
export function validateEvalCase(value: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return ["case must be an object"];
  }

  if (!isNonEmptyString(value.id)) {
    errors.push("id must be a non-empty string");
  }

  if (!isNonEmptyString(value.prompt)) {
    errors.push("prompt must be a non-empty string");
  }

  if (!isExpectedFirstPath(value.expected_first_path)) {
    errors.push('expected_first_path must be "code_execution" or "direct"');
  }

  if (!isRecord(value.acceptance)) {
    errors.push("acceptance must be an object");
    return errors;
  }

  if (!isAcceptanceType(value.acceptance.type)) {
    errors.push('acceptance.type must be "exact", "structural", or "behavioral"');
  }

  if (!Array.isArray(value.acceptance.rules)) {
    errors.push("acceptance.rules must be a non-empty array of strings");
    return errors;
  }

  if (value.acceptance.rules.length === 0) {
    errors.push("acceptance.rules must be a non-empty array of strings");
    return errors;
  }

  value.acceptance.rules.forEach((rule, index) => {
    if (!isNonEmptyString(rule)) {
      errors.push(`acceptance.rules[${index}] must be a non-empty string`);
      return;
    }

    const equalsIndex = rule.indexOf("=");
    if (equalsIndex <= 0) {
      errors.push(`acceptance.rules[${index}] must match "key=value" with a known rule key`);
      return;
    }

    const key = rule.slice(0, equalsIndex).trim();
    if (!EVAL_CASE_ACCEPTANCE_RULE_KEYS.includes(key as EvalCaseAcceptanceRuleKey)) {
      errors.push(
        `acceptance.rules[${index}] has unknown rule key "${key}" (expected one of: ${EVAL_CASE_ACCEPTANCE_RULE_KEYS.join(", ")})`
      );
    }
  });

  return errors;
}

/** Validate and cast an eval case; throws (with `source` prefixed) listing every error. */
export function parseEvalCase(value: unknown, source = "eval case"): EvalCase {
  const errors = validateEvalCase(value);

  if (errors.length > 0) {
    throw new Error(`${source} validation failed: ${errors.join("; ")}`);
  }

  return value as EvalCase;
}
