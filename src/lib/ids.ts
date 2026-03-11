export const createId = (prefix: string): string => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${suffix}`;
};