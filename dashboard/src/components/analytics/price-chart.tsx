'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  ColorType,
  type CandlestickSeriesOptions,
  type DeepPartial,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { PriceHistory } from '@/hooks/use-analytics-data';

interface PriceChartProps {
  data: PriceHistory;
  className?: string;
}

const CHART_BG = '#18181b'; // zinc-900
const GRID_COLOR = '#27272a'; // zinc-800
const TEXT_COLOR = '#a1a1aa'; // zinc-400
const UP_COLOR = '#22C55E';
const DOWN_COLOR = '#EF4444';
const CROSSHAIR_COLOR = '#71717a'; // zinc-500

export function PriceChart({ data, className }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const initChart = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clean up existing chart
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
    }

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: TEXT_COLOR,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        vertLine: { color: CROSSHAIR_COLOR, labelBackgroundColor: CHART_BG },
        horzLine: { color: CROSSHAIR_COLOR, labelBackgroundColor: CHART_BG },
      },
      rightPriceScale: {
        borderColor: GRID_COLOR,
      },
      timeScale: {
        borderColor: GRID_COLOR,
        timeVisible: false,
      },
      width: container.clientWidth,
      height: 380,
    });

    chartRef.current = chart;

    const candlestickOptions: DeepPartial<CandlestickSeriesOptions> = {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderDownColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
    };

    const series = chart.addSeries(CandlestickSeries, candlestickOptions);
    candlestickSeriesRef.current = series;

    // Set data
    const chartCandles = data.candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    series.setData(chartCandles);

    // Set markers for entry/exit points using v5 createSeriesMarkers API
    if (data.markers.length > 0) {
      const markers: SeriesMarker<Time>[] = data.markers.map((m) => ({
        time: m.time as Time,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      }));
      createSeriesMarkers(series, markers);
    }

    chart.timeScale().fitContent();
  }, [data]);

  // Initialize chart on mount / data change
  useEffect(() => {
    initChart();
  }, [initChart]);

  // Handle resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !chartRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        if (chartRef.current && width > 0) {
          chartRef.current.applyOptions({ width });
        }
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [data]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        candlestickSeriesRef.current = null;
      }
    };
  }, []);

  return (
    <Card className={cn('border-border bg-card', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 3v18h18" />
            <path d="M18 17V9" />
            <path d="M13 17V5" />
            <path d="M8 17v-3" />
          </svg>
          Price Chart
        </CardTitle>
        <CardDescription>
          {data.symbol} candlestick with trade entry/exit markers
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          ref={containerRef}
          data-testid="price-chart-container"
          className="w-full rounded-lg overflow-hidden"
        />
      </CardContent>
    </Card>
  );
}
