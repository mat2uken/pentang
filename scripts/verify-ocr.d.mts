export type OcrBox = {
  text: string;
  nx: number;
  ny: number;
};

export function findBox(boxesText: string, needle: string): OcrBox | null;
export function hasExpectedResult(text: unknown): boolean;
