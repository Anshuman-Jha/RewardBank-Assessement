import { v4 as uuidv4 } from "uuid";

export const newId = (prefix: string): string => `${prefix}_${uuidv4()}`;

export const nowIso = (): string => new Date().toISOString();
