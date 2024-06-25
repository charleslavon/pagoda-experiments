import { type Action } from '@near-wallet-selector/core';
import { parseNearAmount } from 'near-api-js/lib/utils/format';

import { KEYPOM_MARKETPLACE_CONTRACT } from './common';
import {
  deriveKeyFromPassword,
  encryptPrivateKey,
  exportPublicKeyToBase64,
  generateKeyPair,
  getByteSize,
  uint8ArrayToBase64,
} from './crypto-helpers';
import { localStorageGet } from './local-storage';

export interface DateAndTimeInfo {
  startDate: number; // Milliseconds from Unix Epoch

  startTime?: string; // Raw time string such as 9:00 AM
  // For single day events, toDay is not required
  endDate?: number; // Milliseconds from Unix Epoch
  endTime?: string; // Raw time string such as 9:00 AM
}

export interface TicketInfoFormMetadata {
  name: string;
  denomination: string;
  maxSupply?: number;
  maxPurchases?: number;
  priceNear?: string;
  priceFiat?: string;
  description?: string | undefined;
  artwork?: FileList;
  salesValidThrough?: DateAndTimeInfo;
  passValidThrough?: DateAndTimeInfo;
}

export interface TicketInfoMetadata {
  name: string;
  description?: string;
  artwork?: string; // CID to IPFS. To render, use `${CLOUDFLARE_IPDS}/${media}`
  extra?: string; // Stringified TicketMetadataExtra
}

export interface TicketMetadataExtra {
  eventId: string;
  dateCreated: string;
  limitPerUser?: number;
  priceNear?: string;
  priceFiat?: string;
  maxSupply?: number;
  salesValidThrough?: DateAndTimeInfo;
  passValidThrough?: DateAndTimeInfo;
}

/* ---- Keeping for reference as we build additional functionality ----

// export interface TicketDropFormData {
//   // Step 0
//   stripeAccountId?: string;
//   acceptStripePayments: boolean;
//   acceptNearPayments: boolean;
//   nearPrice?: number;

//   // Step 1
//   eventName: { value: string; error?: string };
//   eventDescription: { value: string; error?: string };
//   eventLocation: { value: string; error?: string };
//   date: { value: DateAndTimeInfo; error?: string };
//   eventArtwork: { value: File | undefined; error?: string };
//   sellable: boolean;

//   // Step 2
//   questions: Array<{ question: string; isRequired: boolean }>;

//   // Step 3
//   tickets: TicketInfoFormMetadata[];

//   costBreakdown: {
//     marketListing: string;
//     total: string;
//     perDrop: string;
//     perEvent: string;
//   };
// }

export interface FunderEventMetadata {
  // Stage 0
  nearCheckout: boolean;

  // Stage 1
  name: string;
  id: string;
  description: string;
  location: string;
  date: DateAndTimeInfo;
  artwork: string;
  sellable?: boolean;
  dateCreated: string;

  // Stage 2
  questions?: QuestionInfo[];

  // If there are some questions, then we need to encrypt the answers
  pubKey?: string;
  encPrivKey?: string;
  iv?: string;
  salt?: string;
}

------- End references ----   */

export interface FunderEventMetadata {
  // Stage 0
  nearCheckout?: boolean;

  // Stage 1
  name: string;
  id: string;
  location: string;
  date: DateAndTimeInfo;
  artwork: string;
  dateCreated: string;
  description?: string | undefined;
  sellable?: boolean;

  // Stage 2
  // questions?: QuestionInfo[];

  // If there are some questions, then we need to encrypt the answers
  pubKey?: string;
  encPrivKey?: string;
  iv?: string;
  salt?: string;
}

export type FunderMetadata = Record<string, FunderEventMetadata>;

export type FormSchema = {
  name: string;
  stripeAccountId: string | undefined;
  acceptNearPayments: boolean;
  acceptStripePayments: boolean;
  location: string;
  date: string;
  tickets: TicketInfoFormMetadata[];
  checkoutType: 'near' | 'stripe' | 'both';
  description?: string;
  startTime?: string;
  endTime?: string;
  eventArtwork?: FileList;
  // ticketPrice?: number;
  // ticketQuantityLimit?: number;
};

