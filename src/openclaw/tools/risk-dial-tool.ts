// OpenClaw Risk Dial Tool — View and adjust the risk dial level (1-10)

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';
import { calculateTierAllocation } from '../../risk/risk-dial.js';
import type { RiskDialLevel, RiskDialTierAllocation } from '../../risk/types.js';

function formatAllocation(alloc: RiskDialTierAllocation): string {
  return `Safe: ${(alloc.safe * 100).toFixed(0)}%, Growth: ${(alloc.growth * 100).toFixed(0)}%, Degen: ${(alloc.degen * 100).toFixed(0)}%, Reserve: ${(alloc.reserve * 100).toFixed(0)}%`;
}

function isValidDialLevel(level: unknown): level is RiskDialLevel {
  return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 10;
}

export function createRiskDialTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  // Track current dial level in closure — would be connected to RiskDialManager in production
  let currentDial: RiskDialLevel = 5;

  return {
    name: 'risk-dial',
    description: 'View or adjust the risk dial level (1-10). Level 1 is most conservative, 10 is most aggressive.',
    parameters: [
      { name: 'level', type: 'number', description: 'New risk dial level (1-10). Omit to view current level.', required: false },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const newLevel = params.level as number | undefined;

      if (newLevel === undefined) {
        // View mode
        const allocation = calculateTierAllocation(currentDial);
        return {
          success: true,
          message: `Risk dial: ${currentDial}/10. Allocation: ${formatAllocation(allocation)}`,
          data: {
            currentDial,
            allocation,
          },
        };
      }

      if (!isValidDialLevel(newLevel)) {
        return {
          success: false,
          message: 'Risk dial must be an integer between 1 and 10',
        };
      }

      const oldDial = currentDial;
      const oldAllocation = calculateTierAllocation(oldDial);
      currentDial = newLevel;
      const newAllocation = calculateTierAllocation(newLevel);

      return {
        success: true,
        message: `Risk dial changed: ${oldDial} → ${newLevel}. New allocation: ${formatAllocation(newAllocation)}`,
        data: {
          oldDial,
          newDial: newLevel,
          oldAllocation,
          newAllocation,
        },
      };
    },
  };
}
