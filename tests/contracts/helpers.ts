export const readFixtureText = async (name: string): Promise<string> =>
  await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

export const readFixtureJson = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFixtureText(name)) as T;

export const readJsonLines = async <T>(name: string): Promise<T[]> =>
  (await readFixtureText(name))
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