const FIRST_DROP_BASE_COST = BigInt('15899999999999900000000');
const SUBSEQUENT_DROP_BASE_COST = BigInt('14460000000000200000000');
const FUNDER_METADATA_BASE_COST = BigInt('840000000000000000000');
const FIRST_MARKET_DROP_BASE_COST = BigInt('11790000000000000000000');
const SUBSEQUENT_MARKET_DROP_BASE_COST = BigInt('6810000000000000000000');
const YOCTO_PER_BYTE = BigInt('15000000000000000000'); // Includes a 200% safety margin

const BASE_MARKET_BYTES_PER_KEY = BigInt('800');
const METADATA_MARKET_BYTES_PER_KEY = BigInt('900');

export const calculateDepositCost = ({
  eventMetadata,
  tickets,
  marketTicketInfo,
}: {
  eventMetadata: FunderEventMetadata;
  tickets: TicketInfoFormMetadata[];
  marketTicketInfo: Record<string, { max_tickets: number; price: string; sale_start?: number; sale_end?: number }>;
}) => {
  let marketDeposit = FIRST_MARKET_DROP_BASE_COST;
  let dropDeposit = FIRST_DROP_BASE_COST;
  let funderMetaCost = FUNDER_METADATA_BASE_COST;

  // Calculate drop deposit
  dropDeposit += BigInt(tickets.length - 1) * SUBSEQUENT_DROP_BASE_COST;
  dropDeposit += BigInt(getByteSize(JSON.stringify(tickets))) * YOCTO_PER_BYTE;

  // Calculate funder metadata cost
  funderMetaCost += BigInt(getByteSize(JSON.stringify(eventMetadata))) * YOCTO_PER_BYTE;

  // Initialize market deposit
  marketDeposit += BigInt(Object.keys(marketTicketInfo).length - 1) * SUBSEQUENT_MARKET_DROP_BASE_COST;

  let numFreeKeys = 0; // Initialize numFreeKeys as a number
  for (const keyInfo of Object.values(marketTicketInfo)) {
    if (keyInfo.price === '0') {
      numFreeKeys += keyInfo.max_tickets; // Ensure max_tickets is a number
    }
  }

  // Calculate market key cost for free keys (if any)
  marketDeposit +=
    BigInt(numFreeKeys) * (BASE_MARKET_BYTES_PER_KEY + METADATA_MARKET_BYTES_PER_KEY) * YOCTO_PER_BYTE * BigInt(2);

  // Return the total deposit cost
  return {
    costBreakdown: {
      perDrop: (dropDeposit / BigInt(tickets.length)).toString(),
      perEvent: funderMetaCost.toString(),
      marketListing: marketDeposit.toString(),
      total: (dropDeposit + funderMetaCost + marketDeposit).toString(),
    },
  };
};

async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return await new Promise((resolve, reject) => {
    if (!(file instanceof File)) {
      reject(new TypeError('The provided value is not a File.'));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event: ProgressEvent<FileReader>) => {
      // Explicitly assert the result is an ArrayBuffer
      resolve(event.target!.result as ArrayBuffer);
    };
    reader.onerror = (event: ProgressEvent<FileReader>) => {
      // Safely access error code, considering it could be null
      reject(new Error('File reading error: ' + (event.target?.error?.message || 'Unknown error')));
    };
    reader.readAsArrayBuffer(file);
  });
}

export async function serializeMediaForWorker(formData: FormSchema) {
  if (!formData.eventArtwork) {
    return [];
  }
  const arrayBuffers: string[] = [];

  if (formData.eventArtwork[0]) {
    try {
      const eventArtworkArrayBuffer = await fileToArrayBuffer(formData.eventArtwork[0]);
      arrayBuffers.push(arrayBufferToBase64(eventArtworkArrayBuffer));
    } catch (error) {
      console.error('Error reading event artwork:', error);
    }
  }

  for (const ticket of formData.tickets) {
    if (ticket.artwork && ticket.artwork[0]) {
      try {
        const ticketArtworkArrayBuffer = await fileToArrayBuffer(ticket.artwork[0]);
        arrayBuffers.push(arrayBufferToBase64(ticketArtworkArrayBuffer));
      } catch (error) {
        console.error('Error reading ticket artwork:', error);
      }
    }
  }

  return arrayBuffers;
}

function arrayBufferToBase64(buffer: any) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return window.btoa(binary);
}

