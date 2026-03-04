// VariantValidator — validates AI-generated strategy variant code for safety and correctness

import { createLogger } from '../../utils/logger.js';
import type { GeneratedVariant, ValidationResult } from './types.js';

const logger = createLogger('variant-validator');

/**
 * Forbidden patterns that must never appear in generated strategy code.
 * Each entry is a regex and a human-readable description.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  { pattern: /\bwalletClient\b/, description: 'Direct wallet access via walletClient' },
  { pattern: /\bprivateKey\b/, description: 'Private key access' },
  { pattern: /\beval\s*\(/, description: 'eval() usage' },
  { pattern: /\bnew\s+Function\s*\(/, description: 'new Function() constructor' },
  { pattern: /\bfs\.\w+/, description: 'Filesystem access via fs module' },
  { pattern: /\brequire\s*\(/, description: 'require() usage (CommonJS)' },
  { pattern: /\bprocess\.env\b/, description: 'Environment variable access' },
  { pattern: /\bimport\s*\(/, description: 'Dynamic import() usage' },
  { pattern: /\bfetch\s*\(/, description: 'Network access via fetch()' },
  { pattern: /\bnew\s+XMLHttpRequest\b/, description: 'Network access via XMLHttpRequest' },
  { pattern: /\bhttp[s]?:\/\//, description: 'Hardcoded HTTP URLs' },
  { pattern: /0x[a-fA-F0-9]{11,}/, description: 'Hardcoded address longer than 10 hex chars' },
  { pattern: /\bchild_process\b/, description: 'child_process module access' },
  { pattern: /\bexecSync\s*\(/, description: 'Synchronous shell execution via execSync()' },
  { pattern: /\bspawn(?:Sync)?\s*\(/, description: 'Process spawning via spawn()/spawnSync()' },
  { pattern: /\bexecFile\s*\(/, description: 'Shell execution via execFile()' },
  { pattern: /\b__proto__\b/, description: 'Prototype pollution via __proto__' },
  { pattern: /\bconstructor\s*\[\s*['"]prototype['"]/, description: 'Prototype pollution via constructor["prototype"]' },
  { pattern: /\bsetTimeout\s*\(/, description: 'Async scheduling via setTimeout()' },
  { pattern: /\bsetInterval\s*\(/, description: 'Recurring scheduling via setInterval()' },
];

/**
 * VariantValidator performs defense-in-depth validation on AI-generated strategy code.
 *
 * Validation pipeline:
 * 1. Syntax check — basic structural validity
 * 2. Extends CrossChainStrategy check
 * 3. Risk bounds check — stoploss, maxPositions within safe limits
 * 4. Safety check — no forbidden patterns (eval, wallet access, network, filesystem)
 */
export class VariantValidator {
  /**
   * Run the full validation pipeline on a generated variant.
   */
  async validate(variant: GeneratedVariant): Promise<ValidationResult> {
    const syntaxValid = this.checkSyntax(variant.sourceCode);
    const extendsStrategy = this.checkExtendsStrategy(variant.sourceCode);
    const riskBoundsCheck = this.checkRiskBounds(variant.sourceCode);
    const safetyCheck = this.checkSafety(variant.sourceCode);

    const violations: string[] = [];

    if (!syntaxValid) {
      violations.push('Syntax check failed: code has structural issues');
    }
    if (!extendsStrategy) {
      violations.push('Class does not extend CrossChainStrategy');
    }
    if (!riskBoundsCheck.valid) {
      violations.push(...riskBoundsCheck.violations);
    }
    if (!safetyCheck.safe) {
      violations.push(...safetyCheck.violations);
    }

    const valid = syntaxValid && extendsStrategy && riskBoundsCheck.valid && safetyCheck.safe;

    const result: ValidationResult = {
      valid,
      violations,
      syntaxValid,
      extendsStrategy,
      riskBoundsValid: riskBoundsCheck.valid,
      safetyCheckPassed: safetyCheck.safe,
    };

    logger.info(
      { variantId: variant.id, valid, violationCount: violations.length },
      `Variant validation ${valid ? 'passed' : 'failed'}`,
    );

    return result;
  }

