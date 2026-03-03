'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { RiskDial } from '@/components/settings/risk-dial';
import { ChainsSettings } from '@/components/settings/chains-settings';
import { StrategiesSettings } from '@/components/settings/strategies-settings';
import { AgentSettings } from '@/components/settings/agent-settings';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure risk profile, enabled chains, active strategies, and agent behaviour.
        </p>
      </div>

      {/* Risk Dial — prominent section at the top */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Risk Profile</CardTitle>
          <CardDescription>
            Set how aggressively CYRUS allocates capital. Changes trigger a live portfolio rebalance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RiskDial />
        </CardContent>
      </Card>

      <Separator />

      {/* Tabbed configuration sections */}
      <Tabs defaultValue="chains">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="chains">Chains</TabsTrigger>
          <TabsTrigger value="strategies">Strategies</TabsTrigger>
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="apikeys">API Keys</TabsTrigger>
        </TabsList>

        {/* Chains */}
        <TabsContent value="chains" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Active Chains</CardTitle>
              <CardDescription>
                Toggle which chains CYRUS monitors and executes on. Disabled chains are excluded from all strategies.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChainsSettings />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Strategies */}
        <TabsContent value="strategies" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Strategy Configuration</CardTitle>
              <CardDescription>
                Enable or disable individual strategies and tune their parameters.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StrategiesSettings />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agent */}
        <TabsContent value="agent" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent Behaviour</CardTitle>
              <CardDescription>
                Control tick interval, logging verbosity, and confirmation requirements.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AgentSettings />
            </CardContent>
          </Card>
        </TabsContent>

        {/* API Keys */}
        <TabsContent value="apikeys" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Keys</CardTitle>
              <CardDescription>
                Key status is read-only. Configure secrets via server-side environment variables.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ApiKeysSettings />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
