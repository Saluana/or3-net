export const toIsoDateTime = (timestampMs: number): string => new Date(timestampMs).toISOString();
export const fromIsoDateTime = (timestamp: string): number => Date.parse(timestamp);