// export const estimateCosts = async ({
//   formData,
//   accountId,
//   setFormData,
//   setCurrentStep,
// }: {
//   accountId: string;
//   formData: TicketDropFormData;
//   setFormData: (data: TicketDropFormData | ((prev: TicketDropFormData) => TicketDropFormData)) => void;
//   setCurrentStep: any;
// }) => {
//   const eventId = Date.now().toString();
//   const masterKey = get('MASTER_KEY');

//   const funderInfo = await keypomInstance.viewCall({
//     methodName: 'get_funder_info',
//     args: { account_id: accountId },
//   });
//   const funderMetadata: FunderMetadata =
//     funderInfo === undefined || funderInfo === null ? {} : JSON.parse(funderInfo.metadata);

//   const eventMetadata: FunderEventMetadata = {
//     nearCheckout: formData.acceptNearPayments,
//     name: formData.eventName.value,
//     dateCreated: Date.now().toString(),
//     description: formData.eventDescription.value,
//     sellable: formData.sellable,
//     location: formData.eventLocation.value,
//     date: formData.date.value,
//     artwork: 'bafybeiehk3mzsj2ih4u4fkvmkfrome3kars7xyy3bxh6xfjquws4flglqa',
//     questions: formData.questions.map((question) => ({
//       question: question.question,
//       required: question.isRequired || false,
//     })),
//     id: eventId.toString(),
//   };

//   if (formData.questions.length > 0) {
//     const { publicKey, privateKey } = await generateKeyPair();
//     const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
//     const saltBase64 = uint8ArrayToBase64(saltBytes);
//     const symmetricKey = await deriveKeyFromPassword(masterKey, saltBase64);
//     const { encryptedPrivateKeyBase64, ivBase64 } = await encryptPrivateKey(privateKey, symmetricKey);

//     eventMetadata.pubKey = await exportPublicKeyToBase64(publicKey);
//     eventMetadata.encPrivKey = encryptedPrivateKeyBase64;
//     eventMetadata.iv = ivBase64;
//     eventMetadata.salt = saltBase64;
//   }

//   funderMetadata[eventId] = eventMetadata;

//   const drop_ids: string[] = [];
//   const drop_configs: any = [];
//   const asset_datas: any = [];
//   const ticket_information: Record<
//     string,
//     { max_tickets: number; price: string; sale_start?: number; sale_end?: number }
//   > = {};

//   for (const ticket of formData.tickets) {
//     const dropId = `${Date.now().toString()}-${ticket.name.replaceAll(' ', '').toLocaleLowerCase()}`;

//     ticket_information[`${dropId}`] = {
//       max_tickets: ticket.maxSupply,
//       price: parseNearAmount(ticket.priceNear)!.toString(),
//       sale_start: ticket.salesValidThrough.startDate || undefined,
//       sale_end: ticket.salesValidThrough.endDate || undefined,
//     };

//     const dropConfig = {
//       metadata: JSON.stringify(ticket),
//       add_key_allowlist: [KEYPOM_MARKETPLACE_CONTRACT],
//       transfer_key_allowlist: [KEYPOM_MARKETPLACE_CONTRACT],
//     };
//     const assetData = [
//       {
//         uses: 2,
//         assets: [null],
//         config: {
//           permissions: 'claim',
//         },
//       },
//     ];
//     drop_ids.push(dropId);
//     asset_datas.push(assetData);
//     drop_configs.push(dropConfig);
//   }

//   const { costBreakdown } = calculateDepositCost({
//     eventMetadata,
//     tickets: formData.tickets,
//     marketTicketInfo: ticket_information,
//   });

//   setFormData((prev: TicketDropFormData) => ({
//     ...prev,
//     costBreakdown,
//   }));

//   setCurrentStep((prevStep: number) => prevStep + 1);
// };

