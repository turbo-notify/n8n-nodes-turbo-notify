import type { IExecuteFunctions, ILoadOptionsFunctions, IPollFunctions } from 'n8n-workflow';

/** Anything that can call the API: a node run, a trigger poll, a list picker. */
export type TurboNotifyContext = IExecuteFunctions | IPollFunctions | ILoadOptionsFunctions;

export const CREDENTIAL = 'turboNotifyApi';
