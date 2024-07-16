import { WalletSelectorParams } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupNightly } from '@near-wallet-selector/nightly';
import { setupSender } from '@near-wallet-selector/sender';

import { usePurchasedTickets } from '@/hooks/usePurchasedTickets';

import { NETWORK_ID } from './config';
import { FunderEventMetadata, TicketMetadataExtra } from './helpers';

const modules = [setupMyNearWallet(), setupSender(), setupMeteorWallet(), setupNightly()];

const TESTNET_WALLET_SELECTOR_PARAMS: WalletSelectorParams = {
  network: 'testnet',
  modules,
};

const MAINNET_WALLET_SELECTOR_PARAMS: WalletSelectorParams = {
  network: 'mainnet',
  modules,
};

export const WALLET_SELECTOR_PARAMS =
  NETWORK_ID === 'mainnet' ? MAINNET_WALLET_SELECTOR_PARAMS : TESTNET_WALLET_SELECTOR_PARAMS;

export type EventDataForWallet = {
  event: FunderEventMetadata;
  tickets: {
    artwork?: string;
    description?: string;
    extra: TicketMetadataExtra;
    secretKey: string;
    title: string;
  }[];
};

export function stringifyEventDataForWallet(data: ReturnType<typeof usePurchasedTickets>['data']) {
  if (!data) return '';

  const result: EventDataForWallet = {
    event: data.event,
    tickets: data.tickets.map((ticket) => ({
      artwork: ticket.artwork,
      description: ticket.description,
      extra: ticket.extra,
      secretKey: ticket.secretKey,
      title: ticket.title,
    })),
  };

  return encodeURIComponent(btoa(JSON.stringify(result)));
}

export function decodeEventDataForWallet(data: string) {
  return JSON.parse(atob(decodeURIComponent(data))) as EventDataForWallet;
}
