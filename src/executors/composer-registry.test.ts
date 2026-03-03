import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_PROTOCOLS,
  VAULT_TOKEN_REGISTRY,
  isVaultToken,
  getProtocolInfo,
  isSupportedProtocol,
} from './composer-registry.js';
import type { SupportedProtocol } from './composer-registry.js';
import { chainId, tokenAddress } from '../core/types.js';
import { CHAINS } from '../core/constants.js';

describe('composer-registry', () => {
  // --- SUPPORTED_PROTOCOLS ---

  describe('SUPPORTED_PROTOCOLS', () => {
    it('contains all expected protocols', () => {
      expect(SUPPORTED_PROTOCOLS).toContain('aave-v3');
      expect(SUPPORTED_PROTOCOLS).toContain('morpho');
      expect(SUPPORTED_PROTOCOLS).toContain('euler');
      expect(SUPPORTED_PROTOCOLS).toContain('pendle');
      expect(SUPPORTED_PROTOCOLS).toContain('lido');
      expect(SUPPORTED_PROTOCOLS).toContain('etherfi');
      expect(SUPPORTED_PROTOCOLS).toContain('ethena');
    });

    it('has exactly 7 protocols', () => {
      expect(SUPPORTED_PROTOCOLS).toHaveLength(7);
    });
  });

  // --- VAULT_TOKEN_REGISTRY ---

  describe('VAULT_TOKEN_REGISTRY', () => {
    it('is a non-empty map', () => {
      expect(VAULT_TOKEN_REGISTRY.size).toBeGreaterThan(0);
    });

    it('contains Morpho vault on Base', () => {
      const key = `${CHAINS.BASE}-${tokenAddress('0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a')}`;
      const info = VAULT_TOKEN_REGISTRY.get(key);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('morpho');
      expect(info!.chainId).toBe(CHAINS.BASE);
    });

    it('contains Lido wstETH on Ethereum', () => {
      const key = `${CHAINS.ETHEREUM}-${tokenAddress('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0')}`;
      const info = VAULT_TOKEN_REGISTRY.get(key);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('lido');
      expect(info!.chainId).toBe(CHAINS.ETHEREUM);
    });

    it('contains Ethena sUSDe on Ethereum', () => {
      const key = `${CHAINS.ETHEREUM}-${tokenAddress('0x9d39a5de30e57443bff2a8307a4256c8797a3497')}`;
      const info = VAULT_TOKEN_REGISTRY.get(key);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('ethena');
    });

    it('all entries have valid protocol and chainId', () => {
      for (const [, info] of VAULT_TOKEN_REGISTRY) {
        expect(SUPPORTED_PROTOCOLS).toContain(info.protocol);
        expect(info.chainId).toBeGreaterThan(0);
        expect(info.description).toBeTruthy();
      }
    });
  });

  // --- isVaultToken ---

  describe('isVaultToken', () => {
    it('returns true for known Morpho vault on Base', () => {
      const token = tokenAddress('0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A');
      expect(isVaultToken(token, CHAINS.BASE)).toBe(true);
    });

    it('returns true for known Lido wstETH on Ethereum', () => {
      const token = tokenAddress('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0');
      expect(isVaultToken(token, CHAINS.ETHEREUM)).toBe(true);
    });

    it('returns false for unknown token address', () => {
      const token = tokenAddress('0x0000000000000000000000000000000000000123');
      expect(isVaultToken(token, CHAINS.ETHEREUM)).toBe(false);
    });

    it('returns false for known token on wrong chain', () => {
      // Morpho vault is on Base, not Ethereum
      const token = tokenAddress('0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A');
      expect(isVaultToken(token, CHAINS.ETHEREUM)).toBe(false);
    });

    it('is case-insensitive for token address', () => {
      const tokenUpper = tokenAddress('0x7BFA7C4F149E7415B73BDEDFE609237E29CBF34A');
      const tokenLower = tokenAddress('0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a');
      expect(isVaultToken(tokenUpper, CHAINS.BASE)).toBe(true);
      expect(isVaultToken(tokenLower, CHAINS.BASE)).toBe(true);
    });
  });

  // --- getProtocolInfo ---

  describe('getProtocolInfo', () => {
    it('returns protocol info for known vault token', () => {
      const token = tokenAddress('0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A');
      const info = getProtocolInfo(token, CHAINS.BASE);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('morpho');
      expect(info!.chainId).toBe(CHAINS.BASE);
      expect(info!.description).toContain('Morpho');
    });

    it('returns undefined for unknown token', () => {
      const token = tokenAddress('0x0000000000000000000000000000000000000456');
      const info = getProtocolInfo(token, CHAINS.ETHEREUM);
      expect(info).toBeUndefined();
    });

    it('returns correct info for Aave V3 aToken on Arbitrum', () => {
      const token = tokenAddress('0x724dc807b04555b71ed48a6896b6f41593b8c637');
      const info = getProtocolInfo(token, CHAINS.ARBITRUM);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('aave-v3');
      expect(info!.chainId).toBe(CHAINS.ARBITRUM);
    });

    it('returns correct info for EtherFi eETH on Ethereum', () => {
      const token = tokenAddress('0x35fa164735182de50811e8e2e824cfb9b6118ac2');
      const info = getProtocolInfo(token, CHAINS.ETHEREUM);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('etherfi');
    });

    it('returns correct info for Euler vault on Ethereum', () => {
      const token = tokenAddress('0x797dd80692c3b2dadadbcc6120e7aad7311dc60a');
      const info = getProtocolInfo(token, CHAINS.ETHEREUM);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('euler');
    });

    it('returns correct info for Pendle on Ethereum', () => {
      const token = tokenAddress('0xc69ad9bab1dee23f4605a82b3354f8e40d665f49');
      const info = getProtocolInfo(token, CHAINS.ETHEREUM);
      expect(info).toBeDefined();
      expect(info!.protocol).toBe('pendle');
    });
  });

  // --- isSupportedProtocol ---

  describe('isSupportedProtocol', () => {
    it('returns true for all supported protocols', () => {
      for (const protocol of SUPPORTED_PROTOCOLS) {
        expect(isSupportedProtocol(protocol)).toBe(true);
      }
    });

    it('returns false for unsupported protocol', () => {
      expect(isSupportedProtocol('compound')).toBe(false);
      expect(isSupportedProtocol('uniswap')).toBe(false);
      expect(isSupportedProtocol('')).toBe(false);
    });
  });
});
