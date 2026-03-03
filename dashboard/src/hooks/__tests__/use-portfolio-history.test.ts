import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePortfolioHistory } from '@/hooks/use-portfolio-history';

const mockHistory = [
  { timestamp: '12:00', value: 100000 },
  { timestamp: '13:00', value: 102000 },
  { timestamp: '14:00', value: 101500 },
];

describe('usePortfolioHistory', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to 1D time range', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePortfolioHistory());
    expect(result.current.timeRange).toBe('1D');
  });

  it('fetches history data on mount', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockHistory,
    } as Response);

    const { result } = renderHook(() => usePortfolioHistory());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });

  it('fetches new data when time range changes', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockHistory,
    } as Response);

    const { result } = renderHook(() => usePortfolioHistory());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setTimeRange('1W');
    });

    await waitFor(() => {
      expect(result.current.timeRange).toBe('1W');
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('range=1W'),
      expect.any(Object)
    );
  });

  it('includes range param in request URL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    renderHook(() => usePortfolioHistory());

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('range=1D'),
        expect.any(Object)
      );
    });
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => usePortfolioHistory());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toEqual([]);
  });
});
