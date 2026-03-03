import { http } from 'wagmi';
import { mainnet, arbitrum, optimism, polygon, base, bsc } from 'wagmi/chains';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'development-placeholder';

export const wagmiConfig = getDefaultConfig({
  appName: 'CYRUS Agent Dashboard',
  projectId,
  chains: [mainnet, arbitrum, optimism, polygon, base, bsc],
  transports: {
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [base.id]: http(),
    [bsc.id]: http(),
  },
});