  /**
   * Check basic syntax validity using string/regex analysis.
   * Verifies class declaration, balanced braces, and basic structure.
   */
  checkSyntax(sourceCode: string): boolean {
    // Must contain a class declaration
    if (!/\bclass\s+\w+/.test(sourceCode)) {
      return false;
    }

    // Check for balanced braces
    let braceCount = 0;
    for (const char of sourceCode) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      if (braceCount < 0) return false;
    }
    if (braceCount !== 0) return false;

    // Check for balanced parentheses
    let parenCount = 0;
    for (const char of sourceCode) {
      if (char === '(') parenCount++;
      if (char === ')') parenCount--;
      if (parenCount < 0) return false;
    }
    if (parenCount !== 0) return false;

    // Must have at least one method-like pattern
    if (!/\w+\s*\([^)]*\)\s*[:{]/.test(sourceCode)) {
      return false;
    }

    return true;
  }

  /**
   * Check that the source code contains a class extending CrossChainStrategy.
   */
  checkExtendsStrategy(sourceCode: string): boolean {
    return /\bclass\s+\w+\s+extends\s+CrossChainStrategy\b/.test(sourceCode);
  }

  /**
   * Check that risk parameters are within safe bounds.
   * - stoploss >= 0.005 in absolute terms (i.e., value like -0.005 means 0.5% loss)
   * - maxPositions <= 10
   */
  checkRiskBounds(sourceCode: string): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    // Check stoploss — look for patterns like `stoploss = -0.003` or `readonly stoploss = -0.003`
    const stoplossMatch = sourceCode.match(
      /\bstoploss\s*[=:]\s*(-?\d+\.?\d*)/,
    );
    if (stoplossMatch) {
      const stoplossValue = parseFloat(stoplossMatch[1]);
      // stoploss is typically negative (e.g., -0.10 means -10%)
      // The absolute value must be >= 0.005 (0.5% minimum stop loss)
      const absStoploss = Math.abs(stoplossValue);
      if (absStoploss < 0.005) {
        violations.push(
          `stoploss absolute value ${absStoploss} is below minimum 0.005 (0.5%)`,
        );
      }
    }

    // Check maxPositions — look for patterns like `maxPositions = 15`
    const maxPosMatch = sourceCode.match(
      /\bmaxPositions\s*[=:]\s*(\d+)/,
    );
    if (maxPosMatch) {
      const maxPositions = parseInt(maxPosMatch[1], 10);
      if (maxPositions > 10) {
        violations.push(
          `maxPositions ${maxPositions} exceeds maximum of 10`,
        );
      }
    }

    // Check minimalRoi values are positive
    const roiMatches = sourceCode.matchAll(
      /\bminimalRoi\s*[=:]\s*\{([^}]*)\}/g,
    );
    for (const roiMatch of roiMatches) {
      const roiBody = roiMatch[1];
      const valueMatches = roiBody.matchAll(/:\s*(-?\d+\.?\d*)/g);
      for (const valueMatch of valueMatches) {
        const value = parseFloat(valueMatch[1]);
        if (value <= 0) {
          violations.push(`minimalRoi value ${value} is not positive`);
        }
      }
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  /**
   * Scan source code for forbidden/unsafe patterns.
   * Defense-in-depth: never trust LLM-generated code without scanning.
   */
  checkSafety(sourceCode: string): { safe: boolean; violations: string[] } {
    const violations: string[] = [];

    for (const { pattern, description } of FORBIDDEN_PATTERNS) {
      if (pattern.test(sourceCode)) {
        violations.push(`Unsafe pattern detected: ${description}`);
      }
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }
}
