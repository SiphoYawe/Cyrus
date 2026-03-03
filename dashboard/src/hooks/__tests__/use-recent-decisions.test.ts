import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRecentDecisions } from '@/hooks/use-recent-decisions';

const mockDecisions = [
  {
    id: 'd1',
    timestamp: new Date().toISOString(),
    tier: 'Growth',
    strategyName: 'YieldHunter',
    summary: 'Deployed USDC to Arbitrum vault.',
    narrative: 'Full narrative here.',
  },
  {
    id: 'd2',
    timestamp: new Date().toISOString(),
    tier: 'Safe',
    strategyName: 'StableGuard',
    summary: 'Rebalanced stable positions.',
    narrative: 'Detailed narrative.',
  },
];

describe('useRecentDecisions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts in loading state with empty array', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRecentDecisions());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toEqual([]);
  });

  it('fetches decisions on mount', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockDecisions,
    } as Response);

    const { result } = renderHook(() => useRecentDecisions());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('sets error state on failed fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const { result } = renderHook(() => useRecentDecisions());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toEqual([]);
  });

  it('calls API with limit param', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    renderHook(() => useRecentDecisions(5));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/activity?limit=5'),
        expect.any(Object)
      );
    });
  });

  it('exposes refetch function', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const { result } = renderHook(() => useRecentDecisions());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(typeof result.current.refetch).toBe('function');
  });
});
