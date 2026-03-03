// bigint utilities for token amount math — NEVER use number for wei values

export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const str = abs.toString().padStart(decimals + 1, '0');
  const intPart = str.slice(0, str.length - decimals) || '0';
  const fracPart = str.slice(str.length - decimals);

  // Trim trailing zeros
  const trimmed = fracPart.replace(/0+$/, '');
  const result = trimmed ? `${intPart}.${trimmed}` : intPart;

  return negative ? `-${result}` : result;
}

export function parseUnits(value: string, decimals: number): bigint {
  const [intPart, fracPart = ''] = value.split('.');
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, '0');

  if (fracPart.length > decimals) {
    throw new Error(
      `Too many decimal places: ${fracPart.length} > ${decimals}`
    );
  }

  const negative = intPart.startsWith('-');
  const absInt = negative ? intPart.slice(1) : intPart;
  const combined = BigInt(absInt + paddedFrac);

  return negative ? -combined : combined;
}

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('Division by zero');
  }
  return (a * b) / denominator;
}

export function percentOf(amount: bigint, basisPoints: bigint): bigint {
  return mulDiv(amount, basisPoints, 10000n);
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
