import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMorningBriefing } from '@/hooks/use-morning-briefing';

const mockData = {
  overnightPnl: 210,
  overnightPnlPercent: 1.1,
  operationsCount: 3,
  yieldDelta: 0.2,
  riskStatus: 'Low',
  generatedAt: new Date().toISOString(),
};

describe('useMorningBriefing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts in loading state', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useMorningBriefing());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('fetches and returns briefing data on mount', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const { result } = renderHook(() => useMorningBriefing());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockData);
    expect(result.current.error).toBeNull();
  });

  it('sets error when fetch fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const { result } = renderHook(() => useMorningBriefing());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toBeNull();
  });

  it('calls correct API endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    renderHook(() => useMorningBriefing());

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/portfolio/briefing'),
        expect.any(Object)
      );
    });
  });
});
