import { config } from './config.ts';
import { credentialMode, env } from './env.ts';
import { startupNoticeLog } from './logger.ts';

export function logStartupWarnings(): void {
  if (
    config.oracle.onchainCollateralAddress &&
    config.oracle.onchainQuoteAddress &&
    config.oracle.onchainMaxStaleness == null
  ) {
    startupNoticeLog.warn(
      {
        event: 'oracle_staleness_check_disabled',
        onchainCollateralAddress: config.oracle.onchainCollateralAddress,
        onchainQuoteAddress: config.oracle.onchainQuoteAddress,
        onchainPrimary: config.oracle.onchainPrimary,
      },
      'onchain oracle staleness checking is disabled via explicit config override',
    );
  }

  const collateralToken = config.collateralTokenAddress?.toLowerCase();
  if (collateralToken && collateralToken === config.quoteTokenAddress.toLowerCase()) {
    startupNoticeLog.warn(
      { event: 'oracle_denomination_degenerate', source: 'offchain' },
      'collateralTokenAddress equals quoteTokenAddress: the offchain oracle will price every pair as a constant 1.0',
    );
  }

  const collateralFeed = config.oracle.onchainCollateralAddress?.toLowerCase();
  if (collateralFeed && collateralFeed === config.oracle.onchainQuoteAddress?.toLowerCase()) {
    startupNoticeLog.warn(
      { event: 'oracle_denomination_degenerate', source: 'onchain' },
      'oracle.onchainCollateralAddress equals oracle.onchainQuoteAddress: the onchain oracle will price every pair as a constant 1.0',
    );
  }

  if (config.oracle.fixedPrice != null) {
    startupNoticeLog.warn(
      {
        event: 'oracle_fixed_price_enabled',
        rawPrice: config.oracle.fixedPrice,
      },
      'fixed-price mode is enabled: live oracle queries and validation are bypassed',
    );
  }

  for (const [i, ark] of config.arks.entries()) {
    const arkCollateralToken = ark.collateralTokenAddress?.toLowerCase();
    if (arkCollateralToken && arkCollateralToken === config.quoteTokenAddress.toLowerCase()) {
      startupNoticeLog.warn(
        { event: 'oracle_denomination_degenerate', source: 'offchain', ark: ark.vaultAddress },
        `arks[${i}].collateralTokenAddress equals quoteTokenAddress: the offchain oracle will price this ark's pair as a constant 1.0`,
      );
    }

    const arkCollateralFeed = ark.onchainCollateralAddress?.toLowerCase();
    if (
      arkCollateralFeed &&
      arkCollateralFeed === config.oracle.onchainQuoteAddress?.toLowerCase()
    ) {
      startupNoticeLog.warn(
        { event: 'oracle_denomination_degenerate', source: 'onchain', ark: ark.vaultAddress },
        `arks[${i}].onchainCollateralAddress equals oracle.onchainQuoteAddress: the onchain oracle will price this ark's pair as a constant 1.0`,
      );
    }

    if (ark.fixedPrice != null && config.oracle.fixedPrice == null) {
      startupNoticeLog.warn(
        { event: 'oracle_fixed_price_enabled', rawPrice: ark.fixedPrice, ark: ark.vaultAddress },
        `fixed-price mode is enabled for arks[${i}]: live oracle queries and validation are bypassed for this ark`,
      );
    }
  }

  if (
    credentialMode === 'remoteSigner' &&
    env.REMOTE_SIGNER_URL != null &&
    new URL(env.REMOTE_SIGNER_URL).protocol === 'http:'
  ) {
    const tokenExposed = Boolean(env.REMOTE_SIGNER_AUTH_TOKEN);
    const message = tokenExposed
      ? 'REMOTE_SIGNER_ALLOW_INSECURE is set with REMOTE_SIGNER_AUTH_TOKEN: signer requests and the bearer token will be sent over plaintext http. Use https in production.'
      : 'REMOTE_SIGNER_ALLOW_INSECURE is set: signer requests will be sent over plaintext http. Use https in production.';
    startupNoticeLog.warn(
      {
        event: 'remote_signer_insecure_transport',
        tokenExposed,
      },
      message,
    );
  }
}
