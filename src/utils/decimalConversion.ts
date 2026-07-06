const DECIMAL_INPUT = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

export function scaleDecimals(rawValue: bigint, fromDecimals: number, toDecimals: number): bigint {
  const from = BigInt(fromDecimals);
  const to = BigInt(toDecimals);

  if (from === to) {
    return rawValue;
  } else if (from < to) {
    return rawValue * 10n ** (to - from);
  } else {
    return rawValue / 10n ** (from - to);
  }
}

export function toWad(rawValue: bigint, assetDecimals: number): bigint {
  return scaleDecimals(rawValue, assetDecimals, 18);
}

export function toWadTokenUnit(assetDecimals: number): bigint {
  const unit = toWad(1n, assetDecimals);
  return unit > 0n ? unit : 1n;
}

export function toAsset(rawValue: string | number, decimals: number): bigint {
  return _parseDecimalToUnits(rawValue, decimals);
}

function _parseDecimalToUnits(rawValue: string | number, decimals: number): bigint {
  const normalized = _normalizeDecimalInput(rawValue);
  const match = normalized.match(DECIMAL_INPUT);
  if (!match) throw new Error(`invalid decimal value: ${normalized}`);

  const sign = match[1] === '-' ? -1n : 1n;
  const wholeDigits = match[2] ?? '0';
  const fractionDigits = match[2] != null ? (match[3] ?? '') : (match[4] ?? '');
  const exponentDigits = match[5] ?? '0';

  const digits = `${wholeDigits}${fractionDigits}`.replace(/^0+/, '') || '0';
  const scale = BigInt(decimals) + BigInt(exponentDigits) - BigInt(fractionDigits.length);
  let scaled = BigInt(digits);

  if (scale >= 0n) {
    scaled *= 10n ** scale;
  } else {
    scaled /= 10n ** -scale;
  }

  return sign * scaled;
}

function _normalizeDecimalInput(rawValue: string | number): string {
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) throw new Error('decimal value must be finite');
    return rawValue.toString();
  }

  const normalized = rawValue.trim();
  if (!normalized) throw new Error('decimal value must not be empty');
  return normalized;
}
