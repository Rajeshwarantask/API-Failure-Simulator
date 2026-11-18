import { randomBytes } from "node:crypto";

export function generateSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

export function deriveSeed(baseSeed: number, attempt: number): number {
  return (baseSeed + Math.imul(attempt, 0x9e3779b9)) >>> 0;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    let value = (state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
