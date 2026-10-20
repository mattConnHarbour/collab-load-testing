import type { SuperDoc } from 'superdoc';

type LoadTestBridge = {
  ui?: SuperDoc['ui'];
  ready: boolean;
  connection: string;
  connectedUsers: number;
  errors: string[];
};

declare global {
  interface Window {
    __collabLoadTest?: LoadTestBridge;
  }
}

export const loadTestBridge: LoadTestBridge | undefined = new URLSearchParams(window.location.search).get('loadTest') === '1'
  ? (window.__collabLoadTest = { ready: false, connection: 'connecting', connectedUsers: 0, errors: [] })
  : undefined;
