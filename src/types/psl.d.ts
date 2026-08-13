// `psl`'s package.json declares "types": "types/index.d.ts" but its
// "exports" map has no "types" condition, so TypeScript's NodeNext module
// resolution cannot find the shipped types (a known package.json gotcha,
// not specific to this project). Minimal ambient declaration covering only
// the API surface actually used here (psl.get).
declare module 'psl' {
  interface ParsedDomain {
    readonly tld: string | null;
    readonly sld: string | null;
    readonly domain: string | null;
    readonly subdomain: string | null;
    readonly listed: boolean;
  }

  interface Psl {
    get(domain: string): string | null;
    parse(domain: string): ParsedDomain;
    isValid(domain: string): boolean;
  }

  const psl: Psl;
  export default psl;
}