export const createPayload = async ({
  accountId,
  formData,
  eventArtworkCid,
  ticketArtworkCids,
  eventId,
}: {
  accountId: string;
  formData: FormSchema;
  eventArtworkCid: string;
  ticketArtworkCids: string[];
  eventId: string;
}): Promise<{ actions: Action[]; dropIds: string[] }> => {
  const masterKey = localStorageGet('MASTER_KEY');

  if (!masterKey) {
    throw new Error('Missing local storage value MASTER_KEY inside createPayload()');
  }

  const funderMetadata: FunderMetadata = {};

  const eventMetadata: FunderEventMetadata = {
    name: formData.name,
    dateCreated: Date.now().toString(),
    description: formData.description,
    location: formData.location,
    date: {
      startDate: Date.parse(formData.date),
      startTime: formData.startTime,
      endDate: Date.parse(formData.endTime || ''),
      endTime: formData.endTime,
    },
    artwork: eventArtworkCid,
    // nearCheckout: formData.acceptNearPayments,
    // sellable: formData.sellable,
    // questions: formData.questions.map((question: { question: any; isRequired: any; }) => ({
    //   question: question.question,
    //   required: question.isRequired || false,
    // })),
    id: eventId.toString(),
  };

  // if (formData.questions.length > 0) {
  if (formData) {
    const { publicKey, privateKey } = await generateKeyPair();
    const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
    const saltBase64 = uint8ArrayToBase64(saltBytes);
    const symmetricKey = await deriveKeyFromPassword(masterKey, saltBase64);
    const { encryptedPrivateKeyBase64, ivBase64 } = await encryptPrivateKey(privateKey, symmetricKey);

    eventMetadata.pubKey = await exportPublicKeyToBase64(publicKey);
    eventMetadata.encPrivKey = encryptedPrivateKeyBase64;
    eventMetadata.iv = ivBase64;
    eventMetadata.salt = saltBase64;
  }

  funderMetadata[eventId] = eventMetadata;

  const drop_ids: string[] = [];
  const drop_configs: any = [];
  const asset_datas: any = [];
  const ticket_information: Record<
    string,
    { max_tickets: number; price: string; sale_start?: number; sale_end?: number }
  > = {};

  for (const ticket of formData.tickets) {
    const dropId = `${Date.now().toString()}-${ticket.name.replaceAll(' ', '').toLocaleLowerCase()}`;

    const ticketExtra: TicketMetadataExtra = {
      dateCreated: Date.now().toString(),
      // price: parseNearAmount(ticket.price)!.toString(),
      priceNear: ticket.priceNear ?? '0',
      priceFiat: ticket.priceFiat ?? '0',
      salesValidThrough: ticket.salesValidThrough,
      passValidThrough: ticket.passValidThrough,
      maxSupply: ticket.maxSupply,
      limitPerUser: ticket.maxPurchases,
      eventId,
    };

    const ticketNftInfo: TicketInfoMetadata = {
      name: ticket.name,
      description: ticket.description,
      artwork: ticketArtworkCids.shift() || '',
      extra: JSON.stringify(ticketExtra),
    };

    ticket_information[`${dropId}`] = {
      max_tickets: ticket.maxSupply ?? 0,
      price: parseNearAmount(ticket.priceNear ?? '0')!.toString(),
      // sale_start: ticket.salesValidThrough.startDate || undefined,
      // sale_end: ticket.salesValidThrough.endDate || undefined,
    };

    const dropConfig = {
      nft_keys_config: {
        token_metadata: ticketNftInfo,
      },
      add_key_allowlist: [KEYPOM_MARKETPLACE_CONTRACT],
      // transfer_key_allowlist: formData.sellable ? [KEYPOM_MARKETPLACE_CONTRACT] : [],
      transfer_key_allowlist: [KEYPOM_MARKETPLACE_CONTRACT],
    };
    const assetData = [
      {
        uses: 2,
        assets: [null],
        config: {
          permissions: 'claim',
        },
      },
    ];
    drop_ids.push(dropId);
    asset_datas.push(assetData);
    drop_configs.push(dropConfig);
  }

  const { costBreakdown } = calculateDepositCost({
    eventMetadata,
    tickets: formData.tickets,
    marketTicketInfo: ticket_information,
  });

  const actions: Action[] = [
    {
      type: 'FunctionCall',
      params: {
        methodName: 'create_drop_batch',
        args: {
          drop_ids,
          drop_configs,
          asset_datas,
          change_user_metadata: JSON.stringify(funderMetadata),
          on_success: {
            receiver_id: KEYPOM_MARKETPLACE_CONTRACT,
            method_name: 'create_event',
            args: JSON.stringify({
              event_id: eventId,
              funder_id: accountId,
              ticket_information,
              stripe_status: formData.acceptStripePayments,
              stripe_account_id: formData.stripeAccountId,
            }),
            attached_deposit: costBreakdown.marketListing,
          },
        },
        gas: '300000000000000',
        deposit: costBreakdown.total,
      },
    },
  ];

  return { actions, dropIds: drop_ids };
